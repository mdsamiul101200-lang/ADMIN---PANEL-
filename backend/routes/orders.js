const { Router } = require('../lib/mini');
const crypto = require('crypto');
const db = require('../db');
const pay = require('../services/paymentService');
const { ProviderError, ValidationError, HttpError } = require('../services/errors');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { audit } = require('../utils/audit');

const router = Router();
router.use(requireAuth);

const METHODS = ['UPI', 'USDT', 'BANK'];
const OPEN = ['PENDING', 'PROCESSING'];
const getOrder = (id) => db.prepare('SELECT * FROM orders WHERE order_id=?').get(id);
const esc = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

// ---------- helpers ----------
function upsertUser(userId, name) {
  if (!userId) return;
  const t = db.now();
  db.prepare(`INSERT INTO users (user_id,name,account,created_at,updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET name=COALESCE(excluded.name,users.name), updated_at=excluded.updated_at`)
    .run(String(userId), name ? String(name) : null, String(userId), t, t);
}

function applyNormalized(orderId, n) {
  const before = getOrder(orderId);
  if (!before) return null;
  const f = { updated_at: db.now(), last_synced_at: db.now() };
  if (n.userId) f.user_id = String(n.userId);
  if (n.amount !== undefined) f.amount = n.amount;
  if (n.currency) f.currency = String(n.currency);
  if (n.referenceId) f.reference_id = String(n.referenceId);
  if (n.customerName) f.customer_name = String(n.customerName);
  if (n.providerStatus) f.provider_status = n.providerStatus;
  if (n.status) {
    f.status = n.status;
    if (n.status === 'COMPLETED' && !before.completed_at) f.completed_at = db.now();
    if (n.status === 'CANCELLED' && !before.cancelled_at) f.cancelled_at = db.now();
  }
  const { raw, ...safe } = n;
  f.last_response = JSON.stringify(safe);
  const keys = Object.keys(f);
  db.prepare(`UPDATE orders SET ${keys.map((k) => `${k}=@${k}`).join(',')} WHERE order_id=@order_id`).run({ ...f, order_id: orderId });
  upsertUser(f.user_id || before.user_id, n.customerName);
  return { before, after: getOrder(orderId) };
}

function savePayment(orderId, n, raw) {
  const t = db.now();
  const o = getOrder(orderId);
  db.prepare(`INSERT INTO payment_records (order_id,provider,payment_method,reference_id,amount,status,verification_status,paid_at,raw_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(order_id) DO UPDATE SET provider=COALESCE(excluded.provider,provider), payment_method=COALESCE(excluded.payment_method,payment_method),
      reference_id=COALESCE(excluded.reference_id,reference_id), amount=COALESCE(excluded.amount,amount), status=COALESCE(excluded.status,status),
      verification_status=COALESCE(excluded.verification_status,verification_status), paid_at=COALESCE(excluded.paid_at,paid_at),
      raw_json=excluded.raw_json, updated_at=excluded.updated_at`)
    .run(orderId, n.provider != null ? String(n.provider) : null, n.paymentMethod ? String(n.paymentMethod) : o.payment_method, n.referenceId ? String(n.referenceId) : null,
      n.amount ?? null, n.providerStatus ?? null, n.verificationStatus !== undefined ? String(n.verificationStatus) : null,
      n.paidAt ? String(n.paidAt) : null, JSON.stringify(raw || null).slice(0, 20000), t, t);
  if (n.referenceId && !o.reference_id) db.prepare('UPDATE orders SET reference_id=? WHERE order_id=?').run(String(n.referenceId), orderId);
}

function recordTx(order, kind, admin) {
  const t = db.now();
  db.prepare(`INSERT INTO transactions (transaction_id,order_id,user_id,amount,payment_method,reference_id,status,kind,admin_email,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('TX-' + crypto.randomBytes(6).toString('hex').toUpperCase(), order.order_id, order.user_id, order.amount, order.payment_method, order.reference_id, order.status, kind, admin, t, t);
}

async function refreshOrder(orderId, ctx) {
  const d = await pay.C2CRechargeGetOrderDetail({ orderId }, ctx);
  const r = applyNormalized(orderId, d.normalized);
  let paymentNote = null;
  try {
    const p = await pay.C2CRechargeGetPayingDetail({ orderId }, ctx);
    savePayment(orderId, p.normalized, p.raw);
  } catch (e) { paymentNote = e.publicMessage || 'Payment details unavailable.'; }
  return { ...r, paymentNote, statusKnown: Boolean(d.normalized.status) };
}

function toErrorResponse(e) {
  if (e instanceof ValidationError) return { status: 400, body: { ok: false, message: e.message } };
  if (e instanceof HttpError) return { status: e.status, body: { ok: false, message: e.message } };
  if (e instanceof ProviderError) {
    if (e.detail) console.error(`[provider:${e.category}]`, e.detail);
    const status = { rate_limited: 429, timeout: 504, conflict: 409, not_found: 404 }[e.category]
      || (['network', 'not_configured', 'provider_unavailable'].includes(e.category) ? 503 : 502);
    return { status, body: { ok: false, category: e.category, message: e.publicMessage } };
  }
  console.error('[internal]', e && e.message);
  return { status: 500, body: { ok: false, message: 'Something went wrong. Please try again.' } };
}

/** Wrap a mutating handler: idempotency key + per-order in-flight lock + safe error mapping. */
const inflight = new Set();
const guarded = (handler) => async (req, res) => {
  const idem = req.get('Idempotency-Key');
  if (!idem || !/^[\w-]{16,80}$/.test(idem)) return res.status(400).json({ ok: false, message: 'Missing request identifier.' });
  const hit = db.prepare('SELECT status_code,response FROM idempotency WHERE idem_key=? AND admin_id=?').get(idem, req.admin.id);
  if (hit) return res.status(hit.status_code).json(JSON.parse(hit.response));
  const lock = req.params.orderId || req.body.orderId || 'new:' + idem;
  if (inflight.has(lock)) return res.status(409).json({ ok: false, message: 'Another operation on this order is still in progress.' });
  inflight.add(lock);
  let status = 200, body;
  try { body = await handler(req); } catch (e) { ({ status, body } = toErrorResponse(e)); } finally { inflight.delete(lock); }
  if (status < 400) db.prepare('INSERT OR IGNORE INTO idempotency (idem_key,admin_id,status_code,response,created_at) VALUES (?,?,?,?,?)').run(idem, req.admin.id, status, JSON.stringify(body), db.now());
  res.status(status).json(body);
};

const loadOrder = (req) => {
  const o = getOrder(req.params.orderId);
  if (!o) throw new HttpError(404, 'Order not found.');
  return o;
};
const ctxOf = (req, orderId) => ({ admin: req.admin.email, orderId });

// ---------- list ----------
router.get('/', requirePerm('orders:read'), (req, res) => {
  const q = req.query, where = [], args = [];
  const sts = String(q.status || '').split(',').filter((s) => pay.STATUSES.includes(s));
  if (sts.length) { where.push(`status IN (${sts.map(() => '?').join(',')})`); args.push(...sts); }
  if (METHODS.includes(q.method)) { where.push('payment_method=?'); args.push(q.method); }
  if (q.userId) { where.push(`user_id LIKE ? ESCAPE '\\'`); args.push(`%${esc(q.userId)}%`); }
  if (q.orderId) { where.push(`order_id LIKE ? ESCAPE '\\'`); args.push(`%${esc(q.orderId)}%`); }
  if (q.txId) { where.push(`(reference_id LIKE ? ESCAPE '\\' OR order_id IN (SELECT order_id FROM transactions WHERE transaction_id LIKE ? ESCAPE '\\'))`); args.push(`%${esc(q.txId)}%`, `%${esc(q.txId)}%`); }
  if (q.q) {
    const l = `%${esc(String(q.q).slice(0, 100))}%`;
    where.push(`(order_id LIKE ? ESCAPE '\\' OR user_id LIKE ? ESCAPE '\\' OR reference_id LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\'
      OR order_id IN (SELECT order_id FROM transactions WHERE transaction_id LIKE ? ESCAPE '\\'))`);
    args.push(l, l, l, l, l);
  }
  if (q.from) { where.push('created_at >= ?'); args.push(String(q.from)); }
  if (q.to) { where.push('created_at <= ?'); args.push(String(q.to)); }
  if (q.min !== undefined && q.min !== '' && Number.isFinite(Number(q.min))) { where.push('amount >= ?'); args.push(Number(q.min)); }
  if (q.max !== undefined && q.max !== '' && Number.isFinite(Number(q.max))) { where.push('amount <= ?'); args.push(Number(q.max)); }
  const sorts = ['order_id', 'user_id', 'amount', 'status', 'payment_method', 'created_at', 'updated_at'];
  const sort = sorts.includes(q.sort) ? q.sort : 'created_at';
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const pageSize = Math.min(100, Math.max(5, parseInt(q.pageSize, 10) || 20));
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM orders ${w}`).get(...args).c;
  const items = db.prepare(`SELECT order_id,user_id,customer_name,order_type,amount,currency,payment_method,reference_id,status,created_at,updated_at
    FROM orders ${w} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
  res.json({ ok: true, items, total, page, pageSize });
});

// ---------- detail (local record) ----------
router.get('/:orderId', requirePerm('orders:read'), (req, res) => {
  const order = getOrder(req.params.orderId);
  if (!order) return res.status(404).json({ ok: false, message: 'Order not found.' });
  const { last_response, ...o } = order;
  const payment = db.prepare('SELECT provider,payment_method,reference_id,amount,status,verification_status,paid_at,updated_at FROM payment_records WHERE order_id=?').get(order.order_id) || null;
  const transactions = db.prepare('SELECT transaction_id,kind,status,amount,admin_email,created_at FROM transactions WHERE order_id=? ORDER BY id DESC LIMIT 20').all(order.order_id);
  const history = req.admin.permissions.includes('audit:read')
    ? db.prepare('SELECT action,admin_email,previous_status,new_status,created_at FROM audit_logs WHERE order_id=? ORDER BY id DESC LIMIT 20').all(order.order_id) : [];
  let response = null;
  try { response = last_response ? JSON.parse(last_response) : null; } catch { /* ignore */ }
  res.json({ ok: true, order: o, payment, transactions, history, response });
});

// ---------- create ----------
router.post('/', requirePerm('orders:create'), guarded(async (req) => {
  const b = req.body || {};
  const p = { userId: String(b.userId || '').trim(), amount: Number(b.amount), currency: String(b.currency || '').trim().toUpperCase(), paymentMethod: b.paymentMethod, reference: b.reference ? String(b.reference).trim() : undefined };
  const r = await pay.CreateRechargeOrder(p, ctxOf(req));
  const n = r.normalized;
  if (!n.orderId) throw new ProviderError('unexpected', 'Unexpected server response.', { detail: 'CreateRechargeOrder returned no order id' });
  const orderId = String(n.orderId);
  if (getOrder(orderId)) throw new HttpError(409, 'This order already exists.');
  const t = db.now();
  db.prepare(`INSERT INTO orders (order_id,user_id,customer_name,order_type,amount,currency,payment_method,reference_id,status,provider_status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orderId, p.userId, n.customerName ? String(n.customerName) : null, 'RECHARGE', n.amount ?? p.amount, p.currency, p.paymentMethod,
      n.referenceId ? String(n.referenceId) : p.reference || null, n.status || 'PENDING', n.providerStatus || null, t, t);
  upsertUser(p.userId, n.customerName);
  const order = getOrder(orderId);
  recordTx(order, 'ORDER_CREATED', req.admin.email);
  audit(req, { action: 'ORDER_CREATED', orderId, next: order.status });
  return { ok: true, message: 'Order created.', order };
}));

// ---------- track an existing provider order ----------
router.post('/track', requirePerm('orders:create'), guarded(async (req) => {
  const orderId = String((req.body && req.body.orderId) || '').trim();
  const method = req.body && req.body.paymentMethod;
  if (!METHODS.includes(method)) throw new ValidationError('Choose a payment method.');
  if (getOrder(orderId)) throw new HttpError(409, 'This order is already tracked.');
  const d = await pay.C2CRechargeGetOrderDetail({ orderId }, ctxOf(req, orderId));
  const n = d.normalized;
  if (!n.orderId || String(n.orderId) !== orderId) throw new ProviderError('unexpected', 'Unexpected server response.', { detail: 'order id mismatch on track' });
  const t = db.now();
  db.prepare(`INSERT INTO orders (order_id,user_id,customer_name,order_type,amount,currency,payment_method,reference_id,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(orderId, n.userId ? String(n.userId) : null, n.customerName || null, 'RECHARGE', n.amount ?? null, n.currency || null, method,
      n.referenceId ? String(n.referenceId) : null, n.status || 'PENDING', t, t);
  applyNormalized(orderId, n);
  const order = getOrder(orderId);
  recordTx(order, 'ORDER_TRACKED', req.admin.email);
  audit(req, { action: 'ORDER_TRACKED', orderId, next: order.status });
  return { ok: true, message: 'Order added from provider data.', order, statusKnown: Boolean(n.status) };
}));

// ---------- refresh ----------
router.post('/:orderId/refresh', requirePerm('orders:refresh'), guarded(async (req) => {
  const o = loadOrder(req);
  const r = await refreshOrder(o.order_id, ctxOf(req, o.order_id));
  if (r.after.status !== r.before.status) {
    recordTx(r.after, 'STATUS_SYNCED', req.admin.email);
    audit(req, { action: 'ORDER_SYNCED', orderId: o.order_id, previous: r.before.status, next: r.after.status });
  }
  return { ok: true, message: 'Order information refreshed.', order: r.after, paymentNote: r.paymentNote, statusKnown: r.statusKnown };
}));

// ---------- start (C2CRecharge) ----------
router.post('/:orderId/start', requirePerm('orders:update'), guarded(async (req) => {
  const o = loadOrder(req);
  if (o.status !== 'PENDING') throw new HttpError(409, `Order is ${o.status}; it cannot be started.`);
  await pay.C2CRecharge({ orderId: o.order_id, userId: o.user_id, amount: o.amount }, ctxOf(req, o.order_id));
  const r = await refreshOrder(o.order_id, ctxOf(req, o.order_id));
  recordTx(r.after, 'ORDER_STARTED', req.admin.email);
  audit(req, { action: 'ORDER_STARTED', orderId: o.order_id, previous: o.status, next: r.after.status });
  return { ok: true, message: 'Order process started.', order: r.after, statusKnown: r.statusKnown };
}));

// ---------- submit UTR (UPI) ----------
router.post('/:orderId/utr', requirePerm('orders:utr'), guarded(async (req) => {
  const o = loadOrder(req);
  if (o.payment_method !== 'UPI') throw new HttpError(409, 'UTR submission applies to UPI orders only.');
  if (!OPEN.includes(o.status)) throw new HttpError(409, `Order is ${o.status}; UTR cannot be submitted.`);
  const utr = String((req.body && req.body.utr) || '').trim();
  const r = await pay.ArUpiSubmitUtr({ orderId: o.order_id, userId: o.user_id, amount: o.amount, utr }, ctxOf(req, o.order_id));
  const rr = await refreshOrder(o.order_id, ctxOf(req, o.order_id));
  if (r.normalized.verificationStatus !== undefined) {
    db.prepare('UPDATE payment_records SET verification_status=? WHERE order_id=?').run(String(r.normalized.verificationStatus), o.order_id);
  }
  recordTx(rr.after, 'UTR_SUBMITTED', req.admin.email);
  audit(req, { action: 'UTR_SUBMITTED', orderId: o.order_id, previous: o.status, next: rr.after.status, details: { utrLast4: utr.slice(-4) } });
  return { ok: true, message: r.normalized.message ? String(r.normalized.message) : 'UTR submitted.', order: rr.after, statusKnown: rr.statusKnown };
}));

// ---------- controlled status action ----------
const ACTIONS = { APPROVE: 'Approve payment', REJECT: 'Reject payment', CONFIRM: 'Confirm recharge' };
router.post('/:orderId/action', requirePerm('orders:update'), guarded(async (req) => {
  const o = loadOrder(req);
  const action = String((req.body && req.body.action) || '');
  if (!ACTIONS[action]) throw new ValidationError('Unsupported action.');
  // Re-verify the live state with the provider before acting.
  const pre = await refreshOrder(o.order_id, ctxOf(req, o.order_id));
  if (!OPEN.includes(pre.after.status)) throw new HttpError(409, `Order is already ${pre.after.status}; no action is allowed.`);
  const params = { orderId: o.order_id, userId: pre.after.user_id, amount: pre.after.amount, currency: pre.after.currency, action };
  const resp = action === 'CONFIRM' ? await pay.C2CRechargeConfirm(params, ctxOf(req, o.order_id)) : await pay.updateByMethod[o.payment_method](params, ctxOf(req, o.order_id));
  const post = await refreshOrder(o.order_id, ctxOf(req, o.order_id));
  const changed = post.after.status !== pre.after.status;
  recordTx(post.after, 'ACTION_' + action, req.admin.email);
  audit(req, { action: 'ORDER_UPDATED', orderId: o.order_id, previous: pre.after.status, next: post.after.status, details: { requested: action, providerMessage: resp.normalized.message ? String(resp.normalized.message).slice(0, 200) : null } });
  return {
    ok: true, order: post.after, statusKnown: post.statusKnown, changed,
    message: changed ? 'Order updated successfully.' : 'The provider accepted the request, but the order status has not changed yet. Refresh again shortly.',
    level: changed ? 'success' : 'warning',
  };
}));

module.exports = router;
