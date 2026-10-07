const crypto = require('crypto');
const P = { N: 16384, r: 8, p: 1 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(pw, salt, 64, P).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [t, s, h] = String(stored).split('$');
  if (t !== 'scrypt' || !s || !h) return false;
  const want = Buffer.from(h, 'hex');
  const got = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, P);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
module.exports = { hashPassword, verifyPassword };
