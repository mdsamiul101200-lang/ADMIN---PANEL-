/**
 * Payment API adapter layer.
 * All calls to the external provider happen here, server-side only.
 *
 * ADAPT HERE: the provider's exact request/response schemas are not part of the
 * brief, so request payloads are built in PAYLOADS and responses are mapped in
 * normalize(). Change those two places to match the provider documentation.
 */
const crypto = require('crypto');
const cfg = require('../config');
const db = require('../db');
const { ProviderError, ValidationError } = require('./errors');

const STATUSES = ['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'FAILED', 'REFUNDED'];

// ---- request payload builders (single place to adjust field names) ----
const PAYLOADS = {
  C2CRechargeConfirm: (p) => ({ orderId: p.orderId, userId: p.userId, amount: p.amount }),
  CreateRechargeOrder: (p) => ({ userId: p.userId, amount: p.amount, currency: p.currency, paymentMethod: p.paymentMethod, reference: p.reference }),
  C2CRecharge: (p) => ({ orderId: p.orderId, userId: p.userId, amount: p.amount }),
  C2CRechargeGetOrderDetail: (p) => ({ orderId: p.orderId }),
  C2CRechargeGetPayingDetail: (p) => ({ orderId: p.orderId }),
  ArUpiSubmitUtr: (p) => ({ orderId: p.orderId, userId: p.userId, amount: p.amount, utr: p.utr }),
  UpdateRechargesUpiOrder: (p) => ({ orderId: p.orderId, userId: p.userId, amount: p.amount, action: p.action }),
  UpdateRechargesUsdtOrder: (p) => ({ orderId: p.orderId, userId: p.userId, amount: p.amount, action: p.action }),
  UpRechargesBankOrder: (p) => ({ orderId: p.orderId, userId: p.userId, amount: p.amount, action: p.action }),
};

const SENSITIVE = /pass|pin\b|secret|token|private|cvv|card|api.?key|seed|mnemonic/i;
function redact(v, depth = 0) {
  if (depth > 6 || v == null) return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = SENSITIVE.test(k) ? '[redacted]' : redact(val, depth + 1);
    return o;
  }
  return v;
}

const str = (v) => (v === undefined || v === null || typeof v === 'object' ? undefined : String(v));
const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
};

function mapStatus(v) {
  if (v === undefined || v === null || v === '') return null;
  const raw = String(v).trim();
  if (Object.prototype.hasOwnProperty.call(cfg.statusMap, raw) && STATUSES.includes(cfg.statusMap[raw])) return cfg.statusMap[raw];
  const s = raw.toLowerCase();
  if (/refund/.test(s)) return 'REFUNDED';
  if (/cancel|reject|declin|expire|revok/.test(s)) return 'CANCELLED';
  if (/fail|error|timeout/.test(s)) return 'FAILED';
  if (/unpaid|not.?paid|pend|wait|await|unconfirm|not.?confirm/.test(s)) return 'PENDING';
  if (/process|paying|verifying|review|in.?progress|confirming/.test(s)) return 'PROCESSING';
  if (/complet|succe|paid|approv|done|finish|confirmed/.test(s)) return 'COMPLETED';
  if (/new|creat|init/.test(s)) return 'PENDING';
  return null; // unknown value: never guess
}

/** Map any provider response into the internal structure. */
function normalize(raw) {
  const root = raw && typeof raw === 'object' ? raw : {};
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : root;

  const code = root.code ?? root.errorCode ?? root.error_code;
  let success = null;
  if (root.success === true || root.ok === true) success = true;
  else if (root.success === false || root.ok === false) success = false;
  else if (code !== undefined) success = ['0', '200', 'success', 'ok'].includes(String(code).toLowerCase());
  else if (root.status === true) success = true;

  let rawStatus = pick(data, ['status', 'orderStatus', 'order_status', 'state', 'payStatus', 'pay_status']);
  if (typeof rawStatus === 'boolean' || (rawStatus && typeof rawStatus === 'object')) rawStatus = undefined;
  const amountRaw = pick(data, ['amount', 'money', 'payAmount', 'pay_amount', 'rechargeAmount']);
  const amount = amountRaw !== undefined && Number.isFinite(Number(amountRaw)) ? Number(amountRaw) : undefined;

  const orderIdVal = pick(data, ['orderId', 'order_id', 'orderNo', 'order_no', 'rechargeNo', 'id']);
  // Some providers return the bare order object with no success/code flag.
  if (success === null && !root.error && !root.errors && (orderIdVal !== undefined || rawStatus !== undefined)) success = true;

  return {
    success,
    orderId: str(pick(data, ['orderId', 'order_id', 'orderNo', 'order_no', 'rechargeNo', 'id'])),
    userId: str(pick(data, ['userId', 'user_id', 'uid', 'userID'])),
    customerName: str(pick(data, ['userName', 'user_name', 'customerName', 'name', 'nickName'])),
    amount,
    currency: str(pick(data, ['currency', 'asset', 'coin'])),
    paymentMethod: str(pick(data, ['paymentMethod', 'payType', 'pay_type', 'payment_method', 'channel'])),
    provider: str(pick(data, ['provider', 'channelName', 'payChannel', 'bankName'])),
    referenceId: str(pick(data, ['referenceId', 'reference', 'utr', 'UTR', 'txid', 'txId', 'transactionId', 'transaction_id', 'payNo'])),
    paidAt: str(pick(data, ['paidAt', 'paid_at', 'payTime', 'pay_time', 'paymentTime'])),
    verificationStatus: str(pick(data, ['verificationStatus', 'verify_status', 'verified'])),
    providerStatus: rawStatus !== undefined ? String(rawStatus) : undefined,
    status: mapStatus(rawStatus),
    message: str(pick(root, ['message', 'msg', 'error', 'errorMessage']) || pick(data, ['message', 'msg'])),
  };
}

function sign(body) {
  return crypto.createHmac('sha256', cfg.apiSecret).update(body).digest('hex');
}

function categorize(httpStatus) {
  if (httpStatus === 400) return ['bad_request', 'The provider rejected the request.'];
  if (httpStatus === 401) return ['unauthorized', 'Provider authentication failed. Check server API credentials.'];
  if (httpStatus === 403) return ['forbidden', 'The provider denied access to this operation.'];
  if (httpStatus === 404) return ['not_found', 'The provider could not find this record.'];
  if (httpStatus === 409) return ['conflict', 'Conflict: this record was changed or already processed.'];
  if (httpStatus === 429) return ['rate_limited', 'Too many requests. Please wait a moment and try again.'];
  if (httpStatus === 502 || httpStatus === 503) return ['provider_unavailable', 'API connection unavailable.'];
  if (httpStatus >= 500) return ['server_error', 'The provider returned a server error.'];
  return ['http_error', 'Unexpected server response.'];
}

async function call(name, params, ctx = {}) {
  const requestId = crypto.randomUUID();
  const logRow = db.prepare(`INSERT INTO api_logs (request_id,endpoint,order_id,admin_email,requested_at) VALUES (?,?,?,?,?)`)
    .run(requestId, name, ctx.orderId || params.orderId || null, ctx.admin || null, db.now()).lastInsertRowid;
  const finish = (httpStatus, success, category) =>
    db.prepare(`UPDATE api_logs SET responded_at=?, http_status=?, success=?, error_category=? WHERE id=?`)
      .run(db.now(), httpStatus ?? null, success ? 1 : 0, category ?? null, logRow);

  if (!cfg.apiBaseUrl) { finish(null, false, 'not_configured'); throw new ProviderError('not_configured', 'API connection unavailable.'); }

  const body = JSON.stringify(PAYLOADS[name](params));
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Request-Id': requestId };
  if (cfg.apiKey) headers[cfg.apiKeyHeader] = `${cfg.apiKeyPrefix}${cfg.apiKey}`;
  if (cfg.signRequests && cfg.apiSecret) headers['X-Signature'] = sign(body);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.apiTimeoutMs);
  let res, text;
  try {
    res = await fetch(`${cfg.apiBaseUrl.replace(/\/$/, '')}/${name}`, { method: 'POST', headers, body, signal: ctrl.signal });
    text = await res.text();
  } catch (e) {
    finish(null, false, e.name === 'AbortError' ? 'timeout' : 'network');
    if (e.name === 'AbortError') throw new ProviderError('timeout', 'The provider took too long to respond.');
    throw new ProviderError('network', 'API connection unavailable.', { detail: e.message });
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    const [cat, msg] = categorize(res.status);
    finish(res.status, false, cat);
    throw new ProviderError(cat, msg, { httpStatus: res.status, detail: text.slice(0, 500) });
  }
  let raw;
  try { raw = JSON.parse(text); } catch {
    finish(res.status, false, 'invalid_json');
    throw new ProviderError('invalid_json', 'Unexpected server response.', { httpStatus: res.status, detail: text.slice(0, 500) });
  }
  const normalized = normalize(raw);
  if (normalized.success === null) {
    finish(res.status, false, 'unexpected_shape');
    throw new ProviderError('unexpected', 'Unexpected server response.', { httpStatus: res.status, detail: JSON.stringify(redact(raw)).slice(0, 500) });
  }
  if (normalized.success === false) {
    finish(res.status, false, 'provider_rejected');
    throw new ProviderError('provider_rejected', normalized.message ? String(normalized.message).slice(0, 200) : 'The provider rejected this operation.', { httpStatus: res.status });
  }
  finish(res.status, true, null);
  return { requestId, normalized, raw: redact(raw) };
}

// ---- validation ----
const need = (cond, msg) => { if (!cond) throw new ValidationError(msg); };
const reId = /^[A-Za-z0-9_\-:.]{1,64}$/;
function vOrder(p) { need(reId.test(String(p.orderId || '')), 'Invalid order ID.'); }
function vOrderFull(p) {
  vOrder(p);
  need(reId.test(String(p.userId || '')), 'Invalid user ID.');
  need(Number(p.amount) > 0 && Number.isFinite(Number(p.amount)), 'Invalid amount.');
}

// ---- the nine service functions ----
const C2CRechargeConfirm = (p, c) => { vOrderFull(p); return call('C2CRechargeConfirm', p, c); };
const CreateRechargeOrder = (p, c) => {
  need(reId.test(String(p.userId || '')), 'Invalid user ID.');
  need(Number.isFinite(Number(p.amount)) && Number(p.amount) > 0 && Number(p.amount) <= 10000000, 'Amount must be between 0 and 10,000,000.');
  need(/^[A-Z]{2,10}$/.test(String(p.currency || '')), 'Currency must be 2-10 capital letters (e.g. INR, USDT).');
  need(['UPI', 'USDT', 'BANK'].includes(p.paymentMethod), 'Unsupported payment method.');
  need(!p.reference || /^[\w\-:. ]{1,64}$/.test(String(p.reference)), 'Invalid reference.');
  return call('CreateRechargeOrder', p, c);
};
const C2CRecharge = (p, c) => { vOrderFull(p); return call('C2CRecharge', p, c); };
const C2CRechargeGetOrderDetail = (p, c) => { vOrder(p); return call('C2CRechargeGetOrderDetail', p, c); };
const C2CRechargeGetPayingDetail = (p, c) => { vOrder(p); return call('C2CRechargeGetPayingDetail', p, c); };
const ArUpiSubmitUtr = (p, c) => {
  vOrderFull(p);
  need(/^[A-Za-z0-9]{6,30}$/.test(String(p.utr || '')), 'UTR must be 6-30 letters/digits.');
  return call('ArUpiSubmitUtr', p, c);
};
const upd = (name) => (p, c) => {
  vOrderFull(p);
  need(['APPROVE', 'REJECT'].includes(p.action), 'Unsupported action.');
  return call(name, p, c);
};
const UpdateRechargesUpiOrder = upd('UpdateRechargesUpiOrder');
const UpdateRechargesUsdtOrder = upd('UpdateRechargesUsdtOrder');
const UpRechargesBankOrder = upd('UpRechargesBankOrder');

const updateByMethod = { UPI: UpdateRechargesUpiOrder, USDT: UpdateRechargesUsdtOrder, BANK: UpRechargesBankOrder };

module.exports = {
  STATUSES, normalize, redact,
  C2CRechargeConfirm, CreateRechargeOrder, C2CRecharge, C2CRechargeGetOrderDetail, C2CRechargeGetPayingDetail,
  ArUpiSubmitUtr, UpdateRechargesUpiOrder, UpdateRechargesUsdtOrder, UpRechargesBankOrder, updateByMethod,
};
