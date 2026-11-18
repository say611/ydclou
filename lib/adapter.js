'use strict';
/* 适配层：把管理员从 cp.139.com 抓到的 cURL 解析成模板，运行时做变量替换后重放。
 * 这就是原站的“真实接口接入”：不硬编码运营商接口，接口改版只换 cURL。 */

/** 极简 bash-cURL 解析器：支持 '...' / "..." / -H / --data-raw / --data / -X / --compressed / -b */
function parseCurl(raw) {
  if (!raw || typeof raw !== 'string') throw new Error('cURL 为空');
  // 1) 归一化续行符与换行
  const s = raw.replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ' ').trim();
  if (!/^curl\b/i.test(s)) throw new Error('不是 curl 开头');

  // 2) 分词（保留引号内内容）
  const argv = [];
  let buf = '';
  let q = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { q = null; continue; }
      if (c === '\\' && q === '"' && i + 1 < s.length) { buf += s[++i]; continue; }
      buf += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (/\s/.test(c)) {
      if (has || buf) { argv.push(buf); buf = ''; has = false; }
      continue;
    }
    buf += c;
  }
  if (has || buf) argv.push(buf);

  const out = { url: '', method: 'GET', headers: {}, body: null };
  const args = argv.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-H' || a === '--header') {
      const v = args[++i] || '';
      const k = v.indexOf(':');
      if (k > 0) out.headers[v.slice(0, k).trim()] = v.slice(k + 1).trim();
    } else if (a === '-X' || a === '--request') {
      out.method = (args[++i] || 'GET').toUpperCase();
    } else if (a === '--data-raw' || a === '--data' || a === '--data-binary' || a === '-d') {
      out.body = (out.body ? out.body + '&' : '') + (args[++i] || '');
      if (out.method === 'GET') out.method = 'POST';
    } else if (a === '-b' || a === '--cookie') {
      out.headers['Cookie'] = args[++i] || '';
    } else if (a === '--compressed' || a === '-s' || a === '-S' || a === '-L' || a === '--location') {
      // 忽略
    } else if (!a.startsWith('-') && !out.url) {
      out.url = a;
    }
  }
  if (!/^https?:\/\//i.test(out.url)) throw new Error('cURL 里没解析出 URL');
  return out;
}

/** 模板变量替换：{{token}} {{instanceId}} {{phone}} {{fp}} {{now}} */
function render(tpl, vars) {
  if (tpl == null) return tpl;
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

/** 正则替换 token 的兜底：模板没写占位符时，尝试替换 Authorization / token= 里的原值 */
function patchAuth(parsed, token) {
  if (!token) return parsed;
  const p = { ...parsed, headers: { ...parsed.headers } };
  for (const k of Object.keys(p.headers)) {
    if (/^(authorization|cookie|x-token|token)$/i.test(k)) {
      const v = p.headers[k];
      if (/^Bearer\s+/i.test(v)) p.headers[k] = 'Bearer ' + token;
      else p.headers[k] = v.replace(/[A-Fa-f0-9]{16,}/, token);
    }
  }
  if (p.body) p.body = p.body.replace(/("(?:token|accessToken|authToken)"\s*:\s*")([^"]*)(")/g, `$1${token}$3`);
  return p;
}

/** 重放一次真实请求；返回统一结构 */
async function replay(parsed, vars) {
  const t0 = Date.now();
  const p = patchAuth(
    {
      url: render(parsed.url, vars),
      method: render(parsed.method, vars),
      headers: Object.fromEntries(Object.entries(parsed.headers).map(([k, v]) => [k, render(v, vars)])),
      body: render(parsed.body, vars)
    },
    vars.token
  );
  // 去掉会影响 Node fetch 的头
  delete p.headers['Content-Length'];
  delete p.headers['content-length'];
  delete p.headers['Host'];
  delete p.headers['host'];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(p.url, {
      method: p.method,
      headers: p.headers,
      body: p.method === 'GET' || p.method === 'HEAD' ? undefined : p.body,
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return {
      ok: res.ok,
      status: res.status,
      ms: Date.now() - t0,
      json,
      text: text.slice(0, 2000),
      url: p.url
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 从各种运营商返回体里猜“成功” —— 兼容 code/resultCode/retCode 等常见字段 */
function judge(r) {
  if (!r) return { ok: false, code: null, text: '无响应' };
  if (!r.ok) return { ok: false, code: r.status, text: `HTTP ${r.status}` };
  const j = r.json || {};
  const code = j.code ?? j.resultCode ?? j.retCode ?? j.ret ?? j.status ?? null;
  const msg = j.message || j.msg || j.desc || j.resultDesc || '';
  const okCode = code === 0 || code === '0' || code === 200 || code === '200' || code === '0000' || code === 0;
  return { ok: okCode || code === null, code, text: String(msg || (okCode ? 'ok' : r.text.slice(0, 80))) };
}

/** 无模板时的模拟脉冲：模拟运营商 200~600ms 的往返 */
async function mockPulse() {
  await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
  return { ok: true, status: 200, ms: 0, json: { code: 0, message: 'mock ok' }, text: '{"code":0}', url: 'mock://instancePrepareV2' };
}

module.exports = { parseCurl, render, replay, judge, mockPulse, patchAuth };
