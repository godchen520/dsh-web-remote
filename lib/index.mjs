// dsh-web-remote — DSH 手机/外网远程访问插件（可分发版）
//
// 功能：
//   · 局域网直连：HTTP(3081) + HTTPS(3082，自动生成自签名证书) 反向代理
//   · 公网访问：Cloudflare Quick Tunnel（cloudflared 缺失时自动下载）
//   · token 鉴权 + gzip 压缩 + WebSocket 升级转发
//   · 常驻手机图标面板（公网/局域网切换、复制、二维码、启动/停止/刷新）
//
// 配置项（cordis.patch.yml 的 config 字段，均可省略）：
//   targetPort      DSH 自身端口               默认 3080
//   httpPortStart   代理 HTTP 起始端口         默认 3081
//   httpsPortStart  代理 HTTPS 起始端口        默认 3082
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
import { createTelegramChannel } from './telegram.mjs';
import { createQQBotChannel } from './qqbot.mjs';
import { createDingTalkChannel } from './dingtalk.mjs';
import { downloadCloudflared, downloadFile } from './download.mjs';
import { INJECT_SCRIPT } from './panel.mjs';
import { createTailscaleProbe, isTailscaleIp, p2pState } from './tailscale.mjs';

// 面板标题上显示的版本号：**运行时读同包上一级的 package.json**，读不到才退回兜底常量。
// 这样发版只改 package.json 一处，徽标自动跟随（宿主重启后生效），不需要记得改两处。
// 部署副本（node_modules/dsh-web-remote）里一定带 package.json，所以正常路径永远读到；
// 兜底常量只在极端情况（被裁掉 package.json）生效；它不参与一致性校验，
// 发版时忘了同步它也不会报错（守卫 #21 只要求它"看起来是个版本号"）。
const PLUGIN_VERSION_FALLBACK = '5.2.0';
function resolvePluginVersion() {
  try {
    const pj = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
    if (pj && typeof pj.version === 'string' && pj.version.trim()) return pj.version.trim();
  } catch (e) { /* 读不到就用兜底常量 */ }
  return PLUGIN_VERSION_FALLBACK;
}
/** 已解析的插件版本号（测试直接 import 这个值来验证"自动跟随 package.json"） */
export const PLUGIN_VERSION = resolvePluginVersion();

/**
 * 是否是 Tailscale / CGNAT 段（100.64.0.0/10）的本机地址。
 * 实现已挪到 tailscale.mjs（那边还要用它解析 status --json），这里只做转发，
 * 免得两处口径漂移；面板 P2P 分页也用它。
 */
export const isTailscaleRange = isTailscaleIp;





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

  const state = { running: false, starting: false, url: null, token: null, port: null, httpsPort: null, ips: [], error: null, updatedAt: null };
  let proxy = null;
  let tunnelHandle = null;

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

  // Tailscale 状态探测：面板要显示「开没开 / 手机在不在线 / 直连还是中继（哪个节点）」。
  // 20 秒缓存 + 后台刷新，snapshot() 永不阻塞；CLI 找不到时退回网卡判断。
  const tailscaleProbe = createTailscaleProbe({
    subprocess,
    spec,
    ips: () => lanIPs(),
    log: (m, e) => console.error('[dsh-web-remote]', m, e || ''),
  });
  ctx.effect(() => {
    tailscaleProbe.start();
    return () => tailscaleProbe.stop();
  });

  const stop = () => {
    if (tunnelHandle) { try { tunnelHandle.terminate(); } catch (e) { /* ignore */ } }
    tunnelHandle = null;
    if (proxy) { proxy.close(); proxy = null; }
    state.running = false;
    state.url = null;
    state.token = null;
    state.port = null;
    state.httpsPort = null;
    state.ips = [];
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
  // 注：原先有个 weixinFollowup（链接后单独补发第二条提示）。已删除 ——
  // 它让「微信收到 2 条、其它通道 1 条」，用户判定为不统一；
  // 现在提示都并进 linkCommandText() 正文，5 个通道一条消息、同样的文字。
  let weixinMonitorMode = false;
  let feishuMonitorMode = false;
  let feishuLastChatId = '';
  // 飞书监听跳过的原因（去重用的）：没配凭证时每轮都会跳过，
  // 只在原因变化时打一次日志，别刷屏
  let feishuMonitorSkipLogged = '';
  // QQ 群主动推送被拒（40034105）只详细说明一次，别每轮刷屏
  let qqbotGroupDeniedLogged = false;
  let weixinLastContextAt = 0;   // 上次微信消息到达时间（context_token 新鲜度）
  let weixinLastStaleMin = -1;   // 本次消息前凭据年龄（供 /状态 展示，-1=本会话尚无微信消息）
  let weixinLastFlushedCount = 0; // 本次消息前补发的积压条数
  // 凭据过期时排队的监听通知（元素为 { text, at }），来信后合并补发。
  // iLink 强制要求有效 context_token（实测不带/过期都 ret:-2 prepare failed，
  // 也探过 12 个候选端点找免凭据推送通道，全部 404），所以用户长时间不说话时
  // 推送物理上做不到 —— 只能排队，并在超过 TTL 后丢弃。
  let weixinPendingNotify = [];
  let weixinDroppedNotify = 0;    // 累计丢弃的过期通知条数（/状态 里显示，不藏）
  let weixinMonitorTimer = null;
  let weixinMonitorSnapshots = {}; // { agentId: { eventsLen, wasRunning } }
  let weixinMonitorTitles = {}; // { agentId: title }
  let monitorDiagLogged = false; // 首次轮询打印一次诊断（agent 数量/状态/事件数）
  let monitorLastNotifyAt = 0;    // 最后一次触发通知的时间
  let monitorLastNotifyTitle = '';// 最后一次通知的会话标题
  let monitorLastSendResult = ''; // 最后一次发送结果（供 /remote/diag 排查）
  // 最近 5 轮通知的各通道发送结果。各通道是异步回报的，只留"最后一条"会被
  // 下一轮的微信分支覆盖、或干脆被没推的轮次抹掉，排查时看不到真相（踩过）。
  let monitorSendHistory = [];
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

  // ====== 钉钉机器人（Stream 模式长连接，走 dingtalk.mjs）======
  // 与飞书/QQ官方不同：机器人消息是 CALLBACK 类型，且 CALLBACK 不自动 ACK，
  // 这些都在通道模块内处理（见 lib/dingtalk.mjs 顶部注释）。
  let dingtalkChannel = null;              // createDingTalkChannel 实例
  let dingtalkMonitorMode = false;         // 监听通知是否推送到钉钉
  let dingtalkAppKey = '';                 // AppKey（ClientID；AppSecret 只存通道闭包与 store）
  // 同样必须在模块作用域：销毁清理会调用它
  function dingtalkStop() {
    if (dingtalkChannel) { try { dingtalkChannel.stop(); } catch (e) { /* ignore */ } }
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

    // ===== 收消息队列：把「收」和「干」拆开 =====
    //
    // 以前收消息和处理消息写在同一个 while 循环里且串行 await：
    //   收到 A →（await 会话跑完，可能几十秒）→ 回复 A → 才回去拉下一条
    // 三个后果：
    //   1. 会话思考期间**完全不再拉取新消息** —— 用户感觉"接收消息很慢"，
    //      其实不是网慢，是它腾不出手；
    //   2. 连着发几条要挨个等一遍；
    //   3. 每条消息自带的 context_token 有有效期。等得越久越可能过期，
    //      发送时报 iLink "prepare failed"，只能入队积压 ——
    //      用户长期以为的"微信接口休眠/挤压消息"，根子在这儿。
    //
    // 现在：收到就入队，另一个消费者按顺序慢慢处理，互不阻塞。
    // （回执不在这里发 —— 由 handleWeixinCommand 进入会话前发，见那里的注释）
    var weixinInbox = [];
    var weixinInboxRunning = false;

    /**
     * 补发积压的监听通知。
     *
     * ⚠ 为什么必须「合并 + 过期丢弃」，而不是逐条排队补发：
     *
     * iLink **强制要求有效的 context_token**（实测：不带 token 与带过期 token 都返回
     * ret:-2 "prepare failed"；也探过 12 个候选端点想找免凭据的推送通道，全部 404）。
     * 而 context_token 只能从"用户刚发来的消息"里获得 —— 等价于客服消息窗口。
     *
     * 于是：**用户长时间不说话时，主动推送在物理上做不到**。
     * 旧实现把每条通知都排进队列、等你下次来信逐条补发，结果：
     *   1. 队列无上限，你离开越久积压越多；
     *   2. 你回来后收到一串几小时前的"某会话已完成"，全是过期信息；
     *   3. 补发到第 k 条失败时后面全部重新入队，可能反复卡住。
     *
     * 现在：先丢掉超过 PENDING_TTL_MS 的（过期通知没有价值），剩下的**合并成一条**发送。
     * 丢弃数量记进 weixinDroppedNotify 并在 /状态 里显示 —— 不藏。
     */
    var PENDING_TTL_MS = 10 * 60 * 1000;   // 超过 10 分钟的通知不再补发

    async function weixinFlushPending() {
      if (weixinPendingNotify.length === 0) return;
      if (!weixinState.lastContextToken) return;

      var now = Date.now();
      var kept = [];
      var dropped = 0;
      for (var i = 0; i < weixinPendingNotify.length; i++) {
        var it = weixinPendingNotify[i];
        // 兼容旧格式（纯字符串，无时间戳）：当作刚入队，不丢
        var at = (it && typeof it === 'object' && it.at) ? it.at : now;
        var txt = (it && typeof it === 'object') ? it.text : it;
        if (now - at > PENDING_TTL_MS) { dropped++; continue; }
        kept.push({ text: txt, at: at });
      }
      weixinPendingNotify = [];
      if (dropped > 0) {
        weixinDroppedNotify += dropped;
        console.log('[dsh-weixin] 丢弃 ' + dropped + ' 条过期通知（超过 ' + (PENDING_TTL_MS / 60000) + ' 分钟，补发已无意义；累计丢弃 ' + weixinDroppedNotify + ' 条）');
      }
      if (kept.length === 0) return;

      // 合并成一条：N 条通知不该变成 N 条消息（那也是另一种"积压"）
      var text = kept.length === 1
        ? kept[0].text
        : ('（合并 ' + kept.length + ' 条通知）\n\n' + kept.map(function (k) { return k.text; }).join('\n\n'));
      if (text.length > 1900) text = text.slice(0, 1900) + '…';

      try {
        await weixinSendMsg(weixinState.botToken, weixinState.lastFromUserId, text, weixinState.lastContextToken || '');
        weixinLastFlushedCount = kept.length;
        console.log('[dsh-weixin] 补发 ' + kept.length + ' 条通知（合并为 1 条消息）');
      } catch (e) {
        // 失败：未过期的放回队列，等下次来信再试
        weixinPendingNotify = kept.concat(weixinPendingNotify);
        console.error('[dsh-weixin] 补发失败，已重新入队 ' + kept.length + ' 条:', e.message);
      }
    }

    /** 消费者：按到达顺序逐条处理，永远不与"收消息"抢同一个循环 */
    async function weixinDrainInbox() {
      if (weixinInboxRunning) return;
      weixinInboxRunning = true;
      try {
        await weixinFlushPending();
        while (weixinInbox.length > 0) {
          var item = weixinInbox.shift();
          var reply;
          try {
            weixinActiveSend = { botToken: weixinState.botToken, toUserId: item.fromUserId, contextToken: item.contextToken };
            try {
              if (weixinGenerateReply) {
                reply = await weixinGenerateReply(item.text);
              } else {
                reply = '[回声] ' + item.text;
              }
            } catch (e) {
              console.error('[dsh-weixin] AI error:', e.message || e);
              reply = '[AI 回复失败: ' + String(e.message || e).slice(0, 100) + ']';
            } finally {
              weixinActiveSend = null;
            }
            // iLink 文本消息有长度限制，超长截断
            if (reply.length > 2000) reply = reply.slice(0, 2000) + '…';
            await weixinSendMsg(weixinState.botToken, item.fromUserId, reply, item.contextToken);
            console.log('[dsh-weixin] replied:', reply.slice(0, 100));
          } catch (e) {
            // 单条失败不能拖垮整个队列
            console.error('[dsh-weixin] 处理消息失败:', e.message || e);
          }
        }
      } finally {
        weixinInboxRunning = false;
      }
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
                weixinState.lastFromUserId = msg.from_user_id;
                // 记录本次消息前的凭据年龄与积压数（供 /状态 展示）
                weixinLastStaleMin = weixinLastContextAt ? Math.round((Date.now() - weixinLastContextAt) / 60000) : -1;
                weixinLastFlushedCount = weixinPendingNotify.length;
                weixinState.lastContextToken = msg.context_token;
                weixinLastContextAt = Date.now();
                // 注意：这里**不发回执** —— 回执由 handleWeixinCommand 进入会话前发
                // （「已收到指令，AI 思考中，请稍等…」），措辞与时机都更准。
                // 早先这里也发了一条「已收到，正在处理…」，用户收到两条回执（踩过），
                // 别再加回来 —— 测试守卫 #29 会拦。
                // 入队就完事，立刻回去拉下一批（这里绝不 await 会话工作）
                weixinInbox.push({
                  text: userText,
                  fromUserId: msg.from_user_id,
                  contextToken: msg.context_token,
                  at: Date.now()
                });
              }
            }
          }
          weixinDrainInbox();
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
    var dt = null;
    try { dt = dingtalkChannel ? dingtalkChannel.status() : null; } catch (e) { /* ignore */ }
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
      dingtalk: {
        state: dt ? dt.health : 'ok',
        fails: dt ? dt.fails : 0,
        error: dt ? (dt.lastError || '') : '',
        kind: dt ? (dt.lastErrorKind || '') : '',
      },
    };
    var downList = [];
    if (h.weixin.state === 'down') downList.push('weixin');
    if (h.feishu.state === 'down') downList.push('feishu');
    if (h.telegram.state === 'down') downList.push('telegram');
    if (h.qqbot.state === 'down') downList.push('qqbot');
    if (h.dingtalk.state === 'down') downList.push('dingtalk');
    h.anyDown = downList.length > 0;
    h.downList = downList;
    return h;
  }

  // 窄屏界面偏好：收起侧边栏后是否把图标栏也去掉，只留一个浮动展开把手。
  //
  // 为什么需要这个：DSH 的 AppFrame 用三列网格，收起态把侧边栏轨道固定设为 56px
  // （dsh-client-ui-layout: collapsedWidth = darwin/窗口标题栏 ? 0 : 56）。
  // 手机上这 56px 就是白占的一条竖栏。桌面端（darwin/窗口标题栏）本来就是 0，
  // 所以这里只针对窄屏补上同样的行为。
  //
  // 默认开（用户要求手机端默认开）；只作用于窄屏 + 收起态，宽屏与展开态一律不碰。
  const DEFAULT_MOBILE_RAIL_HIDDEN = true;
  const mobileRailHidden = () => {
    try {
      const ui = store.load().ui || {};
      return ui.mobileRailHidden === undefined ? DEFAULT_MOBILE_RAIL_HIDDEN : !!ui.mobileRailHidden;
    } catch (e) { return DEFAULT_MOBILE_RAIL_HIDDEN; }
  };

  // 浏览器端量到的窄屏判定一次回报（只用于诊断，不参与决策）。
  // 存内存即可：重启就清空，正好对应"这次加载量到了什么"。
  let railDebug = null;

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
    var dingtalkSt = null;
    try {
      var dc = store.load().dingtalk || {};
      if (dingtalkChannel && dingtalkChannel.status().running) dingtalkSt = 'connected';
      else if (dc.appKey) dingtalkSt = 'configured';
    } catch (e) { /* ignore */ }
    return { running: state.running, url: state.url, token: state.token, port: state.port, httpsPort: state.httpsPort, ips: currentIps(), version: PLUGIN_VERSION, weixin: weixinState.status, error: state.error, lanOpen: config.lanOpen, tailscale: tailscaleProbe.snapshot(), feishu: feishuSt, telegram: telegramSt, telegramMonitor: telegramMonitorMode, qqbot: qqbotSt, qqbotMonitor: qqbotMonitorMode, qqbotAppId: (qqbotAppId || (store.load().qqbot || {}).appId || ''), dingtalk: dingtalkSt, dingtalkMonitor: dingtalkMonitorMode, dingtalkAppKey: (dingtalkAppKey || (store.load().dingtalk || {}).appKey || ''), health: channelHealthSnapshot(), targetPort: config.targetPort, portSource: config.portSource, mobileRailHidden: mobileRailHidden(), railDebug: railDebug };
  };

  /**
   * 当前可用的本机地址列表（每次取状态时重算）。
   * 启动时抓一次是不够的：Tailscale 这类网卡常常是宿主起来之后才出现，
   * 只抓一次的话用户得重启才看得到 P2P 链接（实测踩到）。
   * 排序：把 Tailscale/CGNAT（100.64.0.0/10）放到最后 —— 面板二维码取 ips[0]，
   * 优先给"同 Wi-Fi 直连"那条，免得手机上没开 Tailscale 时扫码打不开。
   */
  function currentIps() {
    // 没在运行时返回 state.ips（stop() 会清空）——
    // 否则停止后面板还会列出一堆"点了也打不开"的链接，而不是"尚未启动"。
    if (!state.running) return state.ips;
    try {
      const list = lanIPs();
      if (list && list.length) {
        const normal = [];
        const p2p = [];
        for (const ip of list) (isTailscaleRange(ip) ? p2p : normal).push(ip);
        return normal.concat(p2p);
      }
    } catch (e) { /* 取不到就退回启动时那份 */ }
    return state.ips;
  }

  if (webServer) {
    /**
     * P2P（Tailscale）访问链接 + 未打通原因。
     * 判定在 tailscale.mjs 的 p2pState 里（纯函数，守卫 #25 有真值表）——
     * 其中包含**手机端有没有开 Tailscale**（读 peer 的 Online）。
     */
    function p2pStateNow() {
      try {
        return p2pState(currentIps(), tailscaleProbe.snapshot(), {
          port: state.port,
          lanOpen: config.lanOpen,
          token: state.token,
        });
      } catch (e) { return { url: null, reason: '检测失败' }; }
    }

    function p2pLinkUrl() {
      return p2pStateNow().url;
    }

    /**
     * `/链接` 回复里的提示（两条都写进正文，5 个通道**完全一致**）。
     *
     * ① 手机字号：**这条以前是让用户自己去缩放页面**，因为插件当时在窄屏注入了
     *    `html{zoom:80%}`。那条 zoom 已删除（它会把 vw 打坏，详见 CHANGELOG
     *    5.7.1-dev.3 / dev.5），所以提示改成走官方设置：
     *    「设置 → 通用设置 → 字号大小」（dsh-client-ui-theme 的 `fontSize.title`，
     *    源码注释确认它注册在 General section 的 item slot 里）。
     * ② 内置浏览器：微信/QQ/钉钉/飞书 的内置浏览器打开外链时可能丢掉 `?token=`
     *    参数（实测微信必然丢，会直接验证失败），所以统一提示「复制链接到
     *    系统浏览器打开」。
     *
     * 历史：②原先只有微信有，且是用 followup 单独发第二条消息 ——
     * 结果用户看到「微信 2 条、其它通道 1 条」，判定为不统一。
     * 现在两条都并进正文，所有通道一条消息、同样的文字。
     */
    const LINK_MOBILE_HINT = '[想要更舒服的字号，可在「设置 → 通用设置」里调整「字号大小」]';
    const LINK_BROWSER_HINT = '[内置浏览器打开可能丢失验证信息，建议复制链接用系统浏览器打开]';

    /**
     * `/链接` 命令的回复：提示 + 公网隧道链接 + P2P 链接。
     * P2P 没打通就写「p2p未打通」，能判断出原因时附在括号里
     * （例如「p2p未打通（手机端未开 Tailscale）」）—— 不要给一个点了打不开的地址。
     *
     * **无参数**：5 个通道的提示与正文完全相同，不需要各传各的。
     */
    function linkCommandText() {
      const pub = (state.url && state.token) ? (state.url + '/?token=' + state.token) : '隧道未建立';
      const p2p = p2pStateNow();
      const p2pText = p2p.url || ('p2p未打通' + (p2p.reason ? '（' + p2p.reason + '）' : ''));
      return LINK_MOBILE_HINT + '\n' + LINK_BROWSER_HINT
        + '\n公网链接：\n' + pub
        + '\n\nP2P 链接：\n' + p2pText;
    }

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
    // 界面偏好：窄屏收起态是否隐藏图标栏（默认开）。面板/脚本都可用来切换。
    const uiHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      let patch = null;
      try { patch = JSON.parse(body); } catch (e) { /* ignore */ }
      if (!patch || typeof patch.mobileRailHidden !== 'boolean') {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'expected { mobileRailHidden: boolean }' }));
        return;
      }
      store.save({ ui: { mobileRailHidden: patch.mobileRailHidden } });
      console.log('[dsh-web-remote] mobileRailHidden =', patch.mobileRailHidden);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(snapshot()));
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/ui', handler: uiHandler }));
    // 诊断：浏览器端把窄屏判定量到的真实数值回报过来，之后在 /remote/info 的 railDebug 里看。
    // 保留最近若干条（一次页面加载会发「首次」和「稳态」两条，两条对比才知道是不是被 React 写回去了）。
    const railReportHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      let entry;
      try { entry = JSON.parse(body); }
      catch (e) { entry = { parseError: String(e && e.message || e) }; }
      railDebug = (railDebug || []).concat([entry]).slice(-6);
      console.log('[dsh-web-remote] rail report:', JSON.stringify(entry));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true }));
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/railreport', handler: railReportHandler }));
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
    const telegramCmdState = { channel: 'telegram', selected: null, pick: null };
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
        if (state.url && state.token) return linkCommandText();
        // 隧道还没建好但 P2P 通了 → 也把链接给出去（P2P 那半照样有用）
        if (p2pLinkUrl()) return linkCommandText();
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
        if (!anyMonitorOn()) { try { stopMonitor(); } catch (e) { /* ignore */ } }
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
    const qqbotCmdState = { channel: 'qqbot', selected: null, pick: null };
    /**
     * 由**文件头魔数**判定真实图片格式，返回 DSH 接受的 mediaType 或 null。
     *
     * 为什么以字节为准、而不是照抄来源方声明的 `content_type`：
     *   DSH 会**用真实字节校验声明的 mediaType**（dsh-attachment 的
     *   SaveImageAttachment 注释："Caller-declared media type, checked against
     *   fully decoded bytes"）—— 声明错了会被直接拒收。既然校验方看字节，
     *   我们就不该把一个外部来源的声明当作事实转手传下去。
     *
     * 备注（更正）：早先我在注释/CHANGELOG 里写过"实测 QQ 会把 WebP 报成 image/png"，
     * **那是错的** —— 我当时看的是 read_image 报告的**归一化预览副本**格式（它会把图
     * 重编码成 WebP），不是源文件。实际那个文件是 2888068 字节的真 PNG（头 89504e47），
     * 与 QQ 声明的 image/png 一致。所以这里是**防御性**做法，不是在修一个已知的 QQ bug。
     *
     * DSH 只认这 4 种：image/png | image/jpeg | image/webp | image/gif。
     */
    function sniffImageMediaType(buf) {
      if (!buf || buf.length < 12) return null;
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
      if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
        && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
      return null;
    }

    /**
     * 把 QQ 消息里的**图片附件**下载到本地并读出字节，供转发进会话使用。
     *
     * 背景：QQ 把图片放在 `msg.attachments[]`（SDK 已解析出 `content_type` + `url`）。
     * 此前插件只读 `msg.content`，纯图片消息因 text 为空被通道层直接丢弃 ——
     * 实测日志印证：`[qqbot] 收到消息 from 格子蓝调 (群):`（冒号后为空）。
     *
     * 返回 `[{ mediaType, data(base64), name, localPath }]`：
     *   · mediaType 由**文件头嗅探**得出（DSH 会校验，见 sniffImageMediaType）；
     *   · 嗅探不出（不是这 4 种格式）时 mediaType 为 null，调用方退回"给路径"的老办法。
     *
     * 只处理图片：语音/文件暂不接（语音另有 voice_wav_url / asr_refer_text）。
     */
    async function downloadQQImageAttachments(attachments) {
      const out = [];
      if (!Array.isArray(attachments) || attachments.length === 0) return out;
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i];
        try {
          if (!a || !a.url) continue;
          const ct = String(a.content_type || '').toLowerCase();
          // 有 content_type 且不是图片就跳过；没有 content_type 时按扩展名兜底判断
          if (ct && ct.indexOf('image/') !== 0) continue;
          const dir = path.join(os.tmpdir(), 'dsh-qq-img');
          fs.mkdirSync(dir, { recursive: true });
          const base = 'qq-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          // 先落到 .part，嗅探出真实格式后再定名 —— 免得扩展名与内容不符（QQ 会报错类型）
          const tmpPath = path.join(dir, base + '.part');
          await downloadFile(a.url, tmpPath);
          const buf = fs.readFileSync(tmpPath);
          const mediaType = sniffImageMediaType(buf);
          const ext = mediaType ? mediaType.split('/')[1].replace('jpeg', 'jpg') : 'bin';
          const dest = path.join(dir, base + '.' + ext);
          try { fs.renameSync(tmpPath, dest); } catch (e) { /* 改名失败就用 .part */ }
          const finalPath = fs.existsSync(dest) ? dest : tmpPath;
          out.push({
            mediaType: mediaType,
            data: mediaType ? buf.toString('base64') : '',
            name: path.basename(finalPath),
            localPath: finalPath,
          });
          console.log('[qqbot] 图片附件已下载: ' + finalPath
            + '（QQ 报 ' + (ct || '无') + '，实际 ' + (mediaType || '未知') + '，' + buf.length + ' 字节）');
        } catch (e) {
          console.error('[qqbot] 图片附件下载失败:', (e && e.message) || e);
        }
      }
      return out;
    }

    async function qqbotHandleCommand(text, msg) {
      const st = qqbotCmdState;
      const t = String(text || '').trim();
      // 图片附件先落地。命令匹配只看**原始文本**（t）；图片只在"转发进会话"时用。
      const imgs = await downloadQQImageAttachments(msg && msg.attachments);
      // 能嗅探出真实格式的 → 作为**真正的图片内容块**送进会话（对话里直接显示图片）；
      // 嗅探不出的（不是 DSH 认的那 4 种）→ 退回"给本地路径"，至少 AI 还能用 read_image 读。
      const imgParts = [];
      const unknownImgs = [];
      imgs.forEach(function (im) {
        if (im.mediaType && im.data) {
          imgParts.push({ type: 'image', mediaType: im.mediaType, data: im.data, name: im.name });
        } else {
          unknownImgs.push(im.localPath);
        }
      });
      // relayContent：字符串（纯文本）或内容块数组（带图）。保持老行为不变。
      let relayContent = t;
      if (imgParts.length || unknownImgs.length) {
        const blocks = [];
        if (t) blocks.push({ type: 'text', text: t });
        imgParts.forEach(function (p) { blocks.push(p); });
        if (unknownImgs.length) {
          blocks.push({ type: 'text', text: unknownImgs.map(function (p) { return '[图片] ' + p; }).join('\n') });
        }
        relayContent = blocks;
      }
      if (!t && imgs.length === 0) return null;
      if (/^\/?(help|帮助|命令)$/i.test(t)) {
        return channelHelp('QQ 官方');
      }
      if (/^\/?(链接|获取链接|公网链接|link)$/i.test(t)) {
        if (!state.running) {
          state.error = null;
          console.log('[qqbot] starting remote (via qq command)...');
          try { await start(); } catch (e) { console.error('[qqbot] 远程启动失败:', e.message); }
        }
        if (state.url && state.token) return linkCommandText();
        // 隧道还没建好但 P2P 通了 → 也把链接给出去（P2P 那半照样有用）
        if (p2pLinkUrl()) return linkCommandText();
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
        if (!anyMonitorOn()) {
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
      // 转发用 relayContent（可能是带图的内容块数组），命令匹配仍用原始 t
      if (!/^\//.test(t)) return await cmdRelayToSession(st, relayContent);
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

    // ====== 钉钉机器人（走 dingtalk.mjs：Stream 模式长连接，不需要公网入口）======
    // 机器人消息是 CALLBACK 类型、且 CALLBACK 不会自动 ACK —— 这两件事都在通道模块内处理，
    // 调用方只管「收到消息 → 返回回复文本」，与 QQ官方 一致。
    function dingtalkLoadConfig() {
      const d = store.load().dingtalk || {};
      return {
        appKey: d.appKey || '',
        appSecret: d.appSecret || '',
        monitor: !!d.monitor,
        lastTarget: d.lastTarget || null,
        robotCode: d.robotCode || '',
      };
    }
    function dingtalkSaveConfig(patch) {
      store.save({ dingtalk: patch });
    }

    function dingtalkEnsureChannel() {
      if (dingtalkChannel) return dingtalkChannel;
      dingtalkChannel = createDingTalkChannel({
        sdkDebug: !!config.dingtalkSdkDebug,
        onMessage: (m) => {
          // robotCode 是主动推送的必填项，随第一条消息一起记下来（重启后也够用）
          if (m && m.robotCode) { try { dingtalkSaveConfig({ robotCode: m.robotCode }); } catch (e) { /* ignore */ } }
          return dingtalkHandleCommand(m.text, m);
        },
        onTargetChange: (t) => {
          // 与 QQ官方 同一个教训：判断「目标是否变化」必须用覆盖前的旧值，所以在通道内做；
          // 这里只负责落盘（每条消息都写盘会白白刷文件）
          try {
            dingtalkSaveConfig({
              lastTarget: { scope: t.scope, targetId: t.targetId },
              robotCode: t.robotCode || '',
            });
          } catch (e) { /* ignore */ }
        },
        onLog: (lv, text) => {
          if (lv === 'error') console.error('[dingtalk]', text);
          else console.log('[dingtalk]', text);
        },
      });
      return dingtalkChannel;
    }

    /**
     * 恢复上次的推送目标：重启 DSH 后无需先给机器人发消息，监听通知也能主动推送。
     * （sessionWebhook 只有 1.5 小时，靠它推不了长期通知，必须用持久化目标走 OpenAPI）
     */
    function dingtalkRestoreTarget() {
      try {
        const cfg = dingtalkLoadConfig();
        const lt = cfg.lastTarget;
        if (lt && lt.scope && lt.targetId && dingtalkChannel && typeof dingtalkChannel.setLastTarget === 'function') {
          if (dingtalkChannel.setLastTarget({ scope: lt.scope, targetId: lt.targetId, robotCode: cfg.robotCode })) {
            console.log('[dingtalk] 已恢复上次会话目标（' + lt.scope + '）—— 无需再发消息即可主动推送');
          }
        }
      } catch (e) { /* ignore */ }
    }

    async function dingtalkStart() {
      const ch = dingtalkEnsureChannel();
      const cfg = dingtalkLoadConfig();
      if (!cfg.appKey || !cfg.appSecret) throw new Error('未配置 AppKey/AppSecret');
      dingtalkAppKey = cfg.appKey;
      await ch.start(cfg.appKey, cfg.appSecret);
      return ch.status();
    }

    const dingtalkCmdState = { channel: 'dingtalk', selected: null, pick: null };
    async function dingtalkHandleCommand(text, msg) {
      const st = dingtalkCmdState;
      const t = String(text || '').trim();
      if (!t) return null;
      if (/^\/?(help|帮助|命令)$/i.test(t)) {
        return channelHelp('钉钉');
      }
      if (/^\/?(链接|获取链接|公网链接|link)$/i.test(t)) {
        if (!state.running) {
          state.error = null;
          console.log('[dingtalk] starting remote (via dingtalk command)...');
          try { await start(); } catch (e) { console.error('[dingtalk] 远程启动失败:', e.message); }
        }
        if (state.url && state.token) return linkCommandText();
        // 隧道还没建好但 P2P 通了 → 也把链接给出去（P2P 那半照样有用）
        if (p2pLinkUrl()) return linkCommandText();
        if (state.error) return '启动失败：' + state.error;
        return '正在获取链接，请稍候（隧道建立约 10~30 秒）…';
      }
      if (/^\/?(启动|开启)$/i.test(t)) {
        if (state.running) return '远程服务已在运行中';
        state.error = null;
        try { await start(); } catch (e) { console.error('[dingtalk] 远程启动失败:', e.message); }
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
        dingtalkMonitorMode = !dingtalkMonitorMode;
        dingtalkSaveConfig({ monitor: dingtalkMonitorMode });
        if (dingtalkMonitorMode) {
          try { startMonitor(); } catch (e) { console.error('[dingtalk] startMonitor 失败:', e.message); }
          return '监听已开启：会话思考完毕会推送到这里。再次发送 /监听 可关闭。';
        }
        if (!anyMonitorOn()) {
          try { stopMonitor(); } catch (e) { /* ignore */ }
        }
        return '钉钉监听已关闭';
      }
      if (/^\/?(状态|status)$/i.test(t)) {
        const stt = dingtalkChannel ? dingtalkChannel.status() : null;
        return '钉钉通道状态：\n'
          + '连接：' + (stt && stt.running ? '已连接' : '未连接') + (stt && stt.registered ? '（订阅已注册）' : '') + '\n'
          + 'AppKey：' + (dingtalkAppKey ? dingtalkAppKey.slice(0, 6) + '…' : '(未配置)') + '\n'
          + '监听：' + (dingtalkMonitorMode ? '开' : '关') + '\n'
          + '收到消息：' + (stt ? stt.messages : 0) + ' 条\n'
          + '选中会话：' + (st.selected ? '有' : '无') + '\n'
          + (stt && stt.lastError ? '最近错误：' + stt.lastError : '');
      }
      // ── 以下与微信通道对齐（8 项共享命令，5 个通道必须完全一致）──
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

    const dingtalkStatusHandler = async (req, res) => {
      const cfg = dingtalkLoadConfig();
      const st = dingtalkChannel ? dingtalkChannel.status() : null;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        configured: !!(cfg.appKey && cfg.appSecret),
        appKey: cfg.appKey || '',
        connected: !!(st && st.running),
        registered: !!(st && st.registered),
        robotCode: (st && st.robotCode) || cfg.robotCode || '',
        health: st ? st.health : 'ok',
        fails: st ? st.fails : 0,
        error: st ? st.lastError : '',
        errorKind: st ? st.lastErrorKind : '',
        lastTarget: cfg.lastTarget || null,
        instLastTarget: st ? (st.lastTarget || null) : null,
        messages: st ? st.messages : 0,
        replies: st ? st.replies : 0,
        pushCount: st ? st.pushCount : 0,
        lastPushAt: st && st.lastPushAt ? new Date(st.lastPushAt).toLocaleString() : '',
        lastPushTarget: st ? (st.lastPushTarget || null) : null,
        lastPushError: st ? (st.lastPushError || '') : '',
        lastMessageAt: st && st.lastMessageAt ? new Date(st.lastMessageAt).toLocaleString() : '',
        lastSentAt: st && st.lastSentAt ? new Date(st.lastSentAt).toLocaleString() : '',
        monitor: dingtalkMonitorMode,
      }));
    };

    const dingtalkConfigHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      const reply = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      try {
        const data = JSON.parse(body || '{}');
        const prev = dingtalkLoadConfig();
        const appKey = String(data.appKey || '').trim();
        const appSecret = String(data.appSecret || '').trim();
        // 只传空对象 = 「重新连接」：复用已保存的凭证直接重连
        if (!appKey && !appSecret) {
          if (!prev.appKey || !prev.appSecret) { reply({ ok: false, error: '请填写 AppKey 和 AppSecret' }); return; }
          try {
            const st0 = await dingtalkStart();
            dingtalkRestoreTarget();
            reply({ ok: true, connected: !!st0.running, registered: !!st0.registered, appKey: prev.appKey });
          } catch (e) {
            reply({ ok: false, error: String((e && e.message) || e), kind: (e && e.code) ? String(e.code) : 'unknown' });
          }
          return;
        }
        if (!appKey || !appSecret) { reply({ ok: false, error: '请填写 AppKey 和 AppSecret' }); return; }
        // 先验凭证：SDK 的 connect() 会把错误全吞掉，不预检面板只会看到「连接超时」
        const ch = dingtalkEnsureChannel();
        let v = null;
        try { v = await ch.verify(appKey, appSecret); } catch (e) { v = { ok: false, error: String((e && e.message) || e) }; }
        if (!v.ok) {
          console.error('[dingtalk] 凭证验证失败:', v.error);
          const hint = v.kind === 'credential' ? '（AppKey 或 AppSecret 不正确，请核对开发者后台的 Client ID / Client Secret）' : '';
          reply({ ok: false, error: (v.error || '凭证验证失败') + hint, kind: v.kind || 'unknown' });
          return;
        }
        dingtalkSaveConfig({ appKey: appKey, appSecret: appSecret });
        dingtalkAppKey = appKey;
        // 换了凭证 → 旧实例的 clientId 已经不对了，停掉重建
        dingtalkStop();
        dingtalkChannel = null;
        try {
          const st = await dingtalkStart();
          dingtalkRestoreTarget(); // 换了凭证也先把上次的推送目标挂回去
          console.log('[dingtalk] 配置成功，AppKey ' + appKey);
          reply({ ok: true, connected: !!st.running, registered: !!st.registered, appKey: appKey, robotCode: st.robotCode || '' });
        } catch (e) {
          const st = dingtalkChannel ? dingtalkChannel.status() : null;
          const hint = st && st.lastErrorKind === 'timeout'
            ? '（已保存凭证；请确认应用已发布、机器人已开启 Stream 模式）'
            : (st && st.lastErrorKind === 'permission' ? '（应用缺少「企业内机器人发送消息权限」）' : '');
          console.error('[dingtalk] 启动失败:', e.message);
          reply({ ok: true, connected: false, error: e.message + hint, kind: st ? st.lastErrorKind : 'unknown' });
        }
      } catch (e) {
        reply({ ok: false, error: String((e && e.message) || e) });
      }
    };

    const dingtalkReconnectHandler = async (req, res) => {
      const reply = (obj) => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(obj));
      };
      try {
        if (!dingtalkChannel) {
          const st0 = await dingtalkStart();
          dingtalkRestoreTarget();
          reply({ ok: true, connected: !!st0.running, registered: !!st0.registered });
          return;
        }
        const st = await dingtalkChannel.reconnect();
        dingtalkRestoreTarget();
        reply({ ok: true, connected: !!st.running, registered: !!st.registered });
      } catch (e) {
        console.error('[dingtalk] 重连失败:', e.message);
        reply({ ok: false, error: String((e && e.message) || e), kind: (e && e.code) ? String(e.code) : 'unknown' });
      }
    };

    const dingtalkDisconnectHandler = async (req, res) => {
      dingtalkStop();
      dingtalkChannel = null;
      dingtalkAppKey = '';
      dingtalkMonitorMode = false;
      dingtalkSaveConfig({ appKey: null, appSecret: null, lastTarget: null, robotCode: null, monitor: false });
      if (!anyMonitorOn()) { try { stopMonitor(); } catch (e) { /* ignore */ } }
      console.log('[dingtalk] 已断开并清除配置');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true }));
    };

    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/dingtalk/status', handler: dingtalkStatusHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/dingtalk/config', handler: dingtalkConfigHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/dingtalk/reconnect', handler: dingtalkReconnectHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/dingtalk/disconnect', handler: dingtalkDisconnectHandler }));

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
    const feishuCmdState = { channel: 'feishu', selected: null, pick: null };
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
          return linkCommandText();
        }
        // 隧道还没建好但 P2P 通了 → 也把链接给出去
        if (p2pLinkUrl()) {
          return linkCommandText();
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
          if (!anyMonitorOn()) { try { stopMonitor(); } catch (e) { /* 定时器可能不存在，忽略 */ } }
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
      // 与其它 4 通道统一措辞（此前飞书写「未识别的命令，发送帮助查看可用命令。」）
      return '未知命令，发送 /帮助 查看可用命令';
    }
    // 自动启动 WebSocket 连接
    feishuStartWS().catch(function (e) { console.error('[feishu] auto WS start failed:', e.message); });

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
          telegramMode: telegramMonitorMode,
          qqbotMode: qqbotMonitorMode,
          dingtalkMode: dingtalkMonitorMode,
          diagLogged: monitorDiagLogged,
          snapshots: weixinMonitorSnapshots,
          pendingCount: weixinPendingNotify.length,
          contextAgeMin: weixinLastContextAt ? Math.round((Date.now() - weixinLastContextAt) / 60000) : -1,
          lastNotifyAt: monitorLastNotifyAt ? new Date(monitorLastNotifyAt).toLocaleString() : '(从未触发)',
          lastNotifyTitle: monitorLastNotifyTitle,
          lastSendResult: monitorLastSendResult || '(无)',
          sendHistory: monitorSendHistory,
        },
        weixin: { hasBotToken: !!weixinState.botToken, lastFromUserId: weixinState.lastFromUserId || '(无)' },
        feishu: { lastChatId: feishuLastChatId || '(无)' },
        // 钉钉通道自述：主动推送（监听通知）到底推没推、失败原因是什么
        dingtalk: dingtalkChannel ? (function () {
          try {
            var ds = dingtalkChannel.status();
            return {
              running: ds.running,
              health: ds.health,
              connected: ds.connected,
              registered: ds.registered,
              appKey: ds.appKey,
              robotCode: ds.robotCode,
              messages: ds.messages,
              replies: ds.replies,
              lastMessageAt: ds.lastMessageAt ? new Date(ds.lastMessageAt).toLocaleString() : '(从未)',
              pushCount: ds.pushCount,
              lastPushAt: ds.lastPushAt ? new Date(ds.lastPushAt).toLocaleString() : '(从未推送)',
              lastPushTarget: ds.lastPushTarget,
              lastPushError: ds.lastPushError || '(无)',
              lastSentAt: ds.lastSentAt ? new Date(ds.lastSentAt).toLocaleString() : '(从未)',
              lastTarget: ds.lastTarget,
              lastError: ds.lastError || '(无)',
              lastErrorKind: ds.lastErrorKind || '',
            };
          } catch (e) { return 'ERR: ' + e.message; }
        })() : null,
        agentsSeen: agentInfo,
      };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out, null, 2));
    }}));

    // ====== 微信命令系统 ======
    // 会话/模型相关的指令状态，与其它 4 个通道同款结构，交给共用的 cmd* 函数使用。
    // （原先这里是两个独立变量 weixinSelectedSession / weixinModelPick，
    //   配套一整套内联实现 —— 已删除，避免与共用版漂移。）
    const weixinCmdState = { channel: 'weixin', selected: null, pick: null };

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
      // sessionId 由调用方显式传入（各通道的 st.selected）。
      // 原先还有一层「不传就退回微信选中会话」的兜底 —— 微信改用共用 cmd* 后，
      // 所有调用点都会传 sessionId，那层兜底已无人使用，删掉避免又成一个隐式耦合。
      const target = sessionId || null;
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
    // 帮助文本里**只列一级指令**：二级/三级用法（/选择 N、/切换模型 N、/选强度 N）
    // 收进所属一级指令的说明里，不单独占行 —— 否则层级混乱，用户会以为 /选择
    // 是条独立指令。
    //
    // 5 个通道共用这一份（微信与其它 4 个通道此前各写一份，改一处漏一处）。
    //
    // ⚠️ /启动 故意不列：/链接 已兼作启动（未启动会自动拉起远程服务），两者重叠，
    //    列出来会让用户困惑「两个都能启动该用哪个」。**命令本身仍然可用**
    //    （4 个通道有实现，微信从来没有），只是不进帮助。
    const HELP_LINES = [
      '· /帮助 —— 显示本列表',
      '· /链接 —— 查看远程链接（未启动会自动开启）',
      '· /停止 —— 停止远程服务',
      '· /监听 —— 开关监听模式（会话思考完毕自动通知）',
      '· /状态 —— 查看通道状态',
      '· /会话列表 —— 列出所有会话，回复「/选择 N」选中',
      '· /当前会话 —— 查看选中的会话名称',
      '· /历史内容 —— 查看选中会话最近一次输出',
      '· /当前模型 —— 查看当前使用的模型',
      '· /切换模型 —— 列出模型，回复「/切换模型 N」选中（可选思考强度）',
      '· 直接发送内容（无需前缀）—— 发送到选中的会话',
      '· 未选择会话时，先 /会话列表 再 /选择 N'
    ];
    // 微信这份与其它通道共用 HELP_LINES，只是开头那句措辞不同（微信不带斜杠也认「帮助」）
    const WEIXIN_HELP = '可用命令：\n' + HELP_LINES.join('\n');

    /**
     * 把某会话的监听快照推到「已结束 + 已看到当前事件数」。
     *
     * 用途：转发（选了会话后你发内容）走 sendToSession 时，**回复内容会直接
     * return 给机器人**；与此同时监听定时器也会发现该会话 running→idle 并再推
     * 一条「【会话】思考完毕」。于是「开了监听 + 选了会话」时，同一次输出会收到
     * **2 条**（用户报告的问题）。
     *
     * 转发这条路径已经负责回消息，监听就不该为同一轮重复推。把快照的 eventsLen
     * 对齐到当前值，监听下一轮判定 `evts.length > snap.eventsLen` 就为 false。
     *
     * 时序上是安全的：whenIdle() 的延续是微任务，会在监听的下一个 setInterval
     * 宏任务之前执行，所以监听来不及抢跑。
     */
    function suppressMonitorFor(sessionId, session) {
      try {
        var sid = String(sessionId);
        try {
          var hdr = session && session.header;
          if (hdr && hdr.id) sid = String(hdr.id);
        } catch (e) { /* 用传入的 sessionId */ }
        var len = 0;
        try { len = sessionEvents(session).length; } catch (e) { len = 0; }
        weixinMonitorSnapshots[sid] = { wasRunning: false, eventsLen: len };
      } catch (e) { /* 快照写失败不影响转发本身 */ }
    }

    async function sendToSession(sessionId, content, channelTag) {
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
      // 消息 id 带上来源通道，便于事后在会话日志里区分是哪端转发进来的。
      // （此前写死 'wxcmd-'，Telegram/QQ/飞书 转发过来也是这个前缀，排查时分不清。）
      const tag = String(channelTag || 'wxcmd').replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'wxcmd';
      const msgId = tag + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      // content 既可以是字符串（原有 5 个通道都这么传），也可以是**内容块数组** ——
      // 数组用于带图片的转发：QQ 收到图后直接在对话里显示图片，而不是给一串路径。
      let blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }];
      //
      // ⚠ 图片必须先"登记"成附件引用，绝不能把裸图片块塞进会话。
      //
      //   会话记录里图片的形状是 ImageBlock（dsh-attachment）：
      //     { type:'image', attachment: { attachmentId, mediaType, bytes, width, height, ... } }
      //   而我们手上是 wire 形式的 PromptContentPart：
      //     { type:'image', mediaType, data:<base64>, name? }        ← 没有 attachment
      //
      //   官方入口是 ctx.attachments.admitPromptContent()，文档原话是
      //   "promotes image parts to durable references ... **before any message is created**"。
      //
      //   真实踩过的坑（2026-10-07）：裸块直接写进会话后，下游每轮读记录取
      //   .attachment.attachmentId → undefined → **整轮失败**
      //   "Cannot read properties of undefined (reading 'attachmentId')"，
      //   压缩总结也跟着失败。会话文件只能靠外部工具备份+补登记才能救回来。
      if (blocks.some(function (b) { return b && b.type === 'image'; })) {
        const attachments = ctx.get('attachments') || hostCtx.get('attachments');
        if (!attachments || typeof attachments.admitPromptContent !== 'function') {
          console.error('[dsh-weixin] 附件服务不可用，丢弃图片块（会话里不许出现未登记的图片）');
          blocks = blocks.filter(function (b) { return b && b.type !== 'image'; });
          if (blocks.length === 0) return '图片附件登记服务不可用，本条已跳过';
        } else {
          try {
            // 顺带会被真实字节校验 mediaType / 体积上限，失败时抛 AttachmentError
            blocks = await attachments.admitPromptContent(blocks);
          } catch (e) {
            const em = (e && e.message) || String(e);
            console.error('[dsh-weixin] 图片登记失败（' + em + '），改为纯文本转发（下载路径见 QQ 日志）');
            blocks = blocks.filter(function (b) { return b && b.type !== 'image'; });
            if (blocks.length === 0) return '图片登记失败：' + em;
          }
        }
      }
      agent.send({ id: msgId, role: 'user', content: blocks, source: { kind: 'user' } }, 'next-turn', true);
      await agent.whenIdle();
      // 转发这条路径会把回复直接回给用户，监听别为同一轮再推一次（否则收到 2 条）
      suppressMonitorFor(sessionId, agent.session);
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
      // 带上通道标识，转发消息的 id 会形如 telegram-1712...-ab12cd，
      // 事后在会话日志里能直接看出是哪端发来的。
      return await sendToSession(st.selected, text, st.channel || 'bot');
    }

    /** 各通道通用的帮助文本（channelName 形如「Telegram」） */
    function channelHelp(channelName) {
      // 与微信共用 HELP_LINES（只列一级指令），避免两边各写一份改一处漏一处
      return channelName + ' 机器人已在线，支持命令：\n' + HELP_LINES.join('\n');
    }

    // 监听模式
    /**
     * 是否还有任何通道开着监听。
     *
     * 此前每个通道关闭监听时各写各的判断（`!weixin && !feishu` 之类），
     * 结果是「关掉飞书会把 Telegram/QQ 的监听一起停掉」——5 个通道必然漏。
     * 现在统一走这里，新增通道只改这一处（测试有守卫，禁止再写字面量判断）。
     */
    function anyMonitorOn() {
      return !!(weixinMonitorMode || feishuMonitorMode || telegramMonitorMode
        || qqbotMonitorMode || dingtalkMonitorMode);
    }

    // ── 监听通知里的图片提取 ──────────────────────────────────────────────
    //
    // 需求：监听通知除了文本，也能把这一轮产生的图片发出去（QQ 已实测支持：
    // 上传 /v2/groups/{openid}/files 拿 file_info → msg_type=7 主动发送，
    // 本地文件与网络 URL 都成功，且不需要额外权限）。
    //
    // 两路信号都扫（用户明确要求"两种都做"）：
    //   ① 结构化的 image content block —— 最直接
    //   ② 文本里的图片引用 —— markdown ![](x) / 裸 http(s) 图片链接 / 本地图片路径
    //
    // 上限 MAX_MONITOR_IMAGES：不加限制的话，一轮里出现几十张图就会刷屏。
    // 这是**正确性下限**（同文本 1900 字符截断），不是可选功能。
    var MAX_MONITOR_IMAGES = 3;
    var IMG_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#]|$)/i;

    /**
     * 从助手消息里提取要发的图片，去重后返回 [{ url }] 或 [{ localPath }]。
     * 只认**本地确实存在**的文件，或 http(s) 链接 —— 别把不存在的路径丢给 QQ 去报错。
     */
    function extractMessageImages(msg) {
      var out = [];
      var seen = {};
      // 注意：这个内部函数**不要**叫 push —— 作用域守卫（测试 #9）会把名为 push 的
      // 声明当成变量，进而把文件前面所有 Array.prototype.push 的调用误判成"越界使用"。
      function addImg(item, key) {
        if (!item || out.length >= MAX_MONITOR_IMAGES) return;
        if (seen[key]) return;
        seen[key] = 1;
        out.push(item);
      }
      // ① 结构化 image block（形状按各家约定做防御性兼容）
      if (msg && Array.isArray(msg.content)) {
        for (var i = 0; i < msg.content.length; i++) {
          var b = msg.content[i];
          if (!b || b.type !== 'image') continue;
          var src = b.source || b;
          if (src && typeof src.url === 'string' && /^https?:\/\//i.test(src.url)) {
            addImg({ url: src.url }, 'u:' + src.url);
          } else if (src && typeof src.data === 'string' && src.data) {
            // base64 → 交给 QQ 上传；SDK 的 sendImage 支持 buffer
            try { addImg({ buffer: Buffer.from(src.data, 'base64') }, 'b:' + src.data.slice(0, 32)); } catch (e) { /* ignore */ }
          } else if (typeof b.url === 'string' && /^https?:\/\//i.test(b.url)) {
            addImg({ url: b.url }, 'u:' + b.url);
          } else if (typeof b.path === 'string' || typeof b.file_path === 'string') {
            var bp = b.path || b.file_path;
            try { if (fs.existsSync(bp)) addImg({ localPath: bp }, 'p:' + bp); } catch (e) { /* ignore */ }
          }
        }
      }
      // ② 文本里的图片引用
      var text = '';
      if (msg && Array.isArray(msg.content)) {
        for (var k = 0; k < msg.content.length; k++) {
          var tb = msg.content[k];
          if (tb && tb.type === 'text' && tb.text) text += tb.text + '\n';
        }
      }
      if (text) {
        // markdown 图片：![alt](url 或 路径)
        var mdRe = /!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g;
        var mm;
        while ((mm = mdRe.exec(text)) !== null) {
          var target = mm[1];
          if (/^https?:\/\//i.test(target)) addImg({ url: target }, 'u:' + target);
          else { try { if (fs.existsSync(target)) addImg({ localPath: target }, 'p:' + target); } catch (e) { /* ignore */ } }
        }
        // 裸 http(s) 图片链接
        var urlRe = /https?:\/\/[^\s"'()<>\[\]]+/gi;
        while ((mm = urlRe.exec(text)) !== null) {
          if (IMG_EXT_RE.test(mm[0])) addImg({ url: mm[0] }, 'u:' + mm[0]);
        }
        // 本地图片路径（Windows 盘符 或 / 开头）
        var pathRe = /(?:[A-Za-z]:[\\/]|\/)[^\s"'()<>\[\]]*?\.(?:png|jpe?g|gif|webp|bmp)/gi;
        while ((mm = pathRe.exec(text)) !== null) {
          var lp = mm[0];
          try { if (fs.existsSync(lp)) addImg({ localPath: lp }, 'p:' + lp); } catch (e) { /* ignore */ }
        }
      }
      return out;
    }

    function startMonitor() {
      // 幂等：先清理已有定时器，避免 /监听 关→开 等路径重复创建监控循环（导致重复通知）
      if (weixinMonitorTimer) { clearInterval(weixinMonitorTimer); weixinMonitorTimer = null; }
      weixinMonitorSnapshots = {};
      weixinMonitorTimer = setInterval(async function () {
        if (!anyMonitorOn()) { stopMonitor(); return; }
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
                  var images = extractMessageImages(msg);
                  // 有文本**或**有图片就通知：只有图没有字的一轮也该推出去
                  if (parts.length > 0 || images.length > 0) {
                    var sessTitle = weixinMonitorTitles[aid] || '';
                    if (!sessTitle && sessionQuery) {
                      try { var _tr = await sessionQuery.readTitle(aid); sessTitle = (typeof _tr === 'string') ? _tr : (_tr && _tr.title) ? _tr.title : ''; } catch (e2) { console.error('[monitor] 读取会话标题失败:', e2.message); }
                    }
                    if (!sessTitle) sessTitle = aid.slice(0, 12);
                    weixinMonitorTitles[aid] = sessTitle;
                    var text = '【' + sessTitle + '】思考完毕：\n' + (parts.length ? parts.join('') : (images.length ? '（本轮为图片，见下）' : ''));
                    if (text.length > 1900) text = text.slice(0, 1900) + '…';
                    // 按各自通道开关发送通知
                    // 归档上一轮的发送结果：各通道是**异步**回报的，只能在下一轮开始时归档。
                    // 只留最后一条会被"下一轮的微信覆盖"或"没推的轮次"抹掉证据（排查时吃过亏），
                    // 所以保留最近 5 轮。
                    if (monitorLastSendResult) {
                      monitorSendHistory.push({
                        at: monitorLastNotifyAt ? new Date(monitorLastNotifyAt).toLocaleString() : '(未知)',
                        title: monitorLastNotifyTitle,
                        result: monitorLastSendResult,
                      });
                      if (monitorSendHistory.length > 5) monitorSendHistory.shift();
                    }
                    monitorLastSendResult = '';
                    monitorLastNotifyAt = Date.now();
                    monitorLastNotifyTitle = sessTitle;
                    if (weixinMonitorMode && weixinState.botToken && weixinState.lastFromUserId) {
                      // 先试后队：不预判 token 年龄，直接尝试发送；只有服务端真实返回失败才入队
                      // （iLink 对过期 context_token 返回 ret:-2 "prepare failed"，由 iLinkParse 抛出）
                      var ctxAgeTxt = weixinLastContextAt ? (Math.round((Date.now() - weixinLastContextAt) / 60000) + ' 分钟') : '本会话无来信';
                      weixinSendMsg(weixinState.botToken, weixinState.lastFromUserId, text, weixinState.lastContextToken || '').then(function () {
                        monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'weixin 已发送 @' + new Date().toLocaleTimeString();
                        console.log('[dsh-weixin] 通知已发送（凭据年龄 ' + ctxAgeTxt + '）');
                      }).catch(function (e) {
                        // 入队时带上时间戳：超过 TTL 的会在补发时被丢弃（不再无限积压）
                        weixinPendingNotify.push({ text: text, at: Date.now() });
                        monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'weixin 失败入队: ' + e.message + ' @' + new Date().toLocaleTimeString();
                        console.log('[dsh-weixin] 通知入队（发送失败: ' + e.message + '；凭据年龄 ' + ctxAgeTxt + '；待发 ' + weixinPendingNotify.length + ' 条，超过 ' + (PENDING_TTL_MS / 60000) + ' 分钟将丢弃）');
                      });
                    } else {
                      monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'weixin 跳过（监听' + (weixinMonitorMode ? '开' : '关') + ' token' + (weixinState.botToken ? '有' : '无') + ' userId' + (weixinState.lastFromUserId ? '有' : '无') + '）';
                    }
                    // 飞书：与钉钉一样，"为什么跳过"也写进 monitorLastSendResult。
                    // 此前只判断了 feishuMonitorMode && feishuLastChatId，没查凭证 ——
                    // 没配 appId/appSecret 时每轮都白试一次，日志刷屏
                    // 「[feishu] monitor send failed: 未配置飞书凭证」。
                    if (feishuMonitorMode) {
                      var fsSkip = '';
                      var fsCfg = null;
                      try { fsCfg = feishuLoadConfig(); } catch (e) { fsSkip = '配置读取失败: ' + e.message; }
                      if (!fsSkip && (!fsCfg || !fsCfg.appId || !fsCfg.appSecret)) fsSkip = '未配置飞书凭证（appId/appSecret）';
                      if (!fsSkip && !feishuLastChatId) fsSkip = '还没有会话目标（先给机器人发一条消息）';
                      if (fsSkip) {
                        monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'feishu 跳过: ' + fsSkip;
                        // 只记一次，避免每轮刷屏（凭据补上后会自然恢复）
                        if (feishuMonitorSkipLogged !== fsSkip) {
                          feishuMonitorSkipLogged = fsSkip;
                          console.log('[feishu] 监听通知跳过：' + fsSkip + '（补上后自动恢复）');
                        }
                      } else {
                        feishuMonitorSkipLogged = '';
                        feishuSendText(feishuLastChatId, text).then(function () {
                          monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'feishu 已发送 @' + new Date().toLocaleTimeString();
                          console.log('[feishu] 通知已发送');
                        }).catch(function (e) {
                          monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'feishu 失败: ' + e.message;
                          console.error('[feishu] monitor send failed:', e.message);
                        });
                      }
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
                          // 文本发完再补图片（已实测：主动消息可带图，本地文件与网络 URL 都行）
                          if (!images.length || !qqbotChannel.sendImage) return;
                          var sentImg = 0;
                          var failImg = 0;
                          var seq = Promise.resolve();
                          images.forEach(function (src) {
                            seq = seq.then(function () {
                              return qqbotChannel.sendImage(qqTarget, src).then(function () {
                                sentImg += 1;
                              }).catch(function (e3) {
                                failImg += 1;
                                console.error('[qqbot] 通知图片发送失败（' + (src.url || src.localPath || 'buffer') + '）:', (e3 && e3.message) || e3);
                              });
                            });
                          });
                          seq.then(function () {
                            if (sentImg || failImg) {
                              console.log('[qqbot] 通知图片：成功 ' + sentImg + ' 张，失败 ' + failImg + ' 张');
                              monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'qqbot 图片 ' + sentImg + ' 张' + (failImg ? '（失败 ' + failImg + '）' : '');
                            }
                          });
                        }).catch(function (e) {
                          var em = String(e && e.message || e);
                          monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'qqbot 失败: ' + em;
                          // 群主动推送被 QQ 拒绝（实测 code 40034105「主动消息失败, 无权限」）。
                          // 根因已查明（2026-10-07）：**群侧没给这个机器人"主动发言"授权**。
                          // 授权开关在 QQ 里，不在开放平台 —— 打开机器人的设置页，
                          // 开启「机器人主动在群聊内发言」。开启后 QQ 会发 GROUP_MSG_RECEIVE
                          // （事件名 / Intent GROUP_AND_C2C_EVENT 1<<25），主动推送立即可用。
                          // 实测：开启前 40034105，开启后同一请求 200 成功。
                          if (qqTarget.scope === 'group' && /40034105|无权限/.test(em)) {
                            if (!qqbotGroupDeniedLogged) {
                              qqbotGroupDeniedLogged = true;
                              console.error('[qqbot] 群主动推送被 QQ 拒绝（40034105 主动消息失败, 无权限）。'
                                + '这是群侧授权没开，不是插件问题。'
                                + '解决办法：群管理员在 QQ 里打开该机器人的设置页，'
                                + '开启「机器人主动在群聊内发言」（机器人可主动发消息，如定时任务推送等）。'
                                + '开启后 QQ 会下发 GROUP_MSG_RECEIVE，主动推送即可用。'
                                + '若仍不通，可改用 Telegram / 钉钉 / 飞书做群通知（长连接，无此限制）。');
                            }
                          } else {
                            console.error('[qqbot] monitor send failed:', em);
                          }
                        });
                      }
                    }
                    // 钉钉：走 OpenAPI 主动推送（sessionWebhook 只有 1.5 小时，靠不住）。
                    // 「为什么跳过」也写进 monitorLastSendResult —— 否则 /remote/diag 里
                    // 只会看到别的通道，根本不知道钉钉是没开监听、没连上，还是还没有会话目标。
                    if (dingtalkMonitorMode) {
                      var dtSkip = '';
                      var dtStt = null;
                      try { dtStt = dingtalkChannel ? dingtalkChannel.status() : null; } catch (e) { dtSkip = '状态读取失败: ' + e.message; }
                      if (!dtSkip && !dtStt) dtSkip = '通道实例不存在';
                      else if (!dtSkip && dtStt.health === 'down') dtSkip = '通道已断开';
                      var dtTarget = dtSkip ? null : (dingtalkChannel.getLastTarget ? dingtalkChannel.getLastTarget() : null);
                      if (!dtSkip && !dtTarget) dtSkip = '还没有会话目标（先给机器人发一条消息）';
                      if (dtSkip) {
                        monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'dingtalk 跳过: ' + dtSkip;
                        console.log('[dingtalk] 监听通知跳过：' + dtSkip);
                      } else {
                        try {
                          dingtalkChannel.send(dtTarget, text).then(function () {
                            monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'dingtalk 已发送 @' + new Date().toLocaleTimeString();
                            console.log('[dingtalk] 通知已发送');
                          }).catch(function (e) {
                            monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'dingtalk 失败: ' + e.message;
                            console.error('[dingtalk] monitor send failed:', e.message);
                          });
                        } catch (e) {
                          // send() 是 async，正常不会同步抛；兜住以免整个监听轮询被带崩
                          monitorLastSendResult = (monitorLastSendResult ? monitorLastSendResult + ' | ' : '') + 'dingtalk 异常: ' + e.message;
                          console.error('[dingtalk] monitor send threw:', e.message);
                        }
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
            return linkCommandText();
          }
          // 隧道还没建好但 P2P 通了 → 也把链接给出去
          if (p2pLinkUrl()) {
            return linkCommandText();
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
            if (!anyMonitorOn()) { stopMonitor(); }
            return '监听模式已关闭';
          }
        }
        // /状态
        if (/^\/状态$/.test(t) || /^\/status$/i.test(t)) {
          var ageTxt = weixinLastStaleMin < 0 ? '本会话尚无微信消息' : (weixinLastStaleMin === 0 ? '新鲜（<1分钟前）' : '上次消息于 ' + weixinLastStaleMin + ' 分钟前');
          // 待发 / 已丢弃都显示 —— 丢弃不是"藏起来"，而是明确的策略（超过 TTL 补发无意义）
          var qTxt = '待发 ' + weixinPendingNotify.length + ' 条';
          if (weixinLastFlushedCount > 0) qTxt += '，上次补发 ' + weixinLastFlushedCount + ' 条';
          if (weixinDroppedNotify > 0) qTxt += '，累计丢弃 ' + weixinDroppedNotify + ' 条过期通知';
          return '微信监听状态：\n· 凭据：' + ageTxt + '\n· 积压：' + qTxt
            + '\n· 监听：微信' + (weixinMonitorMode ? '开' : '关') + ' / 飞书' + (feishuMonitorMode ? '开' : '关') + ' / 纸飞机' + (telegramMonitorMode ? '开' : '关') + ' / QQ' + (qqbotMonitorMode ? '开' : '关') + ' / 钉钉' + (dingtalkMonitorMode ? '开' : '关')
            + '\n（注：微信要求"你刚说过话"才允许机器人推送，长时间不发言时通知只能排队；超过 ' + (PENDING_TTL_MS / 60000) + ' 分钟的会被丢弃）';
        }
        // ── 以下与其它 4 个通道**完全共用**同一组 cmd* 实现 ──
        //
        // 此前微信自己内联复制了一份（/会话列表、/选择 N、/当前会话、/历史内容、
        // /当前模型、/切换模型、/选强度 N）。文案虽与共用版相同，但**两套代码必然漂**：
        // 实测已经漂了 —— 内联版缺「请先「/切换模型」选择模型」这条前置提示，
        // 用户在微信里直接发 /选强度 会毫无反馈地落到"未知命令"。
        // 现在只保留一处实现（就是本组 cmd* 函数）。
        if (/^\/会话列表$/.test(t) || /^\/会话$/.test(t)) return await cmdSessionList();
        const mSel = t.match(/^\/选择[\s：:]*(\d+)$/);
        if (mSel) return await cmdSelectSession(weixinCmdState, mSel[1]);
        if (/^\/当前会话$/.test(t)) return await cmdCurrentSession(weixinCmdState);
        if (/^\/历史内容$/.test(t)) return await cmdHistory(weixinCmdState);
        if (/^\/当前模型$/.test(t)) return await cmdCurrentModel(weixinCmdState);
        if (/^\/切换模型/.test(t)) return await cmdSwitchModel(weixinCmdState, t.replace(/^\/切换模型/, ''));
        if (/^\/选强度/.test(t)) return await cmdPickEffort(weixinCmdState, t.replace(/^\/选强度/, ''));
        // 与其它 4 通道统一措辞（此前微信写「未知命令，发「帮助」查看可用命令」、
        // 飞书写「未识别的命令，发送帮助查看可用命令。」，三家不一样）
        return '未知命令，发送 /帮助 查看可用命令';
      }
      // 非命令消息 → 转发进选中的会话（与其它 4 通道共用 cmdRelayToSession，
      // 未选会话时由它给出统一引导，这里不再自己写一份）。
      // 先发"思考中"（避免长时间无回复）—— 只在确实有目标会话时发，
      // 否则用户会先收到"思考中"再收到"请先选会话"，自相矛盾。
      if (weixinCmdState.selected && weixinActiveSend) {
        try {
          await weixinSendMsg(weixinActiveSend.botToken, weixinActiveSend.toUserId, '已收到指令，AI 思考中，请稍等…', weixinActiveSend.contextToken);
        } catch (e) { /* ignore */ }
      }
      return await cmdRelayToSession(weixinCmdState, t);
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
                // ⚠ 失败**不入队**。
                // 入队机制是给「会话输出通知」用的 —— 那些内容晚点送到仍有意义。
                // 但「DSH已启动」是个时效性问候：重启时用的必然是上次存的旧 token
                // （几乎一定过期），入队后要等你下次来信才补发，那时你收到一句
                // 几小时前的"已启动"只会莫名其妙；而且它让每次重启都固定显示
                // 「积压 1 条」，用户会以为积压又坏了（实际就是这个问候）。
                console.log('[dsh-weixin] 启动通知发送失败（不入队，避免重启后固定积压 1 条）: ' + (e.message || e));
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
        // 飞书监听恢复：**必须先确认凭证还在**。
        // 此前无条件恢复成开 —— 卸载/清掉凭证后开关还留着，监听每轮都白试一次，
        // 日志刷屏「[feishu] monitor send failed: 未配置飞书凭证」。
        if (md.feishu && md.feishu.enabled) {
          var _fsRestoreCfg = null;
          try { _fsRestoreCfg = feishuLoadConfig(); } catch (e) { /* 读不到就当没配 */ }
          if (_fsRestoreCfg && _fsRestoreCfg.appId && _fsRestoreCfg.appSecret) {
            feishuMonitorMode = true;
            console.log('[feishu] monitor auto-restored');
          } else {
            feishuMonitorMode = false;
            console.log('[feishu] 监听开关是开的，但没配凭证（appId/appSecret），本次不恢复监听 —— 补上凭证后重新发 /监听 即可');
          }
        }
        // 钉钉监听恢复（开关持久化在 store.dingtalk.monitor；连接由下面的启动块负责）
        if ((store.load().dingtalk || {}).monitor) {
          dingtalkMonitorMode = true;
          console.log('[dingtalk] monitor auto-restored');
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
    // 钉钉启动：有 AppKey 就自动连（Stream 长连接，8 秒后起，错开其它通道）
    setTimeout(function () {
      try {
        var dtc = dingtalkLoadConfig();
        if (!dtc.appKey || !dtc.appSecret) { console.log('[dingtalk] 未配置 AppKey/AppSecret，跳过'); return; }
        dingtalkAppKey = dtc.appKey;
        dingtalkMonitorMode = !!dtc.monitor;
        dingtalkStart().then(function (st) {
          dingtalkRestoreTarget(); // 重启后恢复上次的推送目标，无需再发消息
          console.log('[dingtalk] 已连接（AppKey ' + dingtalkAppKey + '，订阅=' + (st.registered ? '已注册' : '未注册')
            + '，监听 ' + (dingtalkMonitorMode ? '开' : '关') + '）');
          if (dingtalkMonitorMode) {
            var t = dingtalkChannel ? dingtalkChannel.getLastTarget() : null;
            if (t) {
              dingtalkChannel.send(t, 'DSH已启动，任务监听中').then(function () {
                console.log('[dingtalk] 启动通知已发送');
              }).catch(function (e) { console.error('[dingtalk] 启动通知失败:', e.message); });
            } else {
              console.log('[dingtalk] 尚无会话目标，启动通知跳过（给机器人发一条消息后会记录）');
            }
          }
        }).catch(function (e) {
          console.error('[dingtalk] 自动连接失败:', e.message);
        });
      } catch (e) { console.error('[dingtalk] startup error:', e.message); }
    }, 8000);
  }

  ctx.effect(() => () => {
    if (tunnelHandle) { try { tunnelHandle.terminate(); } catch (e) { /* ignore */ } }
    if (proxy) { try { proxy.close(); } catch (e) { /* ignore */ } }
    telegramStop();
    qqbotStop();
    qqbotQrCleanup();
    dingtalkStop();
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
