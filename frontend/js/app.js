(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IC = {
  grid: 'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z', clock: 'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  list: 'M4 6h16M4 12h16M4 18h16', swap: 'M7 7h13l-4-4M17 17H4l4 4', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  menu: 'M3 6h18M3 12h18M3 18h18', x: 'M6 6l12 12M18 6L6 18', check: 'M5 12l5 5 9-10', ban: 'M5.6 5.6l12.8 12.8M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  warn: 'M12 9v4m0 4h.01M10.3 4l-8 14a2 2 0 001.7 3h16a2 2 0 001.7-3l-8-14a2 2 0 00-3.4 0z', cash: 'M3 7h18v10H3zM12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z',
  sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M12 8a4 4 0 100 8 4 4 0 000-8z', gear: 'M12 8a4 4 0 100 8 4 4 0 000-8z', refresh: 'M4 4v6h6M20 20v-6h-6M20 10A8 8 0 006 6l-2 4M4 14a8 8 0 0014 4l2-4',
};
const ico = (n) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${IC[n] || ''}"/></svg>`;
const S = { me: null, csrf: null, cfg: {}, pollTimer: null, searchTimer: null, F: {} };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'k' + Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
const money = (a, c) => (a == null ? '—' : new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(a) + (c ? ' ' + c : ''));
const when = (s) => (s ? new Date(s).toLocaleString() : '—');
const badge = (s) => `<span class="badge b-${esc((s || 'unknown').toLowerCase())}">${esc(s || 'UNKNOWN')}</span>`;
const can = (p) => S.me && S.me.permissions.includes(p);

function toast(type, msg) {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3800);
}

async function api(path, { method = 'GET', body, idem } = {}) {
  const h = {};
  if (body) h['Content-Type'] = 'application/json';
  if (method !== 'GET') h['X-CSRF-Token'] = S.csrf || '';
  if (idem) h['Idempotency-Key'] = idem;
  let res;
  try { res = await fetch('/api' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch { throw new Error('Network error. Check your connection.'); }
  if (res.headers.get('content-type') && res.headers.get('content-type').includes('text/csv')) return res;
  let data = {};
  try { data = await res.json(); } catch { throw new Error('Unexpected server response.'); }
  if (res.status === 401 && S.me) { S.me = null; stopPoll(); toast('warning', 'Your session has expired.'); showLogin(); throw new Error('Your session has expired.'); }
  if (!res.ok || data.ok === false) { const e = new Error(data.message || 'Request failed.'); e.status = res.status; throw e; }
  return data;
}

async function busy(btn, fn) {
  if (btn.disabled) return;
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  try { return await fn(); } finally { btn.disabled = false; btn.innerHTML = old; }
}
const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

// ---------- polling ----------
function stopPoll() { if (S.pollTimer) clearInterval(S.pollTimer); S.pollTimer = null; document.removeEventListener('visibilitychange', S.vis); S.vis = null; }
function startPoll(fn) {
  stopPoll(); let running = false;
  const tick = async () => { if (document.hidden || running) return; running = true; try { await fn(); } catch { /* shown by caller */ } finally { running = false; } };
  S.pollTimer = setInterval(tick, S.cfg.pollIntervalMs || 15000);
  S.vis = () => { if (!document.hidden) tick(); };
  document.addEventListener('visibilitychange', S.vis);
}

// ---------- login / shell ----------
function showLogin() {
  stopPoll();
  $('#app').innerHTML = `<div class="login"><form class="card stack" id="lf" autocomplete="on">
    <div class="brand"><div class="logo">${ico('shield')}</div><div>Payment Operations<div class="hint">Administrator sign in</div></div></div>
    <label class="f">Email<input class="inp" name="email" type="email" autocomplete="username" required></label>
    <label class="f">Password<input class="inp" name="password" type="password" autocomplete="current-password" required></label>
    <div class="err-box hidden" id="le"></div>
    <button class="btn primary" type="submit">Sign in</button></form></div>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target; const btn = f.querySelector('button');
    await busy(btn, async () => {
      try { await api('/auth/login', { method: 'POST', body: { email: f.email.value, password: f.password.value } }); await boot(); }
      catch (er) { const b = $('#le'); b.textContent = er.message; b.classList.remove('hidden'); }
    });
  };
}

const NAV = [['dashboard', 'Dashboard', 'grid'], ['pending', 'Pending Orders', 'clock'], ['orders', 'All Orders', 'list'], ['transactions', 'Transactions', 'swap'], ['audit', 'Audit Log', 'shield']];
function shell() {
  $('#app').innerHTML = `<div class="shell"><aside class="side" id="side"><div class="brand"><div class="logo">${ico('cash')}</div>Payment Ops</div>
    <nav class="nav">${NAV.filter((n) => n[0] !== 'audit' || can('audit:read')).map((n) => `<a href="#/${n[0]}" data-r="${n[0]}">${ico(n[2])}${n[1]}</a>`).join('')}</nav></aside>
    <div class="main"><header class="top"><button class="btn sm menu-btn" id="mb" aria-label="Menu">${ico('menu')}</button>
    <input class="inp search" id="gs" placeholder="Search order, user, transaction or reference" aria-label="Global search">
    <div class="who"><span><b>${esc(S.me.email)}</b> · ${esc(S.me.role.replace('_', ' '))}</span><button class="btn sm" id="lo">Logout</button></div></header>
    <main class="content" id="view"></main></div></div><div id="ov"></div><div id="md"></div>`;
  $('#mb').onclick = () => { $('#side').classList.toggle('open'); };
  $('#side').onclick = (e) => { if (e.target.closest('a')) $('#side').classList.remove('open'); };
  $('#lo').onclick = async (e) => { await busy(e.currentTarget, async () => { try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ } S.me = null; showLogin(); }); };
  $('#gs').oninput = (e) => { clearTimeout(S.searchTimer); const v = e.target.value.trim(); S.searchTimer = setTimeout(() => { if (v.length >= 2) { S.F.orders = { q: v, page: 1 }; if (location.hash === '#/orders') route(); else location.hash = '#/orders'; } }, 450); };
}

async function boot() {
  try { const me = await api('/auth/me'); S.me = me; S.csrf = me.csrf; S.cfg = me.config; } catch { S.me = null; return showLogin(); }
  shell(); window.onhashchange = route; route();
}

function route() {
  stopPoll(); closeOverlay();
  const r = (location.hash.replace('#/', '') || 'dashboard').split('?')[0];
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.r === r));
  const v = $('#view'); window.scrollTo(0, 0);
  ({ dashboard: pDash, pending: pPending, orders: pOrders, transactions: pTx, audit: pAudit }[r] || pDash)(v);
}

// ---------- shared table pieces ----------
function pager(total, page, size) {
  const pages = Math.max(1, Math.ceil(total / size));
  return `<div class="pager"><span>${total} result${total === 1 ? '' : 's'} · page ${page}/${pages}</span><span><button class="btn sm" data-pg="${page - 1}" ${page <= 1 ? 'disabled' : ''}>Prev</button> <button class="btn sm" data-pg="${page + 1}" ${page >= pages ? 'disabled' : ''}>Next</button></span></div>`;
}
const SK = (n = 5) => `<div class="pad">${Array.from({ length: n }, () => '<div class="sk"></div><br>').join('')}</div>`;

function ordersTable(items, o = {}) {
  if (!items.length) return '<div class="empty">No orders found.</div>';
  const th = (k, l) => `<th data-sort="${k}">${l}${o.sort === k ? (o.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
  const compact = o.compact;
  return `<div class="tw"><table><thead><tr>${th('order_id', 'Order ID')}${th('user_id', 'User ID')}${compact ? '' : '<th>Customer</th><th>Type</th>'}${th('amount', 'Amount')}${compact ? '' : '<th>Currency</th>'}${th('payment_method', 'Method')}${compact ? '' : '<th>Reference</th>'}${th('status', 'Status')}${th('created_at', 'Created')}${compact ? '' : th('updated_at', 'Updated')}<th>Actions</th></tr></thead><tbody>
  ${items.map((r) => `<tr><td class="mono">${esc(r.order_id)}</td><td>${esc(r.user_id)}</td>${compact ? '' : `<td>${esc(r.customer_name || '—')}</td><td>${esc(r.order_type)}</td>`}<td>${money(r.amount, compact ? r.currency : '')}</td>${compact ? '' : `<td>${esc(r.currency || '—')}</td>`}<td>${esc(r.payment_method)}</td>${compact ? '' : `<td class="mono">${esc(r.reference_id || '—')}</td>`}<td>${badge(r.status)}</td><td>${when(r.created_at)}</td>${compact ? '' : `<td>${when(r.updated_at)}</td>`}
  <td class="act"><button class="btn sm" data-view="${esc(r.order_id)}">View</button>${can('orders:refresh') ? `<button class="btn sm" data-refresh="${esc(r.order_id)}" aria-label="Refresh">${ico('refresh')}</button>` : ''}${o.process && can('orders:update') && ['PENDING', 'PROCESSING'].includes(r.status) ? `<button class="btn sm primary" data-proc="${esc(r.order_id)}">Process</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function wireTable(root, reload, state) {
  root.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => openOrder(b.dataset.view, reload)));
  root.querySelectorAll('[data-refresh]').forEach((b) => (b.onclick = () => busy(b, async () => {
    try { await api(`/orders/${encodeURIComponent(b.dataset.refresh)}/refresh`, { method: 'POST', idem: uuid() }); toast('info', 'Order information refreshed.'); } catch (e) { toast('error', e.message); }
    reload();
  })));
  root.querySelectorAll('[data-proc]').forEach((b) => (b.onclick = async () => { try { const d = await api(`/orders/${encodeURIComponent(b.dataset.proc)}`); actionDialog(d.order, reload); } catch (e) { toast('error', e.message); } }));
  root.querySelectorAll('[data-pg]').forEach((b) => (b.onclick = () => { state.page = +b.dataset.pg; reload(); }));
  root.querySelectorAll('[data-sort]').forEach((h) => (h.onclick = () => { state.dir = state.sort === h.dataset.sort && state.dir === 'desc' ? 'asc' : 'desc'; state.sort = h.dataset.sort; state.page = 1; reload(); }));
}

// ---------- pages ----------
async function pDash(v) {
  const cards = [['TOTAL ORDERS', 'totalOrders', 'list'], ['PENDING ORDERS', 'pending', 'clock'], ['PROCESSING ORDERS', 'processing', 'refresh'], ['COMPLETED ORDERS', 'completed', 'check'], ['CANCELLED ORDERS', 'cancelled', 'ban'], ['FAILED ORDERS', 'failed', 'warn'], ['TOTAL PAYMENT VOLUME', 'totalVolume', 'cash', 1], ["TODAY'S PAYMENT VOLUME", 'todayVolume', 'sun', 1]];
  v.innerHTML = `<div class="page-h"><h1>Dashboard</h1><button class="btn" id="rf">${ico('refresh')} Refresh</button></div><div class="grid" id="sg">${cards.map(() => `<div class="card stat"><div class="sk ic"></div><div class="sk"></div><div class="sk"></div></div>`).join('')}</div>
  <div class="card mt16"><div class="pad"><h2 class="h16">Latest orders</h2></div><div id="lo2">${SK()}</div></div><p class="hint" id="note"></p>`;
  const load = async () => {
    try {
      const [s, o] = await Promise.all([api('/stats'), api('/orders?pageSize=8')]);
      $('#sg').innerHTML = cards.map(([l, k, i, m]) => `<div class="card stat"><div class="ic">${ico(i)}</div><div class="lb">${l}</div><div class="vl">${m ? money(s[k]) : s[k]}</div>${k === 'todayVolume' && s.todayTrendPct != null ? `<div class="trend ${s.todayTrendPct >= 0 ? 'up' : 'down'}">${s.todayTrendPct >= 0 ? '▲' : '▼'} ${Math.abs(s.todayTrendPct)}% vs yesterday</div>` : ''}</div>`).join('');
      $('#lo2').innerHTML = ordersTable(o.items, { compact: true }); wireTable($('#lo2'), load, {});
      $('#note').textContent = s.note;
    } catch (e) { toast('error', e.message); $('#lo2').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  $('#rf').onclick = (e) => busy(e.currentTarget, load); load();
}

function ordersPage(v, { title, fixed = {}, process = false, poll = false, key }) {
  const st = (S.F[key] = Object.assign({ page: 1, pageSize: 20, sort: 'created_at', dir: 'desc', method: '', status: '', q: '', userId: '', orderId: '', txId: '', from: '', to: '', min: '', max: '' }, S.F[key] || {}));
  v.innerHTML = `<div class="page-h"><h1>${title}</h1>${poll ? `<span class="live"><span class="dot"></span>Auto-refresh ${Math.round((S.cfg.pollIntervalMs || 15000) / 1000)}s</span>` : ''}${can('orders:create') ? '<button class="btn" id="tr">Track order</button><button class="btn primary" id="cr">+ New order</button>' : ''}</div>
  <div class="tabs">${[['', 'All'], ['UPI', 'UPI'], ['USDT', 'Digital asset'], ['BANK', 'Bank']].map(([m, l]) => `<button class="tab ${st.method === m ? 'on' : ''}" data-m="${m}">${l}</button>`).join('')}</div>
  <form class="card filters" id="ff">
    <label class="f">Search<input class="inp" name="q" value="${esc(st.q)}"></label>
    ${fixed.status ? '' : `<label class="f">Status<select class="inp" name="status"><option value="">All</option>${['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED', 'FAILED', 'REFUNDED'].map((s) => `<option ${st.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>`}
    <label class="f">User ID<input class="inp" name="userId" value="${esc(st.userId)}"></label><label class="f">Order ID<input class="inp" name="orderId" value="${esc(st.orderId)}"></label>
    <label class="f">Transaction ID<input class="inp" name="txId" value="${esc(st.txId)}"></label>
    <label class="f">From<input class="inp" type="date" name="from" value="${esc(st.from)}"></label><label class="f">To<input class="inp" type="date" name="to" value="${esc(st.to)}"></label>
    <label class="f">Min amount<input class="inp" type="number" min="0" step="any" name="min" value="${esc(st.min)}"></label><label class="f">Max amount<input class="inp" type="number" min="0" step="any" name="max" value="${esc(st.max)}"></label>
    <div class="row"><button class="btn primary" type="submit">Apply filters</button><button class="btn" type="button" id="rs">Reset filters</button></div></form>
  <div class="card" id="tb">${SK(6)}</div>`;
  const load = async (quiet) => {
    const p = { ...st, status: fixed.status || st.status, to: st.to ? st.to + 'T23:59:59.999Z' : '' };
    try {
      const d = await api('/orders?' + qs(p));
      $('#tb').innerHTML = ordersTable(d.items, { sort: st.sort, dir: st.dir, process }) + pager(d.total, d.page, d.pageSize);
      wireTable($('#tb'), () => load(), st);
    } catch (e) { if (!quiet) toast('error', e.message); if (!quiet || !$('#tb table')) $('#tb').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  v.querySelectorAll('.tab').forEach((t) => (t.onclick = () => { st.method = t.dataset.m; st.page = 1; v.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x === t)); load(); }));
  $('#ff').onsubmit = (e) => { e.preventDefault(); new FormData(e.target).forEach((val, k) => (st[k] = String(val).trim())); st.page = 1; load(); };
  const q = $('#ff [name=q]'); let t; q.oninput = () => { clearTimeout(t); t = setTimeout(() => { st.q = q.value.trim(); st.page = 1; load(); }, 450); };
  $('#rs').onclick = () => { Object.assign(st, { page: 1, method: '', status: '', q: '', userId: '', orderId: '', txId: '', from: '', to: '', min: '', max: '' }); ordersPage(v, { title, fixed, process, poll, key }); };
  if ($('#cr')) $('#cr').onclick = () => createDialog(() => load());
  if ($('#tr')) $('#tr').onclick = () => trackDialog(() => load());
  load(); if (poll) startPoll(() => load(true));
}
const pPending = (v) => ordersPage(v, { title: 'Pending Orders', fixed: { status: 'PENDING,PROCESSING' }, process: true, poll: true, key: 'pending' });
const pOrders = (v) => ordersPage(v, { title: 'All Orders', process: true, key: 'orders' });

function simplePage(v, { title, key, path, head, row, filters, exportable }) {
  const st = (S.F[key] = Object.assign({ page: 1, pageSize: 20, q: '', status: '', method: '', from: '', to: '', sort: 'created_at', dir: 'desc' }, S.F[key] || {}));
  v.innerHTML = `<div class="page-h"><h1>${title}</h1>${exportable && can('tx:export') ? '<button class="btn" id="ex">Export CSV</button>' : ''}</div>
  <form class="card filters" id="ff"><label class="f">Search<input class="inp" name="q" value="${esc(st.q)}"></label>${filters ? `<label class="f">Method<select class="inp" name="method"><option value="">All</option>${['UPI', 'USDT', 'BANK'].map((m) => `<option ${st.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label><label class="f">From<input class="inp" type="date" name="from" value="${esc(st.from)}"></label><label class="f">To<input class="inp" type="date" name="to" value="${esc(st.to)}"></label>` : ''}
  <div class="row"><button class="btn primary" type="submit">Apply filters</button><button class="btn" type="button" id="rs">Reset filters</button></div></form><div class="card" id="tb">${SK(6)}</div>`;
  const params = () => ({ ...st, to: st.to ? st.to + 'T23:59:59.999Z' : '' });
  const load = async () => {
    try {
      const d = await api(path + '?' + qs(params()));
      const th = (k, l) => `<th ${k ? `data-sort="${k}"` : ''}>${l}${st.sort === k ? (st.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`;
      $('#tb').innerHTML = d.items.length ? `<div class="tw"><table><thead><tr>${head.map(([k, l]) => th(k, l)).join('')}</tr></thead><tbody>${d.items.map(row).join('')}</tbody></table></div>${pager(d.total, d.page, d.pageSize)}` : '<div class="empty">No records found.</div>';
      wireTable($('#tb'), load, st);
    } catch (e) { toast('error', e.message); $('#tb').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  $('#ff').onsubmit = (e) => { e.preventDefault(); new FormData(e.target).forEach((val, k) => (st[k] = String(val).trim())); st.page = 1; load(); };
  $('#rs').onclick = () => { Object.assign(st, { page: 1, q: '', status: '', method: '', from: '', to: '' }); simplePage(v, { title, key, path, head, row, filters, exportable }); };
  if ($('#ex')) $('#ex').onclick = (e) => busy(e.currentTarget, async () => {
    try { const r = await api('/transactions/export?' + qs(params())); const b = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'transactions.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast('success', 'Export ready.'); } catch (er) { toast('error', er.message); }
  });
  load();
}
const pTx = (v) => simplePage(v, { title: 'Transaction History', key: 'tx', path: '/transactions', filters: true, exportable: true,
  head: [['transaction_id', 'Transaction ID'], ['order_id', 'Order ID'], [null, 'User ID'], ['amount', 'Amount'], [null, 'Method'], [null, 'Reference'], ['status', 'Status'], [null, 'Type'], ['created_at', 'Created'], ['updated_at', 'Updated'], [null, 'Administrator']],
  row: (r) => `<tr><td class="mono">${esc(r.transaction_id)}</td><td class="mono">${esc(r.order_id)}</td><td>${esc(r.user_id)}</td><td>${money(r.amount)}</td><td>${esc(r.payment_method)}</td><td class="mono">${esc(r.reference_id || '—')}</td><td>${badge(r.status)}</td><td>${esc(r.kind)}</td><td>${when(r.created_at)}</td><td>${when(r.updated_at)}</td><td>${esc(r.admin_email || '—')}</td></tr>` });
const pAudit = (v) => simplePage(v, { title: 'Audit Log', key: 'audit', path: '/audit',
  head: [[null, 'Time'], [null, 'Administrator'], [null, 'Action'], [null, 'Order'], [null, 'Previous'], [null, 'New']],
  row: (r) => `<tr><td>${when(r.created_at)}</td><td>${esc(r.admin_email || '—')}</td><td>${esc(r.action)}</td><td class="mono">${esc(r.order_id || '—')}</td><td>${r.previous_status ? badge(r.previous_status) : '—'}</td><td>${r.new_status ? badge(r.new_status) : '—'}</td></tr>` });

// ---------- overlays ----------
function closeModal() { $('#md') && ($('#md').innerHTML = ''); }
function closeOverlay() { closeModal(); $('#ov') && ($('#ov').innerHTML = ''); }
function modal(html) {
  const ov = $('#md'); ov.innerHTML = `<div class="modal-bg" id="mbg"><div class="card modal" role="dialog" aria-modal="true">${html}</div></div>`;
  $('#mbg').onclick = (e) => { if (e.target.id === 'mbg') closeModal(); };
  return $('.modal', ov);
}

function actionDialog(order, done) {
  const A = [['CONFIRM', 'Confirm recharge'], ['APPROVE', 'Approve payment'], ['REJECT', 'Reject payment']];
  const m = modal(`<h2>Confirm this administrative action?</h2><dl class="kv"><dt>Order ID</dt><dd class="mono">${esc(order.order_id)}</dd><dt>User ID</dt><dd>${esc(order.user_id)}</dd><dt>Amount</dt><dd>${money(order.amount, order.currency)}</dd><dt>Current status</dt><dd>${badge(order.status)}</dd></dl>
  <label class="f mt12">Requested action<select class="inp" id="act">${A.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
  <div class="warn-box">The status is only changed after the provider confirms it. The panel re-checks the live order first.</div><div class="err-box hidden" id="ae"></div>
  <div class="btns"><button class="btn" id="no">Cancel</button><button class="btn primary" id="go">Confirm</button></div>`);
  const key = uuid();
  $('#no', m).onclick = closeModal;
  $('#go', m).onclick = (e) => busy(e.currentTarget, async () => {
    try {
      const r = await api(`/orders/${encodeURIComponent(order.order_id)}/action`, { method: 'POST', body: { action: $('#act', m).value }, idem: key });
      toast(r.level || 'success', r.message); if (!r.statusKnown) toast('warning', 'Provider status was not recognised; status left unchanged.');
      closeModal(); done && done();
    } catch (er) { const b = $('#ae', m); b.textContent = er.message; b.classList.remove('hidden'); toast('error', er.message); }
  });
}

function createDialog(done) {
  const m = modal(`<h2>New recharge order</h2><form class="stack" id="cf"><label class="f">User ID<input class="inp" name="userId" required maxlength="64"></label>
  <label class="f">Amount<input class="inp" name="amount" type="number" min="0.01" step="0.01" required></label><label class="f">Currency<input class="inp" name="currency" value="INR" required maxlength="10"></label>
  <label class="f">Payment method<select class="inp" name="paymentMethod"><option value="UPI">UPI</option><option value="USDT">Digital asset</option><option value="BANK">Bank</option></select></label>
  <label class="f">Reference (optional)<input class="inp" name="reference" maxlength="64"></label><div class="err-box hidden" id="ce"></div>
  <div class="btns"><button class="btn" type="button" id="no">Cancel</button><button class="btn primary" type="submit">Create</button></div></form>`);
  const key = uuid(); $('#no', m).onclick = closeModal;
  $('#cf', m).onsubmit = (e) => { e.preventDefault(); const f = e.target; busy(f.querySelector('[type=submit]'), async () => {
    try { await api('/orders', { method: 'POST', idem: key, body: { userId: f.userId.value, amount: f.amount.value, currency: f.currency.value, paymentMethod: f.paymentMethod.value, reference: f.reference.value } }); toast('success', 'Order created.'); closeModal(); done(); }
    catch (er) { const b = $('#ce', m); b.textContent = er.message; b.classList.remove('hidden'); }
  }); };
}

function trackDialog(done) {
  const m = modal(`<h2>Track existing order</h2><p class="hint">Loads an order from the provider by its ID and adds it to this panel.</p><form class="stack" id="tf"><label class="f">Order ID<input class="inp" name="orderId" required maxlength="64"></label>
  <label class="f">Payment method<select class="inp" name="paymentMethod"><option value="UPI">UPI</option><option value="USDT">Digital asset</option><option value="BANK">Bank</option></select></label><div class="err-box hidden" id="te"></div>
  <div class="btns"><button class="btn" type="button" id="no">Cancel</button><button class="btn primary" type="submit">Load order</button></div></form>`);
  const key = uuid(); $('#no', m).onclick = closeModal;
  $('#tf', m).onsubmit = (e) => { e.preventDefault(); const f = e.target; busy(f.querySelector('[type=submit]'), async () => {
    try { const r = await api('/orders/track', { method: 'POST', idem: key, body: { orderId: f.orderId.value, paymentMethod: f.paymentMethod.value } }); toast('success', r.message); closeModal(); done(); }
    catch (er) { const b = $('#te', m); b.textContent = er.message; b.classList.remove('hidden'); }
  }); };
}

async function openOrder(orderId, done) {
  const ov = $('#ov'); ov.innerHTML = `<div class="scrim" id="sc"></div><aside class="drawer">${SK(8)}</aside>`;
  $('#sc').onclick = () => { closeOverlay(); done && done(); };
  const draw = async () => {
    let d;
    try { d = await api(`/orders/${encodeURIComponent(orderId)}`); } catch (e) { toast('error', e.message); closeOverlay(); return; }
    const o = d.order, p = d.payment, kv = (a) => `<dl class="kv">${a.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
    const open = ['PENDING', 'PROCESSING'].includes(o.status);
    const dr = $('.drawer', ov);
    dr.innerHTML = `<div class="dh"><button class="btn sm" id="cl" aria-label="Close">${ico('x')}</button><h2 class="mono">${esc(o.order_id)}</h2>${badge(o.status)}</div>
    <div class="card sec"><h3>Customer</h3>${kv([['User ID', esc(o.user_id)], ['Customer name', esc(o.customer_name || '—')], ['Account', esc(o.user_id || '—')]])}</div>
    <div class="card sec"><h3>Order</h3>${kv([['Order type', esc(o.order_type)], ['Amount', money(o.amount, o.currency)], ['Currency', esc(o.currency || '—')], ['Status', badge(o.status)], ['Created', when(o.created_at)], ['Updated', when(o.updated_at)], ['Last synced', when(o.last_synced_at)]])}</div>
    <div class="card sec"><h3>Payment</h3>${kv([['Method', esc(o.payment_method)], ['Provider', esc((p && p.provider) || '—')], ['Reference / TXN', `<span class="mono">${esc(o.reference_id || (p && p.reference_id) || '—')}</span>`], ['Payment status', esc((p && p.status) || '—')], ['Verification', esc((p && p.verification_status) || '—')], ['Paid at', esc((p && p.paid_at) || '—')]])}
      ${o.payment_method === 'USDT' ? '<p class="hint">Digital-asset order: only the transaction reference is shown. Wallet secrets are never displayed.</p>' : ''}${o.payment_method === 'BANK' ? '<p class="hint">Bank order: only permitted payment fields are shown.</p>' : ''}</div>
    ${o.payment_method === 'UPI' && can('orders:utr') && open ? `<div class="card sec"><h3>Submit UPI reference (UTR)</h3><form class="stack" id="uf"><label class="f">UPI reference / UTR<input class="inp mono" name="utr" required maxlength="30" autocomplete="off"></label><button class="btn primary" type="submit">Submit UTR</button></form></div>` : ''}
    <div class="card sec"><h3>API response (normalised)</h3>${d.response ? kv(Object.entries(d.response).filter(([k, v]) => v !== undefined && v !== null && k !== 'success').map(([k, v]) => [esc(k), esc(typeof v === 'object' ? JSON.stringify(v) : v)])) : '<p class="hint">No provider response stored yet. Press Refresh.</p>'}</div>
    ${d.transactions.length ? `<div class="card sec"><h3>Transactions</h3>${d.transactions.map((t) => `<div class="hint">${when(t.created_at)} · <b>${esc(t.kind)}</b> · ${esc(t.transaction_id)}</div>`).join('')}</div>` : ''}
    ${d.history.length ? `<div class="card sec"><h3>Audit trail</h3>${d.history.map((h) => `<div class="hint">${when(h.created_at)} · ${esc(h.admin_email)} · <b>${esc(h.action)}</b> ${h.previous_status ? esc(h.previous_status) + ' → ' + esc(h.new_status) : ''}</div>`).join('')}</div>` : ''}
    <div class="card sec actrow">${can('orders:refresh') ? '<button class="btn" id="rf">Refresh</button>' : ''}${can('orders:update') && o.status === 'PENDING' ? '<button class="btn" id="st">Start process</button>' : ''}${can('orders:update') && open ? '<button class="btn primary" id="pa">Process action</button>' : ''}</div>`;
    $('#cl', dr).onclick = () => { closeOverlay(); done && done(); };
    const rf = $('#rf', dr); if (rf) rf.onclick = () => busy(rf, async () => { try { const r = await api(`/orders/${encodeURIComponent(orderId)}/refresh`, { method: 'POST', idem: uuid() }); toast('info', 'Order information refreshed.'); if (r.paymentNote) toast('warning', r.paymentNote); if (!r.statusKnown) toast('warning', 'Provider status was not recognised; status left unchanged.'); } catch (e) { toast('error', e.message); } draw(); });
    const st = $('#st', dr); if (st) st.onclick = () => busy(st, async () => { try { await api(`/orders/${encodeURIComponent(orderId)}/start`, { method: 'POST', idem: uuid() }); toast('success', 'Order process started.'); } catch (e) { toast('error', e.message); } draw(); });
    const pa = $('#pa', dr); if (pa) pa.onclick = () => actionDialog(o, () => { openOrder(orderId, done); });
    const uf = $('#uf', dr); if (uf) { const key = uuid(); uf.onsubmit = (e) => { e.preventDefault(); busy(uf.querySelector('button'), async () => { try { const r = await api(`/orders/${encodeURIComponent(orderId)}/utr`, { method: 'POST', body: { utr: uf.utr.value.trim() }, idem: key }); toast('success', r.message); } catch (er) { toast('error', er.message); } draw(); }); }; }
  };
  draw();
}

boot();
})();
