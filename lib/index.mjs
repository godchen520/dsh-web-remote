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
import { createStore } from './store.mjs';
import { createProxyServer } from './proxy.mjs';
import { createQQServer } from './qq.mjs';
import { createTelegramChannel } from './telegram.mjs';
import { createQQBotChannel } from './qqbot.mjs';
import { downloadCloudflared, downloadFile } from './download.mjs';
import { INJECT_SCRIPT } from './panel.mjs';





// ───────────────────────── 插件主体 ─────────────────────────

export const name = 'web-remote';
export const inject = ['timer'];

export function apply(ctx, rawConfig) {
  const cfg = rawConfig ?? {};
  // 目标端口探测：桌面版（dsh-desktop）由宿主动态分配端口（webserver 支持 port=0 由系统分配），
  // 写死 3080 会让插件代理指向不存在的端口 → 隧道 502 Host Error，且 token 读取也会失败。
  // 优先级：显式配置 > DSH_WEB_URL 环境变量 > DSH_PORT > 3080 兜底
  const detectedPort = (function () {
    try {
      const m = /:(\d{2,5})(?:[/?#]|$)/.exec(String(process.env.DSH_WEB_URL || ''));
      if (m) { const p = Number(m[1]); if (p > 0) return p; }
    } catch (e) { /* ignore */ }
    try {
      const p2 = Number(process.env.DSH_PORT);
      if (Number.isFinite(p2) && p2 > 0) return p2;
    } catch (e) { /* ignore */ }
    return 0;
  })();
  const explicitPort = Number(cfg.targetPort);
  const hasExplicitPort = Number.isFinite(explicitPort) && explicitPort > 0;
  const config = {
    targetPort: hasExplicitPort ? explicitPort : (detectedPort || 3080),
    portSource: hasExplicitPort ? 'config' : (detectedPort ? 'env' : 'default'),
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
    dshToken: '',
    readDshToken: null,
  };
  // 统一持久化存储（toolsDir 尚未在闭包内就绪，此处按同一规则计算目录）
  var stateDir = config.toolsDir || (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'tools') : path.join(os.homedir(), '.dsh', 'tools'));
  const store = createStore(stateDir);
  // 读取持久化的自定义端口（HTTP 与 HTTPS 各自独立，不能相同）
  try {
    const bootState = store.load();
    if (bootState.customPort) config.httpsPortStart = bootState.customPort;
    if (bootState.customHttpPort) config.httpPortStart = bootState.customHttpPort;
  } catch (e) { console.error('[store] 启动读取失败:', e.message); }

  // 等待 webServer / subprocess 服务就绪后再挂载（与官方 dsh-market 同款模式）
  ctx.inject(['subprocess', 'webServer'], (hostCtx) => {
    const subprocess = hostCtx.subprocess;
    const webServer = hostCtx.webServer;

    // 从 DSH connection 服务实时读取当前 token（懒加载，避免启动竞态）
    ctx.inject(['connection'], (connCtx) => {
      config.readDshToken = function () {
        try {
          const url = connCtx.connection.authenticatedUrl('http://127.0.0.1:' + config.targetPort);
          const token = new URL(url).searchParams.get('token');
          if (token) { config.dshToken = token; return token; }
        } catch (e) { /* ignore */ }
        return config.dshToken || '';
      };
      console.log('[dsh-web-remote] DSH token reader ready');
    });

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
      proxy = createProxyServer({ targetPort: config.targetPort, pfxPath: config.pfxPath, pfxPass: config.pfxPass, lanOpen: config.lanOpen, getDshToken: () => config.readDshToken ? config.readDshToken() : config.dshToken });
      const httpPort = await findFreePort(config.httpPortStart, config.httpPortStart + 9);
      const httpsPort = await findFreePort(config.httpsPortStart, config.httpsPortStart + 9);
      await proxy.start(httpPort, httpsPort);
      state.token = proxy.token;
      state.port = httpPort;
      state.httpsPort = httpsPort;
      state.ips = lanIPs();

      // 2. cloudflared 隧道 —— **失败不得影响局域网代理**
      //
      // 教训：原先隧道那几步直接写在外层 try 里，`waitForPattern(..., 30000)` 超时会 throw，
      // 被外层 catch 抓住后调用 stop()，把**已经启动好的反向代理一起拆掉**。
      // 而 trycloudflare 偶发超时（实测 `context deadline exceeded`）——
      // 结果连"局域网直连"都用不了，可局域网本来根本不需要隧道。
      // 所以这里单独 try/catch：隧道失败只记状态，代理继续跑，running 仍为 true。
      try {
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
        const url = await waitForPattern(tunnelHandle, /(https:\/\/(?!api\.)[a-z0-9]+-[a-z0-9-]+\.trycloudflare\.com)/, 30000);
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
      } catch (eTunnel) {
        state.url = null;
        state.tunnelFailed = true;
        state.error = '公网隧道创建失败：' + String(eTunnel && eTunnel.message || eTunnel)
          + ' —— 局域网访问不受影响；可稍后点「换新链接」重试。';
        console.error('[dsh-web-remote] 隧道创建失败（局域网代理仍正常）:', eTunnel && eTunnel.message);
      }

      // 3. QQ 桥 —— 同样非致命（它挂了不该连累远程访问）
      try {
        qqServer = createQQServer({ infoUrls: ['http://127.0.0.1:' + config.targetPort + '/remote/info', 'http://127.0.0.1:' + config.targetPort + '/remote/access'] });
        qqPort = await findFreePort(config.qqPortStart, config.qqPortStart + 4);
        await qqServer.start(qqPort);
        state.qq = 'listening';
      } catch (eQq) {
        state.qq = null;
        console.error('[dsh-web-remote] QQ 桥启动失败:', eQq && eQq.message);
      }

      // 代理已就绪即视为运行中（隧道/QQ 桥失败不影响这个判断）
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
  const weixinState = { status: 'idle', botToken: null, qrcode: null, qrcodeUrl: null, error: null };
  function saveWeixinToken(token) {
    store.save({ weixin: { botToken: token, savedAt: Date.now() } });
  }
  function loadWeixinToken() {
    const s = store.load();
    return (s.weixin && s.weixin.botToken) || null;
  }
  function clearWeixinToken() {
    store.save({ weixin: { botToken: null, savedAt: null } });
  }
  const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
  function iLinkHeaders(token) {
    const uin = Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF))).toString('base64');
    const h = { 'Content-Type': 'application/json', 'AuthorizationType': 'ilink_bot_token', 'X-WECHAT-UIN': uin };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }
  // iLink 业务错误检查：有 ret 字段且非 0 时抛出（携带 ret/errmsg 便于定位）
  // 注意：getupdates / get_qrcode_status 等接口不返回 ret，属正常响应，直接放行
  function iLinkParse(data) {
    let parsed;
    try { parsed = JSON.parse(data); } catch (e) { return data; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.ret !== undefined && parsed.ret !== 0) {
      const msg = parsed.errmsg || parsed.msg || ('ret=' + parsed.ret);
      const e = new Error('iLink ' + msg);
      e.ilinkRet = parsed.ret;
      e.ilinkMsg = msg;
      throw e;
    }
    return parsed;
  }
  async function iLinkGet(path, token) {
    const https = await import('node:https');
    return new Promise((resolve, reject) => {
      const req = https.request(ILINK_BASE + path, { method: 'GET', headers: iLinkHeaders(token) }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => { try { resolve(iLinkParse(data)); } catch (e) { reject(e); } });
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
        res.on('end', () => { try { resolve(iLinkParse(data)); } catch (e) { reject(e); } });
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
  let feishuMonitorMode = false;
  let feishuLastChatId = '';
  let weixinLastContextAt = 0;   // 上次微信消息到达时间（context_token 新鲜度）
  let weixinLastStaleMin = -1;   // 本次消息前凭据年龄（供 /状态 展示，-1=本会话尚无微信消息）
  let weixinLastFlushedCount = 0; // 本次消息前补发的积压条数
  let weixinPendingNotify = [];  // 凭据过期时积压的监听通知，来信后补发
  let weixinMonitorTimer = null;
  let weixinMonitorSnapshots = {}; // { agentId: { eventsLen, wasRunning } }
  let weixinMonitorTitles = {}; // { agentId: title }
  let monitorDiagLogged = false; // 首次轮询打印一次诊断（agent 数量/状态/事件数）
  let monitorLastNotifyAt = 0;    // 最后一次触发通知的时间
  let monitorLastNotifyTitle = '';// 最后一次通知的会话标题
  let monitorLastSendResult = ''; // 最后一次发送结果（供 /remote/diag 排查）
  // ====== Telegram（小飞机）======
  let telegramChannel = null;              // createTelegramChannel 实例
  let telegramMonitorMode = false;         // 监听通知是否推送到 Telegram
  let telegramLastChatId = null;           // 最后一次收到消息的 chat id（主动推送目标）
  let telegramToken = '';                  // Bot Token（来自 store）
  let telegramProxyUrl = 'http://127.0.0.1:7897'; // HTTP 代理（国内访问 api.telegram.org 必需）
  let telegramApiBase = 'https://api.telegram.org'; // 可指向自建 Bot API 反代
  let telegramSelectedSession = null;      // Telegram 侧当前选中的会话（发消息到会话用）
  // 停止 Telegram 通道：定义在模块作用域，因为销毁清理（ctx.effect，模块作用域）也会调用它
  function telegramStop() {
    if (telegramChannel) { try { telegramChannel.stop(); } catch (e) { /* ignore */ } }
  }

  // ====== QQ 官方机器人（QQ 开放平台 Agent 接入）======
  let qqbotChannel = null;                 // createQQBotChannel 实例
  let qqbotMonitorMode = false;            // 监听通知是否推送到 QQ
  let qqbotAppId = '';                     // AppID（AppSecret 只存在通道闭包里，不落地到 state）
  let qqbotSessionsDir = '';               // 会话持久化目录（RESUME 用）
  // 同样必须在模块作用域：销毁清理会调用它
  function qqbotStop() {
    if (qqbotChannel) { try { qqbotChannel.stop(); } catch (e) { /* ignore */ } }
  }
  // 扫码绑定流程状态（QQ 官方「扫码连接」：手机QQ扫码 → 选择已有机器人 → 授权后返回凭据）
  // state: 'idle' | 'waiting' | 'expired' | 'success' | 'failed'
  let qqbotQrState = { state: 'idle', url: '', error: '', startedAt: 0, appId: '' };
  let qqbotQrStop = null;   // startQrConnect 返回的停止函数
  let qqbotQrTimer = null;  // 超时保护定时器
  function qqbotQrCleanup() {
    if (qqbotQrStop) { try { qqbotQrStop(); } catch (e) { /* ignore */ } qqbotQrStop = null; }
    if (qqbotQrTimer) { clearTimeout(qqbotQrTimer); qqbotQrTimer = null; }
  }
  function qqbotQrCancel(reason) {
    qqbotQrCleanup();
    if (qqbotQrState.state === 'waiting' || qqbotQrState.state === 'expired') {
      qqbotQrState = { state: 'idle', url: '', error: reason || '', startedAt: 0, appId: '' };
    }
  }

  // ====== 三通道健康状态（面板红点 + 直达排查用）======
  // health: 'ok'（正常） | 'degraded'（重试中） | 'down'（已断开/停止）
  let weixinHealth = 'ok';
  let weixinFails = 0;        // 微信轮询连续失败次数
  let weixinLastError = '';   // 微信最近一次错误
  let feishuHealth = 'ok';
  let feishuFails = 0;        // 飞书连续发送失败次数
  let feishuLastError = '';   // 飞书最近一次错误
  const MAX_CHANNEL_FAILS = 3; // 连续失败上限：达到即判定断开

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
        // 轮询成功：恢复健康标记
        if (weixinHealth !== 'ok') { console.log('[dsh-weixin] 已恢复连接'); weixinHealth = 'ok'; }
        weixinFails = 0;
        weixinLastError = '';
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
                // 记录本次消息前的凭据年龄与积压数（供 /状态 展示）
                weixinLastStaleMin = weixinLastContextAt ? Math.round((Date.now() - weixinLastContextAt) / 60000) : -1;
                weixinLastFlushedCount = weixinPendingNotify.length;
                weixinState.lastContextToken = msg.context_token;
                weixinLastContextAt = Date.now();
                // 新凭据到手，补发积压的监听通知（顺序发送；失败则本条及剩余重新入队）
                if (weixinPendingNotify.length > 0) {
                  var pendingList = weixinPendingNotify.splice(0);
                  console.log('[dsh-weixin] 补发 ' + pendingList.length + ' 条积压通知');
                  for (var pi = 0; pi < pendingList.length; pi++) {
                    try {
                      await weixinSendMsg(weixinState.botToken, weixinState.lastFromUserId, pendingList[pi], weixinState.lastContextToken || '');
                    } catch (e) {
                      weixinPendingNotify = pendingList.slice(pi).concat(weixinPendingNotify);
                      console.error('[dsh-weixin] 补发失败，已重新入队 ' + (pendingList.length - pi) + ' 条:', e.message);
                      break;
                    }
                  }
                  if (weixinPendingNotify.length === 0) console.log('[dsh-weixin] 积压通知已全部补发');
                }
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
        weixinFails++;
        weixinLastError = e.message || String(e);
        // 连续失败达上限：停止轮询（不再空转刷屏），恢复靠面板「重连」
        if (weixinFails >= MAX_CHANNEL_FAILS) {
          weixinHealth = 'down';
          weixinState.status = 'error';
          console.error('[dsh-weixin] 连接断开（连续 ' + MAX_CHANNEL_FAILS + ' 次失败，已停止轮询）：' + weixinLastError + ' — 点「重连」恢复');
          break;
        }
        weixinHealth = 'degraded';
        const wait = weixinFails === 1 ? 5000 : 10000;
        console.error('[dsh-weixin] 第 ' + weixinFails + '/' + MAX_CHANNEL_FAILS + ' 次失败：' + weixinLastError + '（' + (wait / 1000) + ' 秒后重试）');
        await new Promise(function (r) { setTimeout(r, wait); });
      }
    }
    weixinPollLoopRunning = false;
    console.log('[dsh-weixin] poll loop stopped');
  }

  let customPublicUrl = null;
  let feishuToken = null;

  // ====== 三通道健康聚合（面板红点数据源）======
  // 注意：必须定义在模块作用域（与 snapshot 同级），
  // 因为 snapshot() 会调用它；若定义在 if(webServer){} 块内则 snapshot 取不到 → ReferenceError
  // 任一通道 down → anyDown=true；面板在「远程」按钮上显示红点，点击直达该通道页
  function channelHealthSnapshot() {
    var tg = null;
    try { tg = telegramChannel ? telegramChannel.status() : null; } catch (e) { /* ignore */ }
    var qq = null;
    try { qq = qqbotChannel ? qqbotChannel.status() : null; } catch (e) { /* ignore */ }
    var h = {
      weixin: { state: weixinHealth, fails: weixinFails, error: weixinLastError || '' },
      feishu: { state: feishuHealth, fails: feishuFails, error: feishuLastError || '' },
      telegram: {
        state: tg ? tg.health : 'ok',
        fails: tg ? tg.fails : 0,
        error: tg ? (tg.lastError || '') : '',
        kind: tg ? (tg.lastErrorKind || '') : '',
      },
      qqbot: {
        state: qq ? qq.health : 'ok',
        fails: qq ? qq.fails : 0,
        error: qq ? (qq.lastError || '') : '',
        kind: qq ? (qq.lastErrorKind || '') : '',
      },
    };
    var downList = [];
    if (h.weixin.state === 'down') downList.push('weixin');
    if (h.feishu.state === 'down') downList.push('feishu');
    if (h.telegram.state === 'down') downList.push('telegram');
    if (h.qqbot.state === 'down') downList.push('qqbot');
    h.anyDown = downList.length > 0;
    h.downList = downList;
    return h;
  }

  const snapshot = () => {
    var feishuSt = null;
    if (feishuToken && Date.now() < feishuToken.expireAt) { feishuSt = 'connected'; }
    else {
      var fc = store.load().feishu || {};
      if (fc.appId) feishuSt = 'configured';
    }
    var telegramSt = null;
    try {
      var tc = store.load().telegram || {};
      if (telegramChannel && telegramChannel.status().running) telegramSt = 'connected';
      else if (tc.botToken) telegramSt = 'configured';
    } catch (e) { /* ignore */ }
    var qqbotSt = null;
    try {
      var qc = store.load().qqbot || {};
      if (qqbotChannel && qqbotChannel.status().running) qqbotSt = 'connected';
      else if (qc.appId) qqbotSt = 'configured';
    } catch (e) { /* ignore */ }
    return { running: state.running, url: state.url, token: state.token, port: state.port, httpsPort: state.httpsPort, ips: state.ips, qq: state.qq, weixin: weixinState.status, error: state.error, lanOpen: config.lanOpen, customPublicUrl: customPublicUrl || null, feishu: feishuSt, telegram: telegramSt, telegramMonitor: telegramMonitorMode, qqbot: qqbotSt, qqbotMonitor: qqbotMonitorMode, qqbotAppId: (qqbotAppId || (store.load().qqbot || {}).appId || ''), health: channelHealthSnapshot(), targetPort: config.targetPort, portSource: config.portSource };
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
    // 微信「重连」：连续失败停止轮询后，重置计数并重新拉起轮询
    const weixinReconnectHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      try {
        weixinFails = 0;
        weixinLastError = '';
        weixinHealth = 'ok';
        if (weixinState.botToken) {
          weixinState.status = 'connected';
          weixinPollLoop();
          console.log('[dsh-weixin] 手动重连：已重新拉起轮询');
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, connected: weixinState.status === 'connected' }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/weixin/reconnect', handler: weixinReconnectHandler }));
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
    function feishuLoadConfig() {
      const f = store.load().feishu || {};
      return { appId: f.appId || '', appSecret: f.appSecret || '' };
    }
    function feishuSaveConfig(cfg) {
      store.save({ feishu: { appId: cfg.appId, appSecret: cfg.appSecret } });
      return true;
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
          // 必须把 token 一并返回：调用方直接用返回值拼 Authorization，
          // 曾因只返回 { ok:true } 导致 'Bearer undefined' → 飞书报 Invalid access token
          return { ok: true, token: data.tenant_access_token };
        }
        return { ok: false, error: data.msg || ('code=' + data.code) };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    async function feishuEnsureToken() {
      if (feishuToken && Date.now() < feishuToken.expireAt) return { ok: true, token: feishuToken.token };
      const cfg = feishuLoadConfig();
      if (!cfg.appId || !cfg.appSecret) return { ok: false, error: '未配置飞书凭证' };
      return feishuVerify(cfg.appId, cfg.appSecret);
    }
    async function feishuSendText(chatId, text, isRetry) {
      const t = await feishuEnsureToken();
      if (!t.ok) throw new Error(t.error);
      if (!t.token) throw new Error('飞书 token 获取异常（空 token）');
      const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.token },
        body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: String(text || '') }) })
      });
      const data = await res.json();
      if (!(data && data.code === 0)) {
        const msg = data ? (data.msg || ('code=' + data.code)) : 'empty response';
        // 鉴权类失败：清掉缓存 token，重新取一次再试（服务端可能提前失效了缓存里的 token）
        const authFail = /token|auth|unauthor/i.test(msg) || (data && (data.code === 99991663 || data.code === 99991661));
        if (authFail && !isRetry) {
          feishuToken = null;
          return feishuSendText(chatId, text, true);
        }
        // 计数连续失败，达上限标记断开（供面板红点）
        feishuFails++;
        feishuLastError = msg;
        if (feishuFails >= MAX_CHANNEL_FAILS) feishuHealth = 'down';
        else feishuHealth = 'degraded';
        throw new Error(msg);
      }
      // 发送成功：恢复健康标记
      if (feishuHealth !== 'ok') { console.log('[feishu] 已恢复连接'); feishuHealth = 'ok'; }
      feishuFails = 0;
      feishuLastError = '';
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
        if (!appId || !appSecret) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '请填写 App ID 和 App Secret' })); return; }
        const v = await feishuVerify(appId, appSecret);
        feishuSaveConfig({ appId, appSecret });
        if (v.ok) { feishuToken = null; await feishuEnsureToken(); feishuStartWS().catch(function(e){}); console.log('[feishu] 凭证验证通过'); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, connected: true })); }
        else { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, connected: false, error: v.error })); }
      } catch (e) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
    };
    const feishuDisconnectHandler = async (req, res) => {
      feishuStopWS();
      store.save({ feishu: { appId: null, appSecret: null } });
      feishuToken = null;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true }));
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/feishu/status', handler: feishuStatusHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/feishu/config', handler: feishuConfigHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/feishu/disconnect', handler: feishuDisconnectHandler }));

    // ====== Telegram（小飞机）======
    // 走 telegram.mjs：纯 HTTP 长轮询，支持 HTTP 代理（国内直连 api.telegram.org 会超时）
    function telegramLoadConfig() {
      const t = store.load().telegram || {};
      return {
        botToken: t.botToken || '',
        // 未显式配置时给常见 Clash 端口作默认值，避免首次使用直接超时
        proxyUrl: t.proxyUrl === undefined ? 'http://127.0.0.1:7897' : (t.proxyUrl || ''),
        apiBase: t.apiBase || 'https://api.telegram.org',
        lastChatId: t.lastChatId || null,
      };
    }
    function telegramSaveConfig(patch) {
      store.save({ telegram: patch });
    }
    function telegramEnsureChannel() {
      if (telegramChannel) return telegramChannel;
      telegramChannel = createTelegramChannel({
        apiBase: telegramApiBase,
        proxyUrl: telegramProxyUrl,
        onMessage: async (msg) => {
          telegramLastChatId = msg.chatId;
          try { telegramSaveConfig({ lastChatId: msg.chatId }); } catch (e) { /* ignore */ }
          return telegramHandleCommand(msg.text, msg.chatId);
        },
        onLog: (lv, text) => console.log('[telegram]', text),
      });
      return telegramChannel;
    }
    async function telegramStart() {
      const ch = telegramEnsureChannel();
      if (!telegramToken) throw new Error('未配置 Bot Token');
      await ch.start(telegramToken);
      return ch.status();
    }
    // 各通道自己的指令状态（选中的目标会话 + 多步选择中间态）
    const telegramCmdState = { selected: null, pick: null };
    async function telegramHandleCommand(text, chatId) {
      const st = telegramCmdState;
      const t = String(text || '').trim();
      if (!t) return null;
      if (/^\/?(help|帮助|命令|start)$/i.test(t) && !/^\/启动$/.test(t)) {
        return channelHelp('Telegram');
      }
      if (/^\/?(链接|获取链接|公网链接|link)$/i.test(t)) {
        if (!state.running) {
          state.error = null;
          console.log('[telegram] starting remote (via telegram command)...');
          try { await start(); } catch (e) { console.error('[telegram] 远程启动失败:', e.message); }
        }
        if (state.url && state.token) return '公网链接：\n' + state.url + '/?token=' + state.token;
        if (state.error) return '启动失败：' + state.error;
        return '正在获取链接，请稍候（隧道建立约 10~30 秒）…';
      }
      if (/^\/?(启动|start-remote|开启)$/i.test(t)) {
        if (state.running) return '远程服务已在运行中';
        state.error = null;
        try { await start(); } catch (e) { console.error('[telegram] 远程启动失败:', e.message); }
        if (state.running) return '远程服务已启动';
        if (state.error) return '启动失败：' + state.error;
        return '正在启动，请稍候…';
      }
      if (/^\/?(停止|关闭远程|stop|停止远程)$/i.test(t)) {
        if (!state.running) return '远程服务未启动';
        stop();
        return '已停止远程服务';
      }
      if (/^\/?(监听|监控|monitor)$/i.test(t)) {
        telegramMonitorMode = !telegramMonitorMode;
        telegramSaveConfig({ monitor: telegramMonitorMode });
        if (telegramMonitorMode) {
          try { startMonitor(); } catch (e) { console.error('[telegram] startMonitor 失败:', e.message); }
          // 首次开启时主动发一条确认，顺带验证发送链路（用户 /start 过机器人即可收）
          const ch = telegramChannel;
          if (ch) { try { await ch.send(chatId, '监听已开启：会话思考完毕会推送到这里。再次发送 /监听 可关闭。'); } catch (e) { console.error('[telegram] 确认消息发送失败:', e.message); } }
          return null;
        }
        if (!weixinMonitorMode && !feishuMonitorMode) { try { stopMonitor(); } catch (e) { /* ignore */ } }
        return 'Telegram 监听已关闭';
      }
      if (/^\/?(状态|status)$/i.test(t)) {
        const stt = telegramChannel ? telegramChannel.status() : { running: false };
        return 'Telegram 通道状态：\n'
          + '• 连接：' + (stt.running ? '已连接' : '未连接') + (stt.me ? '（@' + stt.me.username + '）' : '') + '\n'
          + '• 代理：' + (stt.proxy || '(直连)') + '\n'
          + '• 收到消息：' + (stt.messages || 0) + ' 条\n'
          + '• 监听：' + (telegramMonitorMode ? '开' : '关') + '\n'
          + '• 选中会话：' + (st.selected ? '有' : '无') + '\n'
          + (stt.lastError ? '• 最近错误：' + stt.lastError : '');
      }
      // ── 以下与微信通道对齐（此前 Telegram 缺这几项）──
      if (/^\/?(会话列表|会话|sessions)$/i.test(t)) return await cmdSessionList();
      const mSel = t.match(/^\/?选择[\s：:]*(\d+)$/);
      if (mSel) return await cmdSelectSession(st, mSel[1]);
      if (/^\/?(当前会话|current)$/i.test(t)) return await cmdCurrentSession(st);
      if (/^\/?(历史内容|历史|history)$/i.test(t)) return await cmdHistory(st);
      if (/^\/?(当前模型|模型|model)$/i.test(t)) return await cmdCurrentModel(st);
      if (/^\/?切换模型/.test(t)) return await cmdSwitchModel(st, t.replace(/^\/?切换模型/, ''));
      if (/^\/?选强度/.test(t)) return await cmdPickEffort(st, t.replace(/^\/?选强度/, ''));
      // 非命令文本 → 转发进选中会话（微信早就支持；其他端此前只能被动收通知）
      if (!/^\//.test(t)) return await cmdRelayToSession(st, t);
      return '未知命令，发送 /帮助 查看可用命令';
    }

    const telegramStatusHandler = async (req, res) => {
      const cfg = telegramLoadConfig();
      const st = telegramChannel ? telegramChannel.status() : null;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        configured: !!cfg.botToken,
        connected: !!(st && st.running),
        health: st ? st.health : 'ok',
        fails: st ? st.fails : 0,
        me: st ? st.me : null,
        proxy: cfg.proxyUrl || '(直连)',
        apiBase: cfg.apiBase,
        monitor: telegramMonitorMode,
        lastError: st ? st.lastError : null,
        lastErrorKind: st ? st.lastErrorKind : '',
        messages: st ? st.messages : 0,
      }));
    };
    // Telegram「重连」：打断退避、重建代理隧道、立即重连
    const telegramReconnectHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      try {
        if (!telegramChannel) {
          const st0 = await telegramStart();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, connected: true, health: 'ok', me: st0.me }));
          return;
        }
        const st = await telegramChannel.reconnect();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, connected: true, health: st.health || 'ok', me: st.me }));
      } catch (e) {
        const st = telegramChannel ? telegramChannel.status() : null;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, connected: false, health: 'down', error: e.message, kind: st ? st.lastErrorKind : '' }));
      }
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/telegram/reconnect', handler: telegramReconnectHandler }));
    const telegramConfigHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body || '{}');
        const token = String(data.botToken || '').trim();
        const proxy = data.proxyUrl === undefined ? telegramProxyUrl : String(data.proxyUrl || '').trim();
        const apiBase = String(data.apiBase || telegramApiBase || 'https://api.telegram.org').trim();
        if (!token) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '请填写 Bot Token（向 @BotFather 申请）' }));
          return;
        }
        // 保存配置并（重）启动
        telegramToken = token;
        telegramProxyUrl = proxy;
        telegramApiBase = apiBase;
        telegramSaveConfig({ botToken: token, proxyUrl: proxy, apiBase: apiBase });
        telegramStop();
        telegramChannel = null; // 配置变了，重建实例（代理/地址可能不同）
        try {
          const st = await telegramStart();
          console.log('[telegram] 配置成功，机器人 @' + (st.me ? st.me.username : '?'));
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, connected: true, me: st.me, proxy: st.proxy }));
        } catch (e) {
          const hint = /ETIMEDOUT|timeout|ECONNREFUSED|socket hang up/i.test(e.message)
            ? '（连接超时/被拒：国内需填代理，如 http://127.0.0.1:7897）' : '';
          console.error('[telegram] 启动失败:', e.message);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, connected: false, error: e.message + hint }));
        }
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    };
    const telegramDisconnectHandler = async (req, res) => {
      telegramStop();
      telegramChannel = null;
      telegramToken = '';
      telegramSaveConfig({ botToken: null });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/telegram/status', handler: telegramStatusHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/telegram/config', handler: telegramConfigHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/telegram/disconnect', handler: telegramDisconnectHandler }));

    // ====== QQ 官方机器人（QQ 开放平台）======
    // 走 qqbot.mjs：官方 SDK + WebSocket 长连接，不需要公网入口；AppSecret 只在通道闭包里
    function qqbotLoadConfig() {
      const q = store.load().qqbot || {};
      return {
        appId: q.appId || '',
        appSecret: q.appSecret || '',
        monitor: !!q.monitor,
      };
    }
    function qqbotSaveConfig(patch) {
      store.save({ qqbot: patch });
    }
    function qqbotEnsureChannel() {
      if (qqbotChannel) return qqbotChannel;
      qqbotChannel = createQQBotChannel({
        sessionsDir: qqbotSessionsDir || undefined,
        onMessage: async (msg) => {
          // 这里**不要**做 lastTarget 落盘：通道在调用本钩子之前已经把新目标写进自己的
          // state 了，此时 getLastTarget() 返回的就是新值，比较恒等 → 永远不落盘。
          // 持久化统一走下面的 onTargetChange（通道用覆盖前的旧值判断，天然去重）。
          return qqbotHandleCommand(msg.text, msg);
        },
        // 推送目标持久化：仅在目标**真正发生变化**时由通道回调（写放大问题也一并解决）
        onTargetChange: (t) => {
          try { qqbotSaveConfig({ lastTarget: { scope: t.scope, targetId: t.targetId } }); } catch (e) { /* ignore */ }
        },
        onLog: (lv, text) => {
          if (lv === 'error') console.error('[qqbot]', text);
          else console.log('[qqbot]', text);
        },
      });
      return qqbotChannel;
    }
    /** 从持久化里恢复推送目标（各条启动路径都调用） */
    function qqbotRestoreTarget() {
      try {
        const lt = (store.load().qqbot || {}).lastTarget;
        if (lt && lt.scope && lt.targetId && qqbotChannel && typeof qqbotChannel.setLastTarget === 'function') {
          if (qqbotChannel.setLastTarget(lt)) {
            console.log('[qqbot] 已恢复上次会话目标（' + lt.scope + '）—— 无需再发消息即可主动推送');
          }
        }
      } catch (e) { /* 目标恢复失败不影响连接 */ }
    }
    async function qqbotStart() {
      const ch = qqbotEnsureChannel();
      const cfg = qqbotLoadConfig();
      if (!cfg.appId || !cfg.appSecret) throw new Error('未配置 AppID / AppSecret');
      qqbotAppId = cfg.appId;
      return ch.start(cfg.appId, cfg.appSecret);
    }
    const qqbotCmdState = { selected: null, pick: null };
    async function qqbotHandleCommand(text, msg) {
      const st = qqbotCmdState;
      const t = String(text || '').trim();
      if (!t) return null;
      if (/^\/?(help|帮助|命令)$/i.test(t)) {
        return channelHelp('QQ 官方');
      }
      if (/^\/?(链接|获取链接|公网链接|link)$/i.test(t)) {
        if (!state.running) {
          state.error = null;
          console.log('[qqbot] starting remote (via qq command)...');
          try { await start(); } catch (e) { console.error('[qqbot] 远程启动失败:', e.message); }
        }
        if (state.url && state.token) return '公网链接：\n' + state.url + '/?token=' + state.token;
        if (state.error) return '启动失败：' + state.error;
        return '正在获取链接，请稍候（隧道建立约 10~30 秒）…';
      }
      if (/^\/?(启动|开启)$/i.test(t)) {
        if (state.running) return '远程服务已在运行中';
        state.error = null;
        try { await start(); } catch (e) { console.error('[qqbot] 远程启动失败:', e.message); }
        if (state.running) return '远程服务已启动';
        if (state.error) return '启动失败：' + state.error;
        return '正在启动，请稍候…';
      }
      if (/^\/?(停止|关闭远程|stop)$/i.test(t)) {
        if (!state.running) return '远程服务未启动';
        stop();
        return '已停止远程服务';
      }
      if (/^\/?(监听|监控|monitor)$/i.test(t)) {
        qqbotMonitorMode = !qqbotMonitorMode;
        qqbotSaveConfig({ monitor: qqbotMonitorMode });
        if (qqbotMonitorMode) {
          try { startMonitor(); } catch (e) { console.error('[qqbot] startMonitor 失败:', e.message); }
          return '监听已开启：会话思考完毕会推送到这里。再次发送 /监听 可关闭。';
        }
        if (!weixinMonitorMode && !feishuMonitorMode && !telegramMonitorMode) {
          try { stopMonitor(); } catch (e) { /* ignore */ }
        }
        return 'QQ 监听已关闭';
      }
      if (/^\/?(状态|status)$/i.test(t)) {
        const stt = qqbotChannel ? qqbotChannel.status() : null;
        return 'QQ 通道状态：\n'
          + '连接：' + (stt && stt.running ? '已连接' : '未连接') + '\n'
          + 'AppID：' + (qqbotAppId || '(未配置)') + '\n'
          + '监听：' + (qqbotMonitorMode ? '开' : '关') + '\n'
          + '收到消息：' + (stt ? stt.messages : 0) + ' 条\n'
          + '选中会话：' + (st.selected ? '有' : '无') + '\n'
          + (stt && stt.lastError ? '最近错误：' + stt.lastError : '');
      }
      // ── 以下与微信通道对齐（此前 QQ官方 缺这几项）──
      if (/^\/?(会话列表|会话|sessions)$/i.test(t)) return await cmdSessionList();
      const mSel = t.match(/^\/?选择[\s：:]*(\d+)$/);
      if (mSel) return await cmdSelectSession(st, mSel[1]);
      if (/^\/?(当前会话|current)$/i.test(t)) return await cmdCurrentSession(st);
      if (/^\/?(历史内容|历史|history)$/i.test(t)) return await cmdHistory(st);
      if (/^\/?(当前模型|模型|model)$/i.test(t)) return await cmdCurrentModel(st);
      if (/^\/?切换模型/.test(t)) return await cmdSwitchModel(st, t.replace(/^\/?切换模型/, ''));
      if (/^\/?选强度/.test(t)) return await cmdPickEffort(st, t.replace(/^\/?选强度/, ''));
      if (!/^\//.test(t)) return await cmdRelayToSession(st, t);
      return '未知命令，发送 /帮助 查看可用命令';
    }

    const qqbotStatusHandler = async (req, res) => {
      const cfg = qqbotLoadConfig();
      const st = qqbotChannel ? qqbotChannel.status() : null;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        configured: !!(cfg.appId && cfg.appSecret),
        connected: !!(st && st.running),
        health: st ? st.health : 'ok',
        fails: st ? st.fails : 0,
        appId: cfg.appId || '',
        monitor: qqbotMonitorMode,
        lastError: st ? st.lastError : '',
        lastErrorKind: st ? st.lastErrorKind : '',
        messages: st ? st.messages : 0,
        hasTarget: !!(st && st.lastTarget),
      }));
    };
    const qqbotConfigHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      const reply = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      try {
        const data = JSON.parse(body || '{}');
        // 留空表示沿用已保存的值（便于只改其中一项）
        const prev = qqbotLoadConfig();
        const appId = String(data.appId || '').trim() || prev.appId;
        const appSecret = String(data.appSecret || '').trim() || prev.appSecret;
        if (!appId || !appSecret) { reply({ ok: false, error: '请填写 AppID 和 AppSecret' }); return; }
        qqbotSaveConfig({ appId: appId, appSecret: appSecret });
        qqbotAppId = appId;
        // 已连接的实例先停掉再重建（配置变了）
        if (qqbotChannel) { try { qqbotChannel.stop(); } catch (e) { /* ignore */ } qqbotChannel = null; }
        try {
          const st = await qqbotStart();
          qqbotRestoreTarget(); // 换了凭据也先把上次的推送目标挂回去
          console.log('[qqbot] 配置成功，AppID ' + appId);
          reply({ ok: true, connected: true, health: st.health, appId: appId });
        } catch (e) {
          const st = qqbotChannel ? qqbotChannel.status() : null;
          const hint = st && st.lastErrorKind === 'auth'
            ? '（AppID 或 AppSecret 不正确，请核对开放平台「开发设置」里的值）'
            : (st && st.lastErrorKind === 'sdk-missing' ? '（QQ 官方 SDK 未安装）' : '');
          console.error('[qqbot] 启动失败:', e.message);
          reply({ ok: true, connected: false, error: e.message + hint, kind: st ? st.lastErrorKind : 'unknown' });
        }
      } catch (e) {
        reply({ ok: false, error: String((e && e.message) || e) });
      }
    };
    const qqbotReconnectHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const reply = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      try {
        if (!qqbotChannel) {
          // 通道不存在（断开后重连、或上次启动失败）：重启通道后同样要挂回上次的推送目标，
          // 否则主动推送要等到有人再发一条消息才生效。
          const st0 = await qqbotStart();
          qqbotRestoreTarget();
          reply({ ok: true, connected: true, health: st0.health });
          return;
        }
        const st = await qqbotChannel.reconnect();
        reply({ ok: true, connected: true, health: st.health });
      } catch (e) {
        const st = qqbotChannel ? qqbotChannel.status() : null;
        reply({ ok: true, connected: false, health: 'down', error: e.message, kind: st ? st.lastErrorKind : 'unknown' });
      }
    };
    const qqbotDisconnectHandler = async (req, res) => {
      qqbotStop();
      qqbotChannel = null;
      qqbotAppId = '';
      // 一并清掉推送目标：换了机器人后旧的 targetId 在 QQ 侧已无效，
      // 留着只会在下次启动被恢复成死目标，让主动推送一直报错。
      qqbotSaveConfig({ appId: null, appSecret: null, lastTarget: null });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true }));
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/qqbot/status', handler: qqbotStatusHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/qqbot/config', handler: qqbotConfigHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/qqbot/reconnect', handler: qqbotReconnectHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/qqbot/disconnect', handler: qqbotDisconnectHandler }));

    // ====== QQ 官方「扫码绑定」（@tencent-connect/qqbot-connector）======
    // 流程：面板点「扫码绑定」→ 后端取二维码 URL → 手机QQ扫码 → 选择已有机器人并授权
    //       → onSuccess 拿到 { appId, appSecret } → 自动保存并连接。
    // 注意：扫码是「绑定已有机器人」，不会新建机器人（创建须在开放平台网页完成）。
    const QQ_QR_TIMEOUT_MS = 180000; // 3 分钟未扫码则超时
    async function qqbotQrStart() {
      // 先清掉可能存在的上一轮
      qqbotQrCleanup();
      let m;
      try {
        m = await import('@tencent-connect/qqbot-connector');
      } catch (e) {
        const err = new Error('扫码 SDK 未安装（@tencent-connect/qqbot-connector）：' + ((e && e.message) || e));
        err.kind = 'sdk-missing';
        throw err;
      }
      if (typeof m.startQrConnect !== 'function') {
        throw new Error('扫码 SDK 版本不支持 startQrConnect（需要 >= 1.0.0）');
      }

      // 先置状态，再启动：onQrDisplayed 可能是同步回调
      qqbotQrState = { state: 'waiting', url: '', error: '', startedAt: Date.now(), appId: '' };

      qqbotQrStop = m.startQrConnect({
        onQrDisplayed(url) {
          try {
            qqbotQrState.url = String(url || '');
            if (qqbotQrState.state !== 'success') qqbotQrState.state = 'waiting';
            console.log('[qqbot] 扫码二维码已就绪，等待手机QQ扫描…');
          } catch (e) { /* ignore */ }
        },
        onQrExpired() {
          try {
            if (qqbotQrState.state !== 'success') qqbotQrState.state = 'expired';
            console.log('[qqbot] 二维码已过期，SDK 正在自动刷新…');
          } catch (e) { /* ignore */ }
        },
        onSuccess(list) {
          try {
            const cred = Array.isArray(list) ? list[0] : list;
            if (!cred || !cred.appId || !cred.appSecret) {
              qqbotQrState = { state: 'failed', url: '', error: '扫码返回的凭据不完整', startedAt: 0, appId: '' };
              console.error('[qqbot] 扫码返回凭据不完整');
              return;
            }
            // 拿到凭据：立刻保存（AppSecret 只进 store 与通道闭包，不写日志）
            qqbotSaveConfig({ appId: cred.appId, appSecret: cred.appSecret });
            qqbotAppId = cred.appId;
            qqbotQrState = { state: 'success', url: '', error: '', startedAt: 0, appId: cred.appId };
            qqbotQrCleanup(); // 流程已结束，释放定时器与 stop 句柄
            console.log('[qqbot] 扫码授权成功，AppID ' + cred.appId + '，正在建立连接…');
            // 重建通道并连接
            if (qqbotChannel) { try { qqbotChannel.stop(); } catch (e) { /* ignore */ } qqbotChannel = null; }
            qqbotStart().then(function () {
              qqbotRestoreTarget();
              console.log('[qqbot] 扫码绑定完成，通道已连接');
            }).catch(function (e) {
              qqbotQrState.error = '已获取凭据，但连接失败：' + ((e && e.message) || e);
              console.error('[qqbot] 扫码后连接失败:', (e && e.message) || e);
            });
          } catch (e) {
            qqbotQrState = { state: 'failed', url: '', error: String((e && e.message) || e), startedAt: 0, appId: '' };
            console.error('[qqbot] 扫码成功回调异常:', (e && e.message) || e);
          }
        },
        onFailure(err) {
          try {
            const msg = String((err && err.message) || err || '扫码失败或已取消');
            // 主动取消（stop()）也会走到这里，此时保持 idle 不报错
            if (qqbotQrState.state === 'idle') return;
            qqbotQrState = { state: 'failed', url: '', error: msg, startedAt: 0, appId: '' };
            console.log('[qqbot] 扫码失败/取消：' + msg);
          } catch (e) { /* ignore */ }
        },
      }, { displayQrCodeToConsole: false });

      // 超时保护：避免扫码流程永远挂着
      qqbotQrTimer = setTimeout(function () {
        try {
          if (qqbotQrState.state === 'waiting' || qqbotQrState.state === 'expired') {
            qqbotQrCleanup();
            qqbotQrState = { state: 'failed', url: '', error: '扫码超时（' + (QQ_QR_TIMEOUT_MS / 60000) + ' 分钟未完成），请重试', startedAt: 0, appId: '' };
            console.log('[qqbot] 扫码超时，已自动取消');
          }
        } catch (e) { /* ignore */ }
      }, QQ_QR_TIMEOUT_MS);
      if (typeof qqbotQrTimer.unref === 'function') qqbotQrTimer.unref();

      return qqbotQrState;
    }

    const qqbotQrStartHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const reply = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      try {
        const st = await qqbotQrStart();
        // 二维码 URL 可能异步到达，这里先返回当前状态；面板随后轮询 /qr/status
        reply({ ok: true, state: st.state, qrUrl: st.url, error: st.error || '' });
      } catch (e) {
        reply({ ok: false, state: 'failed', error: String((e && e.message) || e), kind: e.kind || 'unknown' });
      }
    };
    const qqbotQrStatusHandler = async (req, res) => {
      const st = qqbotChannel ? qqbotChannel.status() : null;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        state: qqbotQrState.state,
        qrUrl: qqbotQrState.url,
        error: qqbotQrState.error || '',
        appId: qqbotQrState.appId || '',
        elapsedSec: qqbotQrState.startedAt ? Math.round((Date.now() - qqbotQrState.startedAt) / 1000) : 0,
        connected: !!(st && st.running),
        health: st ? st.health : 'ok',
      }));
    };
    const qqbotQrCancelHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      qqbotQrCancel();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, state: qqbotQrState.state }));
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/qqbot/qr/start', handler: qqbotQrStartHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/qqbot/qr/status', handler: qqbotQrStatusHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/qqbot/qr/cancel', handler: qqbotQrCancelHandler }));

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
              // 记录最后对话的飞书 chatId，用于监听通知（统一存储）
              feishuLastChatId = chatId;
              store.save({ feishu: { lastChatId: chatId } });
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
        try { feishuWSClient.stop(); } catch (e) { /* 连接可能已断开，忽略 */ }
        feishuWSClient = null;
        console.log('[feishu] WebSocket stopped');
      }
    }
    const feishuCmdState = { selected: null, pick: null };
    async function feishuHandleCommand(text, chatId) {
      const st = feishuCmdState;
      const t = (text || '').trim();
      if (!t) return null;
      if (/^\/?(help|帮助|命令)$/i.test(t)) {
        return channelHelp('飞书');
      }
      if (/^\/?(链接|获取链接|公网链接|link)$/i.test(t)) {
        if (!state.running) {
          state.error = null;
          console.log('[feishu] starting remote (via feishu command)...');
          try { await start(); } catch (e) { console.error('[feishu] 远程启动失败:', e.message); }
        }
        if (state.url && state.token) {
          return '公网链接：\n' + state.url + '/?token=' + state.token;
        }
        if (state.error) return '启动失败：' + state.error;
        return '正在获取链接，请稍候（隧道建立约 10~30 秒）…';
      }
      if (/^\/?(启动|start|开启)$/i.test(t)) {
        if (state.running) return '远程服务已在运行中';
        state.error = null;
        try { await start(); } catch (e) { console.error('[feishu] 远程启动失败:', e.message); }
        if (state.running) return '远程服务已启动';
        if (state.error) return '启动失败：' + state.error;
        return '正在启动，请稍候…';
      }
      if (/^\/?(停止|关闭远程|stop|停止远程)$/i.test(t)) {
        if (!state.running) return '远程服务未启动';
        stop();
        return '已停止远程服务';
      }
      if (/^\/?(监听|监控)$/i.test(t)) {
        feishuMonitorMode = !feishuMonitorMode;
        store.save({ monitor: { feishu: { enabled: feishuMonitorMode } } });
        if (feishuMonitorMode) { try { startMonitor(); } catch (e) { console.error('[feishu] startMonitor 失败:', e.message); } return '飞书监听已开启，再次发送 /监听 可关闭'; }
        else {
          if (!weixinMonitorMode) { try { stopMonitor(); } catch (e) { /* 定时器可能不存在，忽略 */ } }
          return '飞书监听已关闭';
        }
      }
      // 飞书此前连 /状态 都没有，这里补齐（与其他通道同款）
      if (/^\/?(状态|status)$/i.test(t)) {
        var fConn = (feishuToken && Date.now() < feishuToken.expireAt)
          ? '已连接'
          : (feishuWSClient ? '连接中' : '未连接');
        return '飞书通道状态：\n'
          + '• 连接：' + fConn + '\n'
          + '• 健康：' + (feishuHealth || 'ok') + (feishuFails ? ('（连续失败 ' + feishuFails + ' 次）') : '') + '\n'
          + '• 监听：' + (feishuMonitorMode ? '开' : '关') + '\n'
          + '• 选中会话：' + (st.selected ? '有' : '无') + '\n'
          + (feishuLastError ? '• 最近错误：' + feishuLastError : '');
      }
      // ── 以下与微信通道对齐（此前飞书缺这几项）──
      if (/^\/?(会话列表|会话|sessions)$/i.test(t)) return await cmdSessionList();
      const mSel = t.match(/^\/?选择[\s：:]*(\d+)$/);
      if (mSel) return await cmdSelectSession(st, mSel[1]);
      if (/^\/?(当前会话|current)$/i.test(t)) return await cmdCurrentSession(st);
      if (/^\/?(历史内容|历史|history)$/i.test(t)) return await cmdHistory(st);
      if (/^\/?(当前模型|模型|model)$/i.test(t)) return await cmdCurrentModel(st);
      if (/^\/?切换模型/.test(t)) return await cmdSwitchModel(st, t.replace(/^\/?切换模型/, ''));
      if (/^\/?选强度/.test(t)) return await cmdPickEffort(st, t.replace(/^\/?选强度/, ''));
      if (!/^\//.test(t)) return await cmdRelayToSession(st, t);
      return '未识别的命令，发送帮助查看可用命令。';
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
        store.save({ customPublicUrl: customPublicUrl });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, url: customPublicUrl }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    };
    try { customPublicUrl = store.load().customPublicUrl || null; } catch (e) { /* store.load 内部已兜底，此处不会触发 */ }
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/custom-url', handler: customUrlHandler }));

    const setPortHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const np = parseInt(data.port, 10);
        // kind 决定改的是哪个端口：'http' → 明文端口（免证书，局域网推荐）；
        // 其它/缺省 → 'https'（保持旧调用者行为不变）
        const kind = data.kind === 'http' ? 'http' : 'https';
        if (isNaN(np) || np < 1024 || np > 65535) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '端口无效（1024-65535）' }));
          return;
        }
        // HTTP 与 HTTPS 是两个独立监听，同一端口必然冲突 —— 提前拦下给明确提示
        const otherPort = kind === 'http' ? config.httpsPortStart : config.httpPortStart;
        if (np === otherPort) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '端口 ' + np + ' 已被另一个协议（' + (kind === 'http' ? 'HTTPS' : 'HTTP') + '）占用，请换一个' }));
          return;
        }
        const net = await import('node:net');
        const free = await new Promise(function (ok) { var s = net.createServer(); s.once('error', function () { ok(false); }); s.listen(np, '127.0.0.1', function () { s.close(function () { ok(true); }); }); });
        if (!free) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '端口 ' + np + ' 已被占用' }));
          return;
        }
        if (kind === 'http') {
          config.httpPortStart = np;
          config.httpPort = np;
          store.save({ customHttpPort: np });
        } else {
          config.httpsPortStart = np;
          config.httpsPort = np;
          store.save({ customPort: np });
        }
        if (state.running) { stop(); await start(); }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, port: np, kind: kind }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/set-port', handler: setPortHandler }));

    // ── 面板脚本注入：两条通道都挂，缺一不可 ──
    // ① 结构化注入行（官方推荐 API，dsh-client-shortcuts / dsh-client-connection 都是这么写的）
    //    宿主会把 rows 渲染进 index.html（served 形态），或随 boot payload 下发给
    //    **页面侧解释器**（静态部署形态 —— DSH 官方桌面版走这条）。
    // ② tapIndex 字符串变换（旧 API）：仅在 served 形态生效，作为老版本 DSH 的兜底。
    // 教训：只挂 tapIndex 时，`dsh web` 浏览器里一切正常，但**桌面版里脚本根本不执行**
    //       （devtools 里 document.getElementById('webrm-native') === null）。
    //       INJECT_SCRIPT 开头有 window.__webrmLoaded 守卫，两条通道同时生效也不会重复初始化。
    try {
      ctx.on('webserver/index-inject', (table) => {
        try {
          table.push({ kind: 'script', placement: 'body', text: INJECT_SCRIPT });
        } catch (e) { /* ignore */ }
      });
    } catch (e) {
      console.error('[dsh-web-remote] 注册 index-inject 失败（旧版 DSH？）:', e.message);
    }
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

    // 读取会话事件：兼容 DSH 新旧 API
    //  新版（dsH 0.1.2+）：session.snapshotEvents() 方法，已无 events 属性
    //  旧版：session.events 数组
    // 注意：用错 API 会静默拿到 undefined，导致监听等逻辑永不触发
    function sessionEvents(session) {
      if (!session) return [];
      try {
        if (typeof session.snapshotEvents === 'function') {
          const arr = session.snapshotEvents();
          if (Array.isArray(arr)) return arr;
        }
        if (Array.isArray(session.events)) return session.events;
      } catch (e) { /* fallthrough */ }
      return [];
    }

    // ====== 诊断端点：暴露监控实时内部状态（排查"监听没反应"用）======
    // GET /remote/diag —— 返回监控定时器状态、快照、agent 列表、最近通知与发送结果
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/diag', handler: async (req, res) => {
      var agentInfo;
      try {
        var lst = (agents && agents.list) ? agents.list() : [];
        agentInfo = lst.map(function (a) {
          return {
            id: (a && a.id) ? String(a.id).slice(0, 14) : '?',
            status: (a && a.status) || '?',
            hasSession: !!(a && a.session),
            events: sessionEvents(a && a.session).length,
          };
        });
      } catch (e) { agentInfo = 'ERR: ' + e.message; }
      var out = {
        ok: true,
        now: new Date().toLocaleString(),
        monitor: {
          timerAlive: !!weixinMonitorTimer,
          weixinMode: weixinMonitorMode,
          feishuMode: feishuMonitorMode,
          diagLogged: monitorDiagLogged,
          snapshots: weixinMonitorSnapshots,
          pendingCount: weixinPendingNotify.length,
          contextAgeMin: weixinLastContextAt ? Math.round((Date.now() - weixinLastContextAt) / 60000) : -1,
          lastNotifyAt: monitorLastNotifyAt ? new Date(monitorLastNotifyAt).toLocaleString() : '(从未触发)',
          lastNotifyTitle: monitorLastNotifyTitle,
          lastSendResult: monitorLastSendResult || '(无)',
        },
        weixin: { hasBotToken: !!weixinState.botToken, lastFromUserId: weixinState.lastFromUserId || '(无)' },
        feishu: { lastChatId: feishuLastChatId || '(无)' },
        agentsSeen: agentInfo,
      };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out, null, 2));
    }}));

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
    async function switchModel(provider, model, reasoningEffort, sessionId) {
      const sel = { provider, model };
      if (reasoningEffort !== undefined) sel.reasoningEffort = reasoningEffort;
      // sessionId 显式传入优先（各通道各自的选中会话）；不传时退回微信的选中会话，
      // 保持旧调用点（微信通道）行为不变。
      const target = sessionId || weixinSelectedSession;
      console.log('[dsh-weixin] switchModel called:', JSON.stringify(sel), 'session:', target);
      if (target) {
        try {
          const res = await callRpc('session.selectModel', { sessionId: target, ...sel });
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
      '· /状态 —— 查看监听通知状态（凭据/积压情况）\n' +
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
      const events = sessionEvents(agent.session);
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
          if (a && a.session) events = sessionEvents(a.session);
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

    // ══════════════════════════════════════════════════════════════════════
    // 跨通道共享指令
    //
    // 背景：微信通道最先做全（13 项），Telegram / QQ官方 / 飞书 只有 6~7 项，
    // 而且**只有微信能把普通消息转发进会话**（其他端只能被动收通知）。
    // 这里把会话/模型相关能力抽成公共函数，各通道传入自己的状态对象即可：
    //
    //   const st = { selected: null, pick: null };
    //   st.selected —— 该通道当前选中的目标会话 id
    //   st.pick     —— 多步选择（切换模型 → 选强度）的中间状态
    //
    // 注意：微信通道仍保留它自己的内联实现（它是基准，不动以免回归），
    // 两边逻辑一致；将来若要收敛，把微信那几段换成调用本组函数即可。
    // ══════════════════════════════════════════════════════════════════════

    /** 可见会话列表：过滤「已归档 / 子代理 / 不属于任何 workspace 的孤儿会话」 */
    async function visibleSessionRecords() {
      if (!sessionQuery) return null;
      const all = await sessionQuery.listSessions();
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
      return (all || []).filter(function (r) {
        if (archived && archived.has(r.header.id)) return false;
        if (r.header.origin === 'subagent' || (r.header.delegationDepth || 0) > 0) return false;
        if (knownSessions && !knownSessions.has(r.header.id)) return false;
        return true;
      });
    }

    async function cmdSessionList() {
      if (!sessionQuery) return '会话服务不可用';
      const list = await visibleSessionRecords();
      if (!list || list.length === 0) return '当前没有会话';
      const lines = [];
      for (let i = 0; i < list.length; i++) {
        const title = await getSessionTitle(list[i].header.id);
        lines.push((i + 1) + '. ' + (title || '(无标题)'));
      }
      return '会话列表：\n' + lines.join('\n') + '\n\n回复「/选择 N」切换目标会话';
    }

    async function cmdSelectSession(st, arg) {
      if (!sessionQuery) return '会话服务不可用';
      const list = await visibleSessionRecords();
      const idx = parseInt(String(arg || '').trim(), 10) - 1;
      if (list && list[idx]) {
        st.selected = list[idx].header.id;
        const title = await getSessionTitle(st.selected);
        return '已选择会话 ' + (idx + 1) + '：' + (title || '(无标题)');
      }
      return '编号无效，请先查看「/会话列表」';
    }

    async function cmdCurrentSession(st) {
      if (!st.selected) return '当前未选择会话，请先「/会话列表」并「/选择 N」';
      const title = await getSessionTitle(st.selected);
      return '当前选中会话：' + (title || String(st.selected));
    }

    async function cmdHistory(st) {
      if (!st.selected) return '当前未选择会话，请先「/会话列表」并「/选择 N」';
      const out = await getSessionLastOutput(st.selected);
      return out || '(该会话暂无输出)';
    }

    async function cmdCurrentModel(st) {
      // 优先查选中会话的模型
      if (st.selected) {
        try {
          const res = await callRpc('session.models', { sessionId: st.selected });
          const cur = res && res.body && res.body.result && res.body.result.ok ? res.body.result.value.current : null;
          if (cur) {
            return '会话模型：' + (cur.model || '(未设置)') + ' (' + (cur.provider || '?') + ')'
              + (cur.reasoningEffort ? '\n思考强度：' + cur.reasoningEffort : '');
          }
        } catch (e) { /* ignore */ }
      }
      if (!agentDefaultModel) return '模型服务不可用';
      const sel = agentDefaultModel.currentSelection();
      return '当前模型（全局默认）：' + (sel.model || '(未设置)') + ' (' + (sel.provider || '?') + ')'
        + (sel.reasoningEffort ? '\n思考强度：' + sel.reasoningEffort : '');
    }

    /** 多步切换模型：arg 为空 → 列出模型；arg 为数字 → 选中第 N 个（可能再进「选强度」） */
    async function cmdSwitchModel(st, arg) {
      const a = String(arg || '').trim();
      if (st.pick && st.pick.step === 'model' && /^\d+$/.test(a)) {
        const idx = parseInt(a, 10) - 1;
        const pick = st.pick;
        if (idx >= 0 && idx < pick.models.length) {
          const m = pick.models[idx];
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
            st.pick = { step: 'effort', provider: m.provider, model: m.id, efforts: efforts };
            return '已选择：' + m.name + ' (' + m.provider + ')\n思考强度：\n0. 默认\n' + effortLines.join('\n') + '\n回复「/选强度 N」选择';
          }
          await switchModel(m.provider, m.id, undefined, st.selected);
          st.pick = null;
          return '✅ 模型已切换：' + m.name + ' (' + m.provider + ')';
        }
        return '编号无效，请重新「/切换模型」查看列表';
      }
      // 第 1 步：列出所有模型
      if (!llm) return 'LLM 服务不可用';
      if (!agentDefaultModel) return '模型服务不可用';
      const cur = agentDefaultModel.currentSelection();
      const allModels = [];
      try {
        const providers = await llm.listProviders();
        for (const p of providers) {
          try {
            const models = await llm.listModels(p.id);
            for (const m of models) {
              allModels.push({ name: m.name || m.id, id: m.id, provider: p.id, reasoning: m.reasoning });
            }
          } catch (e) { /* skip provider */ }
        }
      } catch (e) { /* ignore */ }
      if (allModels.length === 0) return '未找到可用模型';
      const lines = allModels.map(function (m, i) {
        const isCurrent = m.provider === cur.provider && m.id === cur.model;
        return (i + 1) + '. ' + m.name + ' (' + m.provider + ')' + (isCurrent ? ' ← 当前' : '') + (m.reasoning ? ' ⚙' : '');
      });
      st.pick = { step: 'model', models: allModels };
      return '可用模型（⚙=支持思考强度）：\n' + lines.join('\n') + '\n\n回复「/切换模型 N」选择';
    }

    async function cmdPickEffort(st, arg) {
      if (!(st.pick && st.pick.step === 'effort')) return '请先「/切换模型」选择模型';
      const a = String(arg || '').trim();
      if (!/^\d+$/.test(a)) return '请回复数字编号，如「/选强度 2」';
      const idx = parseInt(a, 10);
      const pick = st.pick;
      let effort;
      if (idx === 0) effort = undefined;
      else if (idx >= 1 && idx <= pick.efforts.length) effort = pick.efforts[idx - 1].id;
      else return '编号无效，请选 0-' + pick.efforts.length;
      await switchModel(pick.provider, pick.model, effort, st.selected);
      st.pick = null;
      return '✅ 模型已切换：' + pick.model + ' (' + pick.provider + ')' + (effort ? ' / ' + effort : ' / 默认');
    }

    /** 非命令文本 → 转发进选中会话（与微信一致；未选会话时给出引导） */
    async function cmdRelayToSession(st, text) {
      if (!st.selected) return '请先在「/会话列表」中选择一个会话，再发送内容\n更多命令请发送「/帮助」获取';
      return await sendToSession(st.selected, text);
    }

    /** 各通道通用的帮助文本（channelName 形如「Telegram」） */
    function channelHelp(channelName) {
      return channelName + ' 机器人已在线，支持命令：\n'
        + '· /帮助 —— 显示本列表\n'
        + '· /链接 —— 查看远程链接（未启动会自动开启）\n'
        + '· /启动 / /停止 —— 启动、停止远程服务\n'
        + '· /监听 —— 开关监听模式（会话思考完毕自动通知）\n'
        + '· /状态 —— 查看通道状态\n'
        + '· /会话列表 —— 列出所有会话\n'
        + '· /选择 N —— 选中第 N 个会话\n'
        + '· /当前会话 —— 查看选中的会话名称\n'
        + '· /历史内容 —— 查看选中会话最近一次输出\n'
        + '· /当前模型 —— 查看当前使用的模型\n'
        + '· /切换模型 —— 列出所有模型并切换\n'
        + '· 直接发送内容（无需前缀）—— 发送到选中的会话\n'
        + '· 未选择会话时，先 /会话列表 再 /选择 N';
    }

    // 监听模式
    function startMonitor() {
      // 幂等：先清理已有定时器，避免 /监听 关→开 等路径重复创建监控循环（导致重复通知）
      if (weixinMonitorTimer) { clearInterval(weixinMonitorTimer); weixinMonitorTimer = null; }
      weixinMonitorSnapshots = {};
      weixinMonitorTimer = setInterval(async function () {
        if (!weixinMonitorMode && !feishuMonitorMode) { stopMonitor(); return; }
        if (!agents) { return; }
        try {
          var agentList = [];
          if (agents.list) agentList = agents.list();
          else if (agents._agents) agentList = Array.from(agents._agents.values());
          if (!agentList || !agentList.length) return;
          // 一次性诊断：确认监控能看到 agent 及其状态/事件数（排查"监听没反应"用）
          if (!monitorDiagLogged) {
            monitorDiagLogged = true;
            var _diag = agentList.map(function (a) {
              var sid = (a && a.session && a.session.header && a.session.header.id) ? String(a.session.header.id).slice(0, 10) : '?';
              return sid + ':' + (a && a.status) + '(' + sessionEvents(a && a.session).length + 'ev)';
            });
            console.log('[dsh-weixin] monitor 诊断：看到 ' + agentList.length + ' 个 agent -> ' + _diag.join(', '));
          }
          for (var i = 0; i < agentList.length; i++) {
            var a = agentList[i];
            if (!a || !a.session) continue;
            var aid = a.session.header && a.session.header.id ? a.session.header.id : String(i);
            var snap = weixinMonitorSnapshots[aid] || { wasRunning: false, eventsLen: 0 };
            var evts = sessionEvents(a.session);
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
                      try { var _tr = await sessionQuery.readTitle(aid); sessTitle = (typeof _tr === 'string') ? _tr : (_tr && _tr.title) ? _tr.title : ''; } catch (e2) { console.error('[monitor] 读取会话标题失败:', e2.message); }
                    }
                    if (!sessTitle) sessTitle = aid.slice(0, 12);
                    weixinMonitorTitles[aid] = sessTitle;
                    var text = '【' + sessTitle + '】思考完毕：\n' + parts.join('');
                    if (text.length > 1900) text = text.slice(0, 1900) + '…';
                    // 按各自通道开关发送通知
                    monitorLastNotifyAt = Date.now();
                    monitorLastNotifyTitle = sessTitle;
                    if (weixinMonitorMode && weixinState.botToken && weixinState.lastFromUserId) {
                      // 先试后队：不预判 token 年龄，直接尝试发送；只有服务端真实返回失败才入队
                      // （iLink 对过期 context_token 返回 ret:-2 "prepare failed"，由 iLinkParse 抛出）
                      var ctxAgeTxt = weixinLastContextAt ? (Math.round((Date.now() - weixinLastContextAt) / 60000) + ' 分钟') : '本会话无来信';
                      weixinSendMsg(weixinState.botToken, weixinState.lastFromUserId, text, weixinState.lastContextToken || '').then(function () {
                        monitorLastSendResult = 'weixin 已发送 @' + new Date().toLocaleTimeString();
                        console.log('[dsh-weixin] 通知已发送（凭据年龄 ' + ctxAgeTxt + '）');
                      }).catch(function (e) {
                        weixinPendingNotify.push(text);
                        monitorLastSendResult = 'weixin 失败入队: ' + e.message + ' @' + new Date().toLocaleTimeString();
                        console.log('[dsh-weixin] 通知入队（发送失败: ' + e.message + '；凭据年龄 ' + ctxAgeTxt + '；积压 ' + weixinPendingNotify.length + ' 条）');
                      });
                    } else {
                      monitorLastSendResult = 'weixin 跳过（监听' + (weixinMonitorMode ? '开' : '关') + ' token' + (weixinState.botToken ? '有' : '无') + ' userId' + (weixinState.lastFromUserId ? '有' : '无') + '）';
                    }
                    if (feishuMonitorMode && feishuLastChatId) {
                      feishuSendText(feishuLastChatId, text).then(function () {
                        monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'feishu 已发送 @' + new Date().toLocaleTimeString();
                        console.log('[feishu] 通知已发送');
                      }).catch(function (e) {
                        monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'feishu 失败: ' + e.message;
                        console.error('[feishu] monitor send failed:', e.message);
                      });
                    }
                    if (telegramMonitorMode && telegramChannel && telegramLastChatId && telegramChannel.status().health !== 'down') {
                      telegramChannel.send(telegramLastChatId, text).then(function () {
                        monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'telegram 已发送 @' + new Date().toLocaleTimeString();
                        console.log('[telegram] 通知已发送');
                      }).catch(function (e) {
                        monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'telegram 失败: ' + e.message;
                        console.error('[telegram] monitor send failed:', e.message);
                      });
                    }
                    if (qqbotMonitorMode && qqbotChannel && qqbotChannel.status().health !== 'down') {
                      var qqTarget = qqbotChannel.getLastTarget();
                      if (qqTarget) {
                        qqbotChannel.send(qqTarget, text).then(function () {
                          monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'qqbot 已发送 @' + new Date().toLocaleTimeString();
                          console.log('[qqbot] 通知已发送');
                        }).catch(function (e) {
                          monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'qqbot 失败: ' + e.message;
                          console.error('[qqbot] monitor send failed:', e.message);
                        });
                      }
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
        if (/^\/停止远程$/.test(t) || /^\/关闭远程$/.test(t)) { stop(); return '已停止远程服务'; }
        // /监听
        if (/^\/监听$/.test(t) || /^\/监控$/.test(t)) {
          weixinMonitorMode = !weixinMonitorMode;
          store.save({ monitor: { weixin: { enabled: weixinMonitorMode, userId: weixinState.lastFromUserId || '', contextToken: weixinState.lastContextToken || '' } } });
          if (weixinMonitorMode) {
            startMonitor();
            return '监听模式已开启，会话思考完毕会自动通知你。再次发送 /监听 可关闭';
          } else {
            if (!feishuMonitorMode) { stopMonitor(); }
            return '监听模式已关闭';
          }
        }
        // /状态
        if (/^\/状态$/.test(t) || /^\/status$/i.test(t)) {
          var ageTxt = weixinLastStaleMin < 0 ? '\u672c\u4f1a\u8bdd\u5c1a\u65e0\u5fae\u4fe1\u6d88\u606f' : (weixinLastStaleMin === 0 ? '\u65b0\u9c9c\uff08<1\u5206\u949f\u524d\uff09' : '\u4e0a\u6b21\u6d88\u606f\u4e8e ' + weixinLastStaleMin + ' \u5206\u949f\u524d');
          var qTxt = weixinLastFlushedCount > 0 ? ('\u4e0a\u6b21\u8865\u53d1 ' + weixinLastFlushedCount + ' \u6761') : '\u65e0\u79ef\u538b';
          return '\u5fae\u4fe1\u76d1\u542c\u72b6\u6001\uff1a\n\u00b7 \u51ed\u636e\uff1a' + ageTxt + '\n\u00b7 \u79ef\u538b\uff1a' + qTxt + '\uff08\u5f53\u524d\u5f85\u53d1 ' + weixinPendingNotify.length + ' \u6761\uff09\n\u00b7 \u76d1\u542c\uff1a\u5fae\u4fe1' + (weixinMonitorMode ? '\u5f00' : '\u5173') + ' / \u98de\u4e66' + (feishuMonitorMode ? '\u5f00' : '\u5173');
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
            var md = store.load().monitor || {};
            if (md.weixin && md.weixin.enabled) {
              weixinMonitorMode = true;
              weixinState.lastFromUserId = md.weixin.userId || '';
              weixinState.lastContextToken = md.weixin.contextToken || '';
              startMonitor();
              weixinSendMsg(weixinState.botToken, weixinState.lastFromUserId, 'DSH已启动，任务监听中', weixinState.lastContextToken).then(function () {
                console.log('[dsh-weixin] 启动通知已发送');
              }).catch(function (e) {
                // 启动时凭据常已过期：入队，等用户下次来信后补发
                weixinPendingNotify.push('DSH已启动，任务监听中');
                console.log('[dsh-weixin] 启动通知入队（发送失败: ' + (e.message || e) + '；积压 ' + weixinPendingNotify.length + ' 条）');
              });
              console.log('[dsh-weixin] monitor auto-restored');
            }
          } catch (e) { console.error('[dsh-weixin] monitor restore error:', e.message || e); }
        }, 3000);
      }
    } catch (e) { console.error('[dsh-weixin] startup restore error:', e.message || e); }
    // 飞书独立启动逻辑（不依赖微信）
    setTimeout(function () {
      try {
        var md = store.load().monitor || {};
        // 微信监听未随 token 恢复时（无微信 token 场景），此处兜底恢复
        if (md.weixin && md.weixin.enabled && !weixinMonitorMode) {
          weixinMonitorMode = true;
          weixinState.lastFromUserId = md.weixin.userId || '';
          weixinState.lastContextToken = md.weixin.contextToken || '';
          startMonitor();
        }
        // 飞书监听恢复
        if (md.feishu && md.feishu.enabled) {
          feishuMonitorMode = true;
          console.log('[feishu] monitor auto-restored');
        }
        // 如果有飞书配置，自动启动 WebSocket
        var fCfg = feishuLoadConfig();
        if (fCfg && fCfg.appId && fCfg.appSecret && !feishuWSClient) {
          feishuStartWS().catch(function (e) { console.error('[feishu] auto WS start failed:', e.message); });
        }
        // 恢复最后的飞书 chatId（统一存储）
        if (!feishuLastChatId) {
          feishuLastChatId = (store.load().feishu || {}).lastChatId || '';
        }
        console.log('[feishu] startup: monitor=', feishuMonitorMode, 'chatId=', feishuLastChatId ? feishuLastChatId.slice(0, 12) + '…' : '(none)');
        // 仅在飞书监听开启时发启动通知
        if (feishuMonitorMode && feishuLastChatId) {
          feishuSendText(feishuLastChatId, 'DSH已启动，任务监听中').catch(function (e) { console.error('[feishu] startup notify failed:', e.message || e); });
        }
      } catch (e) { console.error('[feishu] startup error:', e.message); }
    }, 5000);
    // Telegram（小飞机）启动：有 token 就自动连（长轮询在后台跑）
    setTimeout(function () {
      try {
        var tc = telegramLoadConfig();
        if (!tc.botToken) { console.log('[telegram] 未配置 Bot Token，跳过'); return; }
        telegramToken = tc.botToken;
        telegramProxyUrl = tc.proxyUrl;
        telegramApiBase = tc.apiBase;
        telegramLastChatId = tc.lastChatId || null;
        // 监听开关持久化在 store.telegram.monitor
        telegramMonitorMode = !!(store.load().telegram || {}).monitor;
        telegramStart().then(function (st) {
          console.log('[telegram] 已连接 @' + (st.me ? st.me.username : '?') + '（代理 ' + st.proxy + '，监听 ' + (telegramMonitorMode ? '开' : '关') + '）');
          if (telegramMonitorMode && telegramLastChatId) {
            telegramChannel.send(telegramLastChatId, 'DSH已启动，任务监听中').then(function () {
              console.log('[telegram] 启动通知已发送');
            }).catch(function (e) { console.error('[telegram] 启动通知失败:', e.message); });
          }
        }).catch(function (e) {
          console.error('[telegram] 自动连接失败:', e.message);
        });
      } catch (e) { console.error('[telegram] startup error:', e.message); }
    }, 6000);
    // QQ 官方机器人启动：有凭据就自动连（WebSocket 长连接，7 秒后起，错开其它通道）
    setTimeout(function () {
      try {
        var qc = qqbotLoadConfig();
        if (!qc.appId || !qc.appSecret) { console.log('[qqbot] 未配置 AppID/AppSecret，跳过'); return; }
        qqbotAppId = qc.appId;
        qqbotMonitorMode = !!qc.monitor;
        qqbotStart().then(function (st) {
          qqbotRestoreTarget(); // 重启后恢复上次的推送目标，无需再发消息
          console.log('[qqbot] 已连接（AppID ' + qqbotAppId + '，监听 ' + (qqbotMonitorMode ? '开' : '关') + '）');
          if (qqbotMonitorMode) {
            var t = qqbotChannel ? qqbotChannel.getLastTarget() : null;
            if (t) {
              qqbotChannel.send(t, 'DSH已启动，任务监听中').then(function () {
                console.log('[qqbot] 启动通知已发送');
              }).catch(function (e) { console.error('[qqbot] 启动通知失败:', e.message); });
            } else {
              console.log('[qqbot] 尚无会话目标，启动通知跳过（给机器人发一条消息后会记录）');
            }
          }
        }).catch(function (e) {
          console.error('[qqbot] 自动连接失败:', e.message);
        });
      } catch (e) { console.error('[qqbot] startup error:', e.message); }
    }, 7000);
  }

  ctx.effect(() => () => {
    if (tunnelHandle) { try { tunnelHandle.terminate(); } catch (e) { /* ignore */ } }
    if (proxy) { try { proxy.close(); } catch (e) { /* ignore */ } }
    if (qqServer) { try { qqServer.close(); } catch (e) { /* ignore */ } }
    telegramStop();
    qqbotStop();
    qqbotQrCleanup();
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
