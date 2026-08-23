// dsh-web-remote — DSH 手机/外网远程访问插件（可分发版）
//
// 功能：
//   · 局域网直连：HTTP(3081) + HTTPS(3082，自动生成自签名证书) 反向代理
//   · 公网访问：Cloudflare Quick Tunnel（cloudflared 缺失时自动下载）
//   · token 鉴权 + gzip 压缩 + WebSocket 升级转发
//   · 常驻手机图标面板（公网/局域网切换、复制、二维码、启动/停止/刷新）
//   · QQ 机器人通道（OneBot 11 反向 WS，供 NapCat 连接后取链接）
//
// 配置项（cordis.patch.yml 的 config 字段，均可省略）：
//   targetPort      DSH 自身端口               默认 3080
//   httpPortStart   代理 HTTP 起始端口         默认 3081
//   httpsPortStart  代理 HTTPS 起始端口        默认 3082
//   qqPortStart     QQ 桥起始端口              默认 3001
//   cloudflaredPath cloudflared 可执行文件路径  默认 ''（自动探测 PATH / 自动下载）
//   pfxPath         自定义 PFX 证书路径         默认 ''（自动生成自签名证书）
//   pfxPass         PFX 密码                    默认 ''
//   toolsDir        工具与证书缓存目录          默认 ''（$DSH_HOME/tools）
//   autoStart       插件加载即自动启动          默认 true
//   lanOpen         局域网免 token              默认 true（私网来源放行；公网隧道仍要 token）
//   tunnelProtocol  隧道协议 http2|quic|auto    默认 http2（UDP 被 QoS 的网络请用 http2）

import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createGzip } from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { generateSelfSignedCert, lanIPs } from './cert.mjs';
import { createProxyServer } from './proxy.mjs';
import { createQQServer } from './qq.mjs';
import { downloadCloudflared, downloadFile } from './download.mjs';
import { INJECT_SCRIPT } from './panel.mjs';





// ───────────────────────── 插件主体 ─────────────────────────

export const name = 'web-remote';
export const inject = ['timer'];

export function apply(ctx, rawConfig) {
  const cfg = rawConfig ?? {};
  const config = {
    targetPort: cfg.targetPort ?? 3080,
    httpPortStart: cfg.httpPortStart ?? 3081,
    httpsPortStart: cfg.httpsPortStart ?? 3082,
    qqPortStart: cfg.qqPortStart ?? 3001,
    cloudflaredPath: cfg.cloudflaredPath ?? '',
    pfxPath: cfg.pfxPath ?? '',
    pfxPass: cfg.pfxPass ?? '',
    toolsDir: cfg.toolsDir ?? '',
    autoStart: cfg.autoStart ?? true,
    lanOpen: cfg.lanOpen ?? true,
    tunnelProtocol: cfg.tunnelProtocol ?? 'http2',
  };
  // 读取持久化的自定义端口（toolsDir 尚未就绪，用路径拼接）
  try {
    var portDir = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'tools') : path.join(os.homedir(), '.dsh', 'tools');
    var portFile = path.join(portDir, 'custom-port.json');
    if (fs.existsSync(portFile)) {
      var pd = JSON.parse(fs.readFileSync(portFile, 'utf-8'));
      if (pd && pd.port) { config.httpsPortStart = pd.port; }
    }
  } catch (e) {}

  // 等待 webServer / subprocess 服务就绪后再挂载（与官方 dsh-market 同款模式）
  ctx.inject(['subprocess', 'webServer'], (hostCtx) => {
    const subprocess = hostCtx.subprocess;
    const webServer = hostCtx.webServer;

    // 工具目录：$DSH_HOME/tools 或 ~/.dsh/tools
    let toolsDir = config.toolsDir;
    if (!toolsDir) {
      toolsDir = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'tools') : path.join(os.homedir(), '.dsh', 'tools');
    }
    try { fs.mkdirSync(toolsDir, { recursive: true }); } catch (e) { /* ignore */ }

  const state = { running: false, starting: false, url: null, token: null, port: null, httpsPort: null, ips: [], qq: null, error: null, updatedAt: null };
  let proxy = null;
  let tunnelHandle = null;
  let qqServer = null;
  let qqPort = null;

  const waitForPattern = (handle, pattern, timeoutMs) => new Promise((resolve, reject) => {
    let stdoutOffset = 0;
    let stderrOffset = 0;
    let acc = '';
    const started = Date.now();
    const tick = () => {
      try {
        const so = handle.collected.stdout;
        if (so) { const r = so.readFrom(stdoutOffset); stdoutOffset = r.nextOffset; acc += r.text; }
        const se = handle.collected.stderr;
        if (se) { const r = se.readFrom(stderrOffset); stderrOffset = r.nextOffset; acc += r.text; }
        const m = acc.match(pattern);
        if (m) { resolve(m[1] || m[0]); return; }
      } catch (e) { reject(e); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('timeout waiting for output: ' + acc.slice(-300))); return; }
      ctx.timeout(tick, 200);
    };
    tick();
  });

  const spec = (argv, extraEnv) => ({
    argv,
    cwd: toolsDir,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536, spill: { maxBytes: 1048576 } }, stderr: { maxBytes: 65536, spill: { maxBytes: 1048576 } } },
    graceMs: 2000,
    env: extraEnv || {},
  });

  const stop = () => {
    if (tunnelHandle) { try { tunnelHandle.terminate(); } catch (e) { /* ignore */ } }
    tunnelHandle = null;
    if (proxy) { proxy.close(); proxy = null; }
    if (qqServer) { qqServer.close(); qqServer = null; }
    qqPort = null;
    state.running = false;
    state.url = null;
    state.token = null;
    state.port = null;
    state.httpsPort = null;
    state.ips = [];
    state.qq = null;
    state.updatedAt = Date.now();
  };

  const start = async () => {
    if (state.running || state.starting) return state;
    state.starting = true;
    state.error = null;
    try {
      // 1. 反向代理（HTTP + HTTPS 同端口族）
      proxy = createProxyServer({ targetPort: config.targetPort, pfxPath: config.pfxPath, pfxPass: config.pfxPass, lanOpen: config.lanOpen });
      const httpPort = await findFreePort(config.httpPortStart, config.httpPortStart + 9);
      const httpsPort = await findFreePort(config.httpsPortStart, config.httpsPortStart + 9);
      await proxy.start(httpPort, httpsPort);
      state.token = proxy.token;
      state.port = httpPort;
      state.httpsPort = httpsPort;
      state.ips = lanIPs();

      // 2. cloudflared 隧道
      let cloudflaredPath = config.cloudflaredPath;
      if (!cloudflaredPath) {
        try { cloudflaredPath = await subprocess.resolveExecutable('cloudflared'); } catch (e) { /* 不在 PATH */ }
      }
      if (!cloudflaredPath) {
        cloudflaredPath = path.join(toolsDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
        if (!fs.existsSync(cloudflaredPath)) {
          state.error = 'cloudflared 未找到，正在自动下载…';
          await downloadCloudflared(toolsDir);
        }
      }
      const tunnelArgs = [cloudflaredPath, 'tunnel', '--url', 'http://127.0.0.1:' + httpPort, '--no-autoupdate', '--ha-connections', '4'];
      if (config.tunnelProtocol) tunnelArgs.push('--protocol', config.tunnelProtocol);
      tunnelHandle = subprocess.spawn(spec(tunnelArgs));
      const url = await waitForPattern(tunnelHandle, /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/, 30000);
      state.url = url;

      // 监听 cloudflared 进程退出：隧道断了立刻标记，面板不再显示失效的旧链接
      const currentTunnel = tunnelHandle;
      currentTunnel.done.then(() => {
        if (tunnelHandle === currentTunnel && state.running) {
          state.url = null;
          state.error = '隧道已断开（cloudflared 退出），请点「停止」后重新「启动」获取新链接';
          state.updatedAt = Date.now();
        }
      }, () => {});

      // 3. QQ 桥
      qqServer = createQQServer({ infoUrls: ['http://127.0.0.1:' + config.targetPort + '/remote/info', 'http://127.0.0.1:' + config.targetPort + '/remote/access'] });
      qqPort = await findFreePort(config.qqPortStart, config.qqPortStart + 4);
      await qqServer.start(qqPort);
      state.qq = 'listening';

      state.running = true;
      state.updatedAt = Date.now();
    } catch (e) {
      state.error = String(e && e.message || e);
      stop();
    } finally {
      state.starting = false;
    }
    return state;
  };

  // ====== 微信 iLink 状态 ======
  const weixinTokenPath = path.join(toolsDir, 'weixin-token.json');
  const weixinState = { status: 'idle', botToken: null, qrcode: null, qrcodeUrl: null, error: null };
  function saveWeixinToken(token) {
    try { fs.writeFileSync(weixinTokenPath, JSON.stringify({ botToken: token, savedAt: Date.now() })); } catch (e) { console.error('[dsh-weixin] save token failed:', e.message); }
  }
  function loadWeixinToken() {
    try { if (fs.existsSync(weixinTokenPath)) { const d = JSON.parse(fs.readFileSync(weixinTokenPath, 'utf8')); return d.botToken || null; } } catch (e) { /* ignore */ }
    return null;
  }
  function clearWeixinToken() {
    try { if (fs.existsSync(weixinTokenPath)) fs.unlinkSync(weixinTokenPath); } catch (e) { /* ignore */ }
  }
  const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
  function iLinkHeaders(token) {
    const uin = Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF))).toString('base64');
    const h = { 'Content-Type': 'application/json', 'AuthorizationType': 'ilink_bot_token', 'X-WECHAT-UIN': uin };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }
  async function iLinkGet(path, token) {
    const https = await import('node:https');
    return new Promise((resolve, reject) => {
      const req = https.request(ILINK_BASE + path, { method: 'GET', headers: iLinkHeaders(token) }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  }
  async function iLinkPost(path, body, token) {
    const https = await import('node:https');
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body || {});
      const req = https.request(ILINK_BASE + path, { method: 'POST', headers: { ...iLinkHeaders(token), 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
      });
      req.on('error', reject);
      req.setTimeout(40000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(payload);
      req.end();
    });
  }
  async function weixinGetQR() {
    const res = await iLinkGet('/ilink/bot/get_bot_qrcode?bot_type=3');
    if (res.ret !== 0) throw new Error('get_bot_qrcode failed: ' + JSON.stringify(res));
    weixinState.qrcode = res.qrcode;
    weixinState.qrcodeUrl = res.qrcode_img_content;
    weixinState.status = 'waiting';
    weixinState.error = null;
    return { qrcode: res.qrcode, qrcodeUrl: res.qrcode_img_content };
  }
  async function weixinPollQR() {
    if (!weixinState.qrcode) return { status: 'idle' };
    const res = await iLinkGet('/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(weixinState.qrcode));
    if (res.status === 'confirmed' && res.bot_token) {
      weixinState.status = 'connected';
      weixinState.botToken = res.bot_token;
      weixinState.qrcode = null;
      weixinState.qrcodeUrl = null;
      weixinState.error = null;
      console.log('[dsh-weixin] connected! saving token & starting poll loop...');
      saveWeixinToken(res.bot_token);
      weixinPollLoop();
      return { status: 'connected', botToken: res.bot_token, baseurl: res.baseurl };
    }
    if (res.status === 'expired') {
      weixinState.status = 'idle';
      weixinState.qrcode = null;
      weixinState.qrcodeUrl = null;
      return { status: 'expired' };
    }
    return { status: res.status || 'waiting' };
  }
  function weixinDisconnect() {
    weixinState.status = 'idle';
    weixinState.botToken = null;
    weixinState.qrcode = null;
    weixinState.qrcodeUrl = null;
    weixinState.error = null;
    weixinState._polling = false;
    clearWeixinToken();
  }

  // ====== 微信消息轮询（AI 回复）======
  let weixinPollLoopRunning = false;
  let weixinGenerateReply = null; // 由 apply(ctx) 注入
  // 当前消息的发送上下文（命令系统可主动发"思考中"等中间消息）
  let weixinActiveSend = null;
  // 主回复发出后要补发的下一条消息（如链接后的使用提示）
  let weixinFollowup = null;
  let weixinMonitorMode = false;
  let weixinMonitorTimer = null;
  let weixinMonitorSnapshots = {}; // { agentId: { eventsLen, wasRunning } }
  let weixinMonitorTitles = {}; // { agentId: title }

  async function weixinSendMsg(botToken, toUserId, text, contextToken) {
    const clientId = 'dsh-weixin-' + Math.random().toString(36).slice(2, 10);
    const body = {
      msg: {
        from_user_id: '',
        to_user_id: toUserId,
        message_type: 2,
        message_state: 2,
        context_token: contextToken || '',
        client_id: clientId,
        item_list: [{ type: 1, text_item: { text: text } }]
      },
      base_info: { channel_version: '1.0.2' }
    };
    return iLinkPost('/ilink/bot/sendmessage', body, botToken);
  }

  async function weixinPollLoop() {
    if (weixinPollLoopRunning) return;
    weixinPollLoopRunning = true;
    let cursor = '';
    console.log('[dsh-weixin] poll loop started');
    while (weixinState.status === 'connected' && weixinState.botToken) {
      try {
        const res = await iLinkPost('/ilink/bot/getupdates', {
          get_updates_buf: cursor,
          base_info: { channel_version: '1.0.2' }
        }, weixinState.botToken);
        if (res.get_updates_buf) cursor = res.get_updates_buf;
        if (res.msgs && res.msgs.length > 0) {
          for (const msg of res.msgs) {
            if (msg.message_type === 1 && msg.item_list && msg.item_list.length > 0) {
              const textItem = msg.item_list.find(function (i) { return i.type === 1 && i.text_item; });
              if (textItem && msg.from_user_id) {
                const userText = textItem.text_item.text;
                console.log('[dsh-weixin] received:', userText);
                let reply;
                // 暴露发送上下文，供命令系统发"思考中"等中间消息
                weixinActiveSend = { botToken: weixinState.botToken, toUserId: msg.from_user_id, contextToken: msg.context_token };
                weixinState.lastFromUserId = msg.from_user_id;
                weixinState.lastContextToken = msg.context_token;
                try {
                  if (weixinGenerateReply) {
                    reply = await weixinGenerateReply(userText);
                  } else {
                    reply = '[回声] ' + userText;
                  }
                } catch (e) {
                  console.error('[dsh-weixin] AI error:', e.message || e);
                  reply = '[AI 回复失败: ' + String(e.message || e).slice(0, 100) + ']';
                } finally {
                  weixinActiveSend = null;
                }
                // iLink 文本消息有长度限制，超长截断
                if (reply.length > 2000) reply = reply.slice(0, 2000) + '…';
                await weixinSendMsg(weixinState.botToken, msg.from_user_id, reply, msg.context_token);
                console.log('[dsh-weixin] replied:', reply.slice(0, 100));
                // 主回复发出后补发 followup（如链接使用提示）
                if (weixinFollowup) {
                  const f = weixinFollowup;
                  weixinFollowup = null;
                  try {
                    await weixinSendMsg(weixinState.botToken, msg.from_user_id, f, msg.context_token);
                    console.log('[dsh-weixin] followup sent');
                  } catch (e) { console.error('[dsh-weixin] followup failed:', e.message); }
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('[dsh-weixin] poll error:', e.message || e);
        await new Promise(function (r) { setTimeout(r, 5000); });
      }
    }
    weixinPollLoopRunning = false;
    console.log('[dsh-weixin] poll loop stopped');
  }

  let customPublicUrl = null;
  let feishuToken = null;
  const feishuConfigPath_snapshot = path.join(toolsDir, 'feishu-config.json');

  const snapshot = () => {
    var feishuSt = null;
    try {
      if (feishuToken && Date.now() < feishuToken.expireAt) { feishuSt = 'connected'; }
      else {
        var fPath = feishuConfigPath_snapshot;
        console.log('[snapshot] feishu check path:', fPath, 'exists:', fs.existsSync(fPath));
        if (fs.existsSync(fPath)) {
          var fc = JSON.parse(fs.readFileSync(fPath, 'utf-8'));
          console.log('[snapshot] feishu config:', fc.appId ? 'has appId' : 'no appId');
          if (fc && fc.appId) feishuSt = 'configured';
        }
      }
    } catch (e) { console.error('[snapshot] feishu check error:', e.message); }
    return { running: state.running, url: state.url, token: state.token, port: state.port, httpsPort: state.httpsPort, ips: state.ips, qq: state.qq, weixin: weixinState.status, error: state.error, lanOpen: config.lanOpen, customPublicUrl: customPublicUrl || null, feishu: feishuSt };
  };

  if (webServer) {
    const infoHandler = async (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(snapshot()));
    };
    const controlHandler = async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      let action = null;
      try { action = JSON.parse(body).action; } catch (e) { /* ignore */ }
      if (action === 'start') await start();
      else if (action === 'stop') stop();
      else if (action === 'renew') { stop(); await start(); }
      else {
        res.writeHead(400);
        res.end('bad action');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(snapshot()));
    };
    // ====== 微信 iLink 路由 ======
    const weixinQRHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      try {
        const qr = await weixinGetQR();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, qrcodeUrl: qr.qrcodeUrl }));
      } catch (e) {
        weixinState.error = String(e && e.message || e);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: weixinState.error }));
      }
    };
    const weixinPollHandler = async (req, res) => {
      try {
        const result = await weixinPollQR();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
      }
    };
    const weixinUnbindHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      weixinDisconnect();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true }));
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/info', handler: infoHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/access', handler: infoHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/control', handler: controlHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/weixin/qrcode', handler: weixinQRHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/weixin/poll', handler: weixinPollHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/weixin/unbind', handler: weixinUnbindHandler }));

    // ====== 飞书机器人路由 ======
    const feishuConfigPath = path.join(toolsDir, 'feishu-config.json');
    function feishuLoadConfig() {
      try { return JSON.parse(fs.readFileSync(feishuConfigPath, 'utf-8')) || {}; } catch (e) { return {}; }
    }
    function feishuSaveConfig(cfg) {
      try { fs.mkdirSync(toolsDir, { recursive: true }); fs.writeFileSync(feishuConfigPath, JSON.stringify(cfg, null, 2), 'utf-8'); return true; } catch (e) { return false; }
    }
    async function feishuVerify(appId, appSecret) {
      try {
        const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret })
        });
        const data = await res.json();
        if (data && data.code === 0 && data.tenant_access_token) {
          feishuToken = { token: data.tenant_access_token, expireAt: Date.now() + (data.expire || 7200) * 1000 - 60000 };
          return { ok: true };
        }
        return { ok: false, error: data.msg || ('code=' + data.code) };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    async function feishuEnsureToken() {
      if (feishuToken && Date.now() < feishuToken.expireAt) return { ok: true, token: feishuToken.token };
      const cfg = feishuLoadConfig();
      if (!cfg.appId || !cfg.appSecret) return { ok: false, error: '\u672a\u914d\u7f6e\u98de\u4e66\u51ed\u8bc1' };
      return feishuVerify(cfg.appId, cfg.appSecret);
    }
    async function feishuSendText(chatId, text) {
      const t = await feishuEnsureToken();
      if (!t.ok) throw new Error(t.error);
      const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.token },
        body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: String(text || '') }) })
      });
      const data = await res.json();
      if (!(data && data.code === 0)) throw new Error(data.msg || ('code=' + data.code));
    }

    const feishuStatusHandler = async (req, res) => {
      const cfg = feishuLoadConfig();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ configured: !!cfg.appId, appId: cfg.appId || '', connected: !!(feishuToken && Date.now() < feishuToken.expireAt) }));
    };
    const feishuConfigHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const appId = (data.appId || '').trim(), appSecret = (data.appSecret || '').trim();
        if (!appId || !appSecret) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '\u8bf7\u586b\u5199 App ID \u548c App Secret' })); return; }
        const v = await feishuVerify(appId, appSecret);
        feishuSaveConfig({ appId, appSecret });
        if (v.ok) { feishuToken = null; await feishuEnsureToken(); feishuStartWS().catch(function(e){}); console.log('[feishu] \u51ed\u8bc1\u9a8c\u8bc1\u901a\u8fc7'); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, connected: true })); }
        else { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, connected: false, error: v.error })); }
      } catch (e) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
    };
    const feishuDisconnectHandler = async (req, res) => {
      feishuStopWS();
      try { if (fs.existsSync(feishuConfigPath)) fs.unlinkSync(feishuConfigPath); } catch (e) {}
      feishuToken = null;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true }));
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/feishu/status', handler: feishuStatusHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/feishu/config', handler: feishuConfigHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/feishu/disconnect', handler: feishuDisconnectHandler }));

    // ====== 飞书 WebSocket 长连接 ======
    let feishuWSClient = null;
    let feishuSeenIds = new Set();
    async function feishuStartWS() {
      if (feishuToken) { console.log('[feishu] WebSocket already connected'); return; }
      const v = await feishuEnsureToken();
      if (!v.ok) { console.log('[feishu] cannot start WS: ' + v.error); return; }
      try {
        const { Client, EventDispatcher, WSClient } = await import('@larksuiteoapi/node-sdk');
        const cfg = feishuLoadConfig();
        const client = new Client({ appId: cfg.appId, appSecret: cfg.appSecret });
        const dispatcher = new EventDispatcher({}).register({
          'im.message.receive_v1': async (data) => {
            try {
              if (data.sender && data.sender.sender_type === 'app') return;
              const msg = data.message;
              if (msg && msg.message_id) {
                if (feishuSeenIds.has(msg.message_id)) return;
                feishuSeenIds.add(msg.message_id);
                if (feishuSeenIds.size > 200) { var first = feishuSeenIds.values().next().value; feishuSeenIds.delete(first); }
              }
              const rawText = msg.content ? JSON.parse(msg.content).text : '';
              const text = rawText.replace(/@_user_\d+\s*/g, '').trim();
              const chatId = msg.chat_id;
              console.log('[feishu] received:', text || rawText, 'from', chatId);
              if (!text) return;
              // 记录最后对话的飞书 chatId，用于监听通知
              weixinState.lastFeishuChatId = chatId;
              // 持久化到文件，重启后恢复
              try { fs.writeFileSync(path.join(toolsDir, 'feishu-last-chat.json'), JSON.stringify({ chatId: chatId }), 'utf-8'); } catch (e) {}
              const reply = await feishuHandleCommand(text, chatId);
              if (reply) {
                const replyText = typeof reply === 'string' ? reply : JSON.stringify(reply);
                await feishuSendText(chatId, replyText.length > 4000 ? replyText.slice(0, 4000) + '...' : replyText);
              }
            } catch (e) { console.error('[feishu] message handler error:', e.message); }
          }
        });
        feishuWSClient = new WSClient({ appId: cfg.appId, appSecret: cfg.appSecret });
        feishuWSClient.start({ eventDispatcher: dispatcher });
        console.log('[feishu] WebSocket client started');
      } catch (e) {
        console.error('[feishu] WebSocket start failed:', e.message);
        feishuWSClient = null;
      }
    }
    function feishuStopWS() {
      if (feishuWSClient) {
        try { feishuWSClient.stop(); } catch (e) {}
        feishuWSClient = null;
        console.log('[feishu] WebSocket stopped');
      }
    }
    async function feishuHandleCommand(text, chatId) {
      const t = (text || '').trim();
      if (!t) return null;
      if (/^\/?(help|\u5e2e\u52a9|\u547d\u4ee4)$/i.test(t)) {
        return '\u98de\u4e66\u673a\u5668\u4eba\u5df2\u5728\u7ebf\uff0c\u652f\u6301\u547d\u4ee4\uff1a\n\u2022 /\u5e2e\u52a9 - \u663e\u793a\u672c\u5217\u8868\n\u2022 /\u94fe\u63a5 - \u83b7\u53d6 DSH \u8fdc\u7a0b\u94fe\u63a5\n\u2022 /\u542f\u52a8 - \u542f\u52a8\u8fdc\u7a0b\u670d\u52a1\n\u2022 /\u505c\u6b62 - \u505c\u6b62\u8fdc\u7a0b\u670d\u52a1\n\u2022 /\u76d1\u542c - \u5f00\u5173\u76d1\u542c\u6a21\u5f0f\n\u2022 /\u6a21\u578b - \u67e5\u770b\u5f53\u524d\u6a21\u578b';
      }
      if (/^\/?(\u94fe\u63a5|\u83b7\u53d6\u94fe\u63a5|\u516c\u7f51\u94fe\u63a5|link)$/i.test(t)) {
        if (!state.running) {
          state.error = null;
          console.log('[feishu] starting remote (via feishu command)...');
          try { await start(); } catch (e) {}
        }
        if (state.url && state.token) {
          return '\u516c\u7f51\u94fe\u63a5\uff1a\n' + state.url + '/?token=' + state.token;
        }
        if (state.error) return '\u542f\u52a8\u5931\u8d25\uff1a' + state.error;
        return '\u6b63\u5728\u83b7\u53d6\u94fe\u63a5\uff0c\u8bf7\u7a0d\u5019\uff08\u96a7\u9053\u5efa\u7acb\u7ea6 10~30 \u79d2\uff09\u2026';
      }
      if (/^\/?(\u542f\u52a8|start|\u5f00\u542f)$/i.test(t)) {
        if (state.running) return '\u8fdc\u7a0b\u670d\u52a1\u5df2\u5728\u8fd0\u884c\u4e2d';
        state.error = null;
        try { await start(); } catch (e) {}
        if (state.running) return '\u8fdc\u7a0b\u670d\u52a1\u5df2\u542f\u52a8';
        if (state.error) return '\u542f\u52a8\u5931\u8d25\uff1a' + state.error;
        return '\u6b63\u5728\u542f\u52a8\uff0c\u8bf7\u7a0d\u5019\u2026';
      }
      if (/^\/?(\u505c\u6b62|\u5173\u95ed\u8fdc\u7a0b|stop|\u505c\u6b62\u8fdc\u7a0b)$/i.test(t)) {
        if (!state.running) return '\u8fdc\u7a0b\u670d\u52a1\u672a\u542f\u52a8';
        stop();
        return '\u5df2\u505c\u6b62\u8fdc\u7a0b\u670d\u52a1';
      }
      if (/^\/?(\u76d1\u542c|\u76d1\u63a7)$/i.test(t)) {
        weixinMonitorMode = !weixinMonitorMode;
        try {
          var monFile = path.join(toolsDir, 'monitor-mode.json');
          if (weixinMonitorMode) fs.writeFileSync(monFile, JSON.stringify({ enabled: true, userId: weixinState.lastFromUserId || '', contextToken: weixinState.lastContextToken || '' }), 'utf-8');
          else if (fs.existsSync(monFile)) fs.unlinkSync(monFile);
        } catch (e) {}
        if (weixinMonitorMode) { try { startMonitor(); } catch (e) {} return '\u76d1\u542c\u6a21\u5f0f\u5df2\u5f00\u542f\uff0c\u518d\u6b21\u53d1\u9001 \u76d1\u542c \u53ef\u5173\u95ed'; }
        else { try { stopMonitor(); } catch (e) {} return '\u76d1\u542c\u6a21\u5f0f\u5df2\u5173\u95ed'; }
      }
      if (/^\/?(\u6a21\u578b|model)$/i.test(t)) {
        if (!agentDefaultModel) return '\u6a21\u578b\u670d\u52a1\u4e0d\u53ef\u7528';
        const sel = agentDefaultModel.currentSelection();
        return '\u5f53\u524d\u6a21\u578b\uff1a' + (sel.model || '(\u672a\u8bbe\u7f6e)') + ' (' + (sel.provider || '?') + ')' + (sel.reasoningEffort ? '\n\u601d\u8003\u5f3a\u5ea6\uff1a' + sel.reasoningEffort : '');
      }
      return '\u672a\u8bc6\u522b\u7684\u547d\u4ee4\uff0c\u53d1\u9001\u5e2e\u52a9\u67e5\u770b\u53ef\u7528\u547d\u4ee4\u3002';
    }
    // 自动启动 WebSocket 连接
    feishuStartWS().catch(function (e) { console.error('[feishu] auto WS start failed:', e.message); });
    const customUrlHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        customPublicUrl = (data.url && data.url.trim()) || null;
        const p = path.join(toolsDir, 'custom-public-url.json');
        if (customPublicUrl) fs.writeFileSync(p, JSON.stringify({ url: customPublicUrl }), 'utf-8');
        else if (fs.existsSync(p)) fs.unlinkSync(p);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, url: customPublicUrl }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    };
    try { const p = path.join(toolsDir, 'custom-public-url.json'); if (fs.existsSync(p)) { const d = JSON.parse(fs.readFileSync(p, 'utf-8')); if (d && d.url) customPublicUrl = d.url; } } catch (e) {}
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/custom-url', handler: customUrlHandler }));

    const setPortHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const np = parseInt(data.port, 10);
        if (isNaN(np) || np < 1024 || np > 65535) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '\u7aef\u53e3\u65e0\u6548\uff081024-65535\uff09' }));
          return;
        }
        const net = await import('node:net');
        const free = await new Promise(function (ok) { var s = net.createServer(); s.once('error', function () { ok(false); }); s.listen(np, '127.0.0.1', function () { s.close(function () { ok(true); }); }); });
        if (!free) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '\u7aef\u53e3 ' + np + ' \u5df2\u88ab\u5360\u7528' }));
          return;
        }
        config.httpsPortStart = np;
        config.httpsPort = np;
        // 持久化端口到文件
        try {
          var portFile = path.join(toolsDir, 'custom-port.json');
          fs.writeFileSync(portFile, JSON.stringify({ port: np }), 'utf-8');
        } catch (pe) {}
        if (state.running) { stop(); await start(); }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, port: np }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/set-port', handler: setPortHandler }));

    ctx.effect(() => webServer.tapIndex((transform) => {
      if (transform.indexOf('webrm-native') !== -1) return transform;
      return transform.replace('</body>', '<script>' + INJECT_SCRIPT + '</scr' + 'ipt></body>');
    }));

    // ====== 接入 DSH：查/建「微信远程」会话 ======
    const sessions = ctx.get('sessions') || hostCtx.get('sessions');
    const agents = ctx.get('agents') || hostCtx.get('agents');
    const sessionQuery = ctx.get('sessionQuery') || hostCtx.get('sessionQuery');
    const llm = ctx.get('llm') || hostCtx.get('llm');
    const agentDefaultModel = ctx.get('agentDefaultModel') || hostCtx.get('agentDefaultModel');
    const apiProxy = ctx.get('apiProxy') || hostCtx.get('apiProxy');
    console.log('[dsh-weixin] services - sessions:', !!sessions, 'agents:', !!agents, 'sessionQuery:', !!sessionQuery, 'llm:', !!llm, 'agentDefaultModel:', !!agentDefaultModel, 'apiProxy:', !!apiProxy);

    // ====== 微信命令系统 ======
    let weixinSelectedSession = null; // 当前选中的目标会话 id
    let weixinModelPick = null; // { step: 'model'|'effort', models: [...], efforts: [...], provider, model }

    // 通过本地 DSH web 的 /api RPC 端点调用会话级方法（bundle 插件取不到 apiProxy 服务）
    // method 如 'session.selectModel' / 'session.models'
    function callRpc(method, payload) {
      return new Promise(function (resolve, reject) {
        const body = JSON.stringify({ type: 'client-request', rpcId: 'wx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), method, payload });
        const req = http.request({
          host: '127.0.0.1',
          port: config.targetPort,
          path: '/api/' + method,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          timeout: 15000,
        }, function (res) {
          let data = '';
          res.on('data', function (c) { data += c; });
          res.on('end', function () {
            try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
            catch (e) { resolve({ status: res.statusCode, body: data }); }
          });
        });
        req.on('error', reject);
        req.on('timeout', function () { req.destroy(new Error('rpc timeout')); });
        req.write(body);
        req.end();
      });
    }

    // 模型切换 helper：优先会话级（走本地 RPC），无选中则全局
    async function switchModel(provider, model, reasoningEffort) {
      const sel = { provider, model };
      if (reasoningEffort !== undefined) sel.reasoningEffort = reasoningEffort;
      console.log('[dsh-weixin] switchModel called:', JSON.stringify(sel), 'session:', weixinSelectedSession);
      if (weixinSelectedSession) {
        try {
          const res = await callRpc('session.selectModel', { sessionId: weixinSelectedSession, ...sel });
          const ok = res && res.body && res.body.result && res.body.result.ok;
          console.log('[dsh-weixin] selectModel rpc:', res.status, JSON.stringify(res.body && res.body.result || res.body).slice(0, 300));
          if (ok) return true;
        } catch (e) { console.log('[dsh-weixin] selectModel http error:', e.message); }
      }
      // 兜底：全局默认
      if (agentDefaultModel) {
        await agentDefaultModel.saveSelection(sel);
        return true;
      }
      return false;
    }
    const WEIXIN_HELP =
      '可用命令：\n' +
      '· 帮助 —— 显示本列表\n' +
      '· /链接 —— 查看远程链接（未启动会自动开启）\n' +
      '· /停止远程 —— 关闭远程服务\n' +
      '· /监听 —— 开启/关闭监听模式（会话思考完毕自动通知）\n' +
      '· /会话列表 —— 列出所有会话\n' +
      '· /选择 N —— 选中第 N 个会话\n' +
      '· /当前会话 —— 查看选中的会话名称\n' +
      '· /历史内容 —— 查看选中会话最近一次输出\n' +
      '· /当前模型 —— 查看当前使用的模型\n' +
      '· /切换模型 —— 列出所有模型并切换\n' +
      '· 直接发送内容（无需前缀）—— 发送到选中的会话\n' +
      '· 未选择会话时，先 /会话列表 再 /选择 N';

    async function sendToSession(sessionId, content) {
      // 取 live agent：先 get，再 resume
      let agent = null;
      if (agents) {
        try { agent = agents.get(sessionId); } catch (e) { /* ignore */ }
      }
      if (!agent && agents) {
        try {
          console.log('[dsh-weixin] resuming agent for session', String(sessionId));
          const handle = await agents.resume({ resumeSessionId: sessionId });
          agent = (handle && handle.agent) ? handle.agent : handle;
        } catch (e) { console.log('[dsh-weixin] resume failed:', e.message); }
      }
      if (!agent || typeof agent.send !== 'function') {
        return '无法激活会话 ' + String(sessionId) + '（agent 不可用）';
      }
      const msgId = 'wxcmd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      agent.send({ id: msgId, role: 'user', content: [{ type: 'text', text: content }], source: { kind: 'user' } }, 'next-turn', true);
      await agent.whenIdle();
      const events = agent.session.events;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'assistant/message') {
          const msg = events[i].data.message;
          const parts = [];
          if (msg.content) msg.content.forEach(function (b) { if (b.type === 'text' && b.text) parts.push(b.text); });
          if (parts.length > 0) return parts.join('');
        }
      }
      return '(会话未产生回复)';
    }

    // 取会话最近一次 assistant 输出
    async function getSessionLastOutput(sessionId) {
      let events = null;
      if (agents) {
        try {
          const a = agents.get(sessionId);
          if (a && a.session) events = a.session.events;
        } catch (e) { /* ignore */ }
      }
      if (!events && sessionQuery) {
        try {
          const snap = await sessionQuery.readSession(sessionId);
          events = (snap && snap.events) ? snap.events : null;
        } catch (e) { /* ignore */ }
      }
      if (!events) return null;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'assistant/message') {
          const msg = events[i].data.message;
          const parts = [];
          if (msg.content) msg.content.forEach(function (b) { if (b.type === 'text' && b.text) parts.push(b.text); });
          if (parts.length > 0) return parts.join('');
        }
      }
      return '(该会话暂无输出)';
    }

    // 取会话标题
    async function getSessionTitle(sessionId) {
      if (!sessionQuery) return '';
      try {
        const ts = await sessionQuery.readTitle(sessionId);
        return (ts && ts.title) ? ts.title : '';
      } catch (e) { return ''; }
    }

    // 监听模式
    function startMonitor() {
      weixinMonitorSnapshots = {};
      weixinMonitorTimer = setInterval(async function () {
        if (!weixinMonitorMode) { stopMonitor(); return; }
        if (!agents) { return; }
        try {
          var agentList = [];
          if (agents.list) agentList = agents.list();
          else if (agents._agents) agentList = Array.from(agents._agents.values());
          if (!agentList || !agentList.length) return;
          for (var i = 0; i < agentList.length; i++) {
            var a = agentList[i];
            if (!a || !a.session) continue;
            var aid = a.session.header && a.session.header.id ? a.session.header.id : String(i);
            var snap = weixinMonitorSnapshots[aid] || { wasRunning: false, eventsLen: 0 };
            var evts = a.session.events || [];
            var isRunning = (a.status === 'running');
            if (snap.wasRunning && !isRunning && evts.length > snap.eventsLen) {
              for (var j = evts.length - 1; j >= 0; j--) {
                if (evts[j].type === 'assistant/message') {
                  var msg = evts[j].data && evts[j].data.message;
                  var parts = [];
                  if (msg && msg.content) msg.content.forEach(function (b) { if (b.type === 'text' && b.text) parts.push(b.text); });
                  if (parts.length > 0) {
                    var sessTitle = weixinMonitorTitles[aid] || '';
                    if (!sessTitle && sessionQuery) {
                      try { var _tr = await sessionQuery.readTitle(aid); sessTitle = (typeof _tr === 'string') ? _tr : (_tr && _tr.title) ? _tr.title : ''; } catch (e2) {}
                    }
                    if (!sessTitle) sessTitle = aid.slice(0, 12);
                    weixinMonitorTitles[aid] = sessTitle;
                    var text = '\u3010' + sessTitle + '\u3011\u601d\u8003\u5b8c\u6bd5\uff1a\n' + parts.join('');
                    if (text.length > 1900) text = text.slice(0, 1900) + '\u2026';
                    weixinSendMsg(weixinState.botToken, weixinState.lastFromUserId || '', text, weixinState.lastContextToken || '').catch(function (e) { console.error('[dsh-weixin] monitor send failed:', e.message); });
                    // 同时发飞书通知
                    if (weixinState.lastFeishuChatId) {
                      feishuSendText(weixinState.lastFeishuChatId, text).catch(function (e) { console.error('[feishu] monitor send failed:', e.message); });
                    }
                  }
                  break;
                }
              }
            }
            weixinMonitorSnapshots[aid] = { wasRunning: isRunning, eventsLen: evts.length };
          }
        } catch (e) { console.error('[dsh-weixin] monitor poll error:', e.message); }
      }, 5000);
    }
    function stopMonitor() {
      if (weixinMonitorTimer) { clearInterval(weixinMonitorTimer); weixinMonitorTimer = null; }
      weixinMonitorSnapshots = {};
      weixinMonitorTitles = {};
    }

    async function handleWeixinCommand(text) {
      const t = String(text || '').trim();
      if (!t) return null;
      // 帮助（无 / 也可）
      if (/^(帮助|命令|help|\/帮助)$/i.test(t)) return WEIXIN_HELP;
      if (/^\//.test(t)) {
        // /链接
        if (/^\/链接$/.test(t) || /^\/公网链接$/.test(t) || /^\/获取公网链接$/.test(t)) {
          if (!state.running) {
            state.error = null;
            console.log('[dsh-weixin] starting remote (via wechat command)...');
            await start();
          }
          if (state.url && state.token) {
            weixinFollowup = '[如果用外部浏览器，请直接复制链接，从微信内部浏览器跳转，会丢失验证信息导致验证失败]';
            return '[手机浏览器可根据需要调整页面缩放，以获得更合适的显示效果]\n公网链接：\n' + state.url + '/?token=' + state.token;
          }
          if (state.error) return '启动失败：' + state.error;
          return '正在获取链接，请稍候（隧道建立约 10~30 秒）…';
        }
        // /停止远程
        if (/^\/停止远程$/.test(t) || /^\/关闭远程$/.test(t)) { stop(); return '\u5df2\u505c\u6b62\u8fdc\u7a0b\u670d\u52a1'; }
        // /监听
        if (/^\/监听$/.test(t) || /^\/监控$/.test(t)) {
          weixinMonitorMode = !weixinMonitorMode;
          try {
            var monFile = path.join(toolsDir, 'monitor-mode.json');
            if (weixinMonitorMode) fs.writeFileSync(monFile, JSON.stringify({ enabled: true, userId: weixinState.lastFromUserId || '', contextToken: weixinState.lastContextToken || '' }), 'utf-8');
            else if (fs.existsSync(monFile)) fs.unlinkSync(monFile);
          } catch (e) {}
          if (weixinMonitorMode) {
            startMonitor();
            return '\u76d1\u542c\u6a21\u5f0f\u5df2\u5f00\u542f\uff0c\u4f1a\u8bdd\u601d\u8003\u5b8c\u6bd5\u4f1a\u81ea\u52a8\u901a\u77e5\u4f60\u3002\u518d\u6b21\u53d1\u9001 /监听 \u53ef\u5173\u95ed';
          } else {
            stopMonitor();
            return '\u76d1\u542c\u6a21\u5f0f\u5df2\u5173\u95ed';
          }
        }
        // /会话列表
        if (/^\/会话列表$/.test(t) || /^\/会话$/.test(t)) {
          if (!sessionQuery) return '会话服务不可用';
          const records = await sessionQuery.listSessions();
          if (!records || records.length === 0) return '当前没有会话';
          // workspace 层：归档集合 + 所有 workspace 内会话 id（用于过滤孤儿会话）
          let archived = null;
          let knownSessions = null;
          try {
            const wsr = ctx.get('workspaceRegistry') || hostCtx.get('workspaceRegistry');
            if (wsr) {
              if (wsr.archivedSessionIds) archived = new Set(wsr.archivedSessionIds);
              const workspaces = wsr.list();
              if (workspaces) {
                knownSessions = new Set();
                for (const w of workspaces) {
                  if (w.sessionIds) for (const sid of w.sessionIds) knownSessions.add(sid);
                }
              }
            }
          } catch (e) { /* ignore */ }
          const lines = [];
          let n = 0;
          for (const r of records) {
            // 过滤：归档会话、子代理会话、不在任何 workspace 的孤儿会话
            if (archived && archived.has(r.header.id)) continue;
            if (r.header.origin === 'subagent' || (r.header.delegationDepth || 0) > 0) continue;
            if (knownSessions && !knownSessions.has(r.header.id)) continue;
            n += 1;
            const title = await getSessionTitle(r.header.id);
            lines.push(n + '. ' + (title || '(无标题)'));
          }
          if (lines.length === 0) return '当前没有会话';
          return '会话列表：\n' + lines.join('\n') + '\n\n回复「/选择 N」切换目标会话';
        }
        // /选择 N
        let m = t.match(/^\/选择[\s：:]*(\d+)$/);
        if (m) {
          const idx = parseInt(m[1], 10) - 1;
          if (!sessionQuery) return '会话服务不可用';
          // 与 /会话列表 相同的过滤（归档 / 子代理 / 孤儿）
          let archived = null;
          let knownSessions = null;
          try {
            const wsr = ctx.get('workspaceRegistry') || hostCtx.get('workspaceRegistry');
            if (wsr) {
              if (wsr.archivedSessionIds) archived = new Set(wsr.archivedSessionIds);
              const workspaces = wsr.list();
              if (workspaces) {
                knownSessions = new Set();
                for (const w of workspaces) {
                  if (w.sessionIds) for (const sid of w.sessionIds) knownSessions.add(sid);
                }
              }
            }
          } catch (e) { /* ignore */ }
          const all = await sessionQuery.listSessions();
          const visible = (all || []).filter(function (r) {
            if (archived && archived.has(r.header.id)) return false;
            if (r.header.origin === 'subagent' || (r.header.delegationDepth || 0) > 0) return false;
            if (knownSessions && !knownSessions.has(r.header.id)) return false;
            return true;
          });
          if (visible[idx]) {
            weixinSelectedSession = visible[idx].header.id;
            const title = await getSessionTitle(visible[idx].header.id);
            return '已选择会话 ' + (idx + 1) + '：' + (title || '(无标题)');
          }
          return '编号无效，请先查看「/会话列表」';
        }
        // /当前会话
        if (/^\/当前会话$/.test(t)) {
          if (!weixinSelectedSession) return '当前未选择会话，请先「/会话列表」并「/选择 N」';
          const title = await getSessionTitle(weixinSelectedSession);
          return '当前选中会话：' + (title || String(weixinSelectedSession));
        }
        // /历史内容
        if (/^\/历史内容$/.test(t)) {
          if (!weixinSelectedSession) return '当前未选择会话，请先「/会话列表」并「/选择 N」';
          return await getSessionLastOutput(weixinSelectedSession);
        }
        // /当前模型
        if (/^\/当前模型$/.test(t)) {
          // 优先查选中会话的模型
          if (weixinSelectedSession) {
            try {
              const res = await callRpc('session.models', { sessionId: weixinSelectedSession });
              const cur = res && res.body && res.body.result && res.body.result.ok ? res.body.result.value.current : null;
              if (cur) {
                return '会话模型：' + (cur.model || '(未设置)') + ' (' + (cur.provider || '?') + ')' + (cur.reasoningEffort ? '\n思考强度：' + cur.reasoningEffort : '');
              }
              console.log('[dsh-weixin] session.models rpc:', res.status, JSON.stringify(res.body && res.body.result || res.body).slice(0, 300));
            } catch (e) { console.log('[dsh-weixin] session.models error:', e.message); }
          }
          // 兜底：全局默认
          if (!agentDefaultModel) return '模型服务不可用';
          const sel = agentDefaultModel.currentSelection();
          return '当前模型（全局默认）：' + (sel.model || '(未设置)') + ' (' + (sel.provider || '?') + ')' + (sel.reasoningEffort ? '\n思考强度：' + sel.reasoningEffort : '');
        }
        // /选强度 N → 设置思考强度（独立命令，不嵌套在 /切换模型 里）
        if (weixinModelPick && weixinModelPick.step === 'effort' && /^\/选强度/.test(t)) {
          const earg = t.replace(/^\/选强度/, '').trim();
          if (/^\d+$/.test(earg)) {
            const eidx = parseInt(earg, 10);
            const pick = weixinModelPick;
            let effort = undefined;
            if (eidx === 0) {
              effort = undefined;
            } else if (eidx >= 1 && eidx <= pick.efforts.length) {
              effort = pick.efforts[eidx - 1].id;
            } else {
              return '编号无效，请选 0-' + pick.efforts.length;
            }
            const sel = { provider: pick.provider, model: pick.model };
            if (effort !== undefined) sel.reasoningEffort = effort;
            await switchModel(pick.provider, pick.model, effort);
            weixinModelPick = null;
            return '✅ 模型已切换：' + pick.model + ' (' + pick.provider + ')' + (effort ? ' / ' + effort : ' / 默认');
          }
          return '请回复数字编号，如「/选强度 2」';
        }
        // /切换模型（多步交互）
        if (/^\/切换模型/.test(t)) {
          const arg = t.replace(/^\/切换模型/, '').trim();
          // 第 2 步：/切换模型 N → 选择模型
          if (weixinModelPick && weixinModelPick.step === 'model' && /^\d+$/.test(arg)) {
            const idx = parseInt(arg, 10) - 1;
            const pick = weixinModelPick;
            if (idx >= 0 && idx < pick.models.length) {
              const m = pick.models[idx];
              // 尝试获取思考强度（从 resolveModelInfo 或 listing 中的 reasoning）
              let efforts = null;
              if (m.reasoning && m.reasoning.efforts && m.reasoning.efforts.length > 0) {
                efforts = m.reasoning.efforts;
              } else if (llm && llm.resolveModelInfo) {
                try {
                  const info = await llm.resolveModelInfo(m.provider, m.id);
                  if (info && info.reasoning && info.reasoning.efforts) efforts = info.reasoning.efforts;
                } catch (e) { /* ignore */ }
              }
              if (efforts && efforts.length > 0) {
                const effortLines = efforts.map(function (e, i) { return (i + 1) + '. ' + e.name + (e.description ? ' — ' + e.description : ''); });
                weixinModelPick = { step: 'effort', provider: m.provider, model: m.id, efforts: efforts };
                return '已选择：' + m.name + ' (' + m.provider + ')\n思考强度：\n0. 默认\n' + effortLines.join('\n') + '\n回复「/选强度 N」选择';
              }
              // 无思考强度，直接切换
              await switchModel(m.provider, m.id);
              weixinModelPick = null;
              return '✅ 模型已切换：' + m.name + ' (' + m.provider + ')';
            }
            return '编号无效，请重新「/切换模型」查看列表';
          }
          // 第 1 步：/切换模型（无参数）→ 列出所有模型
          if (!llm) return 'LLM 服务不可用';
          if (!agentDefaultModel) return '模型服务不可用';
          const currentSel = agentDefaultModel.currentSelection();
          const allModels = [];
          try {
            const providers = await llm.listProviders();
            for (const p of providers) {
              try {
                const models = await llm.listModels(p.id);
                for (const m of models) {
                  allModels.push({ name: m.name || m.id, id: m.id, provider: p.id, providerName: p.name || p.id, reasoning: m.reasoning });
                }
              } catch (e) { /* skip provider */ }
            }
          } catch (e) { /* ignore */ }
          if (allModels.length === 0) return '未找到可用模型';
          const lines = allModels.map(function (m, i) {
            const isCurrent = m.provider === currentSel.provider && m.id === currentSel.model;
            return (i + 1) + '. ' + m.name + ' (' + m.provider + ')' + (isCurrent ? ' ← 当前' : '') + (m.reasoning ? ' ⚙' : '');
          });
          weixinModelPick = { step: 'model', models: allModels };
          return '可用模型（⚙=支持思考强度）：\n' + lines.join('\n') + '\n\n回复「/切换模型 N」选择';
        }
        return '未知命令，发「帮助」查看可用命令';
      }
      // 非命令消息 → 发送到选中的会话（无需 // 前缀）
      if (!weixinSelectedSession) {
        return '请先在「/会话列表」中选择一个会话，再发送内容\n更多命令请发送「/帮助」获取';
      }
      // 先发"思考中"（避免长时间无回复），再执行
      if (weixinActiveSend) {
        try {
          await weixinSendMsg(weixinActiveSend.botToken, weixinActiveSend.toUserId, '已收到指令，AI 思考中，请稍等…', weixinActiveSend.contextToken);
        } catch (e) { /* ignore */ }
      }
      return await sendToSession(weixinSelectedSession, t);
    }

    (async function () {
      // 查找已有的「微信远程」会话
      let weixinSession = null;
      if (sessionQuery) {
        try {
          const list = await sessionQuery.listSessions();
          for (const s of list) {
            if (s.title && s.title.includes('微信远程')) { weixinSession = s; break; }
            if (s.id && String(s.id).includes('weixin')) { weixinSession = s; break; }
          }
          if (weixinSession) console.log('[dsh-weixin] found existing session:', String(weixinSession.id), weixinSession.title);
          else console.log('[dsh-weixin] no existing session found');
        } catch (e) { console.log('[dsh-weixin] listSessions error:', e.message); }
      }

      // 统一消息处理：命令 → 命令；非命令 → 发到选中会话（handleWeixinCommand 内部处理）
      weixinGenerateReply = async function (userText) {
        try {
          return await handleWeixinCommand(userText);
        } catch (e) {
          console.error('[dsh-weixin] handle error:', e.message);
          return '[错误: ' + String(e.message).slice(0, 200) + ']';
        }
      };
      console.log('[dsh-weixin] ✓ weixin message router ready');
    })();
    // 启动时恢复微信连接 + 监听模式（在 if(webServer) 内，可访问 startMonitor）
    try {
      const savedToken = loadWeixinToken();
      if (savedToken) {
        weixinState.status = 'connected';
        weixinState.botToken = savedToken;
        console.log('[dsh-weixin] restored token from file, starting poll loop...');
        weixinPollLoop();
        setTimeout(function () {
          try {
            var monFile = path.join(toolsDir, 'monitor-mode.json');
            if (fs.existsSync(monFile)) {
              var md = JSON.parse(fs.readFileSync(monFile, 'utf-8'));
              if (md && md.enabled) {
                weixinMonitorMode = true;
                weixinState.lastFromUserId = md.userId || '';
                weixinState.lastContextToken = md.contextToken || '';
                startMonitor();
                weixinSendMsg(weixinState.botToken, weixinState.lastFromUserId, 'DSH\u5df2\u542f\u52a8\uff0c\u4efb\u52a1\u76d1\u542c\u4e2d', weixinState.lastContextToken).catch(function (e) { console.error('[dsh-weixin] startup notify failed:', e.message || e); });
                if (weixinState.lastFeishuChatId) {
                  feishuSendText(weixinState.lastFeishuChatId, 'DSH\u5df2\u542f\u52a8\uff0c\u4efb\u52a1\u76d1\u542c\u4e2d').catch(function (e) { console.error('[feishu] startup notify failed:', e.message || e); });
                }
                console.log('[dsh-weixin] monitor auto-restored');
              }
            }
          } catch (e) { console.error('[dsh-weixin] monitor restore error:', e.message || e); }
        }, 3000);
      }
    } catch (e) { console.error('[dsh-weixin] startup restore error:', e.message || e); }
    // 飞书独立启动通知（不依赖微信）
    setTimeout(function () {
      try {
        var monFile = path.join(toolsDir, 'monitor-mode.json');
        if (fs.existsSync(monFile)) {
          var md = JSON.parse(fs.readFileSync(monFile, 'utf-8'));
          if (md && md.enabled && !weixinMonitorMode) {
            weixinMonitorMode = true;
            startMonitor();
          }
        }
        // 如果有飞书配置，自动启动 WebSocket
        var fCfg = feishuLoadConfig();
        if (fCfg && fCfg.appId && fCfg.appSecret && !feishuWSClient) {
          feishuStartWS().catch(function (e) { console.error('[feishu] auto WS start failed:', e.message); });
        }
        // 恢复最后的飞书 chatId
        console.log('[feishu] startup check: lastFeishuChatId=', weixinState.lastFeishuChatId, 'toolsDir=', toolsDir);
        if (!weixinState.lastFeishuChatId) {
          try {
            var chatFile = path.join(toolsDir, 'feishu-last-chat.json');
            console.log('[feishu] reading chatFile:', chatFile, 'exists:', fs.existsSync(chatFile));
            var savedChat = JSON.parse(fs.readFileSync(chatFile, 'utf-8'));
            console.log('[feishu] parsed chat:', savedChat);
            if (savedChat && savedChat.chatId) {
              weixinState.lastFeishuChatId = savedChat.chatId;
              console.log('[feishu] restored chatId:', savedChat.chatId);
            }
          } catch (e) { console.log('[feishu] chat restore error:', e.message); }
        }
        // 发飞书启动通知
        if (weixinState.lastFeishuChatId) {
          console.log('[feishu] sending startup notification to:', weixinState.lastFeishuChatId);
          feishuSendText(weixinState.lastFeishuChatId, 'DSH\u5df2\u542f\u52a8\uff0c\u4efb\u52a1\u76d1\u542c\u4e2d').catch(function (e) { console.error('[feishu] startup notify failed:', e.message || e); });
        } else {
          console.log('[feishu] no lastChatId, skip startup notification');
        }
      } catch (e) { console.error('[feishu] startup error:', e.message); }
    }, 5000);
  }

  ctx.effect(() => () => {
    if (tunnelHandle) { try { tunnelHandle.terminate(); } catch (e) { /* ignore */ } }
    if (proxy) { try { proxy.close(); } catch (e) { /* ignore */ } }
    if (qqServer) { try { qqServer.close(); } catch (e) { /* ignore */ } }
  });

  if (config.autoStart) {
    start().catch((e) => { state.error = String(e && e.message || e); });
  }

  });
}

async function findFreePort(start, end) {
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error('no free port in ' + start + '..' + end);
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

export default { name, inject, apply };
