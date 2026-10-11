# 发布流程检查清单

> 适用：`dsh-web-remote`（同构的 DSH 插件也可照用）
> 目标：**用户在市场里只看到一条干净的说明；两个 profile 都不落空**

---

## 0. 核心约定

| 约定 | 说明 |
|------|------|
| **本地版本号** | `<目标版本>-dev.<N>`，如 `5.8.0-dev.1`、`5.8.0-dev.2` |
| **发布版本号** | 去掉 `-dev.N`，如 `5.8.0` |
| **版本号只增不减** | 否则市场判定「这是旧版本」，用户**收不到更新提示** |
| **两个 profile** | `desktop` 和 `web` **都必须更新**（桌面版走 desktop） |
| **提交即说明** | 市场的「更新内容」＝ 从用户安装的 SHA 到最新之间的**提交 message** |

> ⚠️ 最后一条决定了发布前必须 **squash** —— 否则用户看到的是一串「修 xxx」「再修 xxx」。

---

## 1. 本地开发阶段

- [ ] 版本号写成 `<目标版本>-dev.<N>`（守卫 #40 会校验格式）
- [ ] 每完成一块就提交（message 随意，反正发布前会 squash 掉）
- [ ] CHANGELOG 里写对应的 `## [<目标版本>-dev.<N>]` 条目

---

## 2. 发布前准备（关键步骤）

- [ ] **squash 成本版一个提交**

  ```bash
  # 方式一：交互式压合
  git rebase -i <上一个发布标签>

  # 方式二：软重置后重提（更直接）
  git reset --soft <上一个发布标签>
  git commit -m "feat: <本版主题>（v5.8.0）"
  ```

- [ ] **版本号改成正式版**（`package.json` 去掉 `-dev.N`）
- [ ] **CHANGELOG 合并**：把 `dev.1`/`dev.2`… 并成一条 `## [5.8.0]`，**不留 `dev` 字样**
- [ ] **跑测试**：`npm test` 必须输出 `ALL TESTS DONE` —— **不过不提交**
- [ ] **破坏性变更**：在 CHANGELOG 和 Release 正文**最顶部**用醒目格式写明

---

## 3. 发布到 GitHub

- [ ] 提交：`chore(release): v5.8.0 —— <一句话主题>`
- [ ] 推送提交：`git push origin main`
- [ ] 打标签并推送：

  ```bash
  git tag -a v5.8.0 -m "v5.8.0 - <主题>"
  git push origin v5.8.0
  ```

- [ ] 建 Release：
  - **标题**：`v5.8.0 — <主题>`
  - **正文**：写**给用户看的介绍**（不是 CHANGELOG 原文）；技术细节折叠进 `<details>`
  - 破坏性版本加**警告横幅**
  - ⚠️ **安装命令必须写成不钉 ref 的形式**（见下方规则），否则用户照抄后**收不到更新提示**

### ⚠️ 安装命令的铁律：不要钉标签

| 写法 | 用户装完能否收到更新提示 |
|------|:---:|
| `pnpm add github:godchen520/dsh-web-remote` | ✅ **能**（推荐） |
| `pnpm add github:godchen520/dsh-web-remote#<40位SHA>` | ✅ 能 |
| `pnpm add github:godchen520/dsh-web-remote#main` | ✅ 能 |
| `pnpm add github:godchen520/dsh-web-remote#v5.8.0` | ❌ **不能**（标签会被市场当 ref 解析，`latest` 恒等于 `current`） |

**原因**：市场判断 GitHub 安装是否有更新，是拿「spec 里写的那个 ref 指向的提交」和「你已装的提交」比。
钉标签时，那个 ref 就是你装的版本自己 → 永远相等 → 永远显示「已是最新」。

> 所以：**README / Release 正文里给用户的命令都不钉 ref**；
> 只有 profile 自己的 `package.json` 用 `#<SHA>`（那是精确锁定，不影响更新提示）。

---

## 4. 部署到 profile（最容易漏的一步）

- [ ] **两个 profile 都改** `package.json`：

  ```json
  "dependencies": {
    "dsh-web-remote": "github:godchen520/dsh-web-remote#<新SHA>"
  }
  ```

  路径：`.dsh/profiles/desktop/package.json` **和** `.dsh/profiles/web/package.json`

- [ ] **两个都跑安装**：

  ```bash
  cd $DSH_HOME/profiles/desktop && pnpm install --config.minimumReleaseAge=0
  cd $DSH_HOME/profiles/web     && pnpm install --config.minimumReleaseAge=0
  ```

- [ ] 验证三处一致：**锁定 SHA** / **lockfile** / **部署副本版本**

---

## 5. 发布后验证

- [ ] 运行实例 `/remote/info` 的 `version` ＝ 新版本
- [ ] 实例**启动时间晚于**部署时间（否则内存里还是旧代码 → 需重启）
- [ ] 市场卡片：
  - 装了新版的用户 → 显示「**已是最新**」
  - 停在旧版的用户 → 显示「**有新版 vX.Y.Z · 更新内容 >**」
- [ ] 依赖有变化时，确认 pnpm 真的装上了

---

## 6. 踩过的坑（血泪记录）

| 坑 | 教训 |
|----|------|
| 只更新了 `web`，桌面版走 `desktop` → **静默失效** | 两个 profile 都要更新 |
| 发布版 CHANGELOG 里留着 `dev` 字样 | 合并时一并去掉 |
| 注释里一个反引号**截断整个注入脚本**，而 `node --check` 完全查不出来 | 新增守卫「注入脚本必须能独立解析」 |
| 版本号从 5.7.2 想发成 5.6.6 | **版本号只能往上走** |
| Release 正文写得太技术 | 用户看的是 Release；技术细节折叠进 `<details>` |
| 推一堆小提交 | 它们会变成用户在市场里看到的「更新内容」→ **发布前 squash** |

---

## 7. 一句话版

> **本地随便提交；发布前 squash 成一个提交 + 合并 CHANGELOG + 去掉 dev 后缀；测试过了才推；推完打标签写 Release；最后两个 profile 都要装。**
