'use strict';
/* 自动走 cp.139.com 登录到“发验证码”这一步，然后停下来等人工提供验证码
 * 用法： node auto-login.js <手机号>
 */
const PHONE = process.argv[2];
if (!/^1\d{10}$/.test(PHONE || '')) {
  console.error('用法：node auto-login.js <11位手机号>');
  process.exit(1);
}
const D = 'http://127.0.0.1:8899';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const get = async (p) => (await fetch(D + p)).json();
const post = async (p, b) => (await fetch(D + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(b || {})
})).json();

const evalJs = async (js) => {
  const r = await post('/eval', { js });
  return r.value;
};

/* 找“可见”的指定文案元素，返回中心坐标 */
async function findVisible(text) {
  const js = `JSON.stringify((() => {
    const vis = (e) => { const b=e.getBoundingClientRect(); const s=getComputedStyle(e);
      return b.width>2 && b.height>2 && s.visibility!=='hidden' && s.display!=='none' && b.bottom>0 && b.top<window.innerHeight*2; };
    const els=[...document.querySelectorAll('div,span,button,a')].filter(e=>(e.innerText||'').trim()===${JSON.stringify(text)} && vis(e));
    const e=els[0]; if(!e) return null;
    const b=e.getBoundingClientRect();
    return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2), n:els.length};
  })())`;
  const v = await evalJs(js);
  return v ? JSON.parse(v) : null;
}

async function tapText(text, label) {
  const r = await findVisible(text);
  if (!r) { console.log(`  ✗ 没找到可见的「${label || text}」`); return false; }
  await post('/tap', { x: r.x, y: r.y });
  console.log(`  ✓ 点击「${label || text}」@(${r.x},${r.y}) 候选${r.n}个`);
  return true;
}

(async () => {
  // 等驱动就绪
  for (let i = 0; i < 30; i++) {
    try { await get('/whos'); break; } catch (_) { await sleep(500); }
  }
  console.log('[1] 打开控制台');
  await post('/nav', { url: 'https://cloud.139.com/#/cloudAppList' });
  await sleep(4500);

  console.log('[2] 点「去登录」');
  const okLogin = await tapText('去登录');
  if (!okLogin) { console.log('  页面可能已登录或结构变化'); }
  await sleep(3000);

  console.log('[3] 填手机号 ' + PHONE);
  const focused = await evalJs(`(() => {
    const i=[...document.querySelectorAll('input')].find(x=>/手机号/.test(x.placeholder||''));
    if(!i) return 'no-input';
    i.focus(); i.click(); return 'ok';
  })()`);
  if (focused !== 'ok') { console.log('  ✗ 找不到手机号输入框'); process.exit(1); }
  await post('/text', { text: PHONE });
  await sleep(800);
  const cur = await evalJs(`[...document.querySelectorAll('input')].find(x=>/手机号/.test(x.placeholder||'')).value`);
  console.log('  当前输入框值：', cur);

  console.log('[4] 点「获取验证码」');
  const okSend = await tapText('获取验证码');
  await sleep(4000);

  const after = await evalJs(`(() => {
    const t=document.body.innerText;
    const m=t.match(/(\\d{2})s|重新获取|已发送|发送成功|操作频繁|请稍后/);
    return JSON.stringify({hit:m?m[0]:null, code:!!document.querySelector('input[type=tel]')});
  })()`);
  console.log('  发送后页面提示：', after);

  // 抓包核对是否真的发出了短信请求
  const reqs = await get('/reqs');
  const smsReqs = (reqs.api || []).filter((r) => /sms|smsCode|sendMsg|verifyCode|sendSms|preMobile|login/i.test(r.url));
  console.log('\n[5] 相关请求（' + smsReqs.length + ' 条）：');
  for (const r of smsReqs.slice(-8)) {
    console.log('  ', r.method, r.status, r.url.slice(0, 120));
    if (r.postData) console.log('      body:', String(r.postData).slice(0, 260));
  }
  await get('/snap');
  console.log('\n截图已保存 drv.png');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
