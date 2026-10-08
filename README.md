[README.md](https://github.com/user-attachments/files/33186836/README.md)
# 图书馆座位预约小程序（CloudBase）

### 2026-10-08：数字统计与同步更新

数字统计现支持今日/自然周/自然月、7/30 天预约趋势、日期/区域/提交时间分布，以及“计算同步”后自动刷新。首页和后台当前使用率统一按当前时段的预约及预选座位计算，以整数百分比显示。个人统计按账号隔离并从云端校准。

完整变更、统计口径、验证范围和需要重新部署的云函数见 [代码检查报告](../tooling/reports/code-quality-review.md)。本地验证：`npm --prefix ../tooling run check` 与 `npm --prefix ../tooling run test`。更新服务端后，进入数字统计页回填最近 7/30 天，以替换旧统计口径。

基于微信小程序 + 腾讯云开发（CloudBase / `wx.cloud`）构建的图书馆座位预约系统。

[![Powered by CloudBase](https://7463-tcb-advanced-a656fc-1257967285.tcb.qcloud.la/mcp/powered-by-cloudbase-badge.svg)](https://github.com/TencentCloudBase/CloudBase-AI-ToolKit)

## 1. 项目简介与架构

- **项目根目录**：`D:\miniprogram-2\miniprogram-2`（`app.json` / `project.config.json` 所在目录）。
- **平台**：原生微信小程序（glass-easel 组件框架），UI 组件为自研轻量组件库（`components/t-*`），**零 npm 依赖**，无需“构建 npm”。
- **主包体积**：约 0.31 MB（上限 1.5 MB，不含插件）；整个项目根目录占用约 0.98 MB。`node_modules` / `miniprogram_npm` / 云函数本地依赖缓存均已移除，`project.config.json` 的 `packOptions.ignore` 为权威忽略清单（`project.private.config.json` 中另存一份但不保证生效）。
- **主包 JS 清理**：只被分包使用的模块已迁出主包——`pkgUser/utils/location.js`（签到页 GPS）、`pkgTools/utils/speed-test.js` 与 `pkgTools/utils/third-party.js`（工具页）；主包 `utils/` 内不得再出现仅分包使用的文件。
- **开发工具目录**：AI 助手规则目录（`.agents` / `.codebuddy` / `rules`）与 Node 自检脚本（`scripts/check-project.js`）已移出小程序项目，存放于 `D:\miniprogram-2\tooling\`——小程序端只保留纯小程序代码，避免开发者工具把 Node 专用文件纳入编译（曾因脚本 shebang 报 `invalid file: scripts/check-project.js`）。
  - 运行自检：`node D:\miniprogram-2\tooling\scripts\check-project.js`
  - 需要助手规则自动加载时，把 `.agents` / `.codebuddy` / `rules` 移回项目根目录（它们已在 `packOptions.ignore` 中，不影响包体积）。
- **架构**：
  - 主包：`pages/`（home 首页、reserve 预约、record 记录、profile 我的）。
  - 分包：`pkgUser`（登录/收藏/签到/预约详情）、`pkgAdmin`（管理后台/座位/统计）、`pkgTools`（工具页/番茄钟/日记本/演示预约）、`pkgSponsor`。
  - 工具层：`utils/`（app-state、cloud-api、route-guard、reservation-engine、cache-manager、font-loader 等；**仅放主包使用的模块**）。
  - 分包工具层：`pkgUser/utils/`、`pkgTools/utils/`（仅对应分包使用的模块放这里，避免主包出现“主包未使用的 JS”）。
  - 自定义组件：`components/`（t-icon/t-button/t-dialog/t-switch/t-result 等自研轻量组件、quote-pop 首页语录动画）。
  - 云函数：`cloudfunctions/`（登录、预约、签到、座位状态聚合、统计等，见下表）。

### 全局视觉约定（去AI化）

- **字体**：全局采用仿宋字体栈 `"FangSong","仿宋","FangSong_GB2312","STFangsong","华文仿宋","Songti SC",serif`（见 `styles/variables.wxss`）；iOS 内置 STFangsong、Windows 内置 FangSong，其余设备回退宋体系。如需全端一致，可在 `utils/font-loader.js` 配置云端字体文件 URL（需 https + 合法域名，推荐子集化字体）。
- **风格**：线装手账·纸墨——无阴影、无渐变、无 emoji 图标（图标一律 t-icon/文字标记）、非对称排版、朱砂印章与虚线装订线等手工细节；导航栏统一品牌墨绿 `#2F6B55`。

### 新增功能：番茄钟与日记（`pkgTools`）

- **番茄钟**（`pkgTools/pomodoro`）：专注/小憩/长休三段循环，每 4 个番茄接一次长休；计时基于结束时间戳防漂移，离开页面继续计时、回来自动结算；专注时长可选 25/45/60 分钟；本机统计（今日/累计番茄数与专注分钟）。入口：我的-菜单、工具页。
- **日记本**（`pkgTools/diary`）：一页一篇，支持补记日期、单字心情章（晴/云/雨/风/静/忙/乐/累）、输入草稿防丢、删除确认；**数据仅保存在本机**（`diary_entries`），不经过云端。入口：我的-菜单、工具页。

### 首页设计约定

- **匿名首页**：首页不展示任何学生个人信息（不显示姓名、头像、收藏数量、禁预约状态等）；问候语为时段问候，不带用户名。登录校验仅在点击“开始选座 / 快捷入口”时触发。
- **点击动画**：右下角浮动“纸笺”按钮，点击一次弹出一句“孤立的话”（本地语录库 `utils/home-quotes.js`，不依赖网络、不读取用户数据），4.5 秒自动收起，连续点击换句且不重复。
- **实时座位统计**：首页显示全馆总座位数、剩余座位数、使用率（含进度条），每 15 秒自动轮询刷新，数据来自 `getSeatsState` 云函数全馆聚合（所有用户看到一致数据）。

## 2. CloudBase 资源清单

- **环境 ID**：`cloud1-d1g6k44f6d5babfd1`（配置于 `app.js`；本仓库更新时未通过云端管理工具重新核验远端状态）。
- **数据库集合（使用中）**：`users`、`reservations`、`seat_locks`、`seats`、`notices`、`violations`、`error_logs` 等（客户端经云函数聚合访问，避免集合权限导致各用户看到不同数据）。
- **云函数清单**：
  - 用户：`userLogin`、`updateUserInfo`、`clearUsers`
  - 座位状态：`getSeatsState`、`getSeatDelta`、`acquireSeatLock`、`releaseSeatLock`、`releaseAllMyLocks`
  - 预约/签到：`createReservation`、`cancelReservation`、`checkin`、`autoCheckout`、`submitAppeal`
  - 统计：`getStatistics`、`aggregateStats`
- **身份与鉴权**：小程序原生 `wx.cloud` 身份（云函数内使用 `cloud.getWXContext().OPENID` 识别用户，客户端不传 OPENID）。
- **存储**：未在本轮改动中使用。

## 3. 部署方式

- 小程序端：使用微信开发者工具打开项目根目录，上传/发布（本项目未提供 AppID 校验结果，实际预览、上传需开发者工具登录并确认 AppID）。
- 云函数：在微信开发者工具中对 `cloudfunctions/<函数名>` 右键“上传并部署（云端安装依赖）”。
- 本轮未执行任何部署（未授权）。

## 4. 访问入口与验证状态

- 未提供小程序 AppID 与体验版二维码，真实访问入口待开发者工具部署后确认。
- 本轮改动已完成静态语法验证（`node --check` / JSON 校验）；运行时的页面交互验证需在微信开发者工具/真机中进行（本环境无开发者工具，标记为未执行）。

## 5. 修改维护注意事项

- **首页隐私红线**：`pages/home/*` 不得再引入任何学生个人信息展示（姓名/头像/收藏数/禁预约提示等）；新增展示项先确认不含用户数据。
- **座位统计口径**：剩余座位 = 总数 − 已占用（活跃预约 ∪ 预选锁）− 维护中；使用率 = 已占用 ÷ 总数。`getSeatsState` 传数字 `floor` 走楼层聚合（预约页使用），缺省或 `'all'` 走全馆聚合并返回 `summary`（首页使用）。
- **新旧云函数兼容**：首页在 `data.summary` 缺失时（旧版云函数）自动用 `seatReservationCount ∪ activeLocks` 客户端聚合，口径一致；部署新版 `getSeatsState` 后自动切换为服务端汇总。
- **轮询与限流**：首页统计轮询 15 秒/次，客户端限流 `QUERY_SEAT_STATUS` 为 40 次/分钟；调整轮询频率时勿突破该限流。
- **取消预约链路**：取消状态由云函数 `cancelReservation` 在服务端更新（校验归属 + 释放座位锁）；客户端 `CloudAPI.cancelReservation` 云函数优先、直改回退，并在取消后清除记录页/预约页缓存。**部署新版云函数前**，客户端直改在“仅创建者可读写”权限下可能被拒绝（云端记录不更新），属预期回退行为。
- **语录库**：`utils/home-quotes.js` 中的句子均为原创短句；如需替换文案，保持“单句、孤立、无用户信息”的约定。
- **本地数据键**：番茄钟状态 `pomodoro_state` / 统计 `pomodoro_stats`；日记正文 `diary_entries` / 草稿 `diary_draft`。这些键只在对应页面读写；清理用户本机缓存会同时清除番茄钟统计与日记，如需云端备份需另行实现。
- **主包红线**：主包必须 < 1.5 MB（当前约 0.31 MB，整项目约 0.97 MB）。禁止在小程序目录内放 Node 专用脚本（Shebang / `require('node:*')` 会被开发者工具判为非法文件）；禁止再引入 npm UI 依赖；新增图标在 `components/t-icon/t-icon.js` 的 `ICONS` 中追加 24×24 SVG path，新组件一律放 `components/` 自研实现。
- **自定义 tabBar**：当前使用原生 tabBar（`app.json` 未开启 `tabBar.custom`），原 `custom-tab-bar/` 组件已归档到 `D:\miniprogram-2\tooling\removed\`；若改用自定义 tabBar，需先把它移回项目根并把 `tabBar.custom` 置为 `true`。
- **定位接口（wx.getLocation）**：该接口需在微信公众平台「开发管理 → 接口设置」单独申请，未申请时开发者工具会提示“app.json 中部分接口暂无权限”。因此当前 `app.json` **已移除** `requiredPrivateInfos` 与 `permission.scope.userLocation`；GPS 定位签到会弹窗提示“定位签到暂不可用”并引导改用扫码签到（`pkgUser/utils/location.js` 返回 `NO_PERMISSION` 时降级，不会抛错）。
  - 申请通过后，把下面两段加回 `app.json` 即可启用定位签到：

    ```json
    "requiredPrivateInfos": ["getLocation"],
    "permission": {
      "scope.userLocation": {
        "desc": "用于为你推荐附近的图书馆座位与签到定位"
      }
    },
    ```
  - 代码侧无需改动：`getLocation` 的声明缺失、隐私协议未同意、用户拒绝授权、系统定位关闭等分支都已分别给出提示。
  - 若不打算申请，可进一步隐藏入口：`pages/profile/profile.js` 菜单里的「定位签到」项、`pkgUser/checkin/checkin.wxml` 的「使用定位签到」按钮。
- **字体加载**：`utils/font-loader.js` 未配置字体 URL 时不发起任何网络请求；配置后需在微信后台把字体域名加入 downloadFile 合法域名。
- **配置来源**：云环境 ID 硬编码于 `app.js` 的 `wx.cloud.init`；更换环境时需同步修改并重启开发者工具模拟器。
