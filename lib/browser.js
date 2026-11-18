'use strict';
/* 浏览器层：CDP 驱动本机 Edge(Chromium) 无头实例，复刻原站“服务端跑 139 网页登录页”的做法。
 * 零依赖：Node 22 内置 WebSocket + fetch，不装 puppeteer/playwright。 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

function freePort(start = 9411) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.id && this.waiting.has(msg.id)) {
        const { resolve, reject } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || 'CDP error')) : resolve(msg.result);
        return;
      }
      if (msg.method && this.handlers.has(msg.method)) {
        for (const cb of this.handlers.get(msg.method)) {
          try { cb(msg.params); } catch (_) {}
        }
      }
    });
  }
  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.waiting.delete(id);
        reject(e);
      }
      setTimeout(() => {
        if (this.waiting.has(id)) {
          this.waiting.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 30000);
    });
  }
}

class BrowserSession {
  constructor(sid, phone) {
    this.sid = sid;
    this.phone = phone;
    this.proc = null;
    this.cdp = null;
    this.port = 0;
    this.userDir = path.join(os.tmpdir(), 'kp-browser-' + sid);
    this.alive = false;
  }

  static async create(sid, phone) {
    const bin = findBrowser();
    if (!bin) throw new Error('本机没找到 Edge/Chrome，无法启动浏览器层');
    const s = new BrowserSession(sid, phone);
    s.port = await freePort(9411 + (Math.floor(Math.random() * 60)));
    fs.mkdirSync(s.userDir, { recursive: true });
    s.proc = spawn(bin, [
      '--headless=new',
      `--remote-debugging-port=${s.port}`,
      `--user-data-dir=${s.userDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
      '--window-size=414,896',
      '--lang=zh-CN',
      'about:blank'
    ], { stdio: 'ignore', windowsHide: true });

    // 等 DevTools 端口就绪
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      await sleep(300);
      try {
        const list = await (await fetch(`http://127.0.0.1:${s.port}/json/list`)).json();
        target = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch (_) {}
    }
    if (!target) {
      s.kill();
      throw new Error('浏览器 DevTools 未就绪（端口 ' + s.port + '）');
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
      setTimeout(() => reject(new Error('CDP 连接超时')), 10000);
    });
    s.cdp = new Cdp(ws);
    s.alive = true;
    await s.cdp.send('Page.enable').catch(() => {});
    await s.cdp.send('Runtime.enable').catch(() => {});
    await s.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 414, height: 896, deviceScaleFactor: 2, mobile: true
    }).catch(() => {});
    return s;
  }

  async navigate(url) {
    await this.cdp.send('Page.navigate', { url });
    await sleep(1200);
    return this.pageInfo();
  }

  async pageInfo() {
    try {
      const r = await this.cdp.send('Runtime.evaluate', {
        expression: 'JSON.stringify({url:location.href,title:document.title,ready:document.readyState})',
        returnByValue: true
      });
      return JSON.parse(r.result.value || '{}');
    } catch (_) {
      return { url: '', title: '', ready: 'unknown' };
    }
  }

  async screenshot() {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 72, fromSurface: true });
    return Buffer.from(r.data, 'base64');
  }

  async tap(x, y) {
    const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await sleep(40);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async swipe(x0, y0, x1, y1, steps = 12) {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(x0 + (x1 - x0) * t),
        y: Math.round(y0 + (y1 - y0) * t),
        button: 'left'
      });
      await sleep(12);
    }
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
  }

  async typeText(text) {
    await this.cdp.send('Input.insertText', { text: String(text) });
  }

  async key(name) {
    const map = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27 };
    const code = map[name] || 13;
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: code, key: name });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: code, key: name });
  }

  /* 登录后从页面里刮 token：localStorage / sessionStorage / cookie 全扫，
     键名或值像 token 的都收，返回最长的高熵串作为候选。 */
  async harvest() {
    const expr = `(() => {
      const out = {ls:{}, ss:{}, ck:document.cookie||'', url:location.href, title:document.title};
      try { for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i);out.ls[k]=localStorage.getItem(k);} } catch(e){}
      try { for (let i=0;i<sessionStorage.length;i++){const k=sessionStorage.key(i);out.ss[k]=sessionStorage.getItem(k);} } catch(e){}
      return JSON.stringify(out);
    })()`;
    const r = await this.cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    const data = JSON.parse(r.result.value || '{}');
    const cands = [];
    const push = (k, v, src) => {
      if (typeof v !== 'string') return;
      let s = v.trim();
      if (!s) return;
      if (s.startsWith('{') || s.startsWith('[')) {
        try { s = JSON.stringify(JSON.parse(s)); } catch (_) {}
      }
      const hit = /token|auth|ticket|sid|session/i.test(k) || /^[A-Za-z0-9._\-]{24,}$/.test(s) || /[A-Fa-f0-9]{32,}/.test(s);
      if (hit) cands.push({ key: k, src, value: s, len: s.length });
    };
    for (const [k, v] of Object.entries(data.ls || {})) push(k, v, 'localStorage');
    for (const [k, v] of Object.entries(data.ss || {})) push(k, v, 'sessionStorage');
    for (const part of String(data.ck || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) push(part.slice(0, i).trim(), part.slice(i + 1).trim(), 'cookie');
    }
    cands.sort((a, b) => b.len - a.len);
    // 云手机站点把接口 token 放在 nToken（256 位），另外 nHwToken 是 JWT，别混淆
    const pick = (k) => (data.ls && data.ls[k]) || (data.ss && data.ss[k]) || null;
    const apiToken = pick('nToken') || pick('token') || pick('accessToken') || (cands[0] && cands[0].value) || null;
    const uuid = pick('uuid') || pick('TY_DEVICE_N_ID') || null;
    return { best: cands[0] || null, apiToken, uuid, all: cands.slice(0, 8), page: { url: data.url, title: data.title } };
  }

  kill() {
    this.alive = false;
    try { this.cdp && this.cdp.ws.close(); } catch (_) {}
    try { this.proc && this.proc.kill(); } catch (_) {}
    try { this.proc && this.proc.kill('SIGKILL'); } catch (_) {}
  }
}

module.exports = { BrowserSession, findBrowser };
