'use strict';
/** Tiny Express-style HTTP toolkit so the app needs zero npm packages. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function parseCookies(h) {
  const o = Object.create(null);
  if (!h) return o;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    if (!(k in o)) o[k] = v;
  }
  return o;
}

function run(fn, err, req, res, next) {
  if (typeof fn.handle === 'function') return err ? next(err) : fn.handle(req, res, next);
  if (err) return fn.length === 4 ? fn(err, req, res, next) : next(err);
  if (fn.length === 4) return next();
  const r = fn(req, res, next);
  if (r && typeof r.then === 'function') r.catch(next);
}

class Router {
  constructor() { this.stack = []; }
  use(...a) {
    let prefix = '/';
    if (typeof a[0] === 'string') prefix = a.shift();
    for (const fn of a.flat()) this.stack.push({ prefix, fn });
    return this;
  }
  _route(method, p, fns) {
    const keys = [];
    const re = new RegExp('^' + esc(p).replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    for (const fn of fns.flat()) this.stack.push({ method, re, keys, fn });
    return this;
  }
  get(p, ...f) { return this._route('GET', p, f); }
  post(p, ...f) { return this._route('POST', p, f); }
  handle(req, res, out) {
    const base = req.path;
    let i = 0;
    const next = (err) => {
      req.path = base;
      if (i >= this.stack.length) return out(err);
      const L = this.stack[i++];
      try {
        if (L.re) {
          if (err || (L.method !== req.method && !(L.method === 'GET' && req.method === 'HEAD'))) return next(err);
          const m = L.re.exec(base);
          if (!m) return next(err);
          req.params = Object.create(null);
          L.keys.forEach((k, j) => { req.params[k] = decodeURIComponent(m[j + 1]); });
          return run(L.fn, null, req, res, next);
        }
        if (L.prefix !== '/') {
          if (!(base === L.prefix || base.startsWith(L.prefix + '/'))) return next(err);
          req.path = base.slice(L.prefix.length) || '/';
        }
        return run(L.fn, err, req, res, next);
      } catch (e) { return next(e); }
    };
    next();
  }
}

class App extends Router {
  listen(port, cb) {
    const server = http.createServer((req, res) => this._serve(req, res));
    server.listen(port, cb);
    return server;
  }
  _serve(req, res) {
    try {
      const u = new URL(req.url, 'http://localhost');
      req.path = u.pathname;
      req.originalUrl = req.url;
      req.query = Object.create(null);
      for (const [k, v] of u.searchParams) req.query[k] = v;
    } catch { res.statusCode = 400; return res.end(); }
    req.cookies = parseCookies(req.headers.cookie);
    req.get = (n) => req.headers[n.toLowerCase()];
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    req.ip = (cfg.trustProxy && fwd.length ? fwd[fwd.length - 1] : req.socket.remoteAddress) || 'unknown';
    req.secure = Boolean(req.socket.encrypted) || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https');
    req.body = {};
    res.status = (c) => { res.statusCode = c; return res; };
    res.set = (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) res.setHeader(a, b); else res.setHeader(k, v); return res; };
    res.json = (o) => { const b = JSON.stringify(o); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Content-Length', Buffer.byteLength(b)); res.end(req.method === 'HEAD' ? undefined : b); };
    res.send = (b) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(req.method === 'HEAD' ? undefined : b); };
    res.redirect = (code, url) => { res.statusCode = code; res.setHeader('Location', url); res.end(); };
    const addCookie = (c) => { const prev = res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', [].concat(prev || [], c)); };
    res.cookie = (name, val, o = {}) => addCookie(`${name}=${encodeURIComponent(val)}; Path=${o.path || '/'}${o.maxAge ? `; Max-Age=${Math.floor(o.maxAge / 1000)}` : ''}${o.httpOnly ? '; HttpOnly' : ''}${o.secure ? '; Secure' : ''}; SameSite=${o.sameSite === 'strict' ? 'Strict' : 'Lax'}`);
    res.clearCookie = (name, o = {}) => addCookie(`${name}=; Path=${o.path || '/'}; Max-Age=0${o.httpOnly ? '; HttpOnly' : ''}${o.secure ? '; Secure' : ''}; SameSite=Strict`);
    this.handle(req, res, (err) => {
      if (res.headersSent) return res.end();
      if (err) { console.error('[unhandled]', err && err.message); res.statusCode = 500; return res.json({ ok: false, message: 'Request could not be processed.' }); }
      res.statusCode = 404; res.json({ ok: false, message: 'Not found.' });
    });
  }
}

function json({ limit = 50 * 1024 } = {}) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    let size = 0, done = false; const chunks = [];
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; res.status(413).json({ ok: false, message: 'Request too large.' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('error', () => { done = true; });
    req.on('end', () => {
      if (done) return;
      done = true;
      const txt = Buffer.concat(chunks).toString('utf8');
      if (txt && String(req.headers['content-type'] || '').includes('application/json')) {
        try { req.body = JSON.parse(txt); } catch { const e = new Error('bad json'); e.type = 'entity.parse.failed'; return next(e); }
        if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) req.body = {};
      }
      next();
    });
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(root, { maxAge = 0 } = {}) {
  const abs = path.resolve(root);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p;
    try { p = decodeURIComponent(req.path); } catch { return next(); }
    if (p.includes('\0')) return next();
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(abs, p);
    if (!f.startsWith(abs + path.sep)) return next();
    fs.stat(f, (e, st) => {
      if (e || !st.isFile()) return next();
      res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream');
      res.setHeader('Content-Length', st.size);
      res.setHeader('Cache-Control', maxAge ? `public, max-age=${maxAge}` : 'no-cache');
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(f).pipe(res);
    });
  };
}

function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.reset < n) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const n = Date.now();
    let h = hits.get(req.ip);
    if (!h || h.reset < n) { h = { c: 0, reset: n + windowMs }; hits.set(req.ip, h); }
    if (++h.c > max) { res.setHeader('Retry-After', Math.ceil((h.reset - n) / 1000)); return res.status(429).json(message); }
    next();
  };
}

module.exports = { App, Router: () => new Router(), json, serveStatic, rateLimit };
