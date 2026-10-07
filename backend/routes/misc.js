const { Router } = require('../lib/mini');
const db = require('../db');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { audit } = require('../utils/audit');
const router = Router();
router.use(requireAuth);
const esc = (s) => String(s).replace(/[\\%_]/g, (c) => '\\' + c);

router.get('/stats', requirePerm('orders:read'), (req, res) => {
  const rows = db.prepare('SELECT status, COUNT(*) c, COALESCE(SUM(amount),0) v FROM orders GROUP BY status').all();
  const by = Object.fromEntries(rows.map((r) => [r.status, r]));
  const c = (s) => (by[s] ? by[s].c : 0);
  const sum = (where) => db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM orders WHERE status='COMPLETED' AND ${where}`).get().v;
  const today = sum(`date(completed_at)=date('now')`);
  const yesterday = sum(`date(completed_at)=date('now','-1 day')`);
  res.json({
    ok: true,
    totalOrders: rows.reduce((a, r) => a + r.c, 0),
    pending: c('PENDING'), processing: c('PROCESSING'), completed: c('COMPLETED'), cancelled: c('CANCELLED'), failed: c('FAILED'),
    totalVolume: by.COMPLETED ? by.COMPLETED.v : 0,
    todayVolume: today,
    todayTrendPct: yesterday > 0 ? Math.round(((today - yesterday) / yesterday) * 1000) / 10 : null,
    note: 'Volume counts COMPLETED orders only (UTC day).',
  });
});

function txQuery(q) {
  const where = [], args = [];
  if (q.status) { where.push('status=?'); args.push(String(q.status)); }
  if (['UPI', 'USDT', 'BANK'].includes(q.method)) { where.push('payment_method=?'); args.push(q.method); }
  if (q.q) { const l = `%${esc(String(q.q).slice(0, 100))}%`; where.push(`(transaction_id LIKE ? ESCAPE '\\' OR order_id LIKE ? ESCAPE '\\' OR user_id LIKE ? ESCAPE '\\' OR reference_id LIKE ? ESCAPE '\\')`); args.push(l, l, l, l); }
  if (q.from) { where.push('created_at >= ?'); args.push(String(q.from)); }
  if (q.to) { where.push('created_at <= ?'); args.push(String(q.to)); }
  const sorts = ['transaction_id', 'order_id', 'amount', 'status', 'created_at', 'updated_at'];
  const sort = sorts.includes(q.sort) ? q.sort : 'created_at';
  return { w: where.length ? 'WHERE ' + where.join(' AND ') : '', args, order: `ORDER BY ${sort} ${q.dir === 'asc' ? 'ASC' : 'DESC'}` };
}
const TXCOLS = 'transaction_id,order_id,user_id,amount,payment_method,reference_id,status,kind,admin_email,created_at,updated_at';

router.get('/transactions', requirePerm('tx:read'), (req, res) => {
  const { w, args, order } = txQuery(req.query);
  const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize, 10) || 20));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const total = db.prepare(`SELECT COUNT(*) c FROM transactions ${w}`).get(...args).c;
  const items = db.prepare(`SELECT ${TXCOLS} FROM transactions ${w} ${order} LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
  res.json({ ok: true, items, total, page, pageSize });
});

router.get('/transactions/export', requirePerm('tx:export'), (req, res) => {
  const { w, args, order } = txQuery(req.query);
  const rows = db.prepare(`SELECT ${TXCOLS} FROM transactions ${w} ${order} LIMIT 10000`).all(...args);
  const cell = (v) => { let s = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const cols = TXCOLS.split(',');
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
  audit(req, { action: 'TRANSACTIONS_EXPORTED', details: { rows: rows.length } });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="transactions.csv"' }).send(csv);
});

router.get('/audit', requirePerm('audit:read'), (req, res) => {
  const where = [], args = [];
  if (req.query.q) { const l = `%${esc(String(req.query.q).slice(0, 100))}%`; where.push(`(admin_email LIKE ? ESCAPE '\\' OR order_id LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\')`); args.push(l, l, l); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const pageSize = Math.min(100, Math.max(5, parseInt(req.query.pageSize, 10) || 20));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_logs ${w}`).get(...args).c;
  const items = db.prepare(`SELECT admin_email,action,order_id,previous_status,new_status,created_at FROM audit_logs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
  res.json({ ok: true, items, total, page, pageSize });
});

module.exports = router;
