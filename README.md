# 云手机保活控制台 · 逆向重建版

对 `a128aad19da6c1834.app.workbuddy.host` 的完整重建：**前端原样复用，后端从零实现**，全部接口契约、数据结构、调度语义对齐原站。

```
.
├── server.js           # 服务端主程序（零依赖 Node，全部路由 + 调度器）
├── lib/
│   ├── cp139.js        # ★ 真实适配器：自算 sign 直连 cloud.139.com
│   ├── adapter.js      # cURL 解析 → 模板变量替换 → 重放（兼容其它接口）
│   ├── browser.js      # CDP 驱动 Edge 无头（登录页/截图/点击/滑动/刮 token）
│   └── db.js           # JSON 存储（原子写）+ 日志
├── public/index.html   # 前端控制台（单文件）
├── driver.js           # 常驻浏览器驱动（HTTP 控制口，逐步操作 + 抓包）
├── capture139.js       # 一次性抓包脚本
├── auto-login.js       # 自动走登录流程到发码
├── start.bat           # Windows 双击启动
├── 部署说明.md          # 中文部署文档（环境/常驻/反代/排错）
├── docs/screenshot.png # 界面截图
├── 139接口抓包报告.md   # 真实接口契约 + 签名算法（重要）
└── LICENSE
```

## 启动

```bash
node server.js          # http://127.0.0.1:8787
```

默认管理员 `admin / admin888`（普通用户注册后有效期 2 天，可被 `regReview` 拦成待审核）。

完整部署（环境要求、环境变量、systemd 常驻、Nginx 反代、备份、排错）见 **[部署说明.md](部署说明.md)**。

## ★ 真实接口已打通（不是模拟）

用真实账号实测登录后抓包 + 复算签名（下方示例已全部占位符化），**自算 sign 直连官方接口返回 200**：

```
POST https://cloud.139.com/uniphone/device/instancePrepareV2
sign = MD5(requestId + appId + token + secret + timestamp)
→ {"header":{"status":"200"},"data":{"devicePrepareInfos":[{"instanceId":"<INSTANCE_ID>","status":0}]}}
耗时 142~282ms

面板 real 模式实测：
  同步设备 → 读到 1 台云机的套餐与到期时间
  手动保活 → 142ms 成功，success 1/0，realCode 0
```

细节见 `139接口抓包报告.md`（完整报文、四组环境常量、配套接口清单）。

## 已验证（本机实跑）

| 项 | 结果 |
|---|---|
| 登录 / `x-auth-token` 鉴权 | ✅ 200，返回 token + me |
| `GET /api/state` | ✅ settings/rounds/logs/users/accounts 全量 |
| `/api/sessions/begin → send → verify` | ✅ 建账号、发码、登录成功、token 回写、设备同步 |
| `POST /api/accounts/:id/run`（mock） | ✅ 脉冲成功，success+1 |
| `POST /api/accounts/:id/run`（**real**） | ✅ 142ms 真实 200，realCode=0 |
| 设备同步（**real**） | ✅ listV2 拉到实例与到期时间 |
| 调度器自动轮次 | ✅ rounds 递增，`nextRoundAt` = +interval，日志 source=auto |
| `/screen/snap?token=` | ✅ 返回 SVG 画面（真实模式返回浏览器截图 JPEG） |
| `/api/adapter/config` 解析 | ✅ cURL 正确解析为 method/url/headers/body |
| 前端 ↔ 后端 | ✅ 见 `docs/screenshot.png` |

## 关键实现细节（与原站对齐）

**1. 保活 = 带签名的官方接口调用**
主路径走 `lib/cp139.js`：`sign = MD5(requestId + appId + token + secret + timestamp)`，直接 `POST https://cloud.139.com/uniphone/device/instancePrepareV2`。备用路径是 cURL 模板回放（`adapter.parseCurl()`，占位符 `{{token}} {{instanceId}}`，`patchAuth()` 兜底替换 Authorization/Cookie/body），便于接别的运营商或接口改版。

**2. 调度器**
`setInterval(15s)` 检查 `nextRoundAt`，到点对每个 `enabled` 账号跑一轮 → `rounds++`、`lastRoundAt=now`、`nextRoundAt=now+intervalMinutes*60000`。到期账号跳过并写 warn 日志（对应原站“跳过本轮”）。

**3. 登录态获取（两种，对应原站两条入口）**
- `/api/sessions/*`：起 Edge 无头打开 `cloud.139.com`，`snap` 走 `Page.captureScreenshot`，`tap/swipe` 走 `Input.dispatchMouseEvent`，登录后 `harvest()` 优先抓 `localStorage.nToken`（256 位）→ 这就是原站“画面里登录，token 自动回写”的实现。
- `/api/auth/sms/*`：短信直登通道（预热 / 发码 / 校验）。
- 面板“编辑”里还能手贴 `cpToken` + `cpDeviceFp`（原站同款字段）。

**4. 画面**
有浏览器会话 → 真实 JPEG 截图；无 → 现场生成 SVG（`<img>` 直接显示，含时间戳/设备/脉冲条，肉眼可辨“活着”）。

## 与原站的差异

| 项 | 原站 | 本重建 |
|---|---|---|
| 网关 | CloudStudio Gateway，HTML 要 `?sharecode=` | 无（本地直连） |
| 保活实现 | cURL 模板回放（管理员导入） | **内置签名算法直连官方接口** + 保留 cURL 回放兼容层 |
| 滑块 | 有专门 `solve-slider` 策略 | 通用拖动（实测可过拼图） |
| 通知 | `notifyOnFail` 字段存在 | 仅落日志，未接推送渠道 |
| 数据存储 | 未知（推测 Redis/PG） | 单文件 JSON，够单机跑 |
| 多租户 | 有 | 有（owner 隔离 + quota + 审核 + 到期） |

## 接真机（只需要一个 token）

1. 任意浏览器登录 `cloud.139.com`（短信验证码）；
2. F12 Console 执行 `localStorage.getItem('nToken')`，复制那串 **256 位十六进制**
   （别拿 `nHwToken`，那是 492 位 JWT，用途不同）；
3. 面板「保活设置」接口模式切 `真实`；账号「编辑」粘贴 token（可选再填 `deviceId`，即 `localStorage.uuid`）；
4. 点「刷新」同步设备 → 点「立即保活」看返回。

> 不想手动拿 token：点「139网页登录」在面板画面里走一遍短信登录，服务端会自动从
> `localStorage.nToken` 刮下来写回账号（`/api/sessions/*` 已实现）。

间隔别低于 10 分钟，运营商侧有频控。
