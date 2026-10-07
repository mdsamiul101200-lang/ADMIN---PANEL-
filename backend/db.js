const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const file = path.resolve(cfg.databaseUrl.replace(/^sqlite:/, ''));
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','ADMIN','OPERATOR','VIEWER')),
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  name TEXT,
  account TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  user_id TEXT,
  customer_name TEXT,
  order_type TEXT NOT NULL DEFAULT 'RECHARGE',
  amount REAL,
  currency TEXT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('UPI','USDT','BANK')),
  reference_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  provider_status TEXT,
  last_response TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  last_synced_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT UNIQUE NOT NULL,
  order_id TEXT NOT NULL,
  user_id TEXT,
  amount REAL,
  payment_method TEXT,
  reference_id TEXT,
  status TEXT,
  kind TEXT,
  admin_email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_order ON transactions(order_id);
CREATE TABLE IF NOT EXISTS payment_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT UNIQUE NOT NULL,
  provider TEXT,
  payment_method TEXT,
  reference_id TEXT,
  amount REAL,
  status TEXT,
  verification_status TEXT,
  paid_at TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER,
  admin_email TEXT,
  action TEXT NOT NULL,
  order_id TEXT,
  previous_status TEXT,
  new_status TEXT,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  order_id TEXT,
  admin_email TEXT,
  requested_at TEXT NOT NULL,
  responded_at TEXT,
  http_status INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  error_category TEXT
);
CREATE TABLE IF NOT EXISTS idempotency (
  idem_key TEXT NOT NULL,
  admin_id INTEGER NOT NULL,
  status_code INTEGER NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (idem_key, admin_id)
);
`);

db.now = () => new Date().toISOString();
module.exports = db;
