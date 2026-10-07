const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal .env loader (no dependency). Real environment variables always win.
function loadEnv(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
const env = process.env.NODE_ENV || 'development';
loadEnv(path.join(__dirname, '..', `.env.${env}`));
loadEnv(path.join(__dirname, '..', '.env'));

const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
let statusMap = {};
try { statusMap = process.env.STATUS_MAP_JSON ? JSON.parse(process.env.STATUS_MAP_JSON) : {}; } catch { console.warn('STATUS_MAP_JSON is not valid JSON; ignored.'); }
const isProd = env === 'production';

const cfg = {
  env, isProd,
  port: int(process.env.PORT, 3000),
  apiBaseUrl: (process.env.API_BASE_URL || '').trim(),
  apiKey: process.env.API_KEY || '',
  apiSecret: process.env.API_SECRET || '',
  apiKeyHeader: process.env.API_KEY_HEADER || 'Authorization',
  apiKeyPrefix: process.env.API_KEY_PREFIX === undefined ? 'Bearer ' : process.env.API_KEY_PREFIX,
  signRequests: process.env.SIGN_REQUESTS === 'true',
  apiTimeoutMs: int(process.env.API_TIMEOUT_MS, 15000),
  databaseUrl: process.env.DATABASE_URL || './data/admin.db',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionIdleMin: int(process.env.SESSION_IDLE_MIN, 30),
  sessionMaxHours: int(process.env.SESSION_MAX_HOURS, 12),
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  pollIntervalMs: Math.max(5000, int(process.env.POLL_INTERVAL_MS, 15000)),
  trustProxy: process.env.TRUST_PROXY ? process.env.TRUST_PROXY === 'true' : isProd,
  forceHttps: process.env.FORCE_HTTPS === 'true',
  statusMap,
  cookieSecure: process.env.COOKIE_SECURE !== undefined ? process.env.COOKIE_SECURE === 'true' : isProd,
  maxLoginFails: 5,
  lockMinutes: 15,
};

if (cfg.sessionSecret.length < 32) {
  if (cfg.isProd) throw new Error('SESSION_SECRET must be set (32+ characters) in production.');
  cfg.sessionSecret = 'dev-' + crypto.randomBytes(24).toString('hex');
  console.warn('[config] Using a temporary dev SESSION_SECRET (sessions reset on restart).');
}
module.exports = cfg;
