# Changelog

All notable changes to this project will be documented in this file.

## [5.1.0] - 2026-10-04

### Added — 钉钉机器人通道（第五个通道）

企业内部应用 + 机器人 **Stream 模式**（长连接），不需要公网入口；与其它通道功能完全对齐。

| 位置 | 内容 |
|---|---|
| `lib/dingtalk.mjs` | **新增** `createDingTalkChannel`：就绪轮询、健康巡检、凭证预检、被动回复 + OpenAPI 主动推送、`lastTarget` 持久化；导出 `stripDingTalkMention` / `splitForDingTalk` / `classifyDingTalkError` |
| `lib/index.mjs` | 通道接线：状态/配置/重连/断开 4 条路由、13 条命令（含 8 项共享命令）、监听推送、启动自动连接与目标恢复、销毁清理、健康快照 |
| `lib/panel.mjs` | 钉钉并入统一的「重新绑定 / 断开」入口（不再有例外），新增凭证表单（AppKey/AppSecret + 验证并连接）、断开态一键重连、健康提示、开放平台入口 |
| 测试 | 新增 6 项守卫（#14–#19）：通道模块纯函数与 API 形状、**五通道命令对齐矩阵**、**监听守卫完整性**、钉钉接线、**SDK 用法守卫**、同步脚本文件清单 |
| 文档 | README / README_EN 新增「钉钉机器人」章节（接入步骤 + 排错），功能表与健康监测表补上钉钉 |
| 依赖 | `dingtalk-stream ^2.1.5`（此前已在 dependencies 中，本次真正用起来） |

**实现要点（都来自 SDK 源码 + 官方文档核对，改这块代码前务必先读 `lib/dingtalk.mjs` 顶部注释）：**

1. **机器人消息是 `CALLBACK` 类型**（topic `/v1.0/im/bot/messages/get`），必须 `registerCallbackListener(TOPIC_ROBOT, cb)`
   —— 只调 `registerAllEventListener` 会**收不到消息**；
2. **`CALLBACK` 不会自动 ACK**（SDK 的 `onCallback` 丢弃返回值），必须自己 `socketCallBackResponse(messageId, {response:null})`，
   且回调要**同步返回**、把耗时处理丢到 ACK 之后；
3. SDK 的 `connect()` **内部吞掉所有异常、永不 reject** → 不能靠它判断成功：先用 `access_token` 接口做凭证预检，
   再轮询 `client.connected/registered` 做就绪判定（超时归类为「应用未发布 / 未开 Stream 模式」）；
4. `keepAlive` 默认 **false**（半死连接发现不了）→ 显式打开；SDK 重连间隔硬编码 1 秒且无退避 → 重连日志限流；
5. 被动回复用消息自带的 `sessionWebhook`（**1.5 小时**有效，绝对毫秒时间戳），返回体 `{errcode,errmsg}` ——
   **HTTP 200 不代表成功**；过期自动回落 OpenAPI 主动推送；
6. `access_token` **自己缓存 7200 秒**（SDK 自带的 `getAccessToken()` 无缓存且走旧版 GET 接口，每次回调都调会被限流）；
7. 群聊 @ 前缀：官方样例显示**服务端已剥离**，只留前导空格 → 只 `trim()`，另加一层很保守的兜底
   （仅当残留 `@xxx ` 且后面是命令时才剥，避免吃掉「@张三 帮我看下」这类正文）；
8. 非文本消息（`picture/audio/video/file/richText`）**没有 `text` 字段**，直接取会抛 → 统一兜底并回一句提示；
9. 主动推送单聊 `userIds` 单次 ≤20、群聊 `msgParam` ≤15000 字节 → 文本按 4000 字自动分片；
10. 一个应用最多 50 条 Stream 连接、服务端随机挑一条推送 → 插件保持幂等，**两个 profile 不要同时跑**。

**接入前置条件：** 需要**企业/组织**（个人版钉钉不支持应用机器人），且要**发布应用**并申请
「企业内机器人发送消息权限」（仅用被动回复可不申请）。

### Fixed — 监听开关的守卫漏通道（存量 bug）

关闭某个通道的监听时，各通道各写各的判断，导致 **关掉飞书会把 Telegram / QQ官方 的监听一起停掉**：

| 位置 | 原判断 | 问题 |
|---|---|---|
| 关 Telegram | `!weixin && !feishu` | 漏 qqbot |
| 关飞书 | `!weixin` | 漏 telegram / qqbot |
| 关微信 | `!feishu` | 漏 telegram / qqbot |
| 监听循环自检 | `!weixin && !feishu` | 漏 telegram / qqbot |

现在统一为 `anyMonitorOn()`（5 个通道一处判定），并加了**形态守卫**：一旦再出现
`!xxxMonitorMode && !yyyMonitorMode` 这类字面量判断，测试直接失败。
另外微信 `/状态` 现在会列出全部 5 个通道的监听开关。

### Fixed — 监听发送结果会被微信分支覆盖（排查时被它误导过）

`monitorLastSendResult` 的写入方式不一致：**微信分支是直接赋值（覆盖）**，飞书/Telegram/QQ/钉钉
都是追加。于是"最后一次发送结果"里可能整段看不到某些通道的记录 —— 实测中我据此
误判过一次"钉钉的监听通知没推出去"（其实用户收到了）。现在全部改为追加，
并新增测试守卫 #20：任何一处通道写入若不是"追加"形态，测试直接失败。

同时给监听加了**轮次归档**：各通道是异步回报的，只保留"最后一条"会被下一轮覆盖，
现在 `/remote/diag` 的 `monitor.sendHistory` 保留最近 5 轮（时间 + 标题 + 各通道结果），
间歇性"没推"的那一轮也能查。

> 守卫 #20 自己还踩了一次 CRLF：仓库是 CRLF，而 JS 里 `.` 不匹配 `\r`、`$` 必须在串尾，
> 所以 `(.*)$` 对 CRLF 行一行都匹配不到（守卫会**假绿**）。已改为按 `/\r?\n/` 切行。

### Changed

- 面板底部提示补上 `/选强度`，并说明钉钉走 Stream 模式、群聊需要 @机器人
- 钉钉通道卡片文案：`钉钉机器人 Webhook 接入` → `钉钉机器人 Stream 接入`
- `tools/sync-dsh-web-remote.ps1` 文件清单加入 `lib\dingtalk.mjs`（漏一个文件部署副本就是旧的）；
  同时给它补了 **UTF-8 BOM** —— 之前无 BOM，Windows PowerShell 5.1 会按 GBK 读脚本，
  中文被解析坏导致脚本**根本跑不起来**
- **监听推送可诊断**：`/remote/diag` 现在列出 5 个通道的监听开关，并附上钉钉通道自述
  （`pushCount` / `lastPushAt` / `lastPushTarget` / `lastPushError`）；
  监听通知跳过钉钉时写明原因（`通道实例不存在` / `通道已断开` / `还没有会话目标`），
  不再像以前那样只看到别的通道、完全不知道钉钉为什么没推
- 钉钉通道的主动推送与被动回复**分开记账**（`pushCount`/`lastPushAt` vs `lastSentAt`），
  避免"回复通了"被误当成"监听通知也通了"
- 面板标题「远程访问」右侧新增**版本徽标**（`v5.1.0`，来自 `/remote/info` 的 `version`）：
  字号为标题的一半（`.5em`）、内边距 1px（约一个笔画宽）、圆角 `2px 2px 2px 0`
  （上两角与右下圆、左下直角）、实底 + 镂空字；
  底色用 `label-primary`、字色用面板底色 token → 浅色主题"黑底白字"、深色主题自动反色成"白底黑字"
  - 版本号**自动跟随 `package.json`**：`index.mjs` 运行时读同包上一级的 `package.json`，
    读不到才退回兜底常量（`PLUGIN_VERSION_FALLBACK`）—— 发版只需改 `package.json` 一处。
    守卫 #21 用 `import` 取运行时的真实解析值来断言（不是去源码里抠字面量）；
    实测把 `package.json` 改成 `9.9.9-test`，解析值立刻跟着变、测试仍全绿
- 标题下划线：从 `border-bottom` 改为容器 `::after`，粗细 **2px**（≈标题笔画粗细）、
  右端收 2px 圆角与徽标右下圆角对齐；
  **线画在容器的 padding 区**（容器 `padding-bottom:2px` + 线的 `bottom:0`），紧贴字形底、0px 重叠
  - 踩坑记录：最初把线放在容器内部（`bottom:2px`），**压进了字形** ——
    19px 中文字形墨迹几乎占满 22px 行框（离行框底只剩 1px），容器内没有容纳 2px 线的空间。
    像素实测：线盖住字底 3 行、字的底边还从线下面露出来。
    挪到 padding 区后实测「字形墨迹末行 43 / 下划线 44..45 / 间隙 0px / 不压字」

## [5.0.0] - 2026-10-03

### Removed — QQ（NapCat / OneBot 11）通道整体移除（**破坏性变更**）

按使用者要求移除该通道。QQ 接入现在**只剩「QQ 官方」一条路**。

删除内容：

| 位置 | 内容 |
|---|---|
| `lib/qq.mjs` | OneBot 11 反向 WebSocket 桥（整个文件删除） |
| `lib/index.mjs` | `createQQServer` 导入、`qqServer`/`qqPort` 变量、`start()` 里的启动块、`stop()` 与关闭钩子里的清理、快照字段 `qq`、配置项 `qqPortStart` |
| `lib/panel.mjs` | 机器人页的 `QQ` 通道条目、`botChannelStatus` 的 `qq` 分支、通道名映射、面板提示文案 |
| 测试 | 原「7. QQ 桥」用例改为**移除守卫**：断言 `lib/qq.mjs` 不存在、且 index/panel 里不再残留 `createQQServer` / `qqServer` / `qqPortStart` / `NapCat` / `OneBot` |
| 文档 | README / README_EN 删除 `qqPortStart` 配置行与「两通道共存」说明 |
| 工具 | `tools/sync-dsh-web-remote.ps1` 的文件清单移除 `lib\qq.mjs` |

**对既有用户的影响**：若 `cordis.patch.yml` 里配过 `qqPortStart`，该字段会被忽略（不再报错）。
状态文件里遗留的 QQ 桥数据不会被读取。

### Fixed — QQ官方 图标错误

「QQ官方」通道此前用的图形与 QQ 品牌图标不符；现改用 **QQ 企鹅图标**
（原先 NapCat 通道在用的那枚，随通道移除一并迁移过来）。

### Changed — 面板提示文案同步更新

机器人页底部提示改为列出当前实际支持的通道与完整指令集
（微信 / 飞书 / 纸飞机 / QQ官方 / 钉钉）。

## [4.1.0] - 2026-10-02

本版主题：**各通道指令集对齐** —— 此前只有微信通道做全（13 项），
Telegram / QQ官方 / 飞书 只有 6~7 项，且**只有微信能把普通消息转发进会话**。

### Added — 跨通道共享指令（把微信的指令集补到其他端）

| 通道 | 改前 | 改后 |
|---|---|---|
| 微信 | 13 项（基准） | 13 项（不变） |
| Telegram | 7 项 | **13 项** |
| QQ 官方 | 7 项 | **13 项** |
| 飞书 | 6 项（连 `/状态` 都没有） | **13 项** |

新增到三个通道的指令：

- `/会话列表` —— 列出可见会话（过滤归档 / 子代理 / 孤儿会话）
- `/选择 N` —— 选中第 N 个会话
- `/当前会话` —— 查看选中的会话
- `/历史内容` —— 查看选中会话最近一次输出
- `/切换模型` + `/选强度 N` —— 多步切换模型与思考强度
- **非命令文本 → 转发进选中会话**（此前其他端只能被动收通知，无法反向操作）
- 飞书额外补上 `/状态`

### Changed — 抽出公共实现，避免四个通道各写一遍

新增（`lib/index.mjs`）：

```
visibleSessionRecords()  会话列表过滤（归档/子代理/孤儿）
cmdSessionList()         会话列表文本
cmdSelectSession(st, n)  选中会话
cmdCurrentSession(st)    当前会话
cmdHistory(st)           最近输出
cmdCurrentModel(st)      当前模型（优先选中会话的，回落全局默认）
cmdSwitchModel(st, arg)  多步切换模型
cmdPickEffort(st, arg)   选择思考强度
cmdRelayToSession(st, t) 非命令文本转发进会话
channelHelp(name)        各通道统一帮助文本
```

每个通道传入自己的状态对象 `{ selected, pick }`（`telegramCmdState` / `qqbotCmdState` / `feishuCmdState`）。

- `switchModel(provider, model, effort, sessionId)` 增加可选第 4 参；
  **不传时仍回落到微信的选中会话**，旧调用点行为不变（向后兼容）。
- 微信通道保留其原有内联实现（它是基准，不动以免回归）；两边逻辑一致，
  将来若要收敛，把微信那几段换成调用本组函数即可。

## [4.0.0] - 2026-10-02

本版主题是 **支持 DSH 官方桌面版**，并重做了面板在两端（浏览器 / 桌面版）的按钮布局与局域网链接形态。

> **为什么是 4.0.0**：新增了一个运行平台（官方桌面版），且面板交互形态有明显变化
> （局域网由"一条链接"改为"并列两条"、按钮改到独立整行）。运行时对既有配置**向后兼容**
> （`/remote/set-port` 的 `kind` 缺省仍为 `https`；`targetPort` 显式配置仍然最优先）。

### Fixed — 局域网链接必然撞自签名证书（面板只给 HTTPS 一条）

**问题**：局域网面板只渲染一条链接，且只要有 `httpsPort` 就一律拼成 `https://`：

```js
url: (info.httpsPort ? 'https://' : 'http://') + ip + ':' + (info.httpsPort || info.port)
```

而 HTTPS 用的是**自签名证书**，浏览器必然拦下：

```
-202: ERR_CERT_AUTHORITY_INVALID
```

用户照抄面板给的链接 → 一定打不开，看起来像"远程连接坏了"。

**修复**：局域网并列给**两条**，各标用途 ——

| 链接 | 说明 |
|---|---|
| `http://ip:<httpPort>/` | **推荐 · 免证书**，浏览器直接打开（非安全上下文，剪贴板 API 等受限） |
| `https://ip:<httpsPort>/` | 自签名证书，浏览器提示不安全，需手动「高级 → 继续前往」（安全上下文） |

同时：
- 扫码二维码改为指向 **HTTP** 地址（手机扫码后直接能开，不撞证书拦截页）
- 点击复制改挂在**各自的链路元素**上（原先挂在容器、且写在 `forEach` 里，两条链接会互相触发，复制内容不可预期）

### Added — HTTP / HTTPS 端口可分别自定义

原先只有 HTTPS 端口能改（`/remote/set-port` 只认 `customPort`）。现在：

- `/remote/set-port` 接受 `{ port, kind }`，`kind: 'http' | 'https'`（缺省 `https`，兼容旧调用）
- 两个端口分别持久化：`customHttpPort` / `customPort`
- **同端口冲突提前拦截**并给出明确提示（HTTP 与 HTTPS 是两个独立监听，不能同端口）
- 局域网面板渲染两行可编辑端口，改完自动 `stop() + start()` 使新端口立即生效

> 想让局域网用 `http://192.168.x.x:5555/`？把 HTTP 端口设为 5555、HTTPS 另换一个即可
> （例如 HTTPS 设 5556）。

### Fixed — 官方桌面版里「远程」按钮完全不显示

**问题**：只注册了 `webServer.tapIndex`（旧 API，字符串替换 index.html）。
`dsh-host-webserver` 的注释写得很清楚：结构化注入行同时喂给**两个渲染器** ——

> *"one table feeds two renderers: the served form renders rows into the index.html
> text, and a **static worker deployment** ships the same rows over its boot
> payload for a page-side interpreter. Anything not expressible as a row stays on
> `tapIndex`, which runs after row rendering."*

**DSH 官方桌面版走的是「静态部署」那条路**（窗口地址 `dsh-app://app/`），
只消费**结构化注入行**，**不跑 `tapIndex`** —— 所以脚本根本没进页面：

```
浏览器 devtools: location.href === 'dsh-app://app/'
                 document.getElementById('webrm-native') === null
```

表现：`dsh web` 在浏览器里一切正常，桌面版里按钮完全不出现。

**修复**：改为**同时**使用两条通道（照抄官方 `dsh-client-shortcuts` 写法）——

```js
ctx.on('webserver/index-inject', (table) => {
  table.push({ kind: 'script', placement: 'body', text: INJECT_SCRIPT });
});
```

- **结构化注入行**：served 形态 + 静态部署形态（桌面版）都覆盖，主通道
- **`tapIndex`**：保留为老版本 DSH 的兜底
- `INJECT_SCRIPT` 开头新增 `window.__webrmLoaded` 一次性守卫：两条通道同时生效也不会重复初始化
  （否则会多出定时器与 MutationObserver）

### Added — 目标端口自动探测（支持 DSH 官方桌面版）

**问题**：插件把 `targetPort` 默认写死为 `3080`（当时 `dsh web` 固定用这个端口）。
但 **DSH 官方桌面版由宿主动态分配端口**（`dsh-host-webserver` 注释明确写着
"the OS-assigned value when `config.port` is 0"），实测为 `19387`。

写死导致的连锁故障：

| 现象 | 原因 |
|---|---|
| 隧道 **502 Bad Gateway / Host Error** | cloudflared → 插件代理(3081) → 转发到 **3080**（已无服务） |
| DSH token 读取失败 | `connection.authenticatedUrl('http://127.0.0.1:' + targetPort)` 也用了错的端口 |
| 微信/飞书/QQ 通道正常 | 它们直连平台，不经过该代理，掩盖了问题 |

**修复**：目标端口按优先级探测 ——

1. 显式配置 `targetPort`（有则最优先，保持可覆盖）
2. 环境变量 `DSH_WEB_URL` 里解析端口
3. 环境变量 `DSH_PORT`
4. 兜底 `3080`

> 实测：桌面版的插件进程里**看不到** `DSH_WEB_URL`（那是 harness 注入给 agent shell 的），
> 因此桌面版需要在 profile 的 `cordis.patch.yml` 里显式指定：
> ```yaml
> - id: web-remote
>   name: dsh-web-remote
>   config:
>     targetPort: 19387
> ```

新增 `/remote/info` 字段 `targetPort` 与 `portSource`（`config` / `env` / `default`），
便于以后判断端口来源。

### Fixed — 隧道创建失败会连带停掉已就绪的局域网

**问题**：`start()` 里公网隧道（cloudflared / trycloudflare）与 QQ 桥是**串行且致命**的 ——
隧道创建超时（trycloudflare 偶发慢或不可达）会抛异常，把**已经启动成功的局域网代理一起 `stop()` 掉**。

表现：明明只想用局域网，结果整个远程服务全废，看起来像"插件坏了"。

**修复**：隧道与 QQ 桥改为**非致命** —— 失败只记 `state.error` 并继续，局域网保持可用，
面板照常显示局域网链接与端口。

### Fixed — 面板脚本被浏览器缓存，改了看不到效果

**问题**：面板脚本（`INJECT_SCRIPT`）嵌在 `index.html` 里返回，而代理层没给 HTML 设缓存头。
浏览器缓存整页后，**重启 DSH 也还是跑旧脚本** —— 表现是"我改了代码但页面没变"，
极易误判成代码没生效（本版开发期间就踩过）。

**修复**：对 `text/html` 强制 `no-store`。

### Changed — 面板「远程」按钮改到「设置」行下方的独立整行

按钮原先插在「设置」行所在的**横向 footer** 里，两端表现都不理想
（浏览器里被父级 flex 拉宽、桌面版里挤到窗口中间看不见）。

现在统一为：**在「设置」行下方独立成行**，宽度跟随容器，并持续跟随原生按钮的高度 / 圆角 / 字号自适应。

> 这一项经过多轮实测修正（尺寸参照选择、插入位置、父级 flex 收缩、瞬时测量污染等），
> 最终形态是"两端观感一致 + 不再挤压原生控件"。

### Tests

新增第 13 项守卫：**反引号守卫** —— 断言 `INJECT_SCRIPT` 里的模板字符串定界符数量正确，
防止注释里的反引号把模板字符串截断（本版开发期间踩过，症状是整段注入脚本编译失败）。

## [3.2.2] - 2026-10-02

### Fixed — 3.2.1 的「写放大优化」把目标持久化改成了静默失效

3.2.1 为了解决热路径写放大，在调用方的 `onMessage` 里加了去重比较：

```js
const cur = qqbotChannel.getLastTarget();          // ← 此时已是被覆盖后的新值
if (!cur || cur.scope !== msg.scope || ...) { ... } // ← 恒为 false
```

但通道在调用 `onMessage` **之前**就已把新目标写进自己的 `state`（`qqbot.mjs`
`handleMessage` 中先 `state.lastTarget = …`，后 `await onMessage(…)`），
因此该比较**恒等** → `qqbotSaveConfig` **永远不执行** → 目标从不落盘。

表现与修复前完全一样：**重启 DSH 后仍必须先给机器人发一条消息**，主动推送才生效。
而且这段代码"看起来是对的"，9 项测试也全过（这块当时没有任何覆盖）。

### Changed

- **变更判断移入通道**（信息最全的地方）：新增导出纯函数 `targetChanged(prev, next)`，
  通道用**覆盖前的旧值**比较，只有真正变化时才触发新回调 `onTargetChange`。
- `index.mjs` 改为通过 `onTargetChange` 持久化，`onMessage` 里不再落盘
  （那里拿不到旧值，比较必然失效）。
- 写放大的问题**同时仍然解决**：目标不变时不落盘。

### Added — 回归测试（本块此前覆盖为 0）

| # | 测试 | 作用 |
|---|---|---|
| 10 | `targetChanged` 真值表（9 例） | 覆盖本次出错的判断逻辑，含数字/字符串 targetId 视为同一目标 |
| 11 | `setLastTarget` 入参校验（6 例） | 拒绝 null / 缺字段 / 非法 scope |
| 12 | **落盘路径守卫** | 断言 `onMessage` 里不得出现 `qqbotSaveConfig` 或 `getLastTarget`，且 `onTargetChange` 必须接线 |

第 12 项是**形态守卫**（对着 3.2.1 的 bug 形状写的），并已自检：
对「修复版 / 塞回落盘 / 塞回 getLastTarget / 删掉接线」四种输入分别为
通过、拦下、拦下、拦下 —— 既不过严也不失效。

## [3.2.1] - 2026-10-02

### Fixed — QQ 推送目标持久化的三个补漏

3.2.0 引入的 `lastTarget` 持久化只覆盖了部分启动路径，本版补齐。

- **「一键重连」路径漏了目标恢复**（`lib/index.mjs` 的 `qqbotReconnectHandler`）：
  面板点「断开」再点「一键重连」时通道会重建，但推送目标没挂回去 ——
  表现为主动推送失效，直到有人再给机器人发一条消息。此前只在配置保存 / 扫码绑定 /
  重启启动三条路径上调用了恢复。
- **断开时未清理旧目标**（`qqbotDisconnectHandler`）：
  断开后换另一台机器人的凭据再启动，会把**上一台机器人**的 `lastTarget` 恢复回来。
  QQ 侧的 `targetId` 是按机器人隔离的 openid，旧值对新机器人无效，只会让主动推送持续报错。
  现在断开时一并写入 `lastTarget: null`（`store.save` 是 deepMerge，赋 `null` 即整棵清除）。
- **热路径写放大**：`onMessage` 原先**每条消息**都无条件落盘一次整个状态文件。
  现在与 `getLastTarget()` 比较，**只在目标真的变化时**才写。

### 说明

- 运行时行为只在这三处变化，其余与 3.2.0 一致。
- `lastTarget` 为 `null` 时所有读取点（恢复逻辑、`getLastTarget()`、`status()`）均已确认安全。

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
