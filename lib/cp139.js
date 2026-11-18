'use strict';
/* 中国移动云手机（cloud.139.com）真实适配器
 * 逆向所得（已用线上真实请求逐字段校验通过）：
 *   POST https://cloud.139.com/uniphone/<api>
 *   headers: appId / token / sign / requestId / timestamp / platform / deviceId ...
 *   sign = MD5(requestId + appId + token + secret + timestamp)
 *   requestId = yyyyMMddHHmmss + 13位时间戳 + 8位随机
 */
const crypto = require('crypto');

const HOST = 'https://cloud.139.com';

const ENVS = {
  h5: { secret: 'esdkabncgfsfkmlondn', appId: '3099801' },
  ios: { secret: 'aBcDeFgHiJkLmNoPqRsTuVwXyZaBcDeF', appId: '3099804' },
  cpapp: { secret: 'MqWtYpAsDfGhJkLzXcVbNmQrTyUianzu', appId: '3099802' },
  hmcpapp: { secret: 'qWeRtYuIoPpAsDfGhJkLzXcVbNmHgFdS', appId: '3099805' }
};

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rand = (n) => Array.from({ length: n }, () => CHARS[crypto.randomInt(CHARS.length)]).join('');
const pad = (n) => String(n).padStart(2, '0');

function buildRequestId(ts) {
  const d = new Date(ts);
  return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + String(ts) + rand(8);
}

function sign(requestId, appId, token, secret, timestamp) {
  return crypto.createHash('md5').update(requestId + appId + token + secret + timestamp).digest('hex').toLowerCase();
}

const CLIENT = ['X3qUAu6hA1yO6CegzcMSrQJknuZ7aEs1', 'AqXZ3iQtf713yN70ydXRZkCkxdeGo3jo'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function deviceInfo(ua) {
  return ['4g', '', 'web', '6.6.8', '', '', ua, crypto.randomUUID(), '', '1920X1080', 'zh', '', '', '', '', ''].join('|') + '|';
}

/** 通用签名请求 */
async function call(api, body, o = {}) {
  const env = ENVS[o.env] || ENVS.h5;
  const token = String(o.token || '').trim();
  if (!token) throw new Error('缺少 token');
  const ts = Date.now();
  const requestId = buildRequestId(ts);
  const sgn = sign(requestId, env.appId, token, env.secret, ts);
  const ua = o.ua || UA;

  const headers = {
    'Content-Type': 'application/json; charset=UTF-8',
    Accept: 'application/json, text/plain, */*',
    appId: env.appId,
    token,
    sign: sgn,
    requestId,
    timestamp: String(ts),
    platform: 'h5',
    deviceId: o.deviceId || '',
    'x-DeviceInfo': deviceInfo(ua),
    'x-kpcc-clientid': CLIENT[0],
    'x-kpcc-clientkey': CLIENT[1],
    'x-channelSrc': '',
    Origin: HOST,
    Referer: HOST + '/',
    'User-Agent': ua
  };

  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeout || 20000);
  try {
    const res = await fetch(HOST + api, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    const header = (json && (json.header || json.head)) || {};
    const code = header.status ?? (json && json.code) ?? null;
    return {
      ok: res.status === 200 && (code === '200' || code === 200 || code == null),
      httpStatus: res.status,
      code,
      message: header.errMsg || header.message || (json && json.message) || '',
      ms: Date.now() - t0,
      data: json && json.data,
      raw: text.slice(0, 1200),
      requestId,
      sign: sgn,
      timestamp: ts
    };
  } finally {
    clearTimeout(timer);
  }
}

/* 保活脉冲：等价“打开云手机”的预备请求，服务端据此把闲置计时清零 */
function prepare({ token, instanceId, platformType = 1, deviceId, env, ua }) {
  if (!instanceId) throw new Error('缺少 instanceId');
  return call('/uniphone/device/instancePrepareV2', { instanceId, platformType: String(platformType) }, { token, deviceId, env, ua });
}

/* 设备列表（云手机清单） */
function listDevices({ token, deviceId, env, ua }) {
  return call('/uniphone/device/setting/listV2', { pageNum: 1, pageSize: 1000 }, { token, deviceId, env, ua });
}

/* 会话是否仍有效 */
function checkToken({ token, deviceId, env }) {
  return call('/uniphone/user/checkToken', {}, { token, deviceId, env });
}

/* 开关机：action = on | off | restart
 * 已真实抓包确认的只有两条：
 *   开机/预备 -> instancePrepareV2（同时也是保活脉冲）
 *   关机      -> shutdown
 * 重启（restart/reboot）端点未确认，这里直接抛错，绝不拿 prepare 冒充、
 * 也不能静默当成关机（旧版就是这么错，导致点“重启”实际在关机）。 */
function power({ token, deviceId, instanceId, action = 'on', env }) {
  const a = String(action || 'on').toLowerCase();
  if (a === 'off' || a === 'stop' || a === 'shutdown') {
    return call('/uniphone/device/shutdown', { instanceId, platformType: '1' }, { token, deviceId, env });
  }
  if (a === 'on' || a === 'start' || a === 'prepare') {
    return prepare({ token, instanceId, platformType: 1, deviceId, env });
  }
  throw new Error('重启接口尚未确认（restart/reboot 未实现），已阻止假成功');
}

/* 重启云手机（真实端点，2026-11 实测确认）：
 *   POST /uniphone/device/reboot   {"phoneId":"<instanceId>","platformType":"1"}
 * 实测：phoneId 传 instanceId 即可，返回 200 OK；随后 instancePrepareV2 的 status 由 0 变 5（启动中）。
 * 网页控制台的“重启”按钮并不是这个接口 —— 那是播放器 handleRelink() 重连串流，不动云机。 */
function reboot({ token, instanceId, phoneId, platformType = 1, deviceId, env }) {
  const pid = phoneId || instanceId;
  if (!pid) throw new Error('缺少 phoneId / instanceId');
  return call('/uniphone/device/reboot', { phoneId: String(pid), platformType: String(platformType) }, { token, deviceId, env });
}

/* 真实截屏，返回 base64 图片（可能为空字符串） */
async function screencap({ token, deviceId, env }) {
  const r = await call('/uniphone/screencap/pict', { deviceId, platformType: '1' }, { token, deviceId, env });
  return { ...r, img: r.data && (r.data.pict || r.data.img || r.data.base64) };
}

/* 把 listV2 的返回归一化成保活需要的结构
 * 注意：保活脉冲用 instanceId（一串短 ID，与 deviceId 不同），截屏/控制才用 deviceId（32 位 hex） */
function normalizeDevices(r) {
  const d = (r && r.data) || {};
  const arr = d.phoneInstanceList || d.list || d.records || d.deviceList || [];
  return arr.map((x) => ({
    id: x.instanceId || x.deviceId || x.cloudId,
    instanceId: x.instanceId || x.deviceId || x.cloudId,
    deviceId: x.deviceId || '',
    plan: x.deviceName || x.productName || x.planName || '云手机',
    status: x.deviceStatus ?? x.status ?? null,
    expireAt: x.endTime && x.endTime < 4102415000000 ? x.endTime : null,
    raw: x
  })).filter((x) => x.instanceId);
}

module.exports = { prepare, listDevices, checkToken, power, reboot, screencap, call, sign, buildRequestId, normalizeDevices, ENVS };
