// Usage: npm run create-admin -- you@example.com "StrongPassword123!" SUPER_ADMIN
const db = require('../db');
const { hashPassword } = require('../utils/password');
const [email, password, role = 'ADMIN'] = process.argv.slice(2);
if (!email || !password) { console.error('Usage: npm run create-admin -- <email> <password> [SUPER_ADMIN|ADMIN|OPERATOR|VIEWER]'); process.exit(1); }
if (!['SUPER_ADMIN', 'ADMIN', 'OPERATOR', 'VIEWER'].includes(role)) { console.error('Invalid role'); process.exit(1); }
if (password.length < 12) { console.error('Password must be at least 12 characters.'); process.exit(1); }
db.prepare('INSERT INTO admins (email,password_hash,role) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role, failed_attempts=0, locked_until=NULL')
  .run(email.toLowerCase(), hashPassword(password), role);
console.log(`Admin ${email} saved as ${role}.`);
