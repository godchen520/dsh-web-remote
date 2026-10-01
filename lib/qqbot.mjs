// dsh-web-remote — QQ 官方机器人通道（QQ 开放平台 / Agent 接入）
//
// 设计要点
//   · 官方 SDK @tencent-connect/qqbot-nodejs —— **动态 import**：SDK 缺失或装坏时
//     只让本通道不可用，绝不拖垮插件整体加载（与飞书通道同一策略）
//   · WebSocket 长连接：**不需要公网入口、不需要备案**；SDK 自带心跳与 RESUME 补发
//   · 群聊 + 单聊（c2c）双场景，intents 由 SDK 默认给全（group + c2c + interaction）
//   · 会话持久化（FileKVStore）：进程重启后可 RESUME，补上断连期间漏掉的消息
//   · 健康状态 ok/degraded/down 与其他通道一致，接入面板红点与「重连」按钮
//   · 单条文本上限 5000 字符，自动分片（优先在换行处断开）
//   · 主动推送：ReplyTarget **不带 msgId** 时 SDK 走 sendProactiveMessage
//     （QQ 侧可能被用户/群主关掉主动消息 → 归类为 rejected，不当作故障）
//
// 关键坑：SDK 的 bot.start() 是「长跑」调用（跑到连接结束才 resolve），
//   因此这里用「ready 事件 vs start() 拒绝」竞速来判断是否真的连上，
//   不能直接 await start()，否则调用方永远挂住。
//
// 用法
//   const ch = createQQBotChannel({ onMessage, onLog, sessionsDir })
//   await ch.start(appId, appSecret)              // 连上（失败抛错，已归类）
//   await ch.send({ scope:'c2c', targetId }, '文本')  // 主动推送
//   ch.stop(); ch.status(); await ch.reconnect()
import fs from 'node:fs';
import path from 'node:path';

const TEXT_LIMIT = 5000;        // QQ 单条文本上限（SDK TEXT_CHUNK_LIMIT = 5000）
const MAX_FAILS = 3;            // 连续错误上限，达到即判定 down
const READY_TIMEOUT_MS = 20000; // 等待 ready 事件的超时
const CHUNK_GAP_MS = 350;       // 分片之间的间隔，避免触发限流

/** 把长文本按 QQ 上限切片（尽量在换行处断开） */
export function splitForQQ(text, limit) {
  const max = limit || TEXT_LIMIT;
  const s = String(text == null ? '' : text);
  if (s.length <= max) return [s];
  const out = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max; // 找不到合适换行就硬切
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/** 把底层错误归类，供 UI 显示针对性提示 */
export function classifyQQError(e) {
  const m = String((e && e.message) || e || '');
  if (/ERR_MODULE_NOT_FOUND|cannot find package|不是内部或外部命令/i.test(m)) return 'sdk-missing';
  // 鉴权/凭证类：QQ 侧典型报错 —— 10004 机器人不存在、Failed to get access_token、
  // appid/secret 不匹配、401/403 等。这类重试无意义，必须让用户改配置。
  if (/机器人不存在|1000[34]|access_token|app\s*id|appid|secret|401|403|unauthor|invalid.*(credential|token)|鉴权|凭证/i.test(m)) return 'auth';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout|socket hang up|network/i.test(m)) return 'network';
  if (/频率|过于频繁|rate.?limit|freq|too many/i.test(m)) return 'rate-limit';
  if (/拒收|拒绝|reject|forbidden|主动消息|not allowed|无权限/i.test(m)) return 'rejected';
  return 'unknown';
}

/**
 * 创建 QQ 官方机器人通道实例。
 * @param {object} options
 * @param {(msg: object) => Promise<string|null>} [options.onMessage] 收到消息，返回回复文本
 * @param {(level: string, text: string) => void} [options.onLog] 日志回调
 * @param {string} [options.sessionsDir] 会话持久化目录（用于 RESUME 补发；留空则用内存）
 * @param {boolean} [options.sdkDebug] 是否把 SDK 内部日志转发到 onLog（默认关闭，避免刷屏）
 */
export function createQQBotChannel(options) {
  const opt = options || {};
  const onMessage = typeof opt.onMessage === 'function' ? opt.onMessage : null;
  const onLog = typeof opt.onLog === 'function' ? opt.onLog : function () {};
  const sessionsDir = opt.sessionsDir ? String(opt.sessionsDir) : '';
  const sdkDebug = !!opt.sdkDebug;

  const state = {
    running: false,       // 是否已就绪且在跑
    health: 'ok',         // 'ok' | 'degraded' | 'down'
    fails: 0,             // 连续错误次数
    lastError: '',
    lastErrorKind: '',
    appId: '',
    accountId: '',
    sdkVersion: '',
    lastTarget: null,     // { scope, targetId } —— 主动推送目标（最近一次会话）
    lastTargetAt: 0,
    messages: 0,
    replies: 0,
    lastMessageAt: 0,
    lastSentAt: 0,
  };

  let sdk = null;         // 动态加载的 SDK 模块
  let bot = null;         // QQBot 实例
  let starting = false;   // 正在启动中（防重入）
  let stopping = false;   // 主动停止中（用于区分"主动停"与"意外断"）
  let startRun = null;    // bot.start() 的长跑 promise
  // 凭据保存在闭包里（**不进 state**，避免 status()/接口把它带出去）
  let creds = { appId: '', appSecret: '' };

  function log(text) {
    try { onLog('info', text); } catch (e) { /* 日志失败不能影响主流程 */ }
  }
  function logErr(text) {
    try { onLog('error', text); } catch (e) { /* ignore */ }
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function setOk(reason) {
    if (state.health !== 'ok') log('已恢复连接' + (reason ? '（' + reason + '）' : ''));
    state.health = 'ok';
    state.fails = 0;
    state.lastError = '';
    state.lastErrorKind = '';
  }

  function bumpFail(e) {
    state.fails += 1;
    state.lastError = String((e && e.message) || e || '');
    state.lastErrorKind = classifyQQError(e);
    if (state.fails >= MAX_FAILS) {
      state.health = 'down';
      state.running = false;
      logErr('连接断开（连续 ' + MAX_FAILS + ' 次错误）：' + state.lastError + ' — 点「重连」恢复');
    } else {
      state.health = 'degraded';
      logErr('第 ' + state.fails + '/' + MAX_FAILS + ' 次错误：' + state.lastError);
    }
  }

  function setDown(e) {
    state.fails = MAX_FAILS;
    state.health = 'down';
    state.running = false;
    state.lastError = String((e && e.message) || e || '');
    state.lastErrorKind = classifyQQError(e);
  }

  /** SDK 日志适配：默认静默（只在 sdkDebug 时转发），避免 SDK 内部噪音刷屏 */
  function makeLogger() {
    const pass = (level) => (msg, meta) => {
      if (!sdkDebug) return;
      try {
        const extra = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        onLog(level, '[qq-sdk] ' + msg + extra);
      } catch (e) { /* ignore */ }
    };
    return { info: pass('info'), error: pass('error'), warn: pass('info'), debug: pass('info') };
  }

  /** 动态加载 SDK；缺失时给出明确指引 */
  async function loadSDK() {
    if (sdk) return sdk;
    try {
      sdk = await import('@tencent-connect/qqbot-nodejs');
      try {
        state.sdkVersion = (sdk.VERSION || sdk.version || '') + '';
      } catch (e) { /* ignore */ }
      return sdk;
    } catch (e) {
      const err = new Error('QQ 官方 SDK 未安装（@tencent-connect/qqbot-nodejs）：' + ((e && e.message) || e));
      err.kind = 'sdk-missing';
      throw err;
    }
  }

  /** 收到消息：交给上层处理并回复 */
  async function handleMessage(msg) {
    try {
      if (!msg) return;
      const target = msg.replyTarget || null;
      const scope = (target && target.scope) || msg.kind || '';
      const targetId = (target && target.targetId) || '';
      if (!targetId) return;
      const senderIsBot = !!msg.senderIsBot;
      if (senderIsBot) return; // 不回机器人自己的消息，防自环

      state.messages += 1;
      state.lastMessageAt = Date.now();
      // 记录主动推送目标（去掉 msgId → 后续推送走 proactive）
      state.lastTarget = { scope: scope, targetId: targetId };
      state.lastTargetAt = Date.now();

      const text = String(msg.content == null ? '' : msg.content).trim();
      const isGroup = scope === 'group' || msg.kind === 'group';
      log('收到消息 from ' + (msg.senderName || msg.senderId || '?') + (isGroup ? ' (群)' : ' (私聊)') + ': ' + text.slice(0, 60));
      if (!text) return;

      let reply = null;
      if (onMessage) {
        try {
          reply = await onMessage({
            scope: scope,
            targetId: targetId,
            senderId: msg.senderId || '',
            senderName: msg.senderName || '',
            text: text,
            isGroup: isGroup,
            messageId: msg.messageId || '',
            raw: msg,
          });
        } catch (e) {
          logErr('命令处理出错：' + ((e && e.message) || e));
          reply = '[处理出错: ' + ((e && e.message) || e) + ']';
        }
      }
      if (reply) {
        try {
          // 回复时带上 msgId，QQ 侧显示为"引用回复"
          await sendRaw({ scope: scope, targetId: targetId, msgId: target && target.msgId }, reply);
          state.replies += 1;
        } catch (e) {
          logErr('回复失败：' + ((e && e.message) || e));
        }
      }
    } catch (e) {
      // 兜底：任何异常都不能让 SDK 的事件回调炸掉
      logErr('消息处理异常：' + ((e && e.message) || e));
    }
  }

  /** 底层发送（自动分片）；target 带 msgId = 回复，不带 = 主动推送 */
  async function sendRaw(target, text) {
    if (!bot) throw new Error('QQ 通道未启动');
    if (!target || !target.targetId) throw new Error('发送目标无效');
    const parts = splitForQQ(text);
    let last = null;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await sleep(CHUNK_GAP_MS); // 分片间隔，避免限流
      last = await bot.sendText({
        scope: target.scope || 'c2c',
        targetId: target.targetId,
        msgId: target.msgId || undefined, // 不带 msgId → proactive
      }, parts[i]);
      state.lastSentAt = Date.now();
    }
    return last;
  }

  return {
    /**
     * 启动并等待真正就绪（ready 事件）。
     * 失败会抛错且状态已置为 down、错误已归类。
     */
    async start(appId, appSecret) {
      if (state.running) return this.status();
      if (starting) throw new Error('QQ 通道正在启动中，请稍候');
      if (!appId || !appSecret) {
        const e = new Error('缺少 AppID 或 AppSecret');
        setDown(e);
        throw e;
      }
      starting = true;
      stopping = false;
      try {
        const m = await loadSDK();

        // 清理旧实例（重连场景）
        if (bot) {
          try { bot.stop(); } catch (e) { /* ignore */ }
          bot = null;
        }

        state.appId = String(appId);
        state.accountId = 'dsh-' + appId;
        creds = { appId: String(appId), appSecret: String(appSecret) }; // 仅存闭包，status() 不暴露

        const botOpts = {
          appId: String(appId),
          appSecret: String(appSecret),
          accountId: state.accountId,
          logger: makeLogger(),
        };

        // 会话持久化（可选）：进程重启后可 RESUME 补发
        if (sessionsDir) {
          try {
            fs.mkdirSync(sessionsDir, { recursive: true });
            if (typeof m.FileKVStore === 'function' && typeof m.kvSessionPersistence === 'function') {
              botOpts.sessionPersistence = m.kvSessionPersistence({
                store: new m.FileKVStore({ dir: sessionsDir }),
                accountId: state.accountId,
              });
            }
          } catch (e) {
            log('会话持久化不可用（降级为内存，不影响使用）：' + ((e && e.message) || e));
          }
        }

        bot = new m.QQBot(botOpts);

        // ── 事件订阅（全部包 try/catch，绝不让回调异常穿透到 SDK）──
        bot.on('ready', () => {
          try {
            setOk('ready');
            state.running = true;
            log('已连接 QQ 机器人（AppID ' + state.appId + '）');
          } catch (e) { /* ignore */ }
        });
        bot.on('resumed', () => {
          try {
            setOk('resumed');
            state.running = true;
            log('连接已恢复（RESUME，补发漏掉的事件）');
          } catch (e) { /* ignore */ }
        });
        bot.on('error', (err) => {
          try {
            if (stopping) return; // 主动停止引发的错误不计入
            bumpFail(err);
          } catch (e) { /* ignore */ }
        });
        bot.on('message', (ctx, msg) => {
          // 不 await：避免阻塞 SDK 的事件循环；内部已自兜底
          handleMessage(msg);
        });

        // ── 竞速：ready 事件 vs start() 拒绝 vs 超时 ──
        // 注意 1：SDK 的 start() 是长跑调用（跑到连接结束才 resolve），
        //         所以绝不能直接 await，只能监听它的 settle 结果。
        // 注意 2：SDK 的 QQBot 不是 EventEmitter —— 只有 on/off，没有 once()。
        //         一次性语义 + 监听器清理必须自己实现（曾因误用 once() 直接启动失败）。
        await new Promise((resolve, reject) => {
          let settled = false;
          let timer = null;
          const onReady = () => finish(resolve, 'ready');
          const onErr = (err) => {
            const kind = classifyQQError(err);
            state.lastError = String((err && err.message) || err || '');
            state.lastErrorKind = kind;
            // 只有"鉴权类/缺 SDK"才立刻判死（重试无意义）；网络抖动、限流只记录，等 ready 或超时
            if (kind === 'auth' || kind === 'sdk-missing') {
              finish(reject, err || new Error('连接失败'));
            } else {
              logErr('启动期错误（继续等待就绪）：' + state.lastError);
            }
          };
          const cleanup = () => {
            try { bot.off('ready', onReady); } catch (e) { /* ignore */ }
            try { bot.off('error', onErr); } catch (e) { /* ignore */ }
          };
          function finish(fn, arg) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            cleanup();
            fn(arg);
          }
          timer = setTimeout(() => {
            finish(reject, new Error('连接超时（' + (READY_TIMEOUT_MS / 1000) + ' 秒内未就绪，请检查 AppID/AppSecret 与网络）'));
          }, READY_TIMEOUT_MS);
          if (typeof timer.unref === 'function') timer.unref();

          bot.on('ready', onReady);
          bot.on('error', onErr);

          startRun = bot.start();
          startRun.then(() => {
            // 长跑结束 = 连接已断开（被 stop() 或对端关闭）
            finish(reject, new Error(stopping ? '已停止' : '连接已结束（未就绪即断开）'));
            if (!stopping) {
              state.running = false;
              if (state.health === 'ok') bumpFail(new Error('WebSocket 连接已断开'));
            }
          }).catch((err) => {
            finish(reject, err || new Error('启动失败'));
          });
        });

        // 就绪成功
        state.running = true;
        setOk();
        return this.status();
      } catch (e) {
        setDown(e);
        throw e;
      } finally {
        starting = false;
      }
    },

    /** 停止通道（幂等，不抛错） */
    stop() {
      stopping = true;
      state.running = false;
      try { if (bot) bot.stop(); } catch (e) { /* ignore */ }
      bot = null;
      return state;
    },

    /**
     * 手动重连：销毁旧实例、清空错误计数、重建连接。
     * 不传参则复用闭包里的原凭据；失败时状态如实置为 down 并抛错（供面板显示原因）。
     */
    async reconnect(appId, appSecret) {
      const id = appId || creds.appId || state.appId;
      const secret = appSecret || creds.appSecret;
      this.stop();
      await sleep(300);
      state.fails = 0;
      state.health = 'ok';
      state.lastError = '';
      state.lastErrorKind = '';
      if (!id || !secret) {
        const e = new Error('缺少 AppID 或 AppSecret，请重新配置');
        setDown(e);
        throw e;
      }
      return this.start(id, secret);
    },

    /** 主动发送（不带 msgId → proactive）；target 形如 { scope, targetId } */
    async send(target, text) {
      if (!bot || !state.running) throw new Error('QQ 通道未启动');
      return sendRaw(target, text);
    },

    /** 最近一次会话目标（监听通知推送用） */
    getLastTarget() {
      return state.lastTarget ? { scope: state.lastTarget.scope, targetId: state.lastTarget.targetId } : null;
    },

    status() {
      return {
        running: state.running,
        health: state.health,
        fails: state.fails,
        appId: state.appId,
        accountId: state.accountId,
        sdkVersion: state.sdkVersion,
        lastError: state.lastError,
        lastErrorKind: state.lastErrorKind,
        lastTarget: state.lastTarget,
        lastTargetAt: state.lastTargetAt,
        messages: state.messages,
        replies: state.replies,
        lastMessageAt: state.lastMessageAt,
        lastSentAt: state.lastSentAt,
        starting: starting,
      };
    },
  };
}
