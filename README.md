# dsh-web-remote

DSH（DeepSeek Harness）手机 / 外网远程访问插件。

用手机浏览器随时随地访问你电脑上的 DSH：
- **公网**：Cloudflare Quick Tunnel（无需公网 IP、无需注册，`cloudflared` 缺失时自动下载）
- **局域网**：HTTP + HTTPS 直连（HTTPS 使用自动生成的自签名证书，零配置）
- **安全**：每次启动生成随机访问令牌；令牌校验通过后写入 HttpOnly Cookie；链接含令牌，请勿泄露
- **体验**：侧边栏常驻手机图标（刷新不消失）→ 面板可切换「公网 / 局域网」、一键复制链接、扫码访问、启动 / 停止 / 刷新
- **加速**：反向代理自动 gzip 压缩（加载大历史会话更快）
- **QQ 通道**：内置 OneBot 11 反向 WebSocket 服务（默认端口 3001），安装 NapCat 后向机器人发送「给我链接」即可获取访问地址

## 截图

页面左下角的手机快捷按钮（点击打开远程访问面板）：

![快捷按钮](docs/quick-button.png)

远程访问面板（公网 / 局域网切换、一键复制链接、二维码、启动 / 停止 / 换新链接）：

![远程访问面板](docs/remote-screenshot.png)

## 安装

本插件是一个标准 DSH bundle 包。两种方式任选：

### 方式一：GitHub 直接安装（当前推荐）

在 profile 目录（如 `$DSH_HOME/profiles/web`）执行：

```bash
pnpm add github:godchen520/dsh-web-remote --config.minimumReleaseAge=0
```

> `--config.minimumReleaseAge=0` 用于绕过 pnpm 11 的新包发布年龄校验；若你的 pnpm 无此限制可省略。

然后把 `dsh-web-remote` 加入 profile `package.json` 的 `dsh.profile.bundles` 列表：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-web-remote"]
    }
  }
}
```

然后重启 DSH。

### 方式二：npm 安装（包发布到 npm registry 后可用）

```bash
pnpm add dsh-web-remote
```

同样把它加进 `dsh.profile.bundles` 并重启。

### 方式三：手动 patch（不依赖 pnpm 安装）

把本包放入 profile 的 `node_modules`（或直接放在 profile 目录旁），然后在 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: web-remote
      name: 'dsh-web-remote'
```

> bundle 方式修改后需要重启 DSH；`cordis.patch.yml` 方式会被 HMR 热加载。

## 配置

全部可选，不配置即开箱即用。在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: web-remote
  config:
    targetPort: 3080        # DSH 自身端口
    httpPortStart: 3081     # 局域网 HTTP 起始端口（自动跳过占用）
    httpsPortStart: 3082    # 局域网 HTTPS 起始端口
    qqPortStart: 3001       # QQ OneBot 桥起始端口
    cloudflaredPath: ''     # 指定 cloudflared 路径；留空自动探测 PATH / 自动下载
    pfxPath: ''             # 指定 PFX 证书；留空自动生成自签名证书
    pfxPass: ''             # PFX 密码
    toolsDir: ''            # 工具与证书缓存目录；留空使用 $DSH_HOME/tools
    autoStart: true         # 插件加载即自动启动
    lanOpen: true           # 局域网免 token（私网来源直接放行）；公网隧道始终需要 token
```

## 使用

1. 启动后，页面左下角出现手机图标（刷新不消失）
2. 点击图标 → 面板显示运行状态和链接：
   - **公网** 标签：`https://xxx.trycloudflare.com/?token=...`
   - **局域网** 标签：`https://192.168.x.x:3082`（同 Wi-Fi 下；默认免 token，直接打开即可）
3. 手机浏览器打开链接即可访问 DSH；HTTPS 自签名证书首次会提示，选择「继续访问」即可
4. 面板内可随时复制链接 / 扫码 / 停止 / 重启（重启后链接与令牌会更新）

## 注意事项

- 每次插件重启隧道地址会变化（公网链接会更新），以面板或 QQ 机器人为准
- 公网链接含访问令牌，请勿泄露给他人；局域网默认免 token（`lanOpen: false` 可恢复令牌校验）
- 自签名证书仅用于加密传输，浏览器会提示不受信任——这是预期行为，选择「继续访问」即可（Edge 浏览器需关闭"增强安全性"或改用手机自带浏览器/iQOO 等）
- cloudflared 自动下载发生在首次启动（需联网），之后复用缓存

## 开发

```bash
npm test          # 语法检查
node test/test-dist.mjs   # 集成测试（假目标服务器 + 代理 + HTTPS + WS + QQ）
```

## License

MIT
