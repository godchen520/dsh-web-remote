# Changelog

All notable changes to this project will be documented in this file.

## [5.7.1-dev.3] - 2026-10-09

### Removed — 删掉 `@media(max-width:768px){html{zoom:80%}}`（"移动端视觉缩小"）

用户决定：**"去掉 80%，现在没有侧边栏，而且设置里有官方的字体大小设置，不需要 80% 了。"**

删它的**技术理由**比视觉理由更硬 —— 它对 `vw` 的破坏已经在上一版被真机坐实：

> 真机取证：`innerWidth=715`、官方已判 `fullscreen`、面板实际只有 **572 = 715 × 0.8**、
> 左边缘 **143 = 715 − 572**。即 `100vw` 解析成**未缩放的** 715，元素再按 80% 渲染。

而官方在窄屏恰恰用 `width:100vw` 给右侧栏全屏 —— 所以这条 zoom 让右侧栏**永远铺不满**。
更糟的是 `zoom` 只在 `<=768px` 生效，**只在手机上出问题**，`>=768` 的窗口看着一切正常，
排查成本极高（我为它白修了一版）。

**结论**：根节点 `zoom` 是个会破坏 `vw`、`fixed`、媒体查询的坑，不要用。
要放大请走官方设置里的字体大小。守卫 #39 新增 ⑪：**panel.mjs 里再出现根节点 zoom 直接判失败**。

已删除 `mobileTag` 那段；其余适配层规则**不依赖 zoom**（都是 px / `inset` / `grid-column`），
所以这次删除不影响去竖栏、把手、设置弹窗重排、右侧栏铺满。

> 右侧栏那条 `position:fixed + inset:0` **保留**：zoom 删除后官方自己的 `100vw` 理应也能铺满，
> 但这条不依赖 `vw` 的实现是一层保险（守卫里也禁止它用 `vw`）。

## [5.7.1-dev.2] - 2026-10-09

### Fixed — 手机上打开右侧栏没有真的全屏（顺便做了现场取证）

用户反馈："手机打开右侧栏明明是全屏模式，但右侧栏没有真的全屏。"

**根因在官方**（`dsh-client-ui-sidebar-right`）：

```js
const autoFullscreen = viewportWidth < 768;   // viewportWidth = window.innerWidth
const fullscreen = autoFullscreen || surface?.layout.mode === "fullscreen";
const track = shown && !autoFullscreen;       // 不全屏时它才要一条轨道
style: { width: fullscreen ? "100vw" : width }
```

也就是说**只有 `window.innerWidth < 768` 时它才给自己 `100vw`**。一旦 ≥768，右侧栏走 "push"
模式：按 `width` 给一个部分宽度、以 `position:absolute; right:0` 挂在右侧栏列的右边缘上 ——
而那条列在手机上恒为 0 宽轨道（`computeColumns`：`available = viewport - s - 400 < 300 → r = 0`），
于是它变成"盖住一半对话"的样子。

**修法**：适配层按官方自己的属性强制全屏，但**不能用 `vw`** ——

```css
body.webrm-mobile [data-sidebar-right-panel="fullscreen"]{
  position:fixed !important;inset:0 !important;width:auto !important;max-width:none !important
}
```

### ⚠ 差点改错：`html{zoom:80%}` 会把 `vw` 打坏

**第一版修法是 `width:100vw !important`，被真机取证直接否掉。**

探针在真机上抓到两条（都是桌面 Edge 窄窗）：

| innerWidth | DSH 模式 | 面板实际宽 | 面板左边缘 | 内联网格 |
|---|---|---|---|---|
| 819 | `push` | 819 | 0 | `56px minmax(400px,1fr) minmax(0px,388px)` |
| **715** | `fullscreen` | **572** | **143** | `56px minmax(0px,1fr) minmax(0px,0px)` |

看第二条：**`572 = 715 × 0.8`**，`143 = 715 − 572` —— **0.8 就是我们自己注入的
`html{zoom:80%}`**。

即：`zoom` 生效时，`100vw` 解析成**未缩放的**视口宽（715），而元素按 80% 渲染 → 只剩 572。
官方让右侧栏全屏用的恰恰是 `width:100vw`，所以**是我们这条 zoom 规则把它的全屏打坏的**
（我的 `width:100vw !important` 自然也一起被坑）。

而 `zoom` 只在 `@media(max-width:768px)` 生效 —— 所以 ≥768 的窗口看着一切正常（819 那条就是），
**只有手机上出问题**。

改用 `position:fixed + inset:0`：走 ICB（zoom 感知），完全不碰 `vw`。

> **推论**：任何在 `<=768px` 下依赖 `vw` 的官方布局都会少 20%。这条 zoom 规则是历史上
> "手机上某些东西莫名偏窄"的一个系统性嫌疑，后续再遇到类似症状先怀疑它。

### 同时补上右侧栏现场取证

这次的教训是**判断依据在"打开右侧栏那一刻"才产生**（`innerWidth` 与 768 的关系），
而原来的上报只在页面加载时发两条 —— 永远抓不到那个现场，于是"为什么没全屏"又只能猜。

新增 `rightbarProbe()` + `watchRightbar()`：盯着 `data-sidebar-right-panel` 一出现就立刻
同步一次，并把 `innerWidth` / `clientWidth` / 面板模式（fullscreen 还是 push）/
面板实际宽度与位置 / 轨道的 `grid-template-columns` 一并回报（最多 3 次）。

顺带**推翻了一个我自己的错误假设**：我原本怀疑 `html{zoom:80%}` 会把 `window.innerWidth`
放大 1.25 倍从而越过 768 —— 真机取证显示 `w=616 dw=616`（相等），现代 Chrome 的 `zoom`
**不会**影响 `window.innerWidth`。差点按错的方向改。

## [5.7.0] - 2026-10-08

### Fixed — 展开把手响应有延迟（收起/展开后要等一会才变）

用户实测："侧栏按钮显示有延迟，打开侧栏要过一会才消失，关闭侧栏也要等一会才出现。"

**根因是适配层重构时删过头了。** 原来有一条挂在 AppFrame 上的 `MutationObserver`
监听 `['style', 'data-sidebar-collapsed']` —— 收起/展开会**立刻**触发同步。
重构时我认为"body 上那条 class 观察器应该能覆盖"，就把它删了；结果那条观察器的
回调是 `updateVisibility`（远程按钮的显隐），**根本不调 `syncMobileAdapt`** ——
于是把手显隐只剩 2 秒的定时兜底，最多要等 2 秒。

**修法**：补一条只盯收起状态的观察器 `watchCollapseState()`：

```js
collapseObs.observe(document.body, {
  attributes: true,
  attributeFilter: ['data-sidebar-collapsed'],
  subtree: true,
})
```

为什么盯 `data-sidebar-collapsed` 而不是 `class`：

- 布局层渲染的是 `"data-sidebar-collapsed": sidebarCollapsed || void 0` ——
  **收起时属性在场、展开时被移除**，一次切换只触发一次
- 盯 `class` 会被任意 hover / 动画 / 主题切换刷爆，白白重算
- 挂在 `document.body` 的 subtree 上，所以 React 整棵重挂也不会漏

定时兜底保留，但注释里写明了**它只是兜底，不能用来响应收起/展开** —— 这次踩的就是
"把兜底当成了主路径"。守卫 #39 新增 ⑨ 断言这条观察器存在、盯的属性正确、且确实被调用。

### Changed — 移动端适配层重写：改用「语义后缀 CSS + body class 作用域」，并修掉设置弹窗被挤扁

两项用户反馈一起处理：

1. 手机上侧边栏收起后那条竖栏仍然占位置（5.6.x 已修，这次是**换实现**）
2. **"手机端的设置页面被挤压的难以使用"** —— 设置弹窗里主题卡被挤成竖排

#### 一、去竖栏：JS 改写内联样式 → 纯 CSS `!important`

原来靠 JS 改写 AppFrame 的**内联** `grid-template-columns`，还要挂 observer 防 React 写回、
用 `data-webrm-rail` 标记做幂等。现在改成一条纯 CSS 规则：

```css
body.webrm-mobile [class$="_frame"]:has([class*="_centerCol"])[data-sidebar-collapsed]{
  grid-template-columns:0 minmax(0,1fr) 0 !important
}
```

`!important` 本来就能压过内联样式 —— 于是**整套「写→被写回→再写」的循环和幂等标记全部删掉**，
`syncMobileRail` 缩成只切两个 body class 的 `syncMobileAdapt`。

#### 二、补上三条 `grid-column` 钉轨规则（这是原来漏掉的隐患）

官方**收起态的侧边栏是绝对定位浮层**，会脱离网格流 —— 于是中间的 `centerCol` 会
**自动落到那条已经变成 0 宽的第一轨道**上，把对话挤成 0 宽，而且是**间歇性**的
（rail 在 relative/absolute 之间切）。所以必须逐列显式钉住：

```css
…[class*="_sidebarCol"]{grid-column:1/2}
…[class$="_centerCol"]{grid-column:2/3}
…[class$="_rightbarCol"]{grid-column:3/4}
```

⚠ 第三条是 **`_rightbarCol`**。参考实现（`dsh-remote-web-ui`，Apache-2.0）写的是
`_detailsCol`，但那个后缀**在本版 DSH 里不存在**（逐包核实过），照抄会让右侧栏失去约束。

#### 三、选择器策略：结构嗅探 → 语义后缀

CSS Module 的类名是「**哈希前缀 + 语义后缀**」（`pI_x6G_centerCol`），所以用
`[class$="_centerCol"]` 这种**属性后缀选择器** —— 官方重建只换哈希时依然有效。
比原来"扫全文档找带内联 grid 的 div"稳得多，也便宜得多。

两个踩到的细节：

- `_frame` 在 **6 个包**里都有（聊天气泡、缩略图、subagent pill…）→ 必须加
  `:has([class*="_centerCol"])` 限定成 AppFrame
- `navCell` 是 `clsx()` 拼出来的（可能带第二个类）→ **后缀匹配会失配**，改用包含匹配
  `[class*="_navCell"]`

#### 四、设置弹窗窄屏重排（用户反馈的那个问题）

官方设置弹窗是**固定宽的两栏**（左导航固定 188px + 右内容 `flex:1`）。窄屏下内容列
只剩 ~240px，里面还要摆三张主题卡 → 文字只能竖排折行。窄屏改成纵向堆叠、导航变横向可滚动一条：

```css
body.webrm-mobile [class$="_overlay"] [class$="_panel"]{flex-direction:column;max-height:calc(100dvh - 32px)}
body.webrm-mobile [class$="_overlay"] [class$="_panel"] [class$="_nav"]{flex-direction:row;…;overflow-x:auto}
body.webrm-mobile [class$="_overlay"] [class$="_panel"] [class$="_navTitle"]{display:none}
body.webrm-mobile [class$="_overlay"] [class$="_panel"] [class$="_navList"]{flex-direction:row;gap:4px}
body.webrm-mobile [class$="_overlay"] [class$="_panel"] [class*="_navCell"]{height:34px;padding:0 12px;flex:none;border-radius:10px}
body.webrm-mobile [class$="_overlay"] [class$="_panel"] [class$="_content"]{flex:1;min-height:0}
```

⚠ **必须限定在 `body.webrm-mobile` 下**：overlay 这个 portal 层是**所有弹窗共用的**，
而适配样式表常驻 `<head>` —— 不加作用域会把**桌面端的设置面板也压成竖排**。

**为什么不走"缩放"这条路**：把页面 zoom 调到 50% 确实能让弹窗布局正确（用户实测），
但那是**全局缩放**，主界面文字会一起变小 —— 用一个问题换另一个问题。
而**只给弹窗加 zoom 没有用**：宽度是父级给的，缩放子元素改变不了它拿到多少布局宽度。
所以这里改的是弹窗的**布局**（谁占多宽），**字号一点不变**。

#### 五、浮动把手钉死左上角

原来量原生开关的高度、把把手钉在同一高度。现在直接钉左上（带 `env(safe-area-inset-*)`
避开刘海），并给标题行让出 52px，免得压住标题：

```css
#webrm-railopen{position:fixed;top:calc(4px + env(safe-area-inset-top));left:calc(8px + env(safe-area-inset-left));…}
body.webrm-mobile.webrm-rail-hidden [class$="_titleRow"]{padding-left:52px}
```

那套测量逻辑（`railAnchorPct` / `rememberRailAnchor`）随之删除。

#### 六、守卫 #39 重写 + 新增一条"注入脚本必须能独立解析"

重构期间踩到一个**只有新守卫能抓的坑**：`panel.mjs` 整体是反引号模板字符串，
我在注释里写了一个反引号（`` `pI_x6G_centerCol` ``）→ **整个注入脚本被截断**，
而 `node --check` 只查宿主文件、完全查不出来。新守卫 ⓪ 直接
`new Function(INJECT_SCRIPT)`，一秒抓到。

⚠ 守卫取的是**求值后**的 `INJECT_SCRIPT`，不能拿模板原文切片：模板里有 `\\'` 这类转义
（例如字体名 `\'SF Pro Text\'`），原文切片喂给 `new Function` 会误报。

另外守卫现在会先**剥掉注释**再做标识符断言 —— 之前连踩三次误报，都是因为注释里
**正当提到**了某个名字（"参考实现用的 `_detailsCol` 在本版不存在"）。

## [5.6.5] - 2026-10-07

### Changed — 展开把手的图标改成与原生收起按钮一致

用户要求："这个按钮能不能改成收起的按钮一样的图标"。

DSH 原生切换按钮用的是 `IconPanelLeftOutlineRegular`（"面板左"：带左侧分隔线的圆角矩形），而我把手原来是自己画的**右箭头小三角**（`polyline 9,6 15,12 9,18`），确实不是一个东西。

**做法不是照着画一个"看起来像"的，而是运行时照抄它的 svg：**

```js
var icon = b.querySelector('svg[class*="panelIcon"]') || b.querySelector('svg');
railIconMarkup = icon.outerHTML;   // 抄到就不换了
```

这样 DSH 换图标时我们也跟着换，不需要跟着改代码。

**关键细节：只在展开态抄。** 收起态那个按钮里除了 panelIcon 还混着一个品牌标记（`railMark` / 鲸鱼 logo，`!wide && !windowsTitlebar` 时才渲染），而且那时的图标是"打开"语义 —— 抄错了就不是用户要的那个。类名是哈希的（`hHd-Xa_panelIcon`），所以按**后缀嗅探**而不是写死全名。

默认图标也换成同族的"面板左"（带 `rect` + 左侧 `line` 的圆角矩形），这样即使还没量到原生按钮，观感也一致。

**守卫 #39 扩充**：断言存在 `learnRailIcon`、只在展开态抄、优先认 `panelIcon`、且默认图标不是那个右箭头小三角。

## [5.6.4] - 2026-10-07

### Fixed — 展开把手与原生收起按钮离得太远

5.6.3 的取证报告终于给出了铁证（手机 `w=360`、`coarse=True`）：

```json
{ "phase": "first", "frameFound": true, "collapsed": "true",
  "tpl0": "56px minmax(0px, 1fr) minmax(0px, 0px)",
  "cut": 5, "wrote": true,
  "tpl1": "0px minmax(0px, 1fr) minmax(0px, 0px)" }
```

`cut=5` 说明 `indexOf('minmax(')` 切分成功，`wrote=true` 且 `tpl1` 已是 `0px` —— **竖栏确实被去掉了，不是被 React 还原**。功能到此完成。

**剩下的纯 UX 问题**（用户反馈）："展开和收起的位置差得太远了"。DSH 原生的收起按钮在**左上角**，而我把手一直固定在**垂直居中**，拇指要跨大半个屏幕。

**本版改动：**

- 把手改为**钉在原生开关的同一高度**：每轮同步时量一次原生开关的中心位置，换算成**视口百分比**（百分比不受 `html{zoom:80%}` 缩放影响，用 px 会被带偏），写入 `top: <pct>%`；量不到时退回 50%。
- `findNativeToggle()`：同时认「打开侧边栏」和「收起侧边栏」两种 aria-label（中英各一）。只有展开态才叫「收起侧边栏」，不认它就永远量不到锚点。
- `findNativeOpenBtn()` 保留，只用于点击展开。

**守卫 #39 扩充**：断言存在锚点逻辑、换算用的是百分比、把手确实应用了锚点、且两种 aria-label 都认。

## [5.6.3] - 2026-10-07

### Fixed — 钩子是对的，但"写进去的 0px 没留下"

5.6.2 的诊断终于报回了**决定性的数据**（这次是桌面版实例，`19387`）：

```json
{ "w": 575, "narrow": true, "pref": true,
  "frameFound": true,                                     // frame 找到了
  "collapsed": "true",                                    // data-sidebar-collapsed 存在且为 true
  "tplBefore": "56px minmax(0px, 1fr) minmax(0px, 0px)"    // 模板完全符合预期
}
```

`want = pref && narrow && collapsed` **三个条件全部成立**，改写分支必然执行了。但 `tplBefore` 是**改写之后**才读的，读回来却还是 `56px` —— 说明写进去的值没留下。此前几轮一直在错误的方向上找原因（先怀疑 profile、再怀疑选择器），实际是这个。

**本版改动：**

- 轨道改写改用 `indexOf('minmax(')` 切第一刀：第一个 `minmax` 之前那段就是第一条轨道，整段换成 `0px`，后两条原样保留。（按空格切会切坏 —— `minmax(0px, 1fr)` 里带逗号和空格；正则作为兜底保留。）
- 上报里加入**改写前 / 改写后 / 是否写入**三件套（`tpl0` / `tpl1` / `wrote` / `cut`），用来区分"根本没写"和"写了又被还原"。
- 一次页面加载发**两条**上报：`phase: "first"`（首次找到 frame）与 `phase: "steady"`（8 秒后）。两条一对比就知道是不是 React 把内联样式写回去了。服务端保留最近 6 条。

**守卫 #39 扩充**：断言存在 `indexOf('minmax(')` 定位、有 `wrote` / `tpl1` 取证、且服务端保留多条。

## [5.6.2] - 2026-10-07

### Fixed — 真正的根因：我只更新了 web profile，桌面版走的是 desktop profile

5.6.0 / 5.6.1 的改动**从来没进过桌面版**。DSH 桌面版加载的是 `profiles/desktop/node_modules/dsh-web-remote`，它的 pin 一直停在 `16d5457`（5.5.1）。我此前的验证全在 `dsh web` 那个实例上做（`/remote/info` 报 5.6.x、页面里也确实有新代码），而那个实例和桌面版是两个 profile —— 所以桌面版/手机自然一点变化都没有。

**同时修掉一个把我带偏一轮的诊断缺陷：** 5.6.1 的 `railReport` **只上报第一次调用**，而第一次发生在页面初始化、React 还没渲染出 AppFrame 的时候 —— 于是它永远报 `frameFound: false`。我拿这个当结论，误判成"DSH 换了布局、`data-sidebar-collapsed` 不存在"。实际上那个 bundle 只是 apps/web 外壳，DSH 客户端包是运行时另拉的，**该结论证据不足，已收回**。

**修法：**

- `railReport` 改成**等找到 frame 再报**（最多等 6 次 ≈ 12 秒）；12 秒后无论如何强制上报一次；
- 找不到 frame 时附 **DOM 取证**（`railProbe`）：`[data-sidebar-collapsed]` 命中数、页面上带内联 `grid-template-columns` 的元素、以及"贴左 / 窄 / 高"的竖栏候选及其祖先链 —— 即使选择器不对，也能一眼看出该挂在哪个元素上；
- `web` 与 `desktop` 两个 profile 的 pin 一起更新。

**守卫 #39 扩充**：断言上报必须等渲染完（`railDebugTries`）、有强制兜底（`railReport(true)`）、且带 DOM 取证（`railProbe` / `attrCount`）。

## [5.6.1] - 2026-10-07

### Fixed — 5.6.0 的窄屏去竖栏在手机上静默不生效

5.6.0 部署正确（服务端 5.6.0、注入脚本里有新代码、手机面板版本徽标也是 v5.6.0），但手机上**什么都没变**。

**根因：窄屏判定只看了 `window.innerWidth < 1024`。** 这个读数在手机上不可靠 —— 条件不成立时 `syncMobileRail()` 直接走到"不处理"分支，而它整个包在 `try/catch` 里、异常被吞掉，所以表现就是**完全静默**：脚本在跑、代码在页面里、版本也对，就是没反应。

**修法：**

- 新增 `railNarrow()`：`innerWidth < 1024` **或** `(pointer: coarse) && screen.width <= 1024`（触摸设备兜底）；
- `syncMobileRail()` 改用 `railNarrow()`。

**同时补上可观测性（这次的真正教训）：** 一个"异常全吞掉"的特性，出问题就只能靠猜。新增：

- 客户端 `railReport()`：首次同步时把量到的真实数值（`innerWidth` / `clientWidth` / `screen.width` / `pointer:coarse` / 是否找到 frame / `data-sidebar-collapsed` 的值 / 改写前的网格模板 / UA）上报一次；
- 服务端 `POST /remote/railreport` 接收，存在内存里并随 `/remote/info` 的 `railDebug` 下发。

**守卫 #39 扩充**：断言存在 `railNarrow` 与 `pointer: coarse` 兜底、`syncMobileRail` 确实改用 `railNarrow()`、以及"上报三件套"（客户端调用 / 服务端存储 / snapshot 下发）一个都不能少。

## [5.6.0] - 2026-10-07

### Added — 窄屏收起态去掉图标栏那条竖栏，只留一个展开把手

手机上通过远程插件打开 DSH 时，侧边栏**收起后那条竖栏仍然占位置**（≈45px，即 56px 轨道 × 移动端 80% 缩放）。现在窄屏收起态会把这条竖栏也去掉，只保留一个贴左边缘中部的展开把手。**手机端默认开**，只作用于窄屏 + 收起态。

**为什么不能靠 CSS 压宽度（踩过的坑）：** 那条竖栏不是侧边栏元素撑出来的，而是 `AppFrame` 三列网格的**第一条轨道**，并且是**内联样式**：

```html
<!-- dsh-client-ui-layout/lib/client.js:320 -->
<div style="grid-template-columns: 56px minmax(0px,1fr) minmax(0px,0px)" data-sidebar-collapsed="true">
```

那个 `56` 是 `collapsedWidth`（`client.js:241`）：`darwin || 窗口标题栏 ? 0 : 56`。所以把侧边栏元素压成 0 宽**没有任何用** —— 轨道照样占 56px，只会从"有内容的竖栏"变成"一条空白"。正确做法是只把内联模板的**第一条**轨道改成 `0px`，后两条原样保留（右侧栏宽度是 JS 按视口动态算的）。

**实现要点：**

- 用 DSH 自己的 `data-sidebar-collapsed` 判定收起，**不碰** CSS Module 哈希 class（`hHd-Xa_*` / `pI_x6G_*` 随版本变）；
- 展开复用 DSH 原生按钮（按 `aria-label`「打开侧边栏 / Open sidebar」定位），不自己改状态；
- React 每次渲染会重写内联样式，所以挂在 frame 的 `style` 观察器上重放；幂等靠 `data-webrm-rail` 标记，且**先打标记、后写样式**（顺序反了会与观察器形成回环）；
- 断点用 **1024**，与 DSH 自己的 `SIDEBAR_AUTO_COLLAPSE` 对齐 —— 用 768 会在 768~1023px 区间漏掉（那些宽度 DSH 同样是收起态）。

**新增端点：** `POST /remote/ui` `{ "mobileRailHidden": true|false }`（读写经 `store.ui.mobileRailHidden`，缺省 `true`；当前值随 `/remote/info` 下发）。

**新增守卫 #39**，把上面这些"改错地方就白改"的事实固化进测试：断言改写的是网格轨道而不是元素宽度、正则只动第一条轨道（真跑一遍验证后两条不变）、不出现哈希 class、标记先于写入、断点对齐 1024、服务端默认开且端点存在。

## [5.5.1] - 2026-10-07

### Fixed — **严重**：5.5.0 把裸图片块写进会话，导致每一轮都崩

**5.5.0 是坏的，请务必升级到 5.5.1。** 症状：

```
本轮运行失败  Cannot read properties of undefined (reading 'attachmentId')   [UNKNOWN]
```

每轮都失败，压缩总结也跟着失败；会话文件一度只能靠外部工具备份 + 补登记才救回来。

**根因：** 我在 5.5.0 里把 wire 形式的图片块直接交给了 `agent.send`：

```js
// 我发的（错）——没有 attachment 字段
{ type: 'image', mediaType: 'image/jpeg', data: '<base64>', name: '...' }
```

但**会话记录里图片的形状是 `ImageBlock`**（`dsh-attachment`）：

```ts
interface ImageBlock {
    type: 'image';
    attachment: ImageAttachmentRef;   // { attachmentId, mediaType, bytes, width, height, ... }
}
```

下游每轮读记录取 `block.attachment.attachmentId` → `block.attachment` 是 `undefined` → 整轮抛错。

**正确的入口是 `ctx.attachments.admitPromptContent()`**，官方文档原话：

> Browser-submitted prompt content accepted by Host prompt endpoints; the accepting Host promotes
> image parts to durable references through `ctx.attachments.admitPromptContent()`
> **before any message is created**, so a wire caller can never cite an attachment it did not upload.

`dsh-acp`（同类的外部协议适配器）就是这么做的，照抄它的路径：
`ctx.get('attachments')` → `saveImages(images)` → `{ type:'image', attachment: refs[i] }`。

**改动（`lib/index.mjs` 的 `sendToSession`，所有通道转发的咽喉点）：**

| 情况 | 行为 |
|---|---|
| 内容里没有图片 | 原样发送（**零开销**，5 个通道的老调用点一行没改） |
| 有图片 | 先 `await attachments.admitPromptContent(blocks)`，再发送登记后的 `blocks` |
| 附件服务不可用 | **摘掉图片块**，只发文本，并回一句「图片附件登记服务不可用，本条已跳过」 |
| 登记失败（格式/体积超限等） | **摘掉图片块**，只发文本，并回一句「图片登记失败：<原因>」；下载路径仍在 QQ 日志里 |

**两条降级路径都坚持一个原则：宁可少发一张图，也绝不让未登记的图片块进会话。**

**测试：** 新增守卫 #38（最关键的一条）——
`sendToSession` 必须调用 `admitPromptContent`；**登记必须在 `agent.send` 之前**；
发送必须用登记后的 `blocks`，不许把原始 `content` 绕过去；必须有**两条**降级路径把图片块摘掉；
图片全被摘光时必须返回说明（不能发空消息或静默失败）；裸 wire 图片块在 `index.mjs` 里
**只允许出现 1 处**（QQ 接收侧构造、随后登记）；踩坑说明必须留在注释里（否则后人会顺手简化掉）。

守卫 #38 已自验：把 `admitPromptContent` 改成 `admitPromptContent__DISABLED` 后，报
「sendToSession 没有调用 admitPromptContent —— 裸图片块会写进会话，每轮崩溃」。

守卫 #37 也顺手放宽了一处：它把 `const blocks = Array.isArray(...)` 写死了，
而带图片时要重新赋值所以是 `let` —— 改成 `(?:const|let)`。

**仍未做**：微信 iLink 支不支持收发图未测；QQ 语音/文件附件未接。

## [5.5.0] - 2026-10-07

### Changed — QQ 收到的图片直接在对话里显示，不再是一串路径

用户要求：「能不能显示图片而不是路径」。

5.4.1 用的是「简单法」（把本地路径写进转发文本，AI 用 `read_image` 自己读）。
能用，但对话里看到的是一行 `[图片] C:\...\png`。现在改成**真正的内容块**。

**先查清了 DSH 期望的形状**（`@deepseek-ai/dsh-attachment` 与 `dsh-api-session-controller`）：

```ts
export type PromptContentPart = {
    readonly type: 'text'; readonly text: string;
} | {
    readonly type: 'image';
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    readonly data: string;    // base64
    readonly name?: string;
};
```

**改动：**

| 位置 | 改动 |
|---|---|
| `lib/index.mjs` | `sendToSession`：`content` 现在**既接受字符串（原有 5 个通道都这么传）也接受内容块数组** —— `Array.isArray(content) ? content : [{type:'text',text:content}]`，**向后兼容**，老调用点一行不用改 |
| `lib/index.mjs` | 新增 `sniffImageMediaType(buf)`：由**文件头魔数**判定真实格式（PNG/JPEG/GIF/WebP），返回 DSH 认的 mediaType 或 null |
| `lib/index.mjs` | `downloadQQImageAttachments`：先落 `.part` → 读字节嗅探 → 按真实格式改名 → 返回 `{ mediaType, data(base64), name, localPath }` |
| `lib/index.mjs` | `qqbotHandleCommand`：能嗅探出格式的作为 `{type:'image'}` 内容块送进会话；**嗅探不出的退回 `[图片] 路径`**（不让整条消息丢掉） |

**为什么以字节为准而不是照抄 `content_type`**：DSH 会**用真实字节校验声明的 mediaType**
（`SaveImageAttachment` 注释："Caller-declared media type, checked against fully decoded bytes"）。
既然校验方看字节，我们就不该把外部来源的声明当事实转手传下去。

**⚠ 更正一处我先前的错误结论**：我在 5.4.1 之后的对话里说过「实测 QQ 会把 WebP 报成 image/png」——
**那是错的**。我当时看的是 `read_image` 报告的**归一化预览副本**格式（它会把图重编码成 WebP），
不是源文件。实际那个文件是 **2888068 字节的真 PNG**（头 `89504e47`），与 QQ 声明的 `image/png` **一致**。
所以嗅探是**防御性**做法，不是在修一个已知的 QQ bug。代码注释里也留了这条更正。

**测试：** 守卫 #37 扩写 —— `sendToSession` 必须做字符串/数组兼容、图片块必须是
`{type,mediaType,data,name?}` 形状、必须有格式嗅探且 4 种魔数齐全、嗅探不出必须退回路径；
**真跑** 6 个嗅探用例（PNG/JPEG/GIF/WebP/非图片/太短）+ 9 个附件用例（且收下的每项都必须带
`mediaType` 与 base64）。
守卫 #28 也顺手修了：它用固定 1800 字符窗口切 `sendToSession`，函数里加段注释就会被撑破
（这次真踩到，误报「找不到 whenIdle」）—— 改成按真实函数边界切。

守卫 #37 已自验两条：把兼容判断去掉会报「没有做字符串/内容块数组兼容」；
把嗅探砍成只剩 PNG 会报「嗅探里没有 JPEG 的魔数」。

## [5.4.1] - 2026-10-07

### Added — 能接收 QQ 发来的图片（此前被静默丢弃）

用户问「你可以收到 QQ 发给你的图片吗」。**先查代码，再让用户实测印证。**

**查到的原因（两处）：**

| 位置 | 问题 |
|---|---|
| `lib/qqbot.mjs` | 只读 `msg.content`；纯图片消息 `text` 为空 → **`if (!text) return;` 直接丢弃** |
| 全插件 | 搜 `attachments` / `content_type` → **0 处命中**，附件从未被读取 |

**用户实测日志印证**（决定性证据）：

```
[qqbot] 收到消息 from 格子蓝调 (群):
```

冒号后为空 —— **图片确实送到了机器人**，只是被那行 `return` 丢掉。
（同一条日志里 `[qqbot] 启动通知已发送` 也顺带证实了群主动推送确实修好了。）

**SDK 其实给了数据**（`dist/protocol/gateway/event-dispatcher.d.ts`）：

```ts
export interface InboundAttachment {
    content_type: string;   // 如 "image/png"
    url: string;            // ← 可直接下载
    filename?: string; height?: number; width?: number; size?: number;
}
// InboundMessage.attachments?: InboundAttachment[]
```

**改动（用户选「简单法」，不碰共用核心）：**

| 位置 | 改动 |
|---|---|
| `lib/qqbot.mjs` | 读 `msg.attachments`；`if (!text && attachments.length === 0) return;`（没文字**也没有附件**才丢）；把 `attachments` 传给上层；日志加上 `[附件 N]` |
| `lib/index.mjs` | 新增 `downloadQQImageAttachments(attachments)`：**只处理图片**（`content_type` 以 `image/` 开头；没有 `content_type` 时兜底当图片），下载到 `<tmp>/dsh-qq-img/`，复用现成的 `downloadFile`（带重定向/超时/重试） |
| `lib/index.mjs` | `qqbotHandleCommand`：**命令匹配仍用原始文本 `t`**，转发用 `relayText`（原文 + `[图片] 本地路径`）—— 否则 `[图片] C:\...` 会把 `/帮助` 之类的匹配搞坏 |
| 未改动 | **`sendToSession` 没动** —— 那是 5 个通道共用的核心函数；简单法把路径写进文本，会话里的 AI 用 `read_image` 自己读 |

**实测验证（真下载，不是断言）：**

```
下载 https://api.qrserver.com/... → 349 字节，文件头 89504e470d0a1a0a ✓ 是 PNG
```

**测试：** 新增守卫 #37 —— 通道层必须「没文字也不丢」且传 `attachments`、旧的 `if (!text) return;` 不许回来；
上层必须只处理图片、必须真下载、必须是独立临时目录；必须有 `relayText` 且转发用它；
**禁止**把 `sendToSession` 改成支持 content 数组（用户选的是简单法）；并**真跑** 9 个附件筛选用例
（png/jpeg/无 content_type 兜底/语音跳过/文件跳过/无 url 跳过/空数组/非数组/多图）。

守卫 #37 已自验：把判定改回 `if (!text) return;` 会报「还是"没文字就丢" —— 纯图片消息仍会被丢弃」。

**待办（未做）**：微信 iLink 支不支持发图/收图**未测**；QQ 语音（`voice_wav_url` + `asr_refer_text` 已有字段）
也还没接。

## [5.4.0] - 2026-10-07

### Added — 监听通知可以带图片发到 QQ（方案 C + 只做 QQ）

用户先做了两个实测（我直接用 API 打，不是猜）：

| 测试 | 结果 |
|---|---|
| 监听能否发图 | ❌ 原实现不发 —— `index.mjs` 只挑 `type === 'text'` 的块；`qqbot.mjs` 只有 `bot.sendText`，没有发图能力 |
| 监听通道本身通不通 | ✅ **通了** —— 文本成功进群（验证了「机器人主动在群聊内发言」那个授权修复） |

**可行性验证（QQ 侧，全部 200 成功）：**

| 图片方式 | 上传 `POST /v2/groups/{openid}/files` | 发送 `msg_type=7` + `media.file_info`（**不带 msg_id = 主动消息**） |
|---|---|---|
| 本地文件（base64） | ✅ 拿到 `file_info` | ✅ 200 |
| 网络 URL（腾讯 CDN） | ✅ | ✅ 200 |
| 网络 URL（公共图床） | ✅ | ✅ 200 |

**结论：主动消息可带图，不需要任何额外权限。** SDK 已封装 `sendImage(target, { localPath | url | buffer })`（上传 + 发送一步到位）。

**改动：**

| 位置 | 改动 |
|---|---|
| `lib/qqbot.mjs` | 新增 `sendImage(target, source, content)` —— 包一层 SDK 的 `bot.sendImage` |
| `lib/index.mjs` | 新增 `extractMessageImages(msg)`：**两路信号都扫**（用户明确要求）<br>① 结构化 `type:'image'` 块（url / base64 / 本地路径，防御性兼容多种形状）<br>② 文本里的图片引用：markdown `![](x)` / 裸 http(s) 图片链接 / 本地图片路径 |
| `lib/index.mjs` | 监听判定从「有文本才通知」改为「**有文本或有图片**就通知」—— 只出图不出字的一轮也能推出去 |
| `lib/index.mjs` | QQ 分支：文本发完后再逐张发图（串行，避免并发上传互相挤），并把「图片 N 张」写进 `monitorLastSendResult` |
| 安全下限 | `MAX_MONITOR_IMAGES = 3`。不加限制的话一轮出现几十张图就会刷屏 —— 这是正确性下限（同文本 1900 字符截断），不是可选功能 |
| 范围 | **只对 QQ 生效**（`sendImage` 调用点有守卫断言恰好 1 处）。微信 iLink 支不支持发图**未测**，要单独验证 |

**只认真实存在的资源**：本地路径必须 `fs.existsSync` 通过才发，网络只认 http(s)，避免把不存在的路径丢给 QQ 报错。

**测试：** 新增守卫 #36 —— 通道必须导出 `sendImage` 且调用 SDK；提取函数必须两路都扫；必须有张数上限；
只出图的一轮必须能通知；`sendImage` 调用点必须恰好 1 处且在 QQ 分支里；
并**真跑** 10 个提取用例（image block url/base64、markdown 网络图/本地图、裸链接、不存在的路径不误收、
普通网页链接不误收、纯文本不误收、同 URL 去重、上限生效）。

守卫 #36 已自验：把判定改回「只认文本」会报「只产生图片、没有文字的一轮不会通知」。

**踩坑记录：** `extractMessageImages` 内部函数最初叫 `push`，触发了测试 #9 的作用域守卫误报
（守卫把名为 `push` 的声明当变量，进而把文件前面所有 `Array.prototype.push` 调用判成越界使用）。
改名为 `addImg` 解决，并在代码里留了注释免得后人再踩。

## [5.3.6] - 2026-10-07

### Fixed — QQ 群收不到监听：**根因查明**（授权开关在 QQ 客户端，不在开放平台）

用户报「QQ群收不到监听」。前几版我一直猜错方向（先猜"开放平台开通权限"、又猜"机器人未上线"），
**真正的开关在 QQ 客户端里**。

**根因：** 群侧没有给这个机器人「主动发言」授权 → 群主动推送被拒 `40034105 主动消息失败, 无权限`。

**正确位置**（截图确认）：

```
QQ → 打开该机器人的设置页 →
  机器人主动在群聊内发言
  机器人可主动发消息，如定时任务推送等     [开]   ← 就是这个
```

**实测验证（同一请求，开关前后对比）：**

| 时刻 | `POST /v2/groups/{openid}/messages`（不带 msg_id = 主动消息） |
|---|---|
| 开启前 | `400 {"message":"主动消息失败, 无权限","code":40034105}` |
| **开启后** | **`200 {"id":"ROBOT1.0_...","timestamp":"2026-10-07T11:37:05+08:00"}`** |

开启后 QQ 会下发事件 **`GROUP_MSG_RECEIVE`**（官方文档：「群管理员在机器人资料页操作开启通知时触发」，
Intent = `GROUP_AND_C2C_EVENT` (1<<25)，而插件用的 `FULL_INTENTS` 本来就包含这一位）。

**排查过程中排除掉的方向（都有实测证据，记下来免得下次重走）：**

| 猜测 | 实测结果 | 结论 |
|---|---|---|
| 换新统一域名 `api.bot.qq.com` | 同样 `40034105` | ❌ 与域名无关 |
| 机器人未上线 | — | ❌ 与上线状态无关 |
| 群是沙箱群 | 沙箱域名回 `11292 沙箱环境不能访问此资源` | ❌ 是正式环境的群 |
| 群"消息推送"开关 | 用户确认一直开着 | ❌ 不是那个开关 |
| 免凭据推送通道 | 12 个候选端点全部 404；不带 token 与带过期 token 都 `ret:-2 prepare failed`（微信侧） | ❌ 不存在 |
| 用 `is_wakeup` 互动召回（30 天窗口） | `40034123 消息发送失败，不支持召回消息` | ❌ 群聊不支持，仅单聊 |
| 自建 HTTPS 回调服务端 | 官方文档：配了回调地址后 WebSocket 失效 | ❌ 会砸掉整套能用的东西，且不必要 |

**改动：** 只改诊断日志文案 —— 之前写的是「去 QQ 开放平台为该机器人开通群主动消息权限」，
**指向错误**，会让用户去开放平台白找一圈。现在指向正确的开关，并提到 `GROUP_MSG_RECEIVE`。

**守卫 #35 更新**：断言日志必须指向「机器人主动在群聊内发言」，并**禁止**再出现
"去 QQ 开放平台开通权限"那句错话。已自验：改回错误文案会报
「日志又指回"去 QQ 开放平台开通权限"了 —— 那是错的，开关在 QQ 客户端」。

**关于「获取群内所有消息」权限**（用户曾开启后改回）：开启后群里每条消息都会进 DSH 会话并被回复
（插件无 mentionGate，SDK 的 `middlewares` 默认是空数组）。用户已把范围改回
「仅获取@机器人的消息」—— **等价于闸门，且在源头生效**（QQ 根本不推非 @ 消息），
比在插件里装 `mentionGate` 更彻底。QQ 侧还提供中间档「获取@机器人的最近10条消息」。

## [5.3.5] - 2026-10-05

### Removed — 撤销「群推送被拒后回退私聊」与「单独持久化私聊目标」

用户明确要求删除：

> 「群推送被拒后回退到私聊，单独持久化私聊目标这两给我去了，谁让你做的」

**这两条是我自作主张加的，用户没有要求过。** 它们会把本该发到群的通知偷偷改发到私聊——
这是行为改变，不该由我单方面决定。已全部撤销。

**撤销内容：**

| 位置 | 撤销 |
|---|---|
| `lib/qqbot.mjs` | `lastC2cTarget` / `lastC2cAt` 状态、`onC2cTarget` 钩子、收到私聊消息时的记录逻辑 |
| `lib/qqbot.mjs` | `getLastC2cTarget()` / `setLastC2cTarget()`，以及 `status()` 里的对应字段 |
| `lib/index.mjs` | 私聊目标落盘钩子、启动恢复私聊目标、群推送被拒后的私聊回退分支 |
| 判定严格性那套 | 随之删除（回退没了，`scope === 'group'` 的限定也就没有意义） |

**保留的只有诊断**：群主动推送被 QQ 官方拒绝（`40034105`）时，打一次说明白原因的日志
（去重，不刷屏）——「这是 QQ 平台的限制，不是插件问题」。普通失败仍走原来的
`monitor send failed:` 如实报错。

**守卫 #35 重写**：现在反过来**禁止**这套回退复活 —— 一旦出现 `lastC2cTarget` /
`getLastC2cTarget` / `setLastC2cTarget` / `onC2cTarget`，或日志里再出现"回退私聊"字样，
测试直接失败并说明「用户明确要求删掉，不能把本该发到群的通知偷偷改发到私聊」。

守卫已自验：加回一个 `getLastC2cTarget()` 后，报
「取私聊回退目标（getLastC2cTarget）又回来了 —— 用户明确要求删掉」。

**状态文件**：`plugin-state.json` 里从未写入 `lastC2cTarget`（改动生效前就被叫停），无需清理。

**结论不变**：QQ 群主动推送改不了，用户侧要么去开放平台开通权限，要么换通道。

## [5.3.4] - 2026-10-05

### Fixed — QQ 群收不到监听（查明是 QQ 平台限制）

> ⚠ 本版曾附带「群推送被拒后回退私聊 + 单独持久化私聊目标」，已在 **5.3.5 撤销**
> （用户未要求，属自作主张）。下面只描述保留下来的部分。

用户报「QQ群收不到监听」。

**排查（用真实 AppID/AppSecret 直调 QQ 官方 API，不是猜）：**

| 请求 | 结果 |
|---|---|
| `POST /v2/groups/{group_openid}/messages`（主动推送） | **400** `{"message":"主动消息失败, 无权限","code":40034105}` |
| `GET /v2/groups/{group_openid}/info` | **200** `{"group_name":"墨居非酋群","group_member_num":9}` |
| `POST /app/getAppAccessToken` | 200（凭证正常） |

**结论：不是插件 bug，也改不了。** 机器人在群里（能读群信息），但 **QQ 官方不允许它主动发言**——
群聊主动消息需要在开放平台开通权限。私聊（c2c）主动推送此前是成功的（日志有 `[qqbot] 通知已发送`）。

**改动（仅诊断）：**

| 位置 | 改动 |
|---|---|
| `lib/index.mjs` | 群推送失败且错误含 `40034105`/`无权限` 时，**详细说明一次**（去重，不刷屏）——「这是 QQ 平台的限制，不是插件问题：机器人在群里能读消息，但"主动发言"需要开放平台开通权限」 |
| 其他失败 | 仍走原来的 `monitor send failed:` 如实报错，不被吞掉 |

**用户侧可选解决办法：**
1. 去 QQ 开放平台为该机器人**开通群主动消息权限**（根治）；
2. 或改用 Telegram / 钉钉 / 飞书做群通知（它们是长连接，没有这个限制）。

## [5.3.3] - 2026-10-05

### Changed — 微信积压策略：合并 + 过期丢弃（此前只是让计数器不显示）

用户指出上一版（5.3.2）的问题：「你这不是骗自己没积压吗」—— **说得对**。
5.3.2 只是让启动问候不入队，于是 `/状态` 显示 0，但**真正的积压机制一条没改**。

**先做了实测探测（结论是"没有出路"）：**

| 探测 | 结果 |
|---|---|
| `sendmessage` **不带** `context_token` | `{"ret":-2,"errmsg":"prepare failed"}` |
| `sendmessage` 带**过期** token | 同上 |
| 12 个候选免凭据推送端点（`pushmessage` / `push_message` / `sendmsg` / `send_message` / `notify` / `send_custom_message` / `send_template_message` / `get_context_token` / `refresh_context_token` / `get_session` / `subscribe` / `get_user_info`） | **全部 404** |
| 基线（不存在的路径） | 404（判别有效） |

**结论：`context_token` 强制必需，iLink 没有免凭据的推送通道。**
它只能从"用户刚发来的消息"里获得 —— 等价于客服消息窗口。
**所以「用户长时间不说话时主动推送」在 iLink 上物理上做不到**，积压无法"消除"，只能"不排队"。

**改动（新策略）：**

| 位置 | 改动 |
|---|---|
| 入队 | 元素从纯字符串改为 `{ text, at }` —— **带时间戳**，否则无法判断过期 |
| 补发 | 先丢掉超过 `PENDING_TTL_MS`（**10 分钟**）的，剩下的**合并成一条**发送。N 条通知不再变成 N 条消息 |
| 旧实现的坑 | 原来是 `splice(0)` 后**逐条**发，补到第 k 条失败时后面全部重新入队 → 队列无上限、可能反复卡住。已删除 |
| `/状态` | 改为显示「待发 N 条，上次补发 M 条，**累计丢弃 K 条过期通知**」+ 一句说明（微信要求"你刚说过话"才允许推送）。**丢弃可见，不藏** |

**行为对照（模拟：离开 40 分钟、期间 6 个会话完成）：**

| | 发出消息数 | 过期内容 | 用户观感 |
|---|---|---|---|
| 旧实现 | **6 条**（逐条） | 6 条全是旧的 | 突然收到一串几十分钟前的"某会话已完成" |
| 新实现 | **1 条**（合并） | 丢弃 5 条 | 只收到 1 条汇总，不含过期信息 |

**测试：** 守卫 #34 重写 —— 入队处只允许 1 个且必须带时间戳、必须有 `PENDING_TTL_MS`、
丢弃数必须累计并在 `/状态` 显示、补发必须合并、不许回到 `splice(0)` 逐条发。

守卫 #34 已自验：把入队改回不带时间戳会报「无法判断过期，队列会无限增长」。

## [5.3.2] - 2026-10-05

### Fixed — 每次重启后微信固定积压 1 条（启动问候）

用户看日志报「微信又积压了消息」。日志里只有这一条积压来源：

```
[dsh-weixin] 启动通知入队（发送失败: iLink prepare failed；积压 1 条）
```

即重启时那句 **「DSH已启动，任务监听中」** —— 它用的是上次存下来的 `context_token`，
重启后几乎必然已过期 → `prepare failed` → 入队，要等用户下次来信才补发。

**两个问题：**

| # | 问题 |
|---|---|
| 1 | **语义不对**：「已启动」是时效性问候，几小时后才送到只会让人莫名其妙（入队机制本是为「会话输出通知」设计的 —— 那些晚点送到仍有意义） |
| 2 | **让 /状态 永远显示「积压 1 条」**，用户会以为积压机制又坏了（实际就是这个问候） |

**改动：**

| 位置 | 改动 |
|---|---|
| 启动问候 | 发送失败时**不再入队**，只打一行日志说明「不入队，避免重启后固定积压 1 条」 |
| 入队机制 | 保留，但现在**只有「会话输出通知」会入队**（token 过期时不丢通知） |
| 测试 | 新增守卫 #34：往积压里塞东西的地方只允许 1 处且必须是监听通知正文 `text`、启动问候不许入队、失败必须有日志、监听通知的入队必须保留 |

**顺带确认（日志里看到，都正常）：**

- `[feishu] 监听开关是开的，但没配凭证（appId/appSecret），本次不恢复监听` ← 5.2.5 的修复生效，不再每轮刷屏
- `[telegram] 未配置 Bot Token，跳过` / `[dingtalk] 未配置 AppKey/AppSecret，跳过` ← 干净跳过

守卫 #34 已自验：把启动问候改回入队后，报「往积压里塞东西的地方有 2 处，应只有 1 处」。

## [5.3.1] - 2026-10-05

### Fixed — `/链接` 回复在微信与其它通道不一致（微信多发一条）

用户反馈：「微信的链接回复也不一样」。

逐字对比 5 个通道的 `/链接` 分支后确认：**正文已经相同**（都走 `linkCommandText`），
剩下的差别是**消息条数**：

| 通道 | 收到 |
|---|---|
| Telegram / QQ / 钉钉 / 飞书 | **1 条**：缩放提示 + 公网链接 + P2P 链接 |
| 微信 | **2 条**：上面那条 **+** 单独补发的 `[如果用外部浏览器，请直接复制链接…]` |

那条额外警告是微信专属的（微信内置浏览器打开外链会丢掉 `?token=`，实测必然验证失败），
当初用 `weixinFollowup` 机制**单独发第二条**，于是看起来就是"微信和别的不一样"。

**改动（警告保留，4 个通道也补上同类提示）：**

| 位置 | 改动 |
|---|---|
| 提示常量 | `LINK_MOBILE_HINT`（手机缩放）+ **新增** `LINK_BROWSER_HINT`（内置浏览器丢参数警告）。两条都由 5 个通道共用 |
| `linkCommandText()` | 改为**无参数**，两条提示直接写进正文。5 个通道拿到的文字与条数**完全一致** |
| 删除 followup 机制 | 移除 `weixinFollowup` 变量、消费者里补发第二条的代码、以及微信分支的两处赋值 —— 这是"微信 2 条"的根源 |
| 测试 | 守卫 #25 与 #33 更新：两条提示常量必须存在且各只出现 1 次、`linkCommandText` 必须**无参数**（有参数就会各传各的、再次分叉）、10 处调用点、`weixinFollowup` 不许复活 |

**改后 5 个通道收到的完全相同的文案：**

```
[手机浏览器可根据需要调整页面缩放，以获得更合适的显示效果]
[内置浏览器打开可能丢失验证信息，建议复制链接用系统浏览器打开]
公网链接：
https://xxx.trycloudflare.com/?token=xxx

P2P 链接：
http://100.103.130.41:5566/?token=xxx
```

守卫 #33 已自验：把飞书的「未知命令」改回旧措辞会报「有 2 种说法」；
守卫 #25 已自验：`linkCommandText` 被传参数会报「5 通道应共用同一份文案」。

## [5.3.0] - 2026-10-05

### Refactor — 微信改用共用指令实现，5 个通道的提示语彻底统一

用户反馈：「把所有指令的提示列出来，现在好像并没有所有软件统一」。

审计（把 `index.mjs` 里所有用户可见的指令提示语抽出来按通道对比）：**28 条提示语**，
其中同一句**都出现两次** —— 4 个通道走共用的 `cmd*` 函数，**微信自己内联复制了一整套**。

**已经漂了（不是"可能漂"）：**

| 问题 | 表现 |
|---|---|
| 微信内联版缺一条前置提示 | 共享的 `cmdPickEffort` 有「请先「/切换模型」选择模型」；微信内联版条件不成立时**直接往下走**，用户在微信里直接发 `/选强度` 会毫无反馈 |
| 「未知命令」有 3 种说法 | 微信「未知命令，发「帮助」查看可用命令」／飞书「未识别的命令，发送帮助查看可用命令。」／TG·QQ·钉钉「未知命令，发送 /帮助 查看可用命令」 |
| `/链接` 提示只有微信有 | 手机缩放提示本应对所有手机端通道成立，却只写在微信分支里 |

**改动：**

| 位置 | 改动 |
|---|---|
| `lib/index.mjs` | 微信的 `/会话列表`、`/选择 N`、`/当前会话`、`/历史内容`、`/当前模型`、`/切换模型`、`/选强度 N`、转发 **全部改为调用共用 `cmd*`**，删掉内联实现（约 180 行） |
| 状态变量 | 删除 `weixinSelectedSession` / `weixinModelPick`，改用与其它 4 通道同款的 `weixinCmdState = { channel: 'weixin', selected, pick }` |
| `switchModel` | 删掉「不传 sessionId 就退回微信选中会话」的隐式兜底 —— 所有调用点现在都显式传 `st.selected` |
| 「未知命令」 | 统一为 `未知命令，发送 /帮助 查看可用命令`（5 个通道一致） |
| `/链接` 提示 | 抽出两个常量：`LINK_MOBILE_HINT`（手机缩放提示，**5 通道共用**）、`WEIXIN_LINK_FOLLOWUP`（微信内置浏览器丢参数警告，**微信专属**）。10 处调用点全部引用常量 |
| 微信专属指令 | `/链接`、`/停止远程`、`/监听`、`/状态`、以及进入会话前的「已收到指令，AI 思考中，请稍等…」回执**保持不变** |

**结果：提示语 28 条 → 18 条**，每个语义分组都只剩 **1 种说法**：

| 分组 | 改前 | 改后 |
|---|---|---|
| 未知命令 | 3 种说法 | **1 种** |
| 未选会话（转发内容时） | 1 种（2 处重复） | 1 种（1 处） |
| 未选会话（看会话/历史） | 1 种（4 处重复） | 1 种（2 处） |
| 编号无效（选会话 / 切模型 / 选强度） | 各 1 种（各 2 处重复） | 各 1 种（各 1 处） |
| 切模型 / 选强度 的后续引导 | 各 1 种（各 2 处重复） | 各 1 种（各 1 处） |
| 选强度前置条件 | 只在共享版（微信缺） | **5 通道都有** |
| `/链接` 缩放提示 | 只有微信 | **5 通道共用** |

**测试：** 守卫 #33 防止再次分叉 —— 微信必须调用全部 8 个共用函数、不许再出现私有状态变量、
「未知命令」只允许 1 种说法且必须出现 5 次（每个 handler 一次）、`/链接` 提示只允许在常量定义处出现。
守卫 #29 的锚点跟着更新（微信转发已改为 `cmdRelayToSession`，并新增"回执前要先判断有没有选中会话"）。

守卫 #33 已自验：把飞书的「未知命令」改回旧措辞后，报「「未知命令」有 2 种说法，应只有 1 种」。

## [5.2.7] - 2026-10-05

### Fixed — 局域网页冒出两条点不开的链接（169.254 链路本地地址）

用户截图：局域网页出现

```
局域网 HTTP  169.254.83.107（推荐 · 免证书，点击复制）
局域网 HTTPS 169.254.83.107（自签名证书，浏览器会提示不安全）
```

用户说「我没做过这两条」。查下来是 **Tailscale 网卡上挂的 `169.254.83.107`**。

**根因：** `lanIPs()` 只过滤了 `!ni.internal`，**没排除链路本地地址**：

```js
if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
```

`169.254.0.0/16` 是 **APIPA**（网卡拿不到 DHCP 时系统自分配的），**永远连不通**。
Tailscale 网卡上也挂着一个（它的内部地址），而 `isTailscaleRange` 只认 `100.64.0.0/10`（CGNAT），
**认不出 `169.254.x.x`** —— 于是它冒充「普通局域网地址」漏进了面板。

**改动：**

| 位置 | 改动 |
|---|---|
| `lib/cert.mjs` | 新增并导出 `isUsableLanIp(ip)`：排除 `169.254.0.0/16`、`0.0.0.0`、`127.0.0.0/8`；`lanIPs()` 接上它 |
| 影响面 | 面板局域网链接、二维码、自签名证书的 SAN 都会跟着干净（都走 `lanIPs()`） |
| 测试 | 新增守卫 #32：**真跑** `isUsableLanIp` 8 例（含用户截图里那个 `169.254.83.107` 必须为 false、`192.168.31.111`/`10.x`/`172.16.x`/`100.103.x` 必须为 true） |

**本机实测：**

| 网卡 | 地址 | 过滤前 | 过滤后 |
|---|---|---|---|
| Tailscale | 169.254.83.107 | 列出 ❌ | 排除 ✅ |
| 以太网 | 192.168.31.111 | 列出 ✅ | 保留 ✅ |

守卫 #32 已自验：把 `169.254` 那行判断删掉后，报
「isUsableLanIp(169.254.83.107) = true，应为 false（Tailscale 网卡的链路本地地址（用户截图里那条））」。

## [5.2.6] - 2026-10-05

### Fixed — 左侧栏收起时「远程」按钮被裁切

用户截图反馈：侧边栏收起后，左下角的「远程」按钮 UI 出错（挤在窄栏里被裁切）。

**根因两处：**

| # | 位置 | 问题 |
|---|---|---|
| 1 | `updateVisibility()` | 用 `findSidebarRoot()` 判断是否收起，而它按「宽度 **90~460**」筛侧边栏；收起后的图标栏只有 **48~64px**，直接被滤掉 → 返回 `null` → `collapsed` 恒为 `false` → 按钮**不隐藏**，却待在窄栏里被裁切 |
| 2 | `MutationObserver` | 只在 `findSidebarRoot()` 成功时才挂上；若**加载时侧边栏已经是收起的**，观察器根本没挂，之后无论怎么展开/收起都不再重算 |

**改动：**

| 位置 | 改动 |
|---|---|
| 新增 `isSidebarCollapsed()` | 独立判断，三重条件任一命中即算收起：① 祖先类名带 `collapsed`；② 按钮所在容器比按钮本身还窄；③ 带 `--dsh-sidebar-inline-padding` 的侧边栏根宽度 `< 90`（**放宽下限，把图标栏算进来**）。不再复用 `findSidebarRoot()` |
| `updateVisibility()` | 改用 `isSidebarCollapsed()` |
| MutationObserver | 改挂 `document.body` + `subtree` —— 任何位置的展开/收起都能捕获，不再依赖"挂载那一刻能找侧边栏" |
| 触发时机 | `ResizeObserver`、窗口 `resize`、2 秒兜底定时器都补上 `updateVisibility()`，收起后能及时隐藏 |

**验证**（无头 Edge 复刻侧边栏 DOM，收起时**故意不加 `collapsed` 类**，只把宽度变 56px）：

| 场景 | 侧边栏宽 | 旧判定 | 新判定 |
|---|---|---|---|
| 展开 | 260px | false ✓ | false ✓ |
| 收起（无类名，只变窄） | 56px | **false** ❌ | **true** ✅ |

守卫 #31 已自验能拦住「改回用 `findSidebarRoot()` 判断收起」的回归。

## [5.2.5] - 2026-10-05

### Fixed — 通道没配凭证时，监听每轮白试并刷屏报错

用户日志里每轮会话输出都出现：

```
[feishu] monitor send failed: 未配置飞书凭证
```

**根因两处：**

| # | 位置 | 问题 |
|---|---|---|
| 1 | 启动恢复 | `feishuMonitorMode = true` **无条件**从 store 恢复 —— 凭证被清掉后开关还留着，监听一直以为该推 |
| 2 | 监听发送分支 | 只判断 `feishuMonitorMode && feishuLastChatId`，**没查凭证** |

对照其它通道，做法本来就不一致：微信查了 `botToken`/`userId`、Telegram/QQ 查了 `channel` 与 `health`、钉钉有整套 `dtSkip`，只有飞书漏了。

**改动：**

| 位置 | 改动 |
|---|---|
| 启动恢复 | 先 `feishuLoadConfig()` 确认 `appId`/`appSecret` 都在才恢复监听；否则不恢复并打一行说明「补上凭证后重新发 /监听 即可」 |
| 监听发送 | 加 `fsSkip` 判断链：配置读取失败 / 未配凭证 / 还没有会话目标 —— 跳过原因写进 `monitorLastSendResult`（`/remote/diag` 里能看出为什么没推） |
| 日志去重 | 新增 `feishuMonitorSkipLogged`，只在**跳过原因变化**时打一次日志，不再每轮刷屏（这正是用户遇到的问题） |
| 测试 | 新增守卫 #30：启动恢复必须在 `feishuMonitorMode = true` **之前**调用 `feishuLoadConfig()`；发送分支必须有「未配置飞书凭证」跳过且原因写进诊断；跳过日志必须去重；正常发送调用不能丢 |

守卫 #30 已自验能拦住「无条件恢复监听开关」的回归。

## [5.2.4] - 2026-10-05

### Fixed — 微信接收消息慢 / 长期"挤压消息"的真正原因

用户反馈「微信那边接收消息那么慢」，并长期以为是「微信接口休眠了」。

根因不在网络，在**收消息与处理消息写在同一个 while 循环里串行 await**：

```
收到 A →（await 会话跑完，可能几十秒）→ 回复 A → 才回去拉下一条
```

三个后果：

| # | 后果 |
|---|---|
| 1 | 会话思考期间**完全不再拉取新消息** —— 用户感觉"接收慢"，其实是它腾不出手 |
| 2 | 连着发几条要挨个等一遍，越积越慢 |
| 3 | **每条消息自带的 `context_token` 有有效期**。等得越久越可能过期，发送时报 iLink `prepare failed`，只能入队积压 —— 这就是"挤压消息"的由来，**不是接口休眠，是我们自己拖到凭据过期** |

| 位置 | 改动 |
|---|---|
| `lib/index.mjs` | 新增 `weixinInbox` 队列 + `weixinDrainInbox()` 消费者：**收消息只入队**，处理另起一条链按顺序做，互不阻塞 |
| 立刻回执 | **不在收消息循环里发** —— 回执统一由 `handleWeixinCommand` 进入会话前发一条「已收到指令，AI 思考中，请稍等…」（措辞与时机都更准）。首版曾在此处又加了一条「已收到，正在处理…」，用户实测收到**两条**回执，本次修掉 |
| 积压补发 | 原在收消息循环里 `await` 的 `weixinFlushPending()` 移到消费者，不再堵收消息 |
| 健壮性 | 消费者单条失败不拖垮队列；`while (inbox.length > 0)` 保证处理期间新来的消息不丢 |
| 测试 | 新增守卫 #29：收消息循环里不许再出现 `weixinGenerateReply` / `whenIdle`、必须入队并唤起消费者、不许再发回执（防和 `handleWeixinCommand` 的回执撞车）、回执必须在 `sendToSession` 之前、消费者必须真的处理并回复 |

时序模拟对照（3 条消息、每条处理 300ms）：

| | 全部接收完 | 说明 |
|---|---|---|
| 旧（串行） | 924ms | 且期间收不到新消息 |
| 新（队列） | **201ms** | 收到即入队 |

守卫 #29 已自验能拦住「把处理逻辑塞回收消息循环」和「重复回执」两类回归。

> 实测（用户微信截图）：重启后积压归零且连发 4 次 `/状态` 不再回涨；
> 发普通内容先收到一条回执「已收到指令，AI 思考中，请稍等…」，再收到会话结果。

> 注：本次只解决「消息被收到的快慢」。回复本身仍要等会话跑完（回执可以让等待有反馈）。

## [5.2.3] - 2026-10-04

### Fixed — 「监听 + 选择会话」时同一次输出会收到 2 条

用户报告：开了监听、又选了会话，被选会话输出结果时会给机器人发 **2 次**。

根因是两条路径同时回消息：

```
你发内容给机器人
   └─ 非命令 → cmdRelayToSession → sendToSession
        ├─ agent.send(...) → await whenIdle()
        ├─ ① return 回复内容          ← 机器人收到的第 1 条
        └─ 会话状态 running→idle
             └─ ② 监听定时器发现「有新事件 + 已结束」
                   → 再推「【会话】思考完毕：…」  ← 机器人收到的第 2 条
```

只有在「选了会话」时才会走 `sendToSession`，所以这个重复也只在选会话后出现；
没选会话时只有监听一条，监听关掉时只有转发一条——这正是用户描述的现象。

| 位置 | 改动 |
|---|---|
| `lib/index.mjs` | 新增 `suppressMonitorFor(sessionId, session)`：把该会话的监听快照置为 `{ wasRunning:false, eventsLen:当前事件数 }`。`sendToSession` 在 `await agent.whenIdle()` **之后**调用它 |
| 为什么在 whenIdle 之后 | 时序上 `whenIdle()` 的延续是**微任务**，会在监听的下一个 `setInterval` 宏任务之前执行，所以监听来不及抢跑；调早了则会话还在跑，监听随后仍会判定新一轮 |
| 监听本身没动 | 核心判定 `snap.wasRunning && !isRunning && evts.length > snap.eventsLen` 保持不变 —— 未选会话时的主动通知照旧 |
| 测试 | 新增守卫 #28：必须有 `suppressMonitorFor`、必须在 `whenIdle()` 之后调用、快照必须写成 `wasRunning:false` 且对齐 `eventsLen`、key 必须用 `session.header.id`（与监听循环一致）、监听核心判定不许被改坏 |

行为对照（模拟两条路径实测）：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 监听开 + 已选会话 | **2 条** ❌ | **1 条** ✅ |
| 监听开 + 未选会话 | 1 条 | 1 条 ✅ |
| 监听关 + 已选会话 | 1 条 | 1 条 ✅ |

守卫 #28 已自验能拦住「删掉抑制调用」的回归。

## [5.2.2] - 2026-10-04

### Fixed — 帮助文本只列一级指令

用户反馈：「有的指令是二级甚至三级，但都在帮助里显示出来了，帮助里只显示一级指令」。

对照代码梳理出的实际层级（详见 `docs/机器人指令树状图.md`）：

| 层级 | 指令 | 原帮助里的状态 |
|---|---|---|
| 一级 | `/帮助` `/链接` `/启动` `/停止` `/监听` `/状态` `/会话列表` `/当前会话` `/历史内容` `/当前模型` `/切换模型` | 混着列 |
| 二级 | `/选择 N`（`/会话列表` 之后）、`/切换模型 N`（`/切换模型` 之后） | ❌ 被当成独立指令单独占行 |
| 三级 | `/选强度 N`（`/切换模型 N` 之后） | ❌ **5 份帮助里一处都没写**，功能存在但无人可知 |

| 位置 | 改动 |
|---|---|
| `lib/index.mjs` | 新增共用 `HELP_LINES`：微信的 `WEIXIN_HELP` 与其它 4 通道的 `channelHelp()` 改为共用同一份（此前两份独立文本，改一处漏一处） |
| 帮助内容 | 只列 **10 条一级指令**；`/选择 N`、`/切换模型 N` 收进所属一级的说明；**补上「可选思考强度」**，让 `/选强度 N` 可被发现 |
| `/启动` | **从帮助里去掉**（`/链接` 已兼作启动：未启动会自动拉起，两者重叠，列出来会让用户困惑「两个都能启动该用哪个」）。**命令本身保留可用**，老用户不会突然收到「未知命令」 |
| 测试 | 新增守卫 #27：一级指令必须齐 10 条、二级/三级不许单独占行、不许列 `/启动`、`/启动` 实现不许被删、两个通道入口必须共用 `HELP_LINES` |

改写后的帮助：

```
可用命令：
· /帮助 —— 显示本列表
· /链接 —— 查看远程链接（未启动会自动开启）
· /停止 —— 停止远程服务
· /监听 —— 开关监听模式（会话思考完毕自动通知）
· /状态 —— 查看通道状态
· /会话列表 —— 列出所有会话，回复「/选择 N」选中
· /当前会话 —— 查看选中的会话名称
· /历史内容 —— 查看选中会话最近一次输出
· /当前模型 —— 查看当前使用的模型
· /切换模型 —— 列出模型，回复「/切换模型 N」选中（可选思考强度）
· 直接发送内容（无需前缀）—— 发送到选中的会话
· 未选择会话时，先 /会话列表 再 /选择 N
```

顺带修掉一个不一致：微信通道**从未实现过** `/启动`（只靠 `/链接` 隐式启动），
去掉 `/启动` 之后 5 个通道的指令集**完全一致**了。

守卫 #27 已自验能拦住「把 `/选择 N` 加回帮助」「把 `/启动` 加回帮助」两类回归。

## [5.2.1] - 2026-10-03

### Changed — 二维码改为**本地生成**：不再依赖任何外部图床

原先面板、微信绑定、QQ 扫码三处的二维码，都是把链接拼到**别人家的图床 URL** 后面让远端画图
（`api.pwmqr.com` / `api.qrserver.com`）。问题不只是慢：

| 问题 | 实测 / 影响 |
|---|---|
| 出图要等远端 | 同一张码：国内源 **0.21s**、境外源 **1.40s**（差 6.7 倍） |
| 每次刷新都要联网 | 断网、内网环境直接没有二维码 |
| 链接会外发第三方 | `?token=xxx` 明文交给图床（TLS 加密但对方可见） |
| 白嫖接口不稳定 | 限流/关停即失效 |

现在按 ISO/IEC 18004 自己实现：字节模式（UTF-8）+ 纠错等级 M + 版本 1–20（M 级上限 669 字节），
`canvas` 画好后 `toDataURL` 塞回原来的 `<img>`（**不换成 canvas 元素** —— 各处 `<img>` 的 `cssText`
与布局都依赖它，换了会错版）。

**渲染分辨率不能省（改这里务必先读）：** 第一版写成「1 模块 = 1 像素」，位图只有 41px（版本4），
被 CSS 拉到 190~200px 显示时浏览器放大插值 —— **边缘全糊，手机上（普遍 2x/3x 屏）甚至扫不出来**
（实测在 2x DPR 下旧图已无法解码，新图正常）。现在按「位图 ≈ 最大显示尺寸(200px) 的 2 倍」换算
每模块像素数，得到 348~420px 的位图（约 3–7KB）：

| | 位图 | 体积 | 190px 显示 | 2x 屏可扫 |
|---|---|---|---|---|
| 1 模块 1 像素（错） | 41×41 | 1.1 KB | 糊、模块粘连 | ❌ 解不出 |
| 2 倍显示尺寸（现在） | 410×410 | 6.5 KB | 锐利 | ✅ |

调参依据（实测对比 1 / 4 / 8 / 16 / 29 px 每模块）：**scale 4 已明显锐利，scale 8 起肉眼与
scale 29 无差别**，但 PNG 从 3KB 涨到 34KB —— 取 2 倍显示尺寸即可，不必画更大。
另外**不要**给二维码设 `image-rendering:pixelated`：位图与显示尺寸不是整数比时，最近邻缩小
反而会让模块边缘发毛；位图大于显示尺寸时浏览器默认的高质量缩小最干净。

**实测：三张码生成耗时 2.8–9.2ms（合计 15ms），比走远端快约 100 倍；离线可用；链接不外发。**

| 位置 | 内容 |
|---|---|
| `lib/panel.mjs` | **新增**内嵌二维码编码器（GF(256) 运算、RS 纠错、分块交织、掩码择优）+ `setQrImage()` 本地渲染；删除 `QR_SOURCES` 与整段超时兜底逻辑 |
| 三处调用 | 面板二维码 / 微信绑定 / QQ 扫码统一走 `setQrImage()` |
| 测试 | 守卫 #26 重写：禁止任何外部图床残留 + 把面板里那份 `qrEncode` 抠出来跑，**用独立解码器 `jsqr` 实测解码 10 例**（含版本 1/2/4/6/8/10/13/17） |
| 依赖 | `jsqr` + `qrcode-generator` 进 `devDependencies`（仅测试用，零依赖、不进生产） |

**踩坑记录（改这段代码前必读）：**

1. **格式信息的位序是「最高位在前」**。写成低位在前时，矩阵长得完全正常、自己写的解码器
   也能"读通"（用了同一套反序假设），但**任何扫码器都读不出**。教训：验证解码器不能和编码器共享假设。
2. **RS 生成多项式的 α 幂必须查表**，不能写 `Math.pow(2, d)` —— d≥8 时超出 GF(256) 范围，
   整张码直接失效。
3. **版本 8 起两组块的数据长度不同**（组1 比组2 少 1 字节）。按"所有块等长"处理会算出错误交织，
   同样是"图正常但扫不出"。表已改为 `[组1数据长, 纠错长, 组1块数, 组2数据长, 组2块数]`。
4. 表（ECC/对齐图案/版本信息）从权威实现**程序化提取**，不手抄。
5. **渲染分辨率不能 1 模块 1 像素** —— 会糊到手机上扫不出（见上文）。

**验证方式**（三层，都跑过）：

- 逐位交叉：数据码字、纠错码字、交织结果与独立实现逐字节一致；生成多项式与标准值一致；
- 解码：**22 例**（含中文/emoji/超长）全部被 `jsqr` 解回原文，版本选择与参考库完全一致；
- 端到端：`msedge --headless` 真实渲染 → 截图 → 裁出二维码区域 → 解码，3/3 通过（证明手机扫得出来）；
  另在 2x DPR 下对比过清晰度：旧的低分辨率图**已无法解码**，新图正常。

守卫 #26 已自验能拦住"格式位序反了""RS 多项式算错""块长按等长处理""退回 1 模块 1 像素"
四类回归。

## [5.2.0] - 2026-10-03

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

### Added — Tailscale 状态探测（面板直接看"通道通没通 / 直连还是中继"）

面板「公网」页在 `P2P（Tailscale）` 标签**同一行后面**显示状态，例如
`P2P（Tailscale）　通道已连通 · 路径 中继（tok）`，不用再敲命令行。新增 `lib/tailscale.mjs`：

- 数据来源两条：**网卡里的 100.64.0.0/10 地址**（零成本兜底）+
  **`tailscale status --json`**（`BackendState` / peer 的 `CurAddr` 直连 vs `Relay` 中继 / `Online`）
- CLI 定位顺序：`PATH` → **Windows 服务 `ImagePath` 同目录**（便携版装在任意目录时只有这条能找到）
  → 常见安装路径；负结果缓存 5 分钟，不反复查注册表
- 20 秒缓存 + 后台刷新，`snapshot()` 永不阻塞请求；CLI 不可用时退回网卡判断
- **没装 Tailscale 的用户看不到这一行**（不给无关的人添噪音）
- 踩坑记录：`status --json` 里 peer 的 `Relay` 是**字符串**（`"tok"`）不是数组，
  最初按数组判断导致路径恒为 `unknown`；现在两种形态都兼容（守卫 #24 覆盖）
- 顺带把 `isTailscaleRange` 的实现收拢到 `tailscale.mjs`（`index.mjs` 只做转发），
  避免"P2P 分页判定"与"免 token 判定"两处口径漂移
- **状态行措辞只描述"通道"，不断言手机**（用户逐轮定稿）：
  - 删掉「Tailscale 状态」标题与「Tailscale：」前缀（紧跟 `P2P（Tailscale）` 时是多余的）
  - 删掉「已连接 · 」前缀
  - **不写「手机在线/离线」** —— `Online` 只表示对端连着控制面，不代表隧道建立
    （实测 `LastHandshake` 常为 `0`、`Rx/Tx` 为 `0`）。改为：
    `通道已连通 · 路径 …` / `通道未连通（对端不在线）` / `通道未连通（没有其它设备）`；
    **未连通时不显示路径**（那是上次的中继，容易误导）
  - 未运行/未登录**套用同一套版式**（同一行、无独立前缀行）
- **记住上次见过的 Tailscale 地址**（`lastIp`）：Tailscale 一停网卡就消失，
  但面板那条 P2P 链接要**保留**，所以把见过的地址记下来，未运行/未登录时照样显示，
  文案注明「未运行（上次地址，启动后可用）」
- **`/链接` 命令同时给两条链接**（公网隧道 + P2P），5 个通道共用一份文案：

  ```
  公网链接：
  https://xxx.trycloudflare.com/?token=...

  P2P 链接：
  http://100.x.y.z:5566
  ```

  P2P 没打通时，P2P 那半写 **`p2p未打通`**，能判断出原因时附在括号里：

  ```
  P2P 链接：
  p2p未打通（手机端未开 Tailscale）
  ```

  - **能检测手机端有没有开 Tailscale**：读 peer 的 `Online` —— 电脑端连着但一台对端都不在线，
    就是"手机没开"，于是判为未打通并写明原因（而不是给一个点了打不开的地址）
  - 判定顺序（抽成纯函数 `p2pState`，守卫 #25 有 10 例真值表）：
    没有 100.64/10 地址 → `本机没有 Tailscale 地址`；`BackendState` 非 Running → `未登录`/`未运行`；
    tailnet 里没有其它设备 → `没有其它设备`；**有对端但全离线 → `手机端未开 Tailscale`**（非手机则 `对端未在线`）；
    代理没端口 → `代理未运行`
  - 拿不到探测数据（CLI 找不到）时退回"只看网卡"，不因读不到 peer 就误判未打通
  - 隧道还没建好但 P2P 通了 → 也照样把链接发出去（P2P 那半有用）

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
> 所以 `(.*)$` 对 CRLF 行一行都匹配不到（守卫会**假绿**）。已改为按 `/\r?\n/` 换行切分。

### Fixed — 面板通道动作按钮（飞书没有断开入口 / 微信已连接仍提示重新扫码）

各通道的「绑定 / 解绑」按钮此前是**按通道各写一套**，于是出现两个问题：

| 通道 | 原问题 |
|---|---|
| **飞书** | 被 `selfManaged` 分支排除，**根本没有断开按钮** —— 连上了就断不掉 |
| **微信** | 已连接状态仍显示「绑定」、仍提示「重新扫码」 |
| Telegram / QQ官方 | 断开入口藏在表单里，与顶部动作区不一致 |

现在统一为**状态感知**的一套动作按钮：

- 未连接 → 「绑定 / 重新绑定」；已连接 → 「解绑 / 断开」
- 四个通道（Telegram / QQ官方 / 飞书 / 微信）都并入**顶部动作区**，调**同一套 disconnect API**
- 移除表单内重复的断开按钮（避免同一动作两个入口）
- 已连接分支加 **`forceConfig` 逃生口**：想重新填凭证时能强制展开表单，不必先断开

> 两个提交（`c6bd9ce` / `62c1708`）在 5.0.0 版本号提交之后才落地，本条为发布前补录。

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
- 面板标题「远程访问」右侧新增**版本徽标**（`v5.2.0`，来自 `/remote/info` 的 `version`）：
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

### Removed

- **「自定义公网链接」功能整体删除**（面板填写框 + `/remote/custom-url` 路由 + 持久化字段 +
  `store.mjs` 的旧文件迁移）：它从设计上就只是"显示/复制"用的一条链接 ——
  二维码和 4 个机器人 `/链接` 命令都绕过它，填了也不改变流量走向，属于半成品；
  用户确认删除，不留死代码
- 机器人页签的长段说明文案精简：只留一句「通过聊天机器人遥控 DSH：微信 / 飞书 / 纸飞机 / QQ官方 / 钉钉。」，
  命令列表不再占面板高度
- 「公网」页 P2P 那一行的标签精简为 `P2P（Tailscale）`（地址本来就在下一行，长提示冗余）

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
