'use strict';
/* 抓 cp.139.com：采集全部网络请求（含 POST body）+ 页面 JS 包清单 + 首屏截图
 * 用法： node capture139.js [url] [waitMs]
 */
const { BrowserSession } = require('./lib/browser');
const fs = require('fs');

const TARGET = process.argv[2] || 'https://cp.139.com/';
const WAIT = Number(process.argv[3] || 14000);

(async () => {
  const s = await BrowserSession.create('cap139', 'cap');
  const reqs = [];
  const pend = new Map();

  try {
    await s.cdp.send('Network.enable', { maxTotalBufferSize: 10485760, maxResourceBufferSize: 5242880 }).catch(() => {});
    s.cdp.on('Network.requestWillBeSent', (p) => {
      pend.set(p.requestId, {
        id: p.requestId,
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
        r.respHeaders = p.response.headers;
        reqs.push(r);
        pend.delete(p.requestId);
      }
    });
    s.cdp.on('Network.loadingFailed', (p) => {
      const r = pend.get(p.requestId);
      if (r) { r.status = -1; r.failed = p.errorText; reqs.push(r); pend.delete(p.requestId); }
    });

    await s.cdp.send('Page.navigate', { url: TARGET });
    await new Promise((r) => setTimeout(r, WAIT));

    const info = await s.pageInfo();
    const shot = await s.screenshot();
    fs.writeFileSync('cap139.png', shot);
    fs.writeFileSync('cap139_requests.json', JSON.stringify({ page: info, requests: reqs }, null, 2));

    const apis = reqs.filter((r) => /\/api\/|\.do|\.json|rest|service/i.test(r.url) && !/\.(js|css|png|jpg|jpeg|svg|woff2?|ico)(\?|$)/i.test(r.url));
    const scripts = reqs.filter((r) => /\.js(\?|$)/i.test(r.url));

    console.log('PAGE:', JSON.stringify(info));
    console.log('TOTAL REQ:', reqs.length, '| API-like:', apis.length, '| JS:', scripts.length);
    console.log('\n--- API-like ---');
    for (const r of apis.slice(0, 40)) {
      console.log(`${r.method} ${r.status} ${r.url.slice(0, 140)}`);
      if (r.postData) console.log('   body:', String(r.postData).slice(0, 300));
    }
    console.log('\n--- JS BUNDLES ---');
    for (const r of scripts.slice(0, 25)) console.log(`${r.status} ${r.url.slice(0, 170)}`);
  } finally {
    s.kill();
  }
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
