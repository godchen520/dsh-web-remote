# 待办清单（重构时一起处理）

> 用户 2026-11-02 决定："以后重构的时候再处理"。
> 这些不是 bug，是**结构性/体验性**改进，不紧急但要记住。

---

## 1. 日志前缀误导：`[dsh-weixin]` → `[remote]`

**现象**：用 QQ 通道时，日志里会出现

```
[dsh-weixin] resuming agent for session session-d6894084-…
```

用户以为"开了微信通道"，实际只是**共用层**打的日志（微信通道 `weixinMode: false`，根本没跑）。

**原因**：插件最初只支持微信，把消息送进会话的通用代码（`sendToSession` /
agent resume / monitor 诊断）都带着 `[dsh-weixin]` 前缀；后来 5 个通道共用，
前缀一直没改。

**做法**：`grep dsh-weixin lib/index.mjs`，把**非微信专属**的日志改成 `[remote]`。
真正的微信收发日志（`weixinSendMsg`、`weixinDrainInbox` 相关）保留原样。

**收益**：排查时不再被误导。成本：低（纯字符串替换 + 跑一遍测试）。

---

## 2. 会话回合失败时给**可执行**的提示

**现象**：QQ 里发消息 → 会话报错 → 错误原文直接回给用户：

```
prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")
```

用户看不懂，也不知道怎么办。

**根因**：目标会话没有设置模型 → `{{model}}` 取空 → 提示词装配失败。

**做法**：在转发层捕获这类错误，翻译成：

```
会话「远程插件」出错了
原因：这个会话还没有选模型
在 QQ 里发 /切换模型 选一个，或打开 DSH 网页设置
```

**收益**：用户能自己解决。成本：中（要匹配错误种类，不要过度包装）。

---

## 3. 代码结构（来自代码质量评估）

| 项 | 现状 | 建议 |
|---|---|---|
| `lib/panel.mjs` | 2303 行 | 按「页面渲染 / 表单 / 事件」拆分 |
| `lib/index.mjs` | 4000+ 行 | 继续往外抽（`dispatchSharedCommand` 已抽出，可再拆 commands） |
| `renderBotPage` | 729 行单函数 | 拆成按通道的小渲染函数 |
| 空 catch | 53 处 | 至少补一行 `/* ignore: 原因 */` 或 debug 日志 |

**已完成**：7 条共享指令从 5 份复制合并为 `dispatchSharedCommand()`（`5.7.8-dev.18`），
并加了守卫 #60 防止再复制回去。

---

## 4. 可选：其他通道也接上「自动选会话 + 思考中回执」

目前只有 **QQ** 有这两项（`5.7.8-dev.15` / `dev.17`）。
微信/飞书/Telegram/钉钉 还是"必须先 /选择"。

**注意**：`dispatchSharedCommand` 已经把 7 条共享指令统一了，
这两项如果要通用，应该跟着放进共用层——**但别直接复制到各通道**（那就是刚消灭的坑）。
