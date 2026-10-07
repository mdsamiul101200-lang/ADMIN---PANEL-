const { Router, rateLimit } = require('../lib/mini');
const { hashPassword, verifyPassword } = require('../utils/password');
const db = require('../db');
const cfg = require('../config');
const { createSession, destroySession, cookieOpts, requireAuth } = require('../middleware/auth');
const { audit } = require('../utils/audit');

const router = Router();
const DUMMY = hashPassword('not-a-real-password');
const limiter = rateLimit({ windowMs: 15 * 60e3, max: 20, message: { ok: false, message: 'Too many attempts. Try again later.' } });

router.post('/login', limiter, (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const fail = () => res.status(401).json({ ok: false, message: 'Invalid email or password.' });
  if (!email || !password || password.length > 200) return fail();
  const a = db.prepare('SELECT * FROM admins WHERE email=?').get(email);
  if (!a || !a.active) { verifyPassword(password, DUMMY); return fail(); }
  if (a.locked_until && Date.parse(a.locked_until) > Date.now()) {
    return res.status(429).json({ ok: false, message: 'Account temporarily locked. Try again later.' });
  }
  if (!verifyPassword(password, a.password_hash)) {
    const n = a.failed_attempts + 1;
    const lock = n >= cfg.maxLoginFails ? new Date(Date.now() + cfg.lockMinutes * 60e3).toISOString() : null;
    db.prepare('UPDATE admins SET failed_attempts=?, locked_until=? WHERE id=?').run(lock ? 0 : n, lock, a.id);
    audit({ ip: req.ip, admin: null }, { action: 'LOGIN_FAILED', details: { email } });
    return fail();
  }
  db.prepare('UPDATE admins SET failed_attempts=0, locked_until=NULL WHERE id=?').run(a.id);
  const { token, csrf } = createSession(a.id);
  res.cookie('sid', token, { ...cookieOpts(), maxAge: cfg.sessionMaxHours * 3600e3 });
  audit({ ip: req.ip, admin: { id: a.id, email: a.email } }, { action: 'LOGIN' });
  res.json({ ok: true });
});

router.post('/logout', requireAuth, (req, res) => {
  destroySession(req.cookies.sid);
  res.clearCookie('sid', cookieOpts());
  audit(req, { action: 'LOGOUT' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    ok: true, email: req.admin.email, role: req.admin.role, permissions: req.admin.permissions, csrf: req.csrf,
    config: { pollIntervalMs: cfg.pollIntervalMs, idleMinutes: cfg.sessionIdleMin, providerConfigured: Boolean(cfg.apiBaseUrl && cfg.apiKey), env: cfg.env },
  });
});

module.exports = router;
