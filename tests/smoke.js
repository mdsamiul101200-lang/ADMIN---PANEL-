// End-to-end smoke test: starts a mock provider + the app, then exercises the main flows.
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const results = [];
const check = (name, ok, extra) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + (extra || '')}`); };

// ---- mock provider ----
const orders = {}; let seq = 100; let calls = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const name = req.url.split('/').pop(); const p = b ? JSON.parse(b) : {}; calls.push({ name, p, auth: req.headers.authorization });
    const send = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof o === 'string' ? o : JSON.stringify(o)); };
    if (req.headers.authorization !== 'Bearer testkey') return send({ code: 401 }, 401);
    if (p.orderId === 'BAD500') return send('oops', 500);
    if (p.orderId === 'WEIRD') return send({ foo: 1 });
    if (p.orderId === 'NOTJSON') return send('<html>');
    if (p.orderId === 'REJ') return send({ code: 1, msg: 'Order locked' });
    if (p.orderId === 'SLOW') return setTimeout(() => send({ code: 0 }), 4000);
    if (name === 'CreateRechargeOrder') { const id = 'ORD' + ++seq; orders[id] = { orderId: id, userId: p.userId, amount: p.amount, currency: p.currency, payType: p.paymentMethod, status: 'unpaid' }; return send({ code: 0, msg: 'Succeed', data: orders[id] }); }
    const o = orders[p.orderId];
    if (!o) return send({ code: 1, msg: 'Order not found' });
    if (name === 'C2CRechargeGetOrderDetail') return send({ code: 0, msg: 'Succeed', data: o });
    if (name === 'C2CRechargeGetPayingDetail') return send({ code: 0, data: { orderId: o.orderId, payType: o.payType, utr: o.utr, status: o.status, channelName: 'TestPay' } });
    if (name === 'ArUpiSubmitUtr') { o.utr = p.utr; o.status = 'processing'; return send({ code: 0, msg: 'UTR received' }); }
    if (name === 'C2CRecharge') { return send({ code: 0, msg: 'Started' }); }
    if (['C2CRechargeConfirm', 'UpdateRechargesUpiOrder', 'UpdateRechargesUsdtOrder', 'UpRechargesBankOrder'].includes(name)) { o.status = p.action === 'REJECT' ? 'cancelled' : 'success'; return send({ code: 0, msg: 'Updated' }); }
    send({ code: 1 });
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mport = mock.address().port, port = 20000 + Math.floor(Math.random() * 20000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pap-'));
  const env = { ...process.env, NODE_ENV: 'development', PORT: String(port), API_BASE_URL: `http://127.0.0.1:${mport}/api/webapi`, API_KEY: 'testkey', API_TIMEOUT_MS: '1500', DATABASE_URL: path.join(dir, 't.db'), SESSION_SECRET: 'x'.repeat(40), ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'CorrectHorse-Battery1' };
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'backend', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch { /* wait */ } await sleep(150); }

  const mk = () => { let cookie = '', csrf = ''; return {
    async req(method, url, body, headers = {}) {
      const r = await fetch(base + url, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
      const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: r.status, json: j, text: t, headers: r.headers };
    },
    setCsrf(c) { csrf = c; }, get cookie() { return cookie; } }; };
  const A = mk();
  const idem = () => ({ 'Idempotency-Key': 'k' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) });

  let r = await A.req('GET', '/'); check('serves index.html', r.status === 200 && r.text.includes('Payment Operations'));
  r = await A.req('GET', '/js/app.js'); check('serves app.js', r.status === 200);
  r = await A.req('GET', '/../backend/config.js'); check('no path traversal', r.status === 404 || !r.text.includes('SESSION_SECRET'));
  r = await A.req('GET', '/api/orders'); check('401 without session', r.status === 401);
  r = await A.req('POST', '/api/auth/login', { email: 'root@example.com', password: 'wrong-password-123' }); check('bad password rejected', r.status === 401 && !r.json.ok);
  r = await A.req('POST', '/api/auth/login', { email: 'root@example.com', password: 'CorrectHorse-Battery1' }); check('login ok (bootstrap admin)', r.status === 200 && /sid=/.test(A.cookie), JSON.stringify(r.json));
  r = await A.req('GET', '/api/auth/me'); check('me returns csrf + permissions', r.json && r.json.csrf && r.json.permissions.includes('orders:update')); A.setCsrf(r.json.csrf);
  check('security headers set', (await A.req('GET', '/')).headers.get('content-security-policy').includes("default-src 'self'"));

  r = await A.req('POST', '/api/orders', { userId: 'U1', amount: 500, currency: 'INR', paymentMethod: 'UPI' }, {}); check('create requires idempotency key', r.status === 400);
  r = await A.req('POST', '/api/orders', { userId: 'U1', amount: -5, currency: 'INR', paymentMethod: 'UPI' }, idem()); check('create validates amount', r.status === 400, r.text);
  const k1 = idem();
  r = await A.req('POST', '/api/orders', { userId: 'U1', amount: 500, currency: 'INR', paymentMethod: 'UPI' }, k1); check('create order', r.status === 200 && r.json.order.status === 'PENDING', r.text);
  const oid = r.json.order.order_id;
  const r2 = await A.req('POST', '/api/orders', { userId: 'U1', amount: 500, currency: 'INR', paymentMethod: 'UPI' }, k1); check('idempotent replay returns same order, no duplicate', r2.status === 200 && r2.json.order.order_id === oid && calls.filter((c) => c.name === 'CreateRechargeOrder').length === 1);
  r = await A.req('POST', '/api/orders', { userId: 'U2', amount: 20, currency: 'USDT', paymentMethod: 'USDT' }, idem()); const usdt = r.json.order.order_id;
  r = await A.req('POST', '/api/orders', { userId: 'U3', amount: 75.5, currency: 'INR', paymentMethod: 'BANK' }, idem()); const bank = r.json.order.order_id;

  r = await A.req('GET', '/api/orders?status=PENDING&method=UPI'); check('list + filter', r.json.total === 1 && r.json.items[0].order_id === oid, r.text);
  r = await A.req('GET', '/api/orders?q=U1'); check('search', r.json.total === 1);
  r = await A.req('GET', "/api/orders?q=%25%27%3B--"); check('search is injection-safe', r.status === 200 && r.json.total === 0);
  r = await A.req('GET', '/api/orders?sort=amount;drop&dir=asc'); check('sort whitelist', r.status === 200);
  r = await A.req('GET', '/api/orders?min=100&max=1000'); check('amount range', r.json.total === 1);
  r = await A.req('GET', `/api/orders/${oid}`); check('detail', r.json.order.user_id === 'U1' && !('last_response' in r.json.order));
  r = await A.req('GET', '/api/orders/NOPE'); check('detail 404', r.status === 404);

  r = await A.req('POST', `/api/orders/${oid}/refresh`, null, idem()); check('refresh syncs payment details', r.status === 200 && r.json.order.status === 'PENDING', r.text);
  r = await A.req('GET', `/api/orders/${oid}`); check('payment record stored', r.json.payment && r.json.payment.provider === 'TestPay');
  r = await A.req('POST', `/api/orders/${oid}/start`, null, idem()); check('start process', r.status === 200, r.text);
  r = await A.req('POST', `/api/orders/${oid}/utr`, { utr: 'ab' }, idem()); check('UTR validation', r.status === 400);
  r = await A.req('POST', `/api/orders/${usdt}/utr`, { utr: '123456789012' }, idem()); check('UTR only for UPI', r.status === 409);
  r = await A.req('POST', `/api/orders/${oid}/utr`, { utr: '123456789012' }, idem()); check('submit UTR -> PROCESSING from server', r.status === 200 && r.json.order.status === 'PROCESSING' && r.json.order.reference_id === '123456789012', r.text);
  r = await A.req('POST', `/api/orders/${oid}/action`, { action: 'HACK' }, idem()); check('invalid action rejected', r.status === 400);
  r = await A.req('POST', `/api/orders/${oid}/action`, { action: 'APPROVE' }, idem()); check('approve -> COMPLETED (server confirmed)', r.status === 200 && r.json.order.status === 'COMPLETED' && r.json.changed === true, r.text);
  check('UPI update endpoint was used', calls.some((c) => c.name === 'UpdateRechargesUpiOrder' && c.p.action === 'APPROVE'));
  r = await A.req('POST', `/api/orders/${oid}/action`, { action: 'REJECT' }, idem()); check('cannot act on COMPLETED order', r.status === 409, r.text);
  r = await A.req('POST', `/api/orders/${usdt}/action`, { action: 'REJECT' }, idem()); check('USDT reject -> CANCELLED', r.status === 200 && r.json.order.status === 'CANCELLED', r.text);
  check('USDT endpoint used', calls.some((c) => c.name === 'UpdateRechargesUsdtOrder'));
  r = await A.req('POST', `/api/orders/${bank}/action`, { action: 'CONFIRM' }, idem()); check('CONFIRM -> C2CRechargeConfirm', r.status === 200 && calls.some((c) => c.name === 'C2CRechargeConfirm'), r.text);

  // in-flight lock
  r = await A.req('POST', '/api/orders/track', { orderId: 'SLOW', paymentMethod: 'UPI' }, idem()); check('timeout handled', r.status === 504 && /too long/.test(r.json.message), r.text);
  r = await A.req('POST', '/api/orders/track', { orderId: 'BAD500', paymentMethod: 'UPI' }, idem()); check('provider 500 -> friendly 502', r.status === 502 && !/oops/.test(r.text), r.text);
  r = await A.req('POST', '/api/orders/track', { orderId: 'WEIRD', paymentMethod: 'UPI' }, idem()); check('unexpected response message', r.status === 502 && r.json.message === 'Unexpected server response.', r.text);
  r = await A.req('POST', '/api/orders/track', { orderId: 'NOTJSON', paymentMethod: 'UPI' }, idem()); check('invalid JSON handled', r.status === 502 && r.json.message === 'Unexpected server response.', r.text);
  r = await A.req('POST', '/api/orders/track', { orderId: 'REJ', paymentMethod: 'UPI' }, idem()); check('provider rejection message shown', r.status === 502 && r.json.message === 'Order locked', r.text);
  orders.EXT1 = { orderId: 'EXT1', userId: 'U9', amount: 40, currency: 'INR', status: 'pending' };
  r = await A.req('POST', '/api/orders/track', { orderId: 'EXT1', paymentMethod: 'UPI' }, idem()); check('track existing order', r.status === 200 && r.json.order.user_id === 'U9' && r.json.order.status === 'PENDING', r.text);
  const slow = A.req('POST', '/api/orders/track', { orderId: 'SLOW', paymentMethod: 'UPI' }, idem());
  await sleep(100);
  const dup = await A.req('POST', '/api/orders/track', { orderId: 'SLOW', paymentMethod: 'UPI' }, idem()); await slow;
  check('duplicate in-flight request blocked (409)', dup.status === 409, dup.text);

  r = await A.req('GET', '/api/stats'); check('stats from real data', r.json.totalOrders === 4 && r.json.completed === 2 && r.json.cancelled === 1 && r.json.totalVolume === 575.5 && r.json.todayVolume === 575.5, r.text);
  r = await A.req('GET', '/api/transactions?pageSize=5'); check('transactions list', r.json.total >= 8 && r.json.items.length === 5);
  r = await A.req('GET', '/api/transactions/export'); check('CSV export', r.status === 200 && r.headers.get('content-type').includes('text/csv') && r.text.startsWith('transaction_id'));
  r = await A.req('GET', '/api/audit'); check('audit log has entries', r.json.total > 5 && r.json.items.some((a) => a.action === 'ORDER_UPDATED' && a.previous_status === 'PROCESSING' && a.new_status === 'COMPLETED'), r.text);
  check('audit has no secrets', !/testkey|CorrectHorse/.test(r.text));

  // CSRF & RBAC
  const bad = await fetch(base + '/api/orders/' + oid + '/refresh', { method: 'POST', headers: { Cookie: A.cookie, 'Idempotency-Key': 'k' + 'z'.repeat(20) } }); check('CSRF token required', bad.status === 403);
  const dbm = require('node:sqlite'); const { hashPassword } = require('../backend/utils/password');
  const d = new dbm.DatabaseSync(path.join(dir, 't.db'));
  for (const [e, role] of [['viewer@example.com', 'VIEWER'], ['op@example.com', 'OPERATOR']]) d.prepare('INSERT INTO admins (email,password_hash,role) VALUES (?,?,?)').run(e, hashPassword('Another-Strong-Pass1'), role);
  const V = mk(); await V.req('POST', '/api/auth/login', { email: 'viewer@example.com', password: 'Another-Strong-Pass1' }); V.setCsrf((await V.req('GET', '/api/auth/me')).json.csrf);
  r = await V.req('GET', '/api/orders'); check('viewer can read', r.status === 200);
  r = await V.req('POST', `/api/orders/${oid}/refresh`, null, idem()); check('viewer cannot refresh (403)', r.status === 403);
  r = await V.req('POST', '/api/orders', { userId: 'U1', amount: 5, currency: 'INR', paymentMethod: 'UPI' }, idem()); check('viewer cannot create (403)', r.status === 403);
  r = await V.req('GET', '/api/audit'); check('viewer cannot read audit (403)', r.status === 403);
  const O = mk(); await O.req('POST', '/api/auth/login', { email: 'op@example.com', password: 'Another-Strong-Pass1' }); O.setCsrf((await O.req('GET', '/api/auth/me')).json.csrf);
  orders.EXT2 = { orderId: 'EXT2', userId: 'U8', amount: 10, currency: 'INR', status: 'pending' };
  r = await A.req('POST', '/api/orders/track', { orderId: 'EXT2', paymentMethod: 'UPI' }, idem());
  r = await O.req('POST', '/api/orders/EXT2/action', { action: 'APPROVE' }, idem()); check('operator cannot approve (403)', r.status === 403);
  r = await O.req('POST', '/api/orders/EXT2/utr', { utr: 'ABCDEF123456' }, idem()); check('operator can submit UTR', r.status === 200, r.text);

  // audit immutability
  let blocked = false; try { d.prepare('DELETE FROM audit_logs').run(); } catch { blocked = true; } check('audit log is append-only (DB trigger)', blocked);
  // lockout
  for (let i = 0; i < 5; i++) await mk().req('POST', '/api/auth/login', { email: 'op@example.com', password: 'nope-nope-nope-1' });
  r = await mk().req('POST', '/api/auth/login', { email: 'op@example.com', password: 'Another-Strong-Pass1' }); check('account locks after repeated failures', r.status === 429, r.text);
  // logout
  r = await A.req('POST', '/api/auth/logout', {}); r = await A.req('GET', '/api/orders'); check('logout invalidates session', r.status === 401);
  // credentials never in browser-visible output
  check('no API key in static files', !fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'app.js'), 'utf8').includes('testkey'));
  check('server log has no stack traces/secrets', !/testkey|CorrectHorse/.test(log));

  srv.kill(); mock.close(); d.close();
  const fails = results.filter((x) => !x).length;
  console.log(`\n${results.length - fails}/${results.length} checks passed`);
  if (fails) { console.log('--- server log ---\n' + log.slice(-1500)); process.exit(1); }
  process.exit(0);
}
main().catch((e) => { console.error('Test crashed:', e); process.exit(2); });
