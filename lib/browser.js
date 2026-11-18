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

  /* 拖拽：mouseMoved 必须带 buttons:1，否则页面只认为鼠标在移动而不是在拖。
     轨迹用 ease-out 缓动 + 末端微调，避免匀速直线被风控判定为机器。 */
  async swipe(x0, y0, x1, y1, steps = 12) {
    const base = { button: 'left', buttons: 1, clickCount: 1 };
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, button: 'none', buttons: 0 });
    await sleep(60);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, ...base });
    await sleep(90);

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = 1 - Math.pow(1 - t, 2);           // ease-out
      await this.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(x0 + (x1 - x0) * e),
        y: Math.round(y0 + (y1 - y0) * e + (Math.random() - 0.5) * 1.5),
        ...base
      });
      await sleep(16 + Math.random() * 14);
    }

    // 末端回拉一点点再松手，模拟人对准
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x1), y: Math.round(y1), ...base });
    await sleep(120);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x1), y: Math.round(y1), ...base });
  }

  async typeText(text) {
    await this.cdp.send('Input.insertText', { text: String(text) });
  }

  /* 触摸拖拽：移动端页面（mobile 模拟）多半只监听 touch/pointer，
     用 mouse 事件拖不动。节奏按人来：按下先停顿、变速移动、松手前停顿。 */
  async touchDrag(x0, y0, x1, y1, steps = 26) {
    const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), radiusX: 3, radiusY: 3, force: 1, id: 1 }];
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) });
    await sleep(180 + Math.random() * 160);   // 按住后的反应时间

    let prev = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // 先慢快慢：smoothstep，末段再放慢以便对准
      const e = t * t * (3 - 2 * t);
      const d = (x1 - x0) * e;
      if (Math.abs(d - prev) < 1.2 && i < steps) continue;   // 跳过过密的点
      prev = d;
      await this.cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: pt(x0 + d, y0 + (y1 - y0) * e + (Math.random() - 0.5) * 1.2)
      });
      await sleep(18 + Math.random() * 26);
    }
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x1, y1) });
    await sleep(220 + Math.random() * 180);   // 松手前停顿
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  /* 拖动滑块手柄：先试触摸，手柄没动再退回鼠标；最后按手柄位移判断是否生效 */
  async dragHandle(handleSel, dist) {
    const read = () => this.evalJs(`(() => {
      const h = document.querySelector(${JSON.stringify(handleSel)});
      if (!h) return null;
      const b = h.getBoundingClientRect();
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
               left: h.style && h.style.left ? h.style.left : null };
    })()`);

    const before = await read();
    if (!before) return { ok: false, reason: 'no-handle' };
    const cx = before.x + Math.round(before.w / 2);
    const cy = before.y + Math.round(before.h / 2);

    await this.touchDrag(cx, cy, cx + dist, cy, 26);
    await sleep(600);
    let after = await read();
    let via = 'touch';

    if (after && before.left != null && after.left === before.left || (after && Math.abs(after.x - before.x) < 2)) {
      via = 'mouse';
      await this.swipe(cx, cy, cx + dist, cy, 26);
      await sleep(600);
      after = await read();
    }

    const moved = after ? Math.abs(after.x - before.x) : 0;
    return { ok: moved >= 4, via, moved, before, after };
  }

  async evalJs(expression, awaitPromise = false) {
    const r = await this.cdp.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise
    });
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || '页面脚本执行失败');
    }
    return r && r.result ? r.result.value : undefined;
  }

  async waitFor(expression, timeoutMs = 15000, interval = 400) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { if (await this.evalJs(expression)) return true; } catch (_) {}
      await sleep(interval);
    }
    return false;
  }

  /* 点可见的、文本完全匹配的元素：优先 <button>，其次面积最小的，并校验落点不被遮挡 */
  async clickText(text) {
    const found = await this.evalJs(`(() => {
      const t = ${JSON.stringify(text)};
      const vis = e => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e);
        return b.width > 2 && b.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'
          && b.bottom > 0 && b.top < innerHeight && s.pointerEvents !== 'none'; };
      const els = [...document.querySelectorAll('button,a,div,span')]
        .filter(e => (e.innerText || '').trim() === t && vis(e))
        .map(e => { const b = e.getBoundingClientRect();
          return { e, tag: e.tagName, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
                   area: Math.round(b.width * b.height), w: Math.round(b.width), h: Math.round(b.height) }; });
      if (!els.length) return null;

      // 排序：button 优先，其次面积小的（更接近真实控件）
      els.sort((a, b) => {
        const ab = a.tag === 'BUTTON' ? 0 : 1, bb = b.tag === 'BUTTON' ? 0 : 1;
        if (ab !== bb) return ab - bb;
        return a.area - b.area;
      });

      // 落点校验：命中的元素要属于候选自身或其后代
      for (const c of els) {
        const hit = document.elementFromPoint(c.x, c.y);
        if (hit && (hit === c.e || c.e.contains(hit))) {
          return { x: c.x, y: c.y, tag: c.tag, w: c.w, h: c.h, n: els.length };
        }
      }
      const c = els[0];
      return { x: c.x, y: c.y, tag: c.tag, w: c.w, h: c.h, n: els.length, covered: true };
    })()`);
    if (!found) return null;
    await this.tap(found.x, found.y);
    return found;
  }

  /* 往输入框写值（走原生 setter，确保 Vue 能收到） */
  async fillInput(reSource, value) {
    return this.evalJs(`(() => {
      const re = new RegExp(${JSON.stringify(String(reSource))}, 'i');
      const ins = [...document.querySelectorAll('input')].filter(i => !i.disabled && i.offsetParent !== null);
      const i = ins.find(x => re.test((x.placeholder || '') + (x.type || '') + (x.name || '')));
      if (!i) return { ok: false, reason: 'no-input' };
      i.focus(); i.click();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, ${JSON.stringify(String(value))});
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, value: i.value, placeholder: i.placeholder || '' };
    })()`);
  }

  fillPhone(phone) { return this.fillInput('手机|phone|tel', phone); }
  fillCode(code) { return this.fillInput('验证码|code|sms', code); }

  /* 勾选「我已阅读并同意协议」：优先用站点暴露的 Vue 方法，其次点 DOM */
  async tickProtocol() {
    return this.evalJs(`(() => {
      const boxes = [...document.querySelectorAll('input[type=checkbox]')];
      if (boxes.some(b => b.checked)) return { ok: true, via: 'already' };

      // 站点把勾选做成组件方法，直接调最干净
      const tryVue = (el) => {
        for (let p = el; p; p = p.parentElement) {
          const v = p.__vue__ || (p.__vueParentComponent && p.__vueParentComponent.proxy);
          if (v && typeof v.protocolCheckClick === 'function') { v.protocolCheckClick(); return true; }
        }
        return false;
      };

      // 找含“协议 / 同意 / 已阅读”的最内层元素
      const cands = [...document.querySelectorAll('span,div,label,i,a,p')]
        .filter(e => /协议|已阅读|同意/.test((e.innerText || '').trim().slice(0, 80)))
        .filter(e => e.children.length <= 2);
      const target = cands[cands.length - 1];
      if (target) {
        if (tryVue(target)) return { ok: true, via: 'vue', text: (target.innerText || '').slice(0, 40) };
        const b = target.getBoundingClientRect();
        return { ok: true, via: 'dom', x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
                 text: (target.innerText || '').slice(0, 40) };
      }
      if (boxes[0]) {
        const b = boxes[0].getBoundingClientRect();
        return { ok: true, via: 'checkbox', x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
      }
      return { ok: false, reason: 'not-found' };
    })()`);
  }

  /* 拼图滑块：定位 .img_bg / .img_slider，把两张图放进 canvas 做模板匹配算缺口，
     再从 .dv_handler 拖过去。图片是 data: URL，同源，不会污染 canvas。 */
  async solveSlider(strategy = 'geom') {
    const geo = await this.evalJs(`(() => {
      const dlg = [...document.querySelectorAll('.van-dialog,[role=dialog]')]
        .find(e => /安全验证/.test(e.innerText || ''));
      if (!dlg) return { ok: false, reason: 'no-dialog' };

      const bgEl = dlg.querySelector('.img_bg img') || dlg.querySelector('.img_bg canvas');
      const pEl  = dlg.querySelector('.img_slider img');
      const hEl  = dlg.querySelector('.dv_handler');
      if (!bgEl || !pEl) return { ok: false, reason: 'no-images' };

      const bb = bgEl.getBoundingClientRect();
      const pb = pEl.getBoundingClientRect();
      const bw = Math.round(bb.width), bh = Math.round(bb.height);
      const pw = Math.round(pb.width), ph = Math.round(pb.height);

      const draw = (el, w, h) => {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(el, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h).data;
      };
      let bd, pd;
      try { bd = draw(bgEl, bw, bh); pd = draw(pEl, pw, ph); }
      catch (err) { return { ok: false, reason: 'canvas-tainted' }; }

      // 缺口是背景里的“白色描边拼图”，块体是纯色填充，直接比色必然失败。
      // 改为：分别求「背景白色轮廓的列重心」与「块体非白像素的包围盒中心」，取中心差为拖拽距离。
      const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

      // 1) 块体左边界（排除近白像素）
      let px0 = pw, px1 = -1;
      for (let y = 0; y < ph; y++) {
        for (let x = 0; x < pw; x++) {
          const i = (y * pw + x) * 4;
          const r = pd[i], g = pd[i + 1], b = pd[i + 2];
          const white = r > 235 && g > 235 && b > 235;
          if (!white) { if (x < px0) px0 = x; if (x > px1) px1 = x; }
        }
      }
      if (px1 < px0) { px0 = 0; px1 = pw - 1; }
      const pieceCenter = (px0 + px1) / 2;

      // 2) 背景白色轮廓的列重心（只取中部，避开底部水印与上下边缘）
      const y0 = Math.round(bh * 0.18), y1 = Math.round(bh * 0.80);
      const colWhite = new Array(bw).fill(0);
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < bw; x++) {
          const i = (y * bw + x) * 4;
          const r = bd[i], g = bd[i + 1], b = bd[i + 2];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          if (lum(bd, i) > 205 && (mx - mn) < 32) colWhite[x]++;   // 高亮且低饱和 = 白色描边
        }
      }
      // 找所有连续列簇，按“宽度接近拼图块宽度”挑最像缺口的那一个
      // （背景里的白花、白猫毛、水印都会产生白色簇，只按像素总量挑会挑错）
      const clusters = [];
      for (let x = 0; x < bw; x++) {
        if (colWhite[x] < 2) continue;
        let j = x, sum = 0;
        while (j < bw && colWhite[j] >= 2) { sum += colWhite[j]; j++; }
        clusters.push({ a: x, b: j - 1, w: j - x, sum });
        x = j;
      }
      clusters.sort((c1, c2) => Math.abs(c1.w - pw) - Math.abs(c2.w - pw) || c2.sum - c1.sum);
      const pick = clusters[0];
      const gapCenter = pick ? (pick.a + pick.b) / 2 : null;

      // 3) 兜底：SAD 全图滑窗
      let sadBest = -1, sadScore = Infinity;
      for (let off = 0; off <= Math.max(0, bw - pw); off++) {
        let s = 0, n = 0;
        for (let y = 0; y < ph; y += 3) {
          for (let x = 0; x < pw; x += 3) {
            const bx = x + off;
            if (bx >= bw || y >= bh) continue;
            const pi2 = (y * pw + x) * 4, bi2 = (y * bw + bx) * 4;
            s += Math.abs(pd[pi2] - bd[bi2]) + Math.abs(pd[pi2 + 1] - bd[bi2 + 1]) + Math.abs(pd[pi2 + 2] - bd[bi2 + 2]);
            n++;
          }
        }
        if (!n) continue;
        const sc = s / n;
        if (sc < sadScore) { sadScore = sc; sadBest = off; }
      }

      const hb = hEl ? hEl.getBoundingClientRect() : null;
      // 缺口左边界对齐更稳：轮廓簇只覆盖描边，中心法会因簇宽与块宽不等而系统性偏移
      const dragEdge = pick ? Math.round(pick.a - px0) : null;
      const dragCenter = gapCenter != null ? Math.round(gapCenter - pieceCenter) : null;
      const drag = dragEdge != null && dragEdge > 4 ? dragEdge : dragCenter;

      return {
        ok: true,
        drag, dragEdge, dragCenter,
        pieceLeft: px0,
        gapCenter: gapCenter != null ? Math.round(gapCenter) : null,
        pieceCenter: Math.round(pieceCenter),
        whiteSpan: pick ? [pick.a, pick.b, pick.sum] : null,
        clusters: clusters.slice(0, 3).map(c => [c.a, c.b, c.w, c.sum]),
        sadOffset: sadBest, sadScore: Math.round(sadScore),
        bg: { w: bw, h: bh, x: Math.round(bb.x), y: Math.round(bb.y) },
        piece: { w: pw, h: ph },
        handle: hb ? { x: Math.round(hb.x + hb.width / 2), y: Math.round(hb.y + hb.height / 2), w: Math.round(hb.width) } : null
      };
    })()`);

    if (!geo || !geo.ok) return { ok: false, reason: (geo && geo.reason) || 'probe-failed', geo };
    if (!geo.handle) return { ok: false, reason: 'no-handle', geo };

    // 按策略选距离：geom 用白色轮廓中心差，sad 用全图滑窗最相似位置
    const maxDist = geo.bg.w - geo.piece.w;
    let dist = strategy === 'sad' ? geo.sadOffset : geo.drag;
    if (dist == null || dist < 8 || dist > maxDist) dist = strategy === 'sad' ? geo.drag : geo.sadOffset;
    if (dist == null || dist <= 0) return { ok: false, reason: 'no-usable-offset', geo };

    const drag = await this.dragHandle('.dv_handler', dist);
    await sleep(900);

    // 校验：弹窗消失 或 按钮进入倒计时 即视为通过
    const done = await this.evalJs(`(() => {
      const dlg = [...document.querySelectorAll('.van-dialog,[role=dialog]')]
        .find(e => /安全验证/.test(e.innerText || ''));
      const btn = [...document.querySelectorAll('button')].map(b => (b.innerText || '').trim()).find(t => /重新获取|\\d+\\s*s/i.test(t));
      const toastEl = document.querySelector('.van-toast, .toast, [class*=toast]');
      const toast = toastEl ? (toastEl.innerText || '').trim().slice(0, 40) : null;
      return { dialogGone: !dlg, countdown: btn || null, toast };
    })()`);

    const passed = !!done.dialogGone || !!done.countdown;
    return { ok: passed, dist, drag, geo, after: done };
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
