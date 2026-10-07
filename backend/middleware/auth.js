const crypto = require('crypto');
const db = require('../db');
const cfg = require('../config');

const ALL = ['orders:read', 'orders:create', 'orders:refresh', 'orders:utr', 'orders:update', 'tx:read', 'tx:export', 'audit:read'];
const PERMS = {
  SUPER_ADMIN: ALL,
  ADMIN: ALL,
  OPERATOR: ['orders:read', 'orders:refresh', 'orders:utr', 'tx:read'],
  VIEWER: ['orders:read', 'tx:read'],
};
const hash = (t) => crypto.createHmac('sha256', cfg.sessionSecret).update(t).digest('hex');
const cookieOpts = () => ({ httpOnly: true, sameSite: 'strict', secure: cfg.cookieSecure, path: '/' });

function createSession(adminId) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id,admin_id,csrf,created_at,last_seen,expires_at) VALUES (?,?,?,?,?,?)')
    .run(hash(token), adminId, csrf, new Date(now).toISOString(), new Date(now).toISOString(), new Date(now + cfg.sessionMaxHours * 3600e3).toISOString());
  return { token, csrf };
}
const destroySession = (token) => token && db.prepare('DELETE FROM sessions WHERE id=?').run(hash(token));

function requireAuth(req, res, next) {
  const expired = () => res.status(401).json({ ok: false, code: 'SESSION_EXPIRED', message: 'Your session has expired.' });
  const token = req.cookies && req.cookies.sid;
  if (!token) return expired();
  const s = db.prepare('SELECT s.*, a.email, a.role, a.active FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.id=?').get(hash(token));
  if (!s || !s.active) return expired();
  const now = Date.now();
  if (Date.parse(s.expires_at) < now || Date.parse(s.last_seen) + cfg.sessionIdleMin * 60e3 < now) {
    destroySession(token);
    return expired();
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const sent = Buffer.from(String(req.get('x-csrf-token') || ''));
    const real = Buffer.from(s.csrf);
    if (sent.length !== real.length || !crypto.timingSafeEqual(sent, real)) {
      return res.status(403).json({ ok: false, message: 'Security check failed. Please reload the page.' });
    }
  }
  db.prepare('UPDATE sessions SET last_seen=? WHERE id=?').run(new Date(now).toISOString(), s.id);
  req.admin = { id: s.admin_id, email: s.email, role: s.role, permissions: PERMS[s.role] || [] };
  req.csrf = s.csrf;
  next();
}

const requirePerm = (perm) => (req, res, next) =>
  req.admin.permissions.includes(perm) ? next() : res.status(403).json({ ok: false, message: 'You do not have permission for this action.' });

module.exports = { requireAuth, requirePerm, createSession, destroySession, cookieOpts, PERMS };
