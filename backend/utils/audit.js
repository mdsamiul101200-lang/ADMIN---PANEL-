const db = require('../db');
function audit(req, { action, orderId = null, previous = null, next = null, details = null }) {
  db.prepare(`INSERT INTO audit_logs (admin_id,admin_email,action,order_id,previous_status,new_status,details,ip,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(req.admin ? req.admin.id : null, req.admin ? req.admin.email : null, action, orderId, previous, next,
      details ? JSON.stringify(details).slice(0, 1000) : null, req.ip, db.now());
}
module.exports = { audit };
