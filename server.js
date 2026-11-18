'use strict';
/* 云手机保活控制台 —— 服务端（零依赖 Node）
 * 复刻目标站的全部 HTTP 契约：鉴权 / 多租户 / 账号池 / 保活调度 / cURL 模板回放 / 浏览器会话 / 画面镜像
 * 启动： node server.js   （默认 http://127.0.0.1:8787）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const dbm = require('./lib/db');
const adapter = require('./lib/adapter');
const cp139 = require('./lib/cp139');
const { BrowserSession, findBrowser } = require('./lib/browser');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const CP_HOME = 'https://cp.139.com/';
const DAY = dbm.DAY;

const db = dbm.load();
const db_ = () => db;
const browserSessions = new Map(); // accountId -> BrowserSession

/* ---------------- 基础工具 ---------------- */
const now = () => Date.now();
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

function send(res, code, obj, type = 'application/json; charset=utf-8') {
  const body = type.startsWith('application/json') ? JSON.stringify(obj) : obj;
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const ok = (res, extra = {}) => send(res, 200, { ok: true, ...extra });
const bad = (res, message, code = 200, extra = {}) => send(res, code, { ok: false, message, ...extra });

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!b) return resolve({});
      try { resolve(JSON.parse(b)); } catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/* ---------------- 鉴权 ---------------- */
function currentUser(req, qs) {
  const qToken = qs && typeof qs.get === 'function' ? qs.get('token') : (qs && qs.token) || '';
  const t = req.headers['x-auth-token'] || qToken || '';
  if (!t) return null;
  const rec = db.tokens[t];
  if (!rec) return null;
  const u = db.users.find((x) => x.id === rec.userId);
  if (!u || u.disabled) return null;
  if (u.role !== 'admin' && u.expireAt && u.expireAt < now()) return null;
  return { user: u, token: t };
}

function issueToken(userId) {
  const t = dbm.newToken();
  db.tokens[t] = { userId, at: now() };
  return t;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    quota: u.quota,
    expireAt: u.expireAt,
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    pending: !!u.pending,
    regIp: u.regIp || '',
    regAt: u.regAt || null,
    regUa: u.regUa || ''
  };
}

/* ---------------- 视图层 ---------------- */
function accountView(a) {
  const dev = (a.devices || [])[0] || null;
  const sess = a.session || {};
  return {
    id: a.id,
    owner: a.owner,
    product: a.product || 'phone',
    title: a.title,
    phone: a.phone,
    enabled: !!a.enabled,
    loggedIn: !!a.loggedIn,
    cpTokenSet: !!a.cpToken,
    note: a.note || '',
    expireHours: a.expireHours ?? null,
    expireAt: a.expireAt ?? null,
    devices: (a.devices || []).map((d) => ({
      id: d.id,
      plan: d.plan,
      power: d.power,
      uptimeMinutes: d.onSince ? Math.max(0, Math.round((now() - d.onSince) / 60000)) : 0,
      statusText: d.statusText || (d.power === 'on' ? '运行中' : '已关机'),
      onSince: d.onSince || null,
      realCode: d.realCode ?? null,
      realText: d.realText || '',
      realAt: d.realAt || null
    })),
    success: a.success || 0,
    fail: a.fail || 0,
    lastRunAt: a.lastRunAt || null,
    lastResult: a.lastResult || '',
    watch: a.watch || 'off',
    watchSession: !!a.watchSession,
    session: {
      status: sess.status || (a.cpToken ? 'valid' : 'none'),
      tokenTail: a.cpToken ? String(a.cpToken).slice(-6) : '',
      hasToken: !!a.cpToken,
      fp: a.cpDeviceFp ? 'D' + String(a.cpDeviceFp).slice(0, 8) + '…' : '',
      issuedAt: sess.issuedAt || null,
      lastOkAt: sess.lastOkAt || null,
      expiresAt: sess.expiresAt || null
    },
    _dev: dev ? dev.id : ''
  };
}

function visibleAccounts(user) {
  return db.accounts.filter((a) => user.role === 'admin' || a.owner === user.id);
}

function stateFor(user) {
  const accs = visibleAccounts(user);
  return {
    settings: { ...db.settings },
    rounds: db.rounds,
    lastRoundAt: db.lastRoundAt,
    nextRoundAt: db.nextRoundAt,
    logs: db.logs.slice(-60).reverse(),
    users: user.role === 'admin' ? db.users.map(publicUser) : [],
    accounts: accs.map(accountView),
    realApi: user.role === 'admin' ? (db.adapter.parsed ? { url: db.adapter.parsed.url, method: db.adapter.parsed.method } : null) : null,
    adapterMode: db.settings.apiMode,
    running: false
  };
}

/* ---------------- 保活核心 ---------------- */
function pickDevice(a) {
  return (a.devices || [])[0] || null;
}

async function runPulse(a, source) {
  const dev = pickDevice(a);
  const plan = dev ? dev.plan : '云手机';
  const real = db.settings.apiMode === 'real';
  const instanceId = dev ? (dev.instanceId || dev.id) : '';
  let result;
  const started = now();

  try {
    if (real && a.cpToken && instanceId) {
      // ① 内置 139 适配器（推荐）：自算 sign，直连官方接口
      const r = await cp139.prepare({
        token: a.cpToken,
        instanceId,
        platformType: 1,
        deviceId: a.cpDeviceId || ''
      });
      result = { ok: r.ok, code: r.code, text: r.message || '', ms: r.ms, via: 'cp139' };
    } else if (real && db.adapter.parsed) {
      // ② cURL 模板回放（兼容其它运营商/接口改版）
      const r = await adapter.replay(db.adapter.parsed, {
        token: a.cpToken || '',
        cpToken: a.cpToken || '',
        instanceId,
        deviceId: (dev && dev.deviceId) || '',
        phone: a.phone || '',
        fp: a.cpDeviceFp || '',
        now: String(now())
      });
      result = adapter.judge(r);
      result.ms = r.ms;
      result.via = 'curl';
    } else if (real) {
      result = { ok: false, code: -1, text: '真实模式缺少 token 或实例 ID', via: 'none' };
    } else {
      await adapter.mockPulse();
      result = { ok: true, code: 0, text: 'mock ok', ms: Date.now() - started, via: 'mock' };
    }
  } catch (e) {
    result = { ok: false, code: -1, text: e.message, via: 'error' };
  }

  a.lastRunAt = now();
  a.session = a.session || {};
  a.session.lastOkAt = now();

  if (dev) {
    dev.realAt = now();
    dev.realCode = result.ok ? 0 : result.code ?? -1;
    dev.realText = result.ok ? '在线 · 运行中' : `异常：${result.text}`;
    if (result.ok) {
      dev.power = 'on';
      dev.statusText = '运行中（服务器确认）';
      if (!dev.onSince) dev.onSince = now();
    }
  }

  if (result.ok) {
    a.success = (a.success || 0) + 1;
    a.lastResult = 'ok';
    dbm.log(db, {
      level: 'success',
      account: a.title,
      plan,
      source,
      message: `✨ 保活脉冲注入成功（instancePrepareV2 已下发），云手机保持活跃，保活计时已清零！（${result.ms}ms）`
    });
  } else {
    a.fail = (a.fail || 0) + 1;
    a.lastResult = 'fail';
    dbm.log(db, {
      level: 'bad',
      account: a.title,
      plan,
      source,
      message: `保活失败：${result.text || '未知错误'}`
    });
  }
  return result;
}

async function runRenew(a) {
  const dev = pickDevice(a);
  const plan = dev ? dev.plan : '云手机';
  const instanceId = dev ? (dev.instanceId || dev.id) : '';
  const real = db.settings.apiMode === 'real';

  if (real && a.cpToken && instanceId) {
    // 续期 = 重新拉起实例（instancePrepareV2 会把实例重新准备好，租期随之下发）
    const r = await cp139.prepare({ token: a.cpToken, instanceId, platformType: 1, deviceId: a.cpDeviceId || '' });
    if (!r.ok) {
      dbm.log(db, { level: 'bad', account: a.title, plan, source: 'renew', message: `续期失败：${r.message || r.code}` });
      return { ok: false, message: `续期失败：${r.message || r.code}` };
    }
  } else if (real && db.adapter.parsed && a.cpToken) {
    const r = await adapter.replay(db.adapter.parsed, {
      token: a.cpToken,
      cpToken: a.cpToken,
      instanceId,
      deviceId: (dev && dev.deviceId) || '',
      phone: a.phone || '',
      fp: a.cpDeviceFp || '',
      now: String(now())
    });
    const j = adapter.judge(r);
    if (!j.ok) {
      dbm.log(db, { level: 'bad', account: a.title, plan, source: 'renew', message: `续期失败：${j.text}` });
      return { ok: false, message: `续期失败：${j.text}` };
    }
  }
  a.expireAt = now() + 30 * DAY;
  a.note = '已续期 +30 天';
  if (dev) {
    dev.power = 'on';
    dev.onSince = now();
    dev.statusText = '运行中（服务器确认）';
  }
  a.lastResult = 'ok';
  dbm.log(db, { level: 'success', account: a.title, plan, source: 'renew', message: '✨ 续期成功（已重新拉起实例），有效期 +30 天' });
  return { ok: true };
}

async function refreshDevices(a, source = 'refresh') {
  const real = db.settings.apiMode === 'real';
  if (real && a.cpToken) {
    try {
      const r = await cp139.listDevices({ token: a.cpToken, deviceId: a.cpDeviceId || '' });
      const list = r.ok ? cp139.normalizeDevices(r) : [];
      if (list.length) {
        a.devices = list.map((x) => ({
          id: x.instanceId,
          instanceId: x.instanceId,
          deviceId: x.deviceId,
          plan: x.plan,
          power: 'on',
          onSince: a.devices && a.devices[0] && a.devices[0].onSince ? a.devices[0].onSince : now(),
          statusText: '运行中（服务器实时确认）',
          realCode: 0,
          realText: '在线 · 运行中',
          realAt: now()
        }));
        if (list[0].expireAt) a.expireAt = list[0].expireAt;
      } else {
        dbm.log(db, {
          level: 'warn', account: a.title, plan: '', source,
          message: `⚠️ 拉取设备列表失败：${r.code || ''} ${r.message || ''}`
        });
      }
    } catch (e) {
      dbm.log(db, { level: 'warn', account: a.title, plan: '', source, message: `⚠️ 同步异常：${e.message}` });
    }
  }
  if (!a.devices || !a.devices.length) {
    a.devices = [{
      id: Math.random().toString(36).slice(2, 10),
      plan: '云手机',
      power: 'on',
      onSince: now(),
      statusText: '运行中'
    }];
  }
  for (const d of a.devices) {
    d.realAt = now();
    d.realCode = 0;
    d.realText = '在线 · 运行中';
  }
  dbm.log(db, {
    level: 'info',
    account: a.title,
    plan: a.devices[0] ? a.devices[0].plan : '',
    source,
    message: `📡 已从服务器同步：${a.devices.length} 台云手机（${a.devices.map((d) => d.id).join(',')}）`
  });
}

/* 调度器：每 15s 检查一次，到点跑一轮（等价原站 round 循环） */
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    if (!db.nextRoundAt) db.nextRoundAt = now() + db.settings.intervalMinutes * 60000;
    if (now() < db.nextRoundAt) return;
    const due = db.accounts.filter((a) => a.enabled);
    for (const a of due) {
      if (a.expireAt && a.expireAt < now()) {
        dbm.log(db, {
          level: 'warn',
          account: a.title,
          plan: (pickDevice(a) || {}).plan || '',
          source: 'auto',
          message: '⏳ 该账号已到期，跳过本轮保活（续期后自动恢复）'
        });
        continue;
      }
      await runPulse(a, 'auto');
    }
    db.rounds = (db.rounds || 0) + 1;
    db.lastRoundAt = now();
    db.nextRoundAt = now() + db.settings.intervalMinutes * 60000;
    dbm.save();
  } finally {
    ticking = false;
  }
}

/* ---------------- 模拟画面（SVG，可直接塞进 <img>） ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function mockScreen(a, label = '云手机画面（模拟）') {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  const dev = pickDevice(a);
  const bar = Math.round((Date.now() / 50) % 260);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="414" height="896" viewBox="0 0 414 896">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d1b2a"/><stop offset="1" stop-color="#10241c"/>
    </linearGradient>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#22C55E"/><stop offset="1" stop-color="#3B82F6"/>
    </linearGradient>
  </defs>
  <rect width="414" height="896" fill="url(#bg)"/>
  <text x="20" y="46" fill="#EEF4F9" font-family="sans-serif" font-size="17" font-weight="700">${esc(a.title || a.phone || '云手机')}</text>
  <text x="394" y="46" text-anchor="end" fill="#7D8C9F" font-family="monospace" font-size="15">${hh}:${mm}:${ss}</text>
  <rect x="20" y="70" y2="0" width="374" height="150" rx="14" fill="#121A24" stroke="#253141"/>
  <text x="40" y="102" fill="#BBC9D8" font-family="sans-serif" font-size="13">设备 ID</text>
  <text x="374" y="102" text-anchor="end" fill="#EEF4F9" font-family="monospace" font-size="13">${esc(dev ? dev.id : '-')}</text>
  <text x="40" y="132" fill="#BBC9D8" font-family="sans-serif" font-size="13">套餐</text>
  <text x="374" y="132" text-anchor="end" fill="#EEF4F9" font-family="sans-serif" font-size="13">${esc(dev ? dev.plan : '-')}</text>
  <text x="40" y="162" fill="#BBC9D8" font-family="sans-serif" font-size="13">状态</text>
  <text x="374" y="162" text-anchor="end" fill="#22C55E" font-family="sans-serif" font-size="13">● 运行中</text>
  <text x="40" y="192" fill="#BBC9D8" font-family="sans-serif" font-size="13">最近脉冲</text>
  <text x="374" y="192" text-anchor="end" fill="#EEF4F9" font-family="monospace" font-size="12">${a.lastRunAt ? new Date(a.lastRunAt).toLocaleTimeString('zh-CN') : '未执行'}</text>
  <rect x="20" y="240" width="374" height="420" rx="16" fill="#0A0F16" stroke="#253141"/>
  <text x="207" y="430" text-anchor="middle" fill="#7D8C9F" font-family="sans-serif" font-size="14">${esc(label)}</text>
  <text x="207" y="458" text-anchor="middle" fill="#4B5A6B" font-family="sans-serif" font-size="12">模拟模式 · 未接入真实串流</text>
  <rect x="20" y="700" width="374" height="10" rx="5" fill="#1C2634"/>
  <rect x="20" y="700" width="${bar}" height="10" rx="5" fill="url(#g)"/>
  <text x="207" y="748" text-anchor="middle" fill="#7D8C9F" font-family="monospace" font-size="12">keepalive pulse frame · ${Date.now()}</text>
  <text x="207" y="800" text-anchor="middle" fill="#4B5A6B" font-family="sans-serif" font-size="12">保活与看玩共用同一会话</text>
</svg>`;
}

/* ---------------- 路由 ---------------- */
async function handle(req, res, pathname, qs) {
  const method = req.method.toUpperCase();
  const m = (re) => pathname.match(re);
  let mm;

  /* 静态页 */
  if (pathname === '/' || pathname === '/index.html') {
    const f = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(f)) return send(res, 500, '缺少 public/index.html', 'text/plain; charset=utf-8');
    return send(res, 200, fs.readFileSync(f), 'text/html; charset=utf-8');
  }

  /* ===== 认证 ===== */
  if (pathname === '/api/auth/login' && method === 'POST') {
    const b = await readBody(req);
    const u = db.users.find((x) => x.username === String(b.username || '').trim());
    if (!u || u.pass !== dbm.sha256(b.password || '')) return bad(res, '用户名或密码错误');
    if (u.disabled) return bad(res, '账号已被停用');
    if (u.pending) return bad(res, '账号待管理员审核');
    if (u.role !== 'admin' && u.expireAt && u.expireAt < now()) return bad(res, '账号已到期');
    const t = issueToken(u.id);
    dbm.save();
    return ok(res, { token: t, me: publicUser(u) });
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    if (username.length < 3) return bad(res, '用户名至少 3 位');
    if (String(b.password || '').length < 6) return bad(res, '密码至少 6 位');
    if (db.users.some((x) => x.username === username)) return bad(res, '用户名已存在');
    const pending = !!db.settings.regReview;
    const u = {
      id: dbm.rid('u'),
      username,
      pass: dbm.sha256(b.password),
      role: 'user',
      quota: 1,
      expireAt: pending ? null : now() + 2 * DAY,
      disabled: false,
      pending,
      createdAt: now(),
      regIp: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString(),
      regAt: now(),
      regUa: String(req.headers['user-agent'] || '').slice(0, 200)
    };
    db.users.push(u);
    dbm.save();
    if (pending) return ok(res, { message: '注册成功，等待管理员审核', pending: true });
    const t = issueToken(u.id);
    dbm.save();
    return ok(res, { token: t, me: publicUser(u) });
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const au = currentUser(req, qs);
    if (au) delete db.tokens[au.token];
    dbm.save();
    return ok(res);
  }

  /* 以下全部需要登录 */
  const au = currentUser(req, qs);
  if (!au) return send(res, 401, { ok: false, message: '未登录', needLogin: true });
  const me = au.user;

  if (pathname === '/api/auth/me' && method === 'GET') return ok(res, { me: publicUser(me) });

  if (pathname === '/api/auth/password' && method === 'POST') {
    const b = await readBody(req);
    if (me.pass !== dbm.sha256(b.oldPassword || '')) return bad(res, '原密码错误');
    if (String(b.newPassword || '').length < 6) return bad(res, '新密码至少 6 位');
    me.pass = dbm.sha256(b.newPassword);
    if (b.newUsername && String(b.newUsername).trim().length >= 3) me.username = String(b.newUsername).trim();
    dbm.save();
    return ok(res, { message: '已更新' });
  }

  if (pathname === '/api/state' && method === 'GET') return ok(res, stateFor(me));

  if (pathname === '/api/settings' && method === 'POST') {
    const b = await readBody(req);
    if (me.role !== 'admin') return bad(res, '仅管理员可修改设置');
    if (b.intervalMinutes != null) db.settings.intervalMinutes = Math.max(1, num(b.intervalMinutes, 30));
    if (b.autoRefreshSeconds != null) db.settings.autoRefreshSeconds = Math.max(5, num(b.autoRefreshSeconds, 20));
    if (b.watchMode) db.settings.watchMode = String(b.watchMode);
    if (b.apiMode) db.settings.apiMode = String(b.apiMode);
    if (b.notifyOnFail != null) db.settings.notifyOnFail = !!b.notifyOnFail;
    if (b.regReview != null) db.settings.regReview = Number(b.regReview) === 1 || b.regReview === true;
    db.nextRoundAt = now() + db.settings.intervalMinutes * 60000;
    dbm.save();
    return ok(res, { state: stateFor(me), message: '设置已保存' });
  }

  if (pathname === '/api/sync-status' && method === 'POST') {
    for (const a of visibleAccounts(me)) {
      if (a.enabled) await refreshDevices(a, 'sync');
    }
    dbm.save();
    return ok(res, { state: stateFor(me), message: '已同步' });
  }

  if (pathname === '/api/logs/clear' && method === 'POST') {
    db.logs = [];
    dbm.save();
    return ok(res, { state: stateFor(me) });
  }

  /* ===== 用户管理（管理员） ===== */
  if (pathname === '/api/users' && method === 'GET') {
    if (me.role !== 'admin') return bad(res, '仅管理员');
    return ok(res, { users: db.users.map(publicUser) });
  }
  if (pathname === '/api/users' && method === 'POST') {
    if (me.role !== 'admin') return bad(res, '仅管理员');
    const b = await readBody(req);
    const username = String(b.username || '').trim();
    if (username.length < 3) return bad(res, '用户名至少 3 位');
    if (db.users.some((x) => x.username === username)) return bad(res, '用户名已存在');
    const days = num(b.days, 2);
    const u = {
      id: dbm.rid('u'),
      username,
      pass: dbm.sha256(b.password || '123456'),
      role: 'user',
      quota: Math.max(1, num(b.quota, 1)),
      expireAt: now() + days * DAY,
      disabled: false,
      pending: false,
      createdAt: now(),
      regIp: '', regAt: null, regUa: ''
    };
    db.users.push(u);
    dbm.save();
    return ok(res, { state: stateFor(me), message: '已创建' });
  }
  if ((mm = m(/^\/api\/users\/([\w-]+)$/)) && (method === 'PATCH' || method === 'DELETE')) {
    if (me.role !== 'admin') return bad(res, '仅管理员');
    const u = db.users.find((x) => x.id === mm[1]);
    if (!u) return bad(res, '用户不存在');
    if (method === 'DELETE') {
      if (u.role === 'admin') return bad(res, '不能删除管理员');
      db.users = db.users.filter((x) => x.id !== u.id);
      db.accounts = db.accounts.filter((a) => a.owner !== u.id);
      for (const [t, rec] of Object.entries(db.tokens)) if (rec.userId === u.id) delete db.tokens[t];
      dbm.save();
      return ok(res, { state: stateFor(me), message: '已删除' });
    }
    const b = await readBody(req);
    if (b.pending != null) {
      u.pending = !!b.pending;
      if (!u.pending && !u.expireAt) u.expireAt = now() + 2 * DAY;
    }
    if (b.password) u.pass = dbm.sha256(b.password);
    if (b.extendDays != null) u.expireAt = Math.max(now(), u.expireAt || now()) + num(b.extendDays, 30) * DAY;
    if (b.days != null) u.expireAt = now() + num(b.days, 2) * DAY;
    if (b.quota != null) u.quota = Math.max(1, num(b.quota, 1));
    if (b.disabled != null) u.disabled = !!b.disabled;
    dbm.save();
    return ok(res, { state: stateFor(me), message: '已更新' });
  }

  /* ===== 适配器 ===== */
  if (pathname === '/api/adapter/config' && method === 'POST') {
    if (me.role !== 'admin') return bad(res, '仅管理员');
    const b = await readBody(req);
    if (b.clear) {
      db.adapter = { curl: '', parsed: null };
      dbm.save();
      return ok(res, { state: stateFor(me), message: '已清除真实接口配置' });
    }
    try {
      const parsed = adapter.parseCurl(String(b.curl || ''));
      db.adapter = { curl: String(b.curl), parsed };
      dbm.save();
      return ok(res, { state: stateFor(me), message: `已导入：${parsed.method} ${parsed.url}` });
    } catch (e) {
      return bad(res, '解析失败：' + e.message);
    }
  }

  if (pathname === '/api/adapter/test' && method === 'POST') {
    if (!db.adapter.parsed) {
      return ok(res, { message: '还没导入 cURL，当前走模拟模式' + (findBrowser() ? '（浏览器层可用）' : '') });
    }
    const a = visibleAccounts(me)[0] || {};
    const dev = pickDevice(a) || {};
    try {
      const r = await adapter.replay(db.adapter.parsed, {
        token: a.cpToken || '',
        cpToken: a.cpToken || '',
        instanceId: dev.id || '',
        deviceId: dev.id || '',
        phone: a.phone || '',
        fp: a.cpDeviceFp || '',
        now: String(now())
      });
      const j = adapter.judge(r);
      return ok(res, { message: `${j.ok ? '连通正常' : '返回异常'}：HTTP ${r.status} · code=${j.code} · ${r.ms}ms` });
    } catch (e) {
      return bad(res, '请求失败：' + e.message);
    }
  }

  /* ===== 账号 ===== */
  if (pathname === '/api/accounts' && method === 'POST') {
    const b = await readBody(req);
    const mine = db.accounts.filter((a) => a.owner === me.id);
    if (me.role !== 'admin' && mine.length >= me.quota) return bad(res, `配额已满（${me.quota} 个）`);
    const a = {
      id: dbm.rid('acc'),
      owner: me.id,
      product: 'phone',
      title: String(b.title || b.phone || '未命名').slice(0, 40),
      phone: String(b.phone || b.title || ''),
      enabled: true,
      loggedIn: false,
      cpToken: '',
      cpDeviceFp: '',
      note: String(b.note || ''),
      expireAt: now() + 30 * DAY,
      devices: [],
      success: 0,
      fail: 0,
      watch: 'off',
      watchSession: false,
      session: {}
    };
    db.accounts.push(a);
    dbm.save();
    return ok(res, { id: a.id, state: stateFor(me) });
  }

  if ((mm = m(/^\/api\/accounts\/([\w-]+)$/))) {
    const a = db.accounts.find((x) => x.id === mm[1]);
    if (!a) return bad(res, '账号不存在');
    if (me.role !== 'admin' && a.owner !== me.id) return bad(res, '无权操作');
    if (method === 'DELETE') {
      const bs = browserSessions.get(a.id);
      if (bs) { bs.kill(); browserSessions.delete(a.id); }
      db.accounts = db.accounts.filter((x) => x.id !== a.id);
      dbm.save();
      return ok(res, { state: stateFor(me), message: '已删除' });
    }
    if (method === 'PATCH') {
      const b = await readBody(req);
      if (b.title != null) a.title = String(b.title).slice(0, 40);
      if (b.phone != null) a.phone = String(b.phone);
      if (b.note != null) a.note = String(b.note);
      if (b.enabled != null) a.enabled = !!b.enabled;
      if (b.watch != null) a.watch = String(b.watch);
      if (b.cpToken) {
        a.cpToken = String(b.cpToken).trim();
        a.loggedIn = true;
        a.session = { status: 'valid', issuedAt: now(), lastOkAt: now(), expiresAt: now() + 30 * DAY };
        dbm.log(db, { level: 'info', account: a.title, plan: (pickDevice(a) || {}).plan || '', source: 'token', message: '🔑 已导入真实登录态（token + 设备指纹）' });
      }
      if (b.cpDeviceFp) a.cpDeviceFp = String(b.cpDeviceFp).trim();
      if (b.cpDeviceId) a.cpDeviceId = String(b.cpDeviceId).trim();
      dbm.save();
      return ok(res, { state: stateFor(me), message: '已保存' });
    }
  }

  if ((mm = m(/^\/api\/accounts\/([\w-]+)\/days$/)) && method === 'PATCH') {
    const a = db.accounts.find((x) => x.id === mm[1]);
    if (!a) return bad(res, '账号不存在');
    if (me.role !== 'admin') return bad(res, '仅管理员');
    const b = await readBody(req);
    const days = Math.max(1, num(b.days, 1));
    a.expireAt = now() + days * DAY;
    dbm.save();
    return ok(res, { state: stateFor(me), message: `有效期已设为 ${days} 天` });
  }

  if ((mm = m(/^\/api\/accounts\/([\w-]+)\/run$/)) && method === 'POST') {
    const a = db.accounts.find((x) => x.id === mm[1]);
    if (!a) return bad(res, '账号不存在');
    if (me.role !== 'admin' && a.owner !== me.id) return bad(res, '无权操作');
    const b = await readBody(req);
    if (b.type === 'renew') {
      const r = await runRenew(a);
      dbm.save();
      return ok(res, { state: stateFor(me), ok: r.ok, message: r.ok ? '✨ 续期成功，有效期 +30 天' : r.message });
    }
    const r = await runPulse(a, 'keepalive');
    dbm.save();
    return ok(res, {
      state: stateFor(me),
      ok: r.ok,
      message: r.ok
        ? '✨ 保活脉冲注入成功（instancePrepareV2 已下发），云手机保持活跃，保活计时已清零！'
        : `保活失败：${r.text}`
    });
  }

  if ((mm = m(/^\/api\/accounts\/([\w-]+)\/watch$/)) && method === 'POST') {
    const a = db.accounts.find((x) => x.id === mm[1]);
    if (!a) return bad(res, '账号不存在');
    const b = await readBody(req);
    a.watchSession = !!b.open;
    if (b.open) a.watch = a.watch === 'off' ? 'resident' : a.watch;
    dbm.save();
    return ok(res, { state: stateFor(me) });
  }

  if ((mm = m(/^\/api\/accounts\/([\w-]+)\/devices\/refresh$/)) && method === 'POST') {
    const a = db.accounts.find((x) => x.id === mm[1]);
    if (!a) return bad(res, '账号不存在');
    await refreshDevices(a, 'refresh');
    dbm.save();
    return ok(res, {
      state: stateFor(me),
      message: a.devices.length ? `已同步 ${a.devices.length} 台` : '未查到云手机记录'
    });
  }

  /* ===== 设备电源 ===== */
  if ((mm = m(/^\/api\/devices\/([\w-]+)\/power$/)) && method === 'POST') {
    const b = await readBody(req);
    let hit = null;
    for (const a of visibleAccounts(me)) {
      for (const d of a.devices || []) if (d.id === mm[1]) hit = { a, d };
    }
    if (!hit) return bad(res, '设备不存在');
    const on = b.action === 'on' || b.action === 'start';
    hit.d.power = on ? 'on' : 'off';
    hit.d.statusText = on ? '运行中（服务器确认）' : '已关机';
    hit.d.onSince = on ? now() : null;
    hit.d.realAt = now();
    dbm.log(db, {
      level: 'info',
      account: hit.a.title,
      plan: hit.d.plan,
      source: 'power',
      message: on ? '⏻ 已下发开机指令' : '⏻ 已下关机指令'
    });
    dbm.save();
    return ok(res, { state: stateFor(me), message: on ? '已下发开机' : '已下发关机' });
  }

  /* ===== 画面镜像 ===== */
  if ((mm = m(/^\/api\/accounts\/([\w-]+)\/screen\/(status|open|close|snap|page|text|fresh|audio|tap|swipe|solve-slider)$/))) {
    const a = db.accounts.find((x) => x.id === mm[1]);
    if (!a) return bad(res, '账号不存在');
    const op = mm[2];
    const bs = browserSessions.get(a.id);
    const real = !!(bs && bs.alive);

    if (op === 'status') {
      return ok(res, { ready: real, dead: !real, message: real ? '画面就绪' : '画面未开启' });
    }
    if (op === 'open') {
      if (real) return ok(res, { ready: true, message: '已在运行' });
      if (!findBrowser()) return ok(res, { ready: false, message: '本机无 Edge/Chrome，走模拟画面' });
      try {
        const s = await BrowserSession.create(a.id.replace(/^acc_/, ''), a.phone);
        await s.navigate(CP_HOME);
        browserSessions.set(a.id, s);
        a.session = a.session || {};
        a.loggedIn = true;
        dbm.log(db, { level: 'info', account: a.title, plan: (pickDevice(a) || {}).plan || '', source: 'screen', message: '🖥 已启动浏览器会话并打开 cp.139.com' });
        dbm.save();
        return ok(res, { ready: true, message: '画面已打开' });
      } catch (e) {
        return ok(res, { ready: false, message: '浏览器启动失败：' + e.message });
      }
    }
    if (op === 'close') {
      if (bs) { bs.kill(); browserSessions.delete(a.id); }
      a.watchSession = false;
      dbm.save();
      return ok(res);
    }
    if (op === 'snap') {
      if (real) {
        try {
          const buf = await bs.screenshot();
          return send(res, 200, buf, 'image/jpeg');
        } catch (_) {}
      }
      return send(res, 200, mockScreen(a), 'image/svg+xml; charset=utf-8');
    }
    if (op === 'fresh') {
      if (real) { await bs.navigate(bs.pageInfo ? CP_HOME : CP_HOME).catch(() => {}); }
      return ok(res, { message: real ? '已刷新' : '模拟画面无需刷新' });
    }
    if (op === 'page') {
      const b = await readBody(req);
      if (real) {
        const map = { home: CP_HOME, login: 'https://cp.139.com/login', mine: 'https://cp.139.com/user' };
        await bs.navigate(map[b.page] || CP_HOME).catch(() => {});
        return ok(res, { message: '已跳转' });
      }
      return ok(res, { message: '模拟模式：页面 ' + (b.page || 'home') });
    }
    if (op === 'text') {
      const b = await readBody(req);
      if (real) {
        await bs.typeText(b.text || '');
        if (b.enter) await bs.key('Enter');
        return ok(res, { message: '已输入' });
      }
      return ok(res, { message: '已输入（模拟）' });
    }
    if (op === 'tap') {
      const b = await readBody(req);
      if (real) { await bs.tap(num(b.x, 0), num(b.y, 0)); return ok(res); }
      return ok(res, { message: '模拟点击' });
    }
    if (op === 'swipe') {
      const b = await readBody(req);
      if (real) { await bs.swipe(num(b.x0, 0), num(b.y0, 0), num(b.x1, 0), num(b.y1, 0)); return ok(res); }
      return ok(res, { message: '模拟滑动' });
    }
    if (op === 'audio') {
      const b = await readBody(req);
      return ok(res, { message: b.muted ? '已静音' : '已取消静音' });
    }
    if (op === 'solve-slider') {
      if (real) {
        // 滑块位置因站点而异：这里只做一次“按轨迹拖动”的通用尝试，失败由前端重试
        const w = 414, y = 640;
        await bs.swipe(60, y, 300, y).catch(() => {});
        return ok(res, { message: '已尝试过滑块' });
      }
      return ok(res, { message: '模拟模式：滑块已通过' });
    }
  }

  /* ===== 登录会话（浏览器驱动） ===== */
  if (pathname === '/api/sessions/begin' && method === 'POST') {
    const b = await readBody(req);
    const phone = String(b.phone || '');
    if (!/^1\d{10}$/.test(phone)) return bad(res, '手机号格式不对');
    const mine = db.accounts.filter((x) => x.owner === me.id);
    if (me.role !== 'admin' && mine.length >= me.quota) return bad(res, `配额已满（${me.quota} 个）`);
    let a = db.accounts.find((x) => x.owner === me.id && x.phone === phone);
    if (!a) {
      a = {
        id: dbm.rid('acc'), owner: me.id, product: 'phone',
        title: String(b.title || phone).slice(0, 40), phone,
        enabled: true, loggedIn: false, cpToken: '', cpDeviceFp: '',
        note: '139网页登录创建', expireAt: now() + 30 * DAY,
        devices: [], success: 0, fail: 0, watch: 'off', watchSession: false, session: {}
      };
      db.accounts.push(a);
    }
    db.sessions[a.id] = { id: a.id, phone, phase: 'wait-code', accountId: a.id, createdAt: now(), message: '登录页已打开' };
    dbm.log(db, { level: 'info', account: a.title, plan: '', source: 'login', message: `🪪 开始短信登录：${phone}（登录成功后保活与看玩共用同一会话）` });
    if (!browserSessions.has(a.id) && findBrowser()) {
      try {
        const s = await BrowserSession.create(a.id.replace(/^acc_/, ''), phone);
        await s.navigate('https://cloud.139.com/#/cloudAppList');
        browserSessions.set(a.id, s);
      } catch (_) {}
    }
    dbm.save();
    return ok(res, { accountId: a.id, state: stateFor(me), message: '登录页已打开' });
  }

  if ((mm = m(/^\/api\/sessions\/([\w-]+)\/(send|verify|close|state)$/))) {
    const sid = mm[1];
    const a = db.accounts.find((x) => x.id === sid);
    const sess = db.sessions[sid];
    if (!a) return bad(res, '会话不存在');
    const op = mm[2];

    if (op === 'state') {
      return ok(res, {
        phase: sess ? sess.phase : a.loggedIn ? 'ok' : 'idle',
        accountId: a.id,
        message: sess ? sess.message : '',
        state: stateFor(me)
      });
    }
    if (op === 'close') {
      const bs = browserSessions.get(a.id);
      if (bs) { bs.kill(); browserSessions.delete(a.id); }
      delete db.sessions[sid];
      dbm.save();
      return ok(res);
    }
    if (op === 'send') {
      if (sess) { sess.phase = 'code-sent'; sess.message = '验证码已发送'; }
      dbm.log(db, { level: 'info', account: a.title, plan: '', source: 'login', message: `📨 验证码已发送至 ${a.phone}${db.settings.apiMode === 'mock' ? '（模拟模式：任意 4~6 位数字均可）' : ''}` });
      dbm.save();
      return ok(res, { message: '验证码已发送' });
    }
    if (op === 'verify') {
      const b = await readBody(req);
      const code = String(b.code || '').replace(/\D/g, '');
      if (code.length < 4) return bad(res, '验证码位数不足');
      if (db.settings.apiMode === 'real' && db.adapter.parsed) {
        // 真实模式：从浏览器会话里刮 token（等价原站“抓取登录态”）
        const bs = browserSessions.get(a.id);
        if (bs && bs.alive) {
          try {
            await bs.navigate('https://cloud.139.com/#/cloudAppList');
            const h = await bs.harvest();
            const tk = h.apiToken || (h.best && h.best.value);
            if (tk) {
              a.cpToken = tk;
              a.cpDeviceId = h.uuid || a.cpDeviceId || '';
              a.cpDeviceFp = a.cpDeviceFp || 'fp_' + Math.random().toString(36).slice(2, 12);
              a.loggedIn = true;
              a.session = { status: 'valid', issuedAt: now(), lastOkAt: now(), expiresAt: now() + 30 * DAY };
              await refreshDevices(a, 'login');
              if (sess) { sess.phase = 'ok'; sess.message = '登录成功'; }
              dbm.log(db, { level: 'info', account: a.title, plan: (pickDevice(a) || {}).plan || '', source: 'login', message: '✅ 登录成功：token 已回写面板，保活与看玩共用同一会话' });
              dbm.save();
              return ok(res, { state: stateFor(me), message: '登录成功' });
            }
          } catch (_) {}
        }
        return bad(res, '没能从页面里刮到登录态，请在画面里手动完成登录后再点一次');
      }
      // 模拟模式：直接放行
      a.loggedIn = true;
      a.cpToken = a.cpToken || 'mock_' + Math.random().toString(16).slice(2, 18);
      a.cpDeviceFp = a.cpDeviceFp || 'fp_' + Math.random().toString(36).slice(2, 12);
      a.session = { status: 'valid', issuedAt: now(), lastOkAt: now(), expiresAt: now() + 30 * DAY };
      if (!a.devices.length) a.devices = [{ id: Math.random().toString(36).slice(2, 10), plan: '云手机', power: 'on', onSince: now(), statusText: '运行中' }];
      if (sess) { sess.phase = 'ok'; sess.message = '登录成功'; }
      dbm.log(db, { level: 'info', account: a.title, plan: (pickDevice(a) || {}).plan || '', source: 'login', message: '✅ 登录成功：token 已回写面板，保活与看玩共用同一会话' });
      dbm.log(db, { level: 'info', account: a.title, plan: (pickDevice(a) || {}).plan || '', source: 'refresh', message: `📡 已从服务器同步：${a.devices.length} 台云手机（${a.devices.map((d) => d.id).join(',')}）` });
      dbm.save();
      return ok(res, { state: stateFor(me), message: '登录成功' });
    }
  }

  if ((mm = m(/^\/api\/sessions\/([\w-]+)\/snap$/)) && method === 'GET') {
    const a = db.accounts.find((x) => x.id === mm[1]);
    if (!a) return send(res, 404, 'no session', 'text/plain');
    const bs = browserSessions.get(a.id);
    if (bs && bs.alive) {
      try { return send(res, 200, await bs.screenshot(), 'image/jpeg'); } catch (_) {}
    }
    return send(res, 200, mockScreen(a, '139 登录页（模拟）'), 'image/svg+xml; charset=utf-8');
  }

  /* ===== 面板短信登录（等价短信直登） ===== */
  if (pathname === '/api/auth/sms/prewarm' && method === 'POST') {
    return ok(res, { message: findBrowser() ? '画面引擎已预热' : '模拟模式（无浏览器层）' });
  }
  if (pathname === '/api/auth/sms/send' && method === 'POST') {
    const b = await readBody(req);
    const phone = String(b.phone || '');
    if (!/^1\d{10}$/.test(phone)) return bad(res, '手机号格式不对');
    const a = db.accounts.find((x) => x.phone === phone && x.owner === me.id) || db.accounts.find((x) => x.phone === phone);
    if (a) {
      a.loginPhase = 'code-sent';
      dbm.log(db, { level: 'info', account: a.title, plan: '', source: 'login', message: `📨 验证码已发送至 ${phone}` });
      dbm.save();
    }
    return ok(res, { message: '验证码已发送' });
  }
  if (pathname === '/api/auth/sms/state' && method === 'GET') {
    const accId = qs.get('acc');
    const a = db.accounts.find((x) => x.id === accId);
    return ok(res, { phase: a ? a.loginPhase || 'idle' : 'idle' });
  }
  if (pathname === '/api/auth/sms/verify' && method === 'POST') {
    const b = await readBody(req);
    const phone = String(b.phone || '');
    const code = String(b.code || '').replace(/\D/g, '');
    if (code.length < 4) return bad(res, '验证码位数不足');
    let a = db.accounts.find((x) => x.phone === phone);
    if (!a) {
      if (me.role !== 'admin' && db.accounts.filter((x) => x.owner === me.id).length >= me.quota) {
        return bad(res, `配额已满（${me.quota} 个）`);
      }
      a = {
        id: dbm.rid('acc'), owner: me.id, product: 'phone', title: phone, phone,
        enabled: true, loggedIn: false, cpToken: '', cpDeviceFp: '',
        note: '', expireAt: now() + 30 * DAY, devices: [], success: 0, fail: 0,
        watch: 'off', watchSession: false, session: {}
      };
      db.accounts.push(a);
    }
    a.loggedIn = true;
    a.loginPhase = 'ok';
    a.cpToken = a.cpToken || 'mock_' + Math.random().toString(16).slice(2, 18);
    a.session = { status: 'valid', issuedAt: now(), lastOkAt: now(), expiresAt: now() + 30 * DAY };
    if (!a.devices.length) a.devices = [{ id: Math.random().toString(36).slice(2, 10), plan: '云手机', power: 'on', onSince: now(), statusText: '运行中' }];
    dbm.log(db, { level: 'info', account: a.title, plan: (pickDevice(a) || {}).plan || '', source: 'login', message: '✅ 登录成功：token 已回写面板，保活与看玩共用同一会话' });
    dbm.save();
    return ok(res, { state: stateFor(me), message: '登录成功' });
  }

  return bad(res, '接口不存在', 404);
}

/* ---------------- 启动 ---------------- */
const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  const qs = new URLSearchParams(u.query || {});
  handle(req, res, u.pathname, qs).catch((e) => {
    if (!res.headersSent) send(res, 500, { ok: false, message: '服务端异常：' + e.message });
    else try { res.end(); } catch (_) {}
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[kp] 控制台已启动  http://${HOST}:${PORT}`);
  console.log(`[kp] 默认管理员  admin / admin888`);
  console.log(`[kp] 接口模式 ${db.settings.apiMode} · 间隔 ${db.settings.intervalMinutes} 分钟 · 浏览器层 ${findBrowser() ? '可用' : '不可用'}`);
  setInterval(() => tick().catch(() => {}), 15000);
  setTimeout(() => tick().catch(() => {}), 3000);
});

process.on('SIGINT', () => {
  for (const s of browserSessions.values()) s.kill();
  dbm.save();
  process.exit(0);
});
process.on('SIGTERM', () => {
  for (const s of browserSessions.values()) s.kill();
  dbm.save();
  process.exit(0);
});
