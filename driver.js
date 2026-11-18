'use strict';
/* 常驻浏览器驱动：起 Edge 无头 + 小 HTTP 控制口，支持逐步操作与抓包
 * 用法： node driver.js [startUrl]
 * 控制口： http://127.0.0.1:8899
 *   GET  /snap                 → png 截图
 *   POST /text {text}          → 输入文本
 *   POST /tap {x,y}            → 点击
 *   POST /swipe {x0,y0,x1,y1}  → 滑动
 *   POST /key {name}           → 按键（Enter/Tab/Escape/Backspace）
 *   POST /nav {url}            → 跳转
 *   POST /eval {js}            → 执行 JS 并返回结果
 *   GET  /whos                 → 可交互元素清单（input/button/a 的文案与坐标）
 *   GET  /reqs                 → 抓到的全部请求（含 POST body）
 *   GET  /harvest              → 扫 localStorage/cookie 里的 token
 *   POST /stop                 → 关闭
 */
const http = require('http');
const fs = require('fs');
const { BrowserSession } = require('./lib/browser');

const CTRL = Number(process.env.CTRL_PORT || 8899);
const START = process.argv[2] || 'https://cp.139.com/';

(async () => {
  const s = await BrowserSession.create('drv', 'drv');
  const reqs = [];
  const pend = new Map();

  await s.cdp.send('Network.enable', { maxTotalBufferSize: 20971520, maxResourceBufferSize: 10485760 }).catch(() => {});
  s.cdp.on('Network.requestWillBeSent', (p) => {
    pend.set(p.requestId, {
      url: p.request.url,
      method: p.request.method,
      type: p.type,
      postData: p.request.postData || null,
      headers: p.request.headers || {},
      at: Date.now()
    });
  });
  s.cdp.on('Network.responseReceived', (p) => {
    const r = pend.get(p.requestId);
    if (r) {
      r.status = p.response.status;
      r.mime = p.response.mimeType;
      reqs.push(r);
      pend.delete(p.requestId);
      if (reqs.length > 3000) reqs.splice(0, 1000);
    }
  });

  await s.cdp.send('Page.navigate', { url: START });
  console.log('[drv] 已打开', START);

  const readBody = (req) => new Promise((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (_) { res({}); } });
  });

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const j = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    try {
      if (u.pathname === '/snap') {
        const png = await s.screenshot();
        fs.writeFileSync('drv.png', png);
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(png);
      }
      if (u.pathname === '/whos') {
        const r = await s.cdp.send('Runtime.evaluate', {
          expression: `JSON.stringify((() => {
            const out=[];
            const pick=(el,kind)=>{const b=el.getBoundingClientRect(); if(b.width<2||b.height<2) return;
              out.push({kind, tag:el.tagName.toLowerCase(), type:el.type||'', text:(el.innerText||el.value||el.placeholder||'').trim().slice(0,40),
                        x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2), w:Math.round(b.width), h:Math.round(b.height)});};
            document.querySelectorAll('input,button,a,textarea,[role=button]').forEach(el=>pick(el, el.tagName.toLowerCase()));
            return out.slice(0,60);
          })())`,
          returnByValue: true
        });
        return j({ ok: true, items: JSON.parse(r.result.value || '[]') });
      }
      if (u.pathname === '/reqs') {
        const all = u.searchParams.get('all') === '1';
        const api = reqs.filter((r) => all
          ? true
          : /\/uniphone\/|\/api\/|\.do|rest|service|graphql/i.test(r.url) && !/\.(js|css|png|jpe?g|svg|woff2?|ico|webp|mp4)(\?|$)/i.test(r.url));
        return j({ ok: true, total: reqs.length, api });
      }
      if (u.pathname === '/harvest') {
        const h = await s.harvest();
        return j({ ok: true, ...h });
      }
      const body = await readBody(req);
      if (u.pathname === '/text') { await s.typeText(body.text || ''); return j({ ok: true }); }
      if (u.pathname === '/tap') { await s.tap(Number(body.x), Number(body.y)); return j({ ok: true }); }
      if (u.pathname === '/swipe') { await s.swipe(Number(body.x0), Number(body.y0), Number(body.x1), Number(body.y1)); return j({ ok: true }); }
      if (u.pathname === '/key') { await s.key(body.name || 'Enter'); return j({ ok: true }); }
      if (u.pathname === '/nav') { await s.navigate(body.url); return j({ ok: true, page: await s.pageInfo() }); }
      if (u.pathname === '/eval') {
        const r = await s.cdp.send('Runtime.evaluate', { expression: String(body.js || '1'), returnByValue: true, awaitPromise: true });
        return j({ ok: true, value: r.result ? r.result.value : null, desc: r.result && r.result.description });
      }
      if (u.pathname === '/stop') { s.kill(); j({ ok: true }); setTimeout(() => process.exit(0), 300); return; }
      return j({ ok: false, message: 'unknown' }, 404);
    } catch (e) {
      return j({ ok: false, message: e.message }, 500);
    }
  });

  server.listen(CTRL, '127.0.0.1', () => console.log('[drv] 控制口 http://127.0.0.1:' + CTRL));
  process.on('SIGINT', () => { s.kill(); process.exit(0); });
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
