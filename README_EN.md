# dsh-web-remote

<p align="center">
  <img src="docs/banner.svg" alt="dsh-web-remote" width="100%">
</p>

[![npm version](https://img.shields.io/badge/npm-dsh--web--remote-blue)](https://github.com/godchen520/dsh-web-remote)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH Compatible](https://img.shields.io/badge/DSH-1.x-brightgreen)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](../../pulls)

<p align="right">
  <a href="README.md">中文</a> | <b>English</b>
</p>

> A plugin for DeepSeek Harness (DSH) that enables mobile and remote access via phone browser or WeChat.

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🌐 **Public Access** | Cloudflare Quick Tunnel — no public IP or registration needed; auto-downloads `cloudflared` |
| 📡 **LAN Direct** | HTTP + HTTPS direct connection (HTTPS with auto-generated self-signed cert, zero config) |
| 🔒 **Secure Auth** | Random token per start; HttpOnly Cookie; LAN can be token-free |
| ⚡ **Performance** | Reverse proxy with automatic gzip compression for faster large session loads |
| 📱 **Sidebar Icon** | Phone shortcut button persists in the bottom-left corner |
| 🔗 **Custom Public URL** | Set your own public URL (e.g. ngrok); edit/clear from the panel |
| 🔌 **Custom Port** | Change the LAN HTTPS port with occupancy detection |
| 🤖 **WeChat Bot** | iLink protocol direct connection to WeChat; AI chat, session control, model switching |
| 💬 **Feishu Bot** | WebSocket long connection; command control, monitor notifications |
| ✈️ **Telegram Bot** | Long polling; HTTP proxy support, command control, monitor push |
| 🐧 **QQ Official Bot** | QQ Open Platform official integration; WebSocket long connection — **no extra QQ account, no public endpoint/ICP filing** |
| 👁️ **Session Monitor** | `/monitor` — get notified on your bound channel when the agent finishes |
| 🩺 **Channel Health** | Per-channel monitoring (WeChat/Feishu/Telegram/QQ); auto-stops after 3 consecutive failures, red-dot shortcut + one-click reconnect |

## 🚀 Quick Start

**3 steps:**

```bash
# 1. Install plugin (run in DSH profile directory)
cd $DSH_HOME/profiles/web
pnpm add github:godchen520/dsh-web-remote

# 2. Register bundle (edit package.json)
# Add "dsh-web-remote" to the "dsh.profile.bundles" array

# 3. Restart DSH
dsh web
```

A 📱 icon appears in the bottom-left corner → click to open the remote panel.

## 📸 Screenshots

**Sidebar button** (bottom-left corner):

![Sidebar Button](docs/quick-button.png)

**Remote Panel** (Public / LAN switch, copy link, QR code, start/stop):

![Remote Panel](docs/remote-screenshot.png)

## 📋 Installation

### Option 1: GitHub Install (Recommended)

```bash
cd $DSH_HOME/profiles/web
pnpm add github:godchen520/dsh-web-remote
```

Add `"dsh-web-remote"` to `dsh.profile.bundles` in `package.json`, then restart DSH.

> Use `--config.minimumReleaseAge=0` if pnpm 11 blocks new packages.

### Option 2: Manual Patch

Place the package in profile's `node_modules`, then add to `cordis.patch.yml`:

```yaml
- insert:
    - id: web-remote
      name: 'dsh-web-remote'
```

> Bundle install requires restart; cordis.patch.yml supports HMR hot-reload.

## ⚙️ Configuration

All optional. Override in `cordis.patch.yml`:

| Option | Default | Description |
|--------|---------|-------------|
| `targetPort` | `3080` | DSH's own port |
| `httpPortStart` | `3081` | LAN HTTP start port (auto-skips occupied) |
| `httpsPortStart` | `3082` | LAN HTTPS start port |
| `qqPortStart` | `3001` | QQ OneBot bridge start port |
| `cloudflaredPath` | `''` | Specify cloudflared path; empty = auto-detect / auto-download |
| `pfxPath` | `''` | PFX certificate; empty = auto-generate self-signed |
| `pfxPass` | `''` | PFX password |
| `toolsDir` | `''` | Tool & cert cache directory; empty = `$DSH_HOME/tools` |
| `autoStart` | `true` | Auto-start on plugin load |
| `lanOpen` | `true` | LAN token-free mode (private network bypass) |

## 📱 Usage

1. After start, a 📱 icon appears in the bottom-left corner
2. Click the icon → panel shows status and links
3. Open the link in your phone browser

**Public:** `https://xxx.trycloudflare.com/?token=...`
**LAN:** `https://192.168.x.x:3082` (same Wi-Fi; token-free by default)

## 🤖 WeChat Bot

Control DSH directly from WeChat:

**Remote Control Commands:**
- `/link` — Get public link (auto-starts if stopped)
- `/stop` — Stop remote service
- `/monitor` — Toggle session monitor (notify when agent finishes)

**Session Management:**
- `/sessions` — List all sessions
- `/select N` — Select session N
- `/session` — Show selected session name
- `/history` — Show session's recent output

**Model Switching:**
- `/model` — Show current model
- `/switch-model` — List and switch models
- `/effort N` — Set reasoning effort

**Chat:**
- Send content directly → auto-sends to selected session with result
- Shows prompt to select a session when none is selected

## 💬 Feishu Bot

Control DSH directly from Feishu (Lark):

- `/link` — Get public link
- `/stop` — Stop remote service
- `/monitor` — Toggle session monitor
- `/help` — Show command list

**Setup:** DSH Web panel → Bot tab → Feishu, fill in App ID and App Secret, then bind.

## ✈️ Telegram Bot

Control DSH directly from Telegram:

- `/link` — Get public link
- `/stop` — Stop remote service
- `/monitor` — Toggle session monitor
- `/help` — Show command list

**Setup:** DSH Web panel → Bot tab → Telegram, fill in the Bot Token, then bind.

**Proxy:** If the Telegram API is unreachable from your network, configure an HTTP proxy in the panel.

## 🐧 QQ Official Bot

Official QQ bot via the **QQ Open Platform** (not NapCat protocol emulation):

- `/link` — Get public link
- `/stop` — Stop remote service
- `/monitor` — Toggle session monitor
- `/model` — Show current model
- `/status` — Channel status
- `/help` — Show command list

**Scenarios:** QQ group chat + message-list private chat (C2C).

**Setup (two options):**

**Option 1 — QR binding (recommended; no secrets to copy):**

1. DSH Web panel → Bot tab → **QQ官方** → click "📱 扫码绑定"
2. Scan the QR code with **mobile QQ**
3. Pick the bot you want to bind in the page that opens, then confirm
4. Credentials are filled in automatically and the channel connects

> Scanning **binds an existing bot** — it does not create one. Create one first via Option 2 if needed.

**Option 2 — Manual entry:**

1. Open the [QQ Open Platform quick-create page](https://q.qq.com/qqbot/openclaw/login.html), sign in with QQ, click "Create Bot" (individual accounts may create up to 5)
2. Copy the **AppID** and **AppSecret** from the platform's developer settings
3. Paste them into the panel and click connect

**Highlights:**

| Item | Notes |
|---|---|
| Extra QQ account | **Not required** — the platform assigns a dedicated bot identity; your QQ is only the admin |
| Public endpoint | **Not required** — WebSocket long connection with built-in heartbeat and RESUME |
| ICP filing | **Not required** |
| Session persistence | Supported — survives restarts via RESUME, replaying missed events |
| Proactive push | Supported (you must have messaged the bot first; group needs owner permission) |

**Group chat:** the group owner simply adds the bot to the group. Receiving *all* group messages requires the owner to enable it in the bot settings.

**Coexistence:** independent from the existing **QQ (NapCat)** channel — both can run at once. NapCat is more feature-complete but carries ban risk; the official bot is compliant and stable.

## 🩺 Channel Health Monitoring

WeChat / Feishu / Telegram / QQ Official are monitored independently:

- **3 consecutive** failures → that channel stops automatically and raises an alert
- The remote icon shows a **red dot** (lights up when any channel is down)
- **Clicking the red dot jumps straight** to the broken channel page, with a **one-click reconnect** button

## 🔧 Compatibility

| DSH version | Status |
|---|---|
| **0.2.x (tested on 0.2.0-rc.2)** | ✅ Supported |
| 0.1.2-rc.1 ~ 0.1.x | ✅ Supported |
| < 0.1.2-rc.1 | ❌ Not supported (`session.events` was still a property back then; no `snapshotEvents()`) |

This plugin **imports no `@deepseek-ai/*` package** — every host capability (`webServer`, `subprocess`, `agents`, `sessions`, `sessionQuery`, …) comes from cordis service injection. So a DSH change to **package exports** (e.g. 0.2.x removing `settingsNamespace` / `installSettingsSection` from `dsh-settings`) cannot affect it.

Only the **service interfaces themselves** need adapting: currently `session.snapshotEvents()` (the 0.1.2+ form).

## ❓ FAQ

**Q: Public link shows "not secure"?**
A: Expected for self-signed HTTPS certs. Choose "Continue anyway" in your phone browser. Edge may need "Enhanced Security" turned off.

**Q: Link changes after DSH restart?**
A: Public tunnel generates a new address each restart — this is normal. WeChat-bound tokens auto-restore.

**Q: cloudflared download fails?**
A: First start needs internet to download cloudflared (~10MB). Afterwards it's cached. You can also manually place it in `toolsDir`.

**Q: WeChat disconnects after scanning?**
A: After DSH restart, WeChat auto-reconnects (token is persisted). If still disconnected, re-send `/link` to rebind.

## 📝 Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

## 🤝 Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for development and submission guidelines.

## 📄 License

[MIT](LICENSE)
