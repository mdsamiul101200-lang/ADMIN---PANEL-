const path = require('path');
const cfg = require('./config');
const db = require('./db');
const { App, json, serveStatic, rateLimit } = require('./lib/mini');
const { hashPassword } = require('./utils/password');

// Optional first-run bootstrap: creates a SUPER_ADMIN only when no admin exists yet.
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && db.prepare('SELECT COUNT(*) c FROM admins').get().c === 0) {
  if (process.env.ADMIN_PASSWORD.length < 12) console.error('[bootstrap] ADMIN_PASSWORD must be at least 12 characters; admin not created.');
  else {
    db.prepare('INSERT INTO admins (email,password_hash,role) VALUES (?,?,?)').run(process.env.ADMIN_EMAIL.trim().toLowerCase(), hashPassword(process.env.ADMIN_PASSWORD), 'SUPER_ADMIN');
    console.log('[bootstrap] First SUPER_ADMIN created. Remove ADMIN_PASSWORD from the environment now.');
  }
}

const app = new App();
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'";

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  if (cfg.isProd) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  if (cfg.forceHttps && !req.secure) return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  next();
});
app.use((req, res, next) => { // CORS allow-list (same-origin by default)
  const o = req.headers.origin;
  if (o && cfg.corsOrigins.includes(o)) {
    res.set({ 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    if (req.method === 'OPTIONS') return res.status(204).end();
  }
  next();
});
app.use(json());
app.use('/api', rateLimit({ windowMs: 60e3, max: 240, message: { ok: false, message: 'Too many requests. Please slow down.' } }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use('/api/auth', require('./routes/auth'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api', require('./routes/misc'));
app.use('/api', (req, res) => res.status(404).json({ ok: false, message: 'Not found.' }));
app.use(serveStatic(path.join(__dirname, '..', 'frontend'), { maxAge: cfg.isProd ? 300 : 0 }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, message: 'Invalid request body.' });
  console.error('[unhandled]', err && err.message);
  res.status(500).json({ ok: false, message: 'Request could not be processed.' });
});

setInterval(() => {
  try { db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(db.now()); db.prepare("DELETE FROM idempotency WHERE created_at < datetime('now','-2 day')").run(); } catch { /* ignore */ }
}, 3600e3).unref();

app.listen(cfg.port, () => console.log(`Admin panel running on :${cfg.port} (${cfg.env}); provider ${cfg.apiBaseUrl && cfg.apiKey ? 'configured' : 'NOT configured'}`));
