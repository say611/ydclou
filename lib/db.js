'use strict';
/* 数据层：单文件 JSON 存储 + 原子写。零依赖。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const newToken = () => crypto.randomBytes(24).toString('hex');
const DAY = 86400000;

function seed() {
  const now = Date.now();
  return {
    settings: {
      intervalMinutes: 30,
      autoRefreshSeconds: 20,
      watchMode: 'resident',
      apiMode: 'mock',
      notifyOnFail: true,
      regReview: false
    },
    rounds: 0,
    lastRoundAt: null,
    nextRoundAt: now + 30 * 60000,
    logs: [],
    users: [
      {
        id: 'u_admin',
        username: 'admin',
        pass: sha256('admin888'),
        role: 'admin',
        quota: 9999,
        expireAt: null,
        disabled: false,
        pending: false,
        createdAt: now,
        regIp: '',
        regAt: null,
        regUa: ''
      }
    ],
    tokens: {},
    accounts: [],
    sessions: {},
    adapter: { curl: '', parsed: null }
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    cache = seed();
    save();
    return cache;
  }
  try {
    cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    const bak = DB_FILE + '.broken.' + Date.now();
    try { fs.copyFileSync(DB_FILE, bak); } catch (_) {}
    cache = seed();
    save();
  }
  const d = seed();
  for (const k of Object.keys(d)) if (cache[k] === undefined) cache[k] = d[k];
  return cache;
}

let pending = false;
function save() {
  if (!cache) return;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

/* 日志：倒序展示用，内部按时间正序追加，最多保留 300 条 */
function log(db, { level = 'info', account = '', plan = '', source = 'auto', message = '' }) {
  db.logs.push({ at: Date.now(), level, account, plan, source, message });
  if (db.logs.length > 300) db.logs = db.logs.slice(-300);
}

module.exports = { load, save, log, sha256, rid, newToken, DATA_DIR, DB_FILE, DAY };
