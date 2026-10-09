# 本仓库的约定

给在本仓库工作的 agent（以及未来的自己）。

## 版本号：本地开发一律用 `<目标版本>-dev.<N>`

本地迭代（改一点 → 推 pin → 真机验）**不消耗正式版本号**，一律写成：

```
5.7.0-dev.1  →  5.7.0-dev.2  →  5.7.0-dev.3  →  …
```

- **目标版本**（上面这个 `5.7.0`）是"这次要交付的那个版本"，在它**真机验证通过之前不动**
- 每推一次本地开发版，`N` 加一
- 验证通过、准备正式交付时，才把 `-dev.N` 去掉，写成 `5.7.0`
- 之后的下一轮开发，目标版本由已交付的正式版本递增决定（例如从 `5.7.0` 起下一轮是 `5.7.1-dev.1`）

**为什么**：`5.7.0` / `5.7.1` 这种号一旦推出去就成了历史，而本地来回修同一个特性的过程
不该占正式号 —— 否则"5.7.1"看起来像一次交付，实际只是本地第 2 次试。

推本地开发版时必须同时做两件事（**守卫 #40 会查**）：

1. `package.json` 的 `version` 改成新的 `-dev.N`
2. `CHANGELOG.md` 里必须有 `## [<同一个号>]` 的条目

## `lib/panel.mjs` 的注释里**绝不能出现反引号**

`lib/panel.mjs` 整体是一个反引号模板字符串（`export const INJECT_SCRIPT = \`…\``）。
注释里写一个反引号就会**把整个注入脚本截断**，而 `node --check` 只查宿主文件、**查不出来**
（踩过两次）。守卫 #39 的 ⓪ 会直接 `new Function(INJECT_SCRIPT)` 把它抓出来。

同理，`INJECT_SCRIPT` 里也不能用模板插值 `${…}`。

## 不要用 shell 回写文本文件

中文 Windows 上 `Get-Content` 会按 GBK 读 UTF-8 文件，`[IO.File]::WriteAllText` 回写就是
一文件乱码（踩过，靠 `git checkout` 恢复的）。改文本一律用编辑工具。

## 改完必须跑

```
npm test                            # 39+ 条守卫，必须 exit 0（要看 exit code！）
node <workspace>/rail-check.mjs     # 窄屏适配层的行为桩（30 条）
```

守卫是"结构断言"，行为桩是"真跑一遍"。**只有守卫过不代表能用** —— 加新逻辑时两边都要补。

## 部署（改完不部署 = 没改）

```
编辑 checkout → npm test → commit → push
  → profiles/web 与 profiles/desktop **两个都**换 pin
  → 各自 pnpm install
  → 核对安装副本与工作树逐字节相同
```

**只更新一个 profile 会让另一端看不到改动**（桌面端走的是 `desktop` profile，踩过）。
`pnpm install` 会把手动拷进去的文件按 pin 还原 —— 所以只能走"push + 换 pin"这条路。

## 窄屏适配层的既有事实（改之前先读）

- 宽度改写走**纯 CSS + `!important`**（能压过 React 的内联样式），不要退回 JS 改写
- **必须逐列钉住 `grid-column`**：官方收起态侧边栏是绝对定位浮层、脱离网格流，
  `centerCol` 会落到已变 0 宽的第一轨道上把对话挤成 0 宽（间歇性）
- 第三条轨道是 **`_rightbarCol`**，不是参考实现里的 `_detailsCol`（本版 DSH 没有那个后缀）
- 选择器用**语义后缀**（`[class$="_xxx"]`），绝不写死哈希前缀；
  `_frame` 在 6 个包里都有，必须 `:has([class*="_centerCol"])` 限定；
  `navCell` 是 `clsx()` 拼类，只能包含匹配
- 所有规则挂在 `body.webrm-mobile` 下（style 标签常驻 head，不限定会改坏桌面端）
- 收起/展开必须**立刻**响应（盯 `data-sidebar-collapsed`），定时器只能当兜底
