// dsh-web-remote — Telegram 通道（"小飞机"）
//
// 设计要点
//   · 纯 HTTP，零第三方依赖（对比飞书要装 52 个包的 SDK）
//   · 国内必须走代理：api.telegram.org 直连超时，支持 proxyUrl（HTTP CONNECT 隧道）
//   · 长轮询 getUpdates（timeout=30）而非 webhook —— 不需要公网入口、不需要证书
//   · 无"会话窗口"限制：用户 /start 过机器人后即可随时主动推送（不像微信 iLink 有窗口）
//   · 单条消息上限 4096 字符，超长自动分片
//
// 用法
//   const ch = createTelegramChannel({ apiBase, proxyUrl, onMessage, onLog })
//   ch.start(botToken)               // 启动长轮询
//   ch.send(chatId, '文本')           // 主动发送（监听通知用）
//   ch.stop(); ch.status()
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import { URL } from 'node:url';

const TG_MAX_LEN = 4096;          // Telegram 单条消息上限
const POLL_TIMEOUT_S = 30;        // 服务端长轮询保持秒数
const POLL_HTTP_TIMEOUT_MS = 45000; // 客户端 HTTP 超时（须大于服务端）
const MAX_FAILS = 3;              // 连续失败上限：达到即停止轮询（恢复靠手动重连）

/** 建立走 HTTP 代理的 HTTPS agent（CONNECT 隧道 + TLS，连接复用） */
function createProxyAgent(proxyUrl) {
  const u = new URL(proxyUrl);
  const proxyIsTls = u.protocol === 'https:';
  const proxyPort = Number(u.port || (proxyIsTls ? 443 : 80));
  const proxyAuth = u.username
    ? decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password || '')
    : undefined;

  const agent = new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2 });
  // 覆写 createConnection：先 CONNECT 打隧道，再在隧道上做 TLS
  agent.createConnection = function (opts, cb) {
    const targetHost = opts.host;
    const targetPort = opts.port || 443;
    const via = proxyIsTls ? https : http;
    const creq = via.request({
      host: u.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: targetHost + ':' + targetPort,
      headers: { Host: targetHost + ':' + targetPort },
      ...(proxyAuth ? { auth: proxyAuth } : {}),
      ...(proxyIsTls ? { rejectUnauthorized: false } : {}),
    });
    creq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        cb(new Error('代理 CONNECT 失败 HTTP ' + res.statusCode));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: targetHost });
      tlsSocket.once('secureConnect', () => cb(null, tlsSocket));
      tlsSocket.once('error', (e) => cb(e));
    });
    creq.once('error', (e) => cb(new Error('代理连接失败: ' + e.message)));
    creq.end();
  };
  return agent;
}

/** 把长文本按 Telegram 上限切片（尽量在换行处断开） */
export function splitForTelegram(text, limit) {
  const max = limit || TG_MAX_LEN;
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

/**
 * 创建 Telegram 通道实例。
 * @param {object} options
 * @param {string} [options.apiBase]  API 根地址，默认 https://api.telegram.org（可指向自建 Bot API 反代）
 * @param {string} [options.proxyUrl] HTTP 代理，如 http://127.0.0.1:7897；留空则直连
 * @param {(msg: object) => Promise<string|null>} [options.onMessage] 收到用户消息，返回回复文本
 * @param {(level: string, text: string) => void} [options.onLog] 日志回调
 */
export function createTelegramChannel(options) {
  const opt = options || {};
  const apiBase = String(opt.apiBase || 'https://api.telegram.org').replace(/\/+$/, '');
  const proxyUrl = opt.proxyUrl ? String(opt.proxyUrl).trim() : '';
  const onMessage = typeof opt.onMessage === 'function' ? opt.onMessage : null;
  const onLog = typeof opt.onLog === 'function' ? opt.onLog : function () {};

  const state = {
    running: false,
    me: null,          // { id, username, firstName }
    lastError: null,
    lastErrorKind: '', // 归类后的错误类型（proxy-refused / proxy-timeout / network / token / conflict / dns / unknown）
    health: 'ok',      // 'ok' | 'degraded' | 'down'
    fails: 0,          // 连续失败次数
    lastChatId: null,
    lastMessageAt: null,
    lastSentAt: null,
    updates: 0,
    messages: 0,
    proxy: proxyUrl || '(直连)',
  };

  let agent = null;
  let abortFlag = false;
  let pollPromise = null;
  let offset = 0;

  function log(text) { try { onLog('info', text); } catch (e) { /* ignore */ } }

  /** 发一个 Telegram Bot API 请求；返回 { ok, result } 或抛错 */
  function apiRequest(token, method, payload, isLongPoll) {
    return new Promise((resolve, reject) => {
      let target;
      try { target = new URL(apiBase + '/bot' + token + '/' + method); } catch (e) { reject(new Error('apiBase 非法: ' + apiBase)); return; }
      const body = payload ? JSON.stringify(payload) : null;
      const headers = { 'content-type': 'application/json' };
      if (body) headers['content-length'] = Buffer.byteLength(body);
      const reqOpts = {
        host: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: body ? 'POST' : 'GET',
        headers,
        timeout: isLongPoll ? POLL_HTTP_TIMEOUT_MS : 20000,
      };
      if (agent) reqOpts.agent = agent;

      const req = https.request(reqOpts, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(d); } catch (e) { /* 非 JSON */ }
          if (!j) { reject(new Error('响应非 JSON (HTTP ' + res.statusCode + '): ' + d.slice(0, 120))); return; }
          if (j.ok === false) {
            const e = new Error('Telegram 错误 ' + j.error_code + ': ' + (j.description || ''));
            e.tgCode = j.error_code;
            e.tgDescription = j.description;
            reject(e);
            return;
          }
          resolve(j.result);
        });
      });
      req.on('error', (e) => reject(e));
      req.on('timeout', () => { req.destroy(new Error('请求超时')); });
      if (body) req.write(body);
      req.end();
    });
  }

  /** 把底层错误归类，供 UI 显示针对性提示 */
  function classifyError(e) {
    const m = String(e && e.message || '');
    if (e && e.tgCode === 401) return 'token';
    if (e && e.tgCode === 409) return 'conflict';
    if (/ECONNREFUSED/i.test(m)) return 'proxy-refused';
    if (/ETIMEDOUT|timeout/i.test(m)) return 'proxy-timeout';
    if (/ECONNRESET|EPIPE|socket hang up/i.test(m)) return 'network';
    if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'dns';
    return 'unknown';
  }

  /** 长轮询循环：连续失败 MAX_FAILS 次即停止（不再空转刷屏），等手动重连 */
  async function pollLoop(token) {
    log('长轮询启动（代理: ' + state.proxy + '）');
    while (!abortFlag) {
      try {
        const updates = await apiRequest(token, 'getUpdates', {
          offset: offset,
          timeout: POLL_TIMEOUT_S,
          allowed_updates: ['message', 'edited_message'],
        }, true);
        if (abortFlag) break;
        // 成功了：若之前在降级/断开，报一次恢复
        if (state.health !== 'ok') {
          log('已恢复连接');
          state.health = 'ok';
        }
        state.fails = 0;
        state.lastError = null;
        state.lastErrorKind = '';
        if (Array.isArray(updates) && updates.length) {
          for (const u of updates) {
            if (typeof u.update_id === 'number') offset = u.update_id + 1;
            const m = u.message || u.edited_message;
            if (!m || !m.chat) continue;
            state.updates++;
            await handleIncoming(token, m);
          }
        }
      } catch (e) {
        state.lastError = e.message;
        state.lastErrorKind = classifyError(e);
        state.fails++;
        // 401 token 失效：重试无意义，直接停
        if (e.tgCode === 401) {
          log('token 无效（401）：已停止轮询，请重新配置 Bot Token');
          state.health = 'down';
          state.running = false;
          return;
        }
        // 409 冲突：另一实例在轮询，不算"连接故障"，继续等待重试
        if (e.tgCode === 409) {
          log('冲突：同一 token 已有其它实例在 getUpdates，等待重试');
          state.health = 'degraded';
          await sleepInterruptible(15000);
          continue;
        }
        // 连续失败达到上限：停止轮询（避免空转刷屏，恢复靠手动「重连」）
        if (state.fails >= MAX_FAILS) {
          state.health = 'down';
          state.running = false;
          log('连接断开（连续 ' + MAX_FAILS + ' 次失败，已停止轮询）：' + e.message + ' — 点「重连」恢复');
          return;
        }
        state.health = 'degraded';
        const wait = state.fails === 1 ? 5000 : 10000;
        log('第 ' + state.fails + '/' + MAX_FAILS + ' 次失败：' + e.message + '（' + (wait / 1000) + ' 秒后重试）');
        await sleepInterruptible(wait);
      }
    }
    log('长轮询已停止');
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // 可被 reconnect() 提前打断的等待
  let sleepTimer = null;
  let sleepResolve = null;
  function sleepInterruptible(ms) {
    return new Promise((resolve) => {
      sleepResolve = resolve;
      sleepTimer = setTimeout(function () { sleepTimer = null; sleepResolve = null; resolve(); }, ms);
    });
  }
  function interruptSleep() {
    if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
    if (sleepResolve) { const r = sleepResolve; sleepResolve = null; r(); }
  }

  /** 处理一条收到的消息 */
  async function handleIncoming(token, m) {
    const chat = m.chat || {};
    const from = m.from || {};
    const text = String(m.text || m.caption || '').trim();
    state.lastChatId = chat.id;
    state.lastMessageAt = Date.now();
    state.messages++;
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    log('收到消息 from ' + (from.username ? '@' + from.username : (from.first_name || chat.id)) + (isGroup ? ' (群)' : ' (私聊)') + ': ' + text.slice(0, 60));
    if (!text) return;
    let reply = null;
    if (onMessage) {
      try {
        reply = await onMessage({ chatId: chat.id, fromId: from.id, username: from.username || from.first_name || '', text: text, isGroup: isGroup, messageId: m.message_id, raw: m });
      } catch (e) {
        reply = '[处理出错: ' + e.message + ']';
      }
    }
    if (reply) {
      try { await send(chat.id, reply); } catch (e) { log('回复失败：' + e.message); }
    }
  }

  /** 主动/回复发送消息（自动分片） */
  async function send(chatId, text) {
    if (!state.running || !state.token) throw new Error('Telegram 通道未启动');
    const parts = splitForTelegram(text);
    let last = null;
    for (const part of parts) {
      last = await apiRequest(state.token, 'sendMessage', {
        chat_id: chatId,
        text: part,
        disable_web_page_preview: true,
      }, false);
      state.lastSentAt = Date.now();
    }
    return last;
  }

  return {
    /** 启动长轮询（会先校验 token） */
    async start(token) {
      if (state.running) return state;
      if (!token) {
        state.health = 'down';
        state.lastError = '缺少 Bot Token';
        state.lastErrorKind = 'token';
        throw new Error('缺少 Bot Token');
      }
      state.token = token;
      state.lastError = null;
      state.lastErrorKind = '';
      state.fails = 0;
      state.health = 'ok';
      // 代理 agent 按需创建
      if (proxyUrl && !agent) {
        try { agent = createProxyAgent(proxyUrl); } catch (e) {
          state.health = 'down';
          state.lastError = '代理地址无效: ' + e.message;
          state.lastErrorKind = 'unknown';
          throw new Error('代理地址无效: ' + e.message);
        }
      }
      // 关键：握手失败也必须标记为 down，否则面板显示"配置表单"而不是"断开+重连"，红点也不亮
      let me;
      try {
        me = await apiRequest(token, 'getMe', null, false);
      } catch (e) {
        state.health = 'down';
        state.fails = MAX_FAILS;
        state.running = false;
        state.lastError = e.message;
        state.lastErrorKind = classifyError(e);
        log('连接失败：' + e.message);
        throw e;
      }
      state.me = { id: me.id, username: me.username || '', firstName: me.first_name || '' };
      log('已连接机器人 @' + state.me.username + ' (' + state.me.firstName + ')');
      state.running = true;
      abortFlag = false;
      offset = 0;
      pollPromise = pollLoop(token);
      return state;
    },
    stop() {
      abortFlag = true;
      interruptSleep();
      state.running = false;
      return state;
    },
    /**
     * 手动重连：打断退避等待、重建代理隧道（Clash 重启后旧连接池不可用）、
     * 清空失败计数后立即重新连接。供面板「重连」按钮调用。
     */
    async reconnect() {
      abortFlag = true;
      interruptSleep();
      state.running = false;
      await sleep(300);
      agent = null;               // 强制重建隧道
      state.fails = 0;
      state.health = 'ok';
      state.lastError = null;
      state.lastErrorKind = '';
      try {
        return await this.start(state.token);
      } catch (e) {
        // 重连也失败：如实反映为 down 并带上归类
        state.fails = MAX_FAILS;
        state.health = 'down';
        state.lastError = e.message;
        state.lastErrorKind = classifyError(e);
        log('重连失败：' + e.message);
        throw e;
      }
    },
    send(chatId, text) { return send(chatId, text); },
    status() {
      return {
        running: state.running,
        health: state.health,
        fails: state.fails,
        me: state.me,
        proxy: state.proxy,
        apiBase: apiBase,
        lastError: state.lastError,
        lastErrorKind: state.lastErrorKind,
        lastChatId: state.lastChatId,
        lastMessageAt: state.lastMessageAt,
        lastSentAt: state.lastSentAt,
        updates: state.updates,
        messages: state.messages,
      };
    },
    /** 配置变更后重建连接（改代理/改 token 用） */
    async restart(token) {
      this.stop();
      await sleep(300);
      agent = null;
      return this.start(token);
    },
  };
}
