# Changelog

All notable changes to this project will be documented in this file.

## [3.2.0] - 2026-10-01

### Added — QQ 官方机器人通道（QQ 开放平台 Agent 接入）

新增 `lib/qqbot.mjs`，一条**合规、无需额外 QQ 号**的 QQ 通道。

| 项 | 说明 |
|---|---|
| 接入方式 | 官方 SDK `@tencent-connect/qqbot-nodejs` + **WebSocket 长连接** |
| 公网依赖 | **无** —— 不需要公网入口、不需要备案 |
| 场景 | QQ 群聊 + 消息列表单聊 |
| SDK 体积 | 1.11 MB（**零新增依赖**，只用到已装的 `ws`） |

**能力**
- **扫码绑定**（`@tencent-connect/qqbot-connector`）：面板显示二维码 → 手机QQ扫码 →
  选择已有机器人并授权 → 凭据自动填入并连接。**全程不用复制 AppSecret**。
  （注意：扫码是**绑定已有机器人**，不会新建；创建须在开放平台网页完成）
- 手动填写 AppID / AppSecret（备用路径，含「打开创建页面」引导按钮）
- 命令：`/帮助` `/链接` `/启动` `/停止` `/监听` `/模型` `/状态`
- 监听推送（会话思考完毕 → 推到 QQ）
- 会话持久化（`FileKVStore`）→ 进程重启后可 RESUME 补发漏掉的消息
- 文本自动分片（上限 5000 字符，优先在换行处断开）
- 已接入统一的**通道健康监测**（红点 / 断开页 / 一键重连）
- 扫码流程带 **3 分钟超时保护**、**过期自动刷新**、**可取消**、**同一时刻只允许一个流程**

**健壮性措施**（本次特别关注）
- **动态 `import` SDK**：SDK 缺失或装坏只让本通道不可用，**不影响插件整体加载**
- **AppSecret 只存在通道闭包内**，不出现在 `status()`、HTTP 接口或日志里
- **`start()` 采用事件竞速而非 `await`**：SDK 的 `start()` 是长跑调用，直接 await 会永久挂起
- **手动实现一次性监听**：SDK 的 `QQBot` 不是 EventEmitter（只有 `on`/`off`，**没有 `once()`**）
- **错误分类**：`auth` / `network` / `rate-limit` / `rejected` / `sdk-missing` / `unknown`，
  含 QQ 侧真实报错格式（如 `10004 机器人不存在`）
- **启动期瞬时错误不判死**：只有鉴权类与缺 SDK 才快速失败，网络抖动继续等待就绪
- 事件回调全部包 `try/catch`，异常不会穿透进 SDK；`stop()` 幂等
- **推送目标持久化**：`lastTarget` 落地到 `store`，重启 DSH 后**无需再给机器人发消息**也能主动推送
  （与微信/飞书/Telegram 的 chatId 持久化行为对齐；非法 scope/targetId 会被 `setLastTarget` 拒绝）

### Changed

- 面板：`QQ官方` / `Telegram` / `飞书` / `钉钉` 通道不再显示无意义的通用「绑定 / 解绑」按钮
  （这些通道在各自表单里有专属的连接 / 断开按钮）
- 依赖新增：`@tencent-connect/qqbot-nodejs`、`@tencent-connect/qqbot-connector`

## [3.1.1] - 2026-09-30

### Changed（仅文档与声明，运行时行为不变）

- **更新 DSH 兼容性声明**：原写「适配 DSH 0.1.2-rc.1+」（写于 0.1.2-rc.1 为最新版时），现更新为
  **「0.1.2-rc.1 至 0.2.x（0.2.0-rc.2 实测）」**。
- **README 新增「兼容性」章节**（中英文）：DSH 版本支持表格 + 说明本插件
  **不 import 任何 `@deepseek-ai/*` 官方包**，宿主能力全部走 cordis 服务注入，
  因此 DSH 对**包级导出**的破坏性改动（如 0.2.x 移除 `dsh-settings` 的
  `settingsNamespace` / `installSettingsSection`）不影响本插件。

### 为什么 0.2.x 无需改代码

| 检查项 | 结果 |
|---|---|
| import 官方包 | 0 个（仅 Node 内置 + 内部模块） |
| 宿主能力来源 | `ctx.get(...)` / `ctx.inject([...])` 服务注入 |
| 需要跟进的宿主接口 | `session.snapshotEvents()`（0.1.2+ 形式，已适配） |

## [3.1.0] - 2026-09-13

### Added
- **Telegram 通道**（`lib/telegram.mjs`）：长轮询收发消息，支持 HTTP 代理、命令系统、监听推送、面板配置
- **三通道健康监测**：微信 / 飞书 / Telegram 各自独立监测，连续 3 次失败即自动停止
  - 远程图标显示红点告警
  - 断线时提供直达页面与「一键重连」按钮

### Fixed
- **面板按钮全部消失（关键）**：`INJECT_SCRIPT` 模板字面量中的 `\n` 被提前转义，导致注入脚本语法崩溃
- **作用域错误**：`channelHealthSnapshot` / `telegramStop` 在块内声明却在块外调用，触发 `ReferenceError`

### 测试
- 新增 `INJECT_SCRIPT` 编译校验，防止模板转义事故复发
- 新增作用域守卫测试，修复失效的 `test-dist` 导入

## [3.0.2] - 2026-09-13

### Fixed
- **监听失灵（关键）**：适配 DSH 新版 API —— `session.events` 属性已改为 `session.snapshotEvents()` 方法。旧代码读到的 `events` 是函数而非数组，导致会话完成检测永远不触发，监听完全失效。现按 `snapshotEvents()` 存在性自动适配，同时保留 `session.events` 数组的向后兼容。
- **飞书**：修复 access token 未正常返回的问题，增加鉴权失败重试
- **监听定时器**：改为幂等，避免重复启动多个轮询定时器

### Added
- **诊断接口** `/remote/diag`：暴露监控实时状态与通知结果记录，便于排查监听问题
- 监控流程补充诊断日志

## [3.0.1] - 2026-09-12

### Fixed
- **微信（iLink）**：增加业务错误检查，避免把失败响应当成功处理
- **微信（iLink）**：改为「先试后队」——优先直接投递，失败才入队等待补发
- **微信（iLink）**：发送失败的消息重新入队，不再静默丢失

## [3.0.0] - 2026-09-01

### Changed
- **适配 DSH 最新版**（`@deepseek-ai/dsh` ≥ 0.1.2-rc.1），修复新版 DSH 下无法正常使用的问题
- 新增适配 DSH 新版的改动（具体改动见各提交）

### Compatibility
- 适配 DSH 版本：`0.1.2-rc.1` 及以上
- 不再兼容旧版 DSH（< 0.1.2-rc.1）

## [2.0.0] - 2026-08-24

### Changed（模块化重构）
- **拆分巨石文件**：`index.mjs`（约2100行）拆分为 6 个职责单一的模块
  - `cert.mjs`：自签名证书生成
  - `download.mjs`：cloudflared 下载
  - `proxy.mjs`：HTTP/HTTPS 反向代理
  - `qq.mjs`：QQ OneBot 桥
  - `panel.mjs`：面板注入脚本
  - `store.mjs`：统一持久化存储
- **统一持久化**：散落的 `weixin-token.json`、`feishu-config.json`、`monitor-mode.json` 等统一到 `plugin-state.json`，旧文件自动迁移保留
- **监听状态按通道隔离**：微信/飞书独立开关、独立通知，新持久化格式兼容旧格式
- **错误处理统一**：8 处静默吞错补日志/注释，格式统一为 `[模块] 动作失败`
- **编码统一**：562 处 unicode 转义改为 UTF-8 中文（运行时字符串值不变）

### Fixed
- 隧道 URL 正则排除 `api.trycloudflare.com`（cloudflared 失败时错误输出被误抓为链接）

## [1.4.0] - 2026-08-19

### Added
- 飞书机器人：WebSocket 长连接收发消息，支持命令系统
- 飞书前端配置 UI：绑定表单 + 凭证验证 + 状态显示
- 飞书后端路由：凭证验证/持久化/状态查询
- 飞书命令：`/链接`、`/停止远程`、`/监听`、`/帮助`
- 监听模式通知同时发送飞书和微信
- DSH 启动通知同时发飞书和微信

### Changed
- 更新插件描述为"免配置公网隧道 + 局域网 HTTPS 直连 + 自定义公网链接/端口 + 微信/飞书机器人"
- 新增 dependencies: `@larksuiteoapi/node-sdk`

## [1.3.2] - 2026-08-19

### Changed
- 优化手机浏览器浏览体验

## [1.3.1] - 2026-08-19

### Changed
- 重构监听逻辑：提取 `startMonitor()` / `stopMonitor()` 函数，消除重复代码
- 监听模式持久化：重启 DSH 后自动恢复监听状态，无需重新发送 `/监听`
- 启动时自动恢复监听并发送通知

## [1.3.0] - 2026-08-19

### Added
- 自定义公网链接：面板支持填写/编辑/清除自定义公网 URL（如 ngrok 地址），持久化保存
- 自定义端口：局域网模式下支持修改 HTTPS 端口号（1024-65535），带端口占用检测，重启后生效
- `/监听` 命令：开启会话监听模式，Agent 思考完毕后自动通过微信推送结果
- `preview-panel.html`：面板 UI 预览页面，方便调试

### Changed
- 移除"QQ 机器人：施工中"提示
- 更新插件描述和关键词

## [1.2.1] - 2026-08-18

### Added
- README 顶部 banner 标题图
- 项目文档完善（CHANGELOG、贡献指南、Issue 模板）

## [1.1.0] - 2026-08-17

### Added
- 微信机器人：iLink 协议直连微信，支持扫码绑定、AI 对话

### Changed
- 远程面板 UI 重构：三标签页（公网 / 局域网 / 机器人）

## [1.0.0] - 2026-08-15

### Fixed
- 会话列表过滤（归档 / 子代理 / 孤儿会话）

## [0.5.0] - 2026-08-17

### Added
- 微信机器人：iLink 协议直连微信，支持扫码绑定、AI 对话
- 微信命令集：`/链接`、`/会话列表`、`/选择 N`、`/当前会话`、`/历史内容`、`/当前模型`、`/切换模型`、`/选强度 N`
- 微信非命令消息自动发送到选中会话
- Token 持久化：重启 DSH 后微信自动重连
- 会话级模型切换（通过 DSH RPC API）
- 会话列表过滤：自动排除归档会话、子代理会话、孤儿会话
- 聊天图标：QQ / 微信 / 钉钉 / 飞书 通道（官方品牌 SVG 图标）

### Changed
- 远程面板 UI 重构：三标签页（公网 / 局域网 / 机器人）
- 机器人页面：默认显示微信通道，支持绑定/解绑操作
- 公网链接显示：提示文字移到开头，换行显示链接

### Fixed
- 会话列表显示无标题会话的问题（过滤孤儿会话）
- 模型切换走会话级 RPC 而非全局默认

## [0.4.0] - 2026-08-15

### Added
- 局域网 HTTPS 直连（自动生成自签名证书）
- 局域网免 token 模式
- QQ OneBot 11 反向 WebSocket 桥接（基础框架）

### Changed
- 侧边栏图标改为内联 SVG，不再依赖外部字体

## [0.3.0] - 2026-08-14

### Added
- 公网访问：Cloudflare Quick Tunnel（自动下载 cloudflared）
- 远程面板：公网/局域网切换、一键复制、二维码扫码
- 启动/停止/换新链接控制
- gzip 压缩加速

## [0.2.0] - 2026-08-13

### Added
- 基础远程访问框架
- 安全认证（随机 token + HttpOnly Cookie）

## [0.1.0] - 2026-08-12

### Added
- 初始版本：DSH bundle 插件骨架
