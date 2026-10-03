// dsh-web-remote — 钉钉机器人通道（Stream 模式长连接）
//
// 与飞书 / QQ官方 一样是长连接，不需要公网入口；但坑点完全不同，
// 以下 6 条来自 dingtalk-stream v2.1.5 源码 + 钉钉官方文档核对，改代码前先读：
//
//  1) 机器人消息是 **CALLBACK** 类型（topic /v1.0/im/bot/messages/get），不是 EVENT。
//     必须 registerCallbackListener(TOPIC_ROBOT, cb) —— 它才会把
//     {type:'CALLBACK', topic:'/v1.0/im/bot/messages/get'} 加进 subscriptions。
//     只调 registerAllEventListener 是收不到机器人消息的。
//  2) CALLBACK **不会自动 ACK**（SDK 的 onCallback 只 emit，丢弃返回值），
//     必须自己 client.socketCallBackResponse(messageId, {response:null})。
//     回调要同步 return，耗时的活丢到 ACK 之后异步做。
//  3) SDK 的 connect() 内部 catch 吞掉所有异常、**永不 reject**
//     → 不能靠 await connect() 判断成功，这里轮询 client.connected/registered 做就绪判定。
//     另外先用 access_token 接口做一次凭证预检，错误信息才说得清。
//  4) keepAlive 默认 false，半死连接发现不了 → 显式打开（SDK 每 8 秒 ping/pong）。
//     SDK 重连间隔硬编码 1 秒且无退避 → 重连日志做限流，别刷屏。
//  5) 被动回复用消息自带的 sessionWebhook（**1.5 小时**有效，sessionWebhookExpiredTime
//     是绝对毫秒时间戳），返回体 {errcode,errmsg} —— HTTP 200 不代表成功。
//     过期/主动通知走 OpenAPI 推送；access_token 自己缓存 7200 秒
//     （SDK 自带的 getAccessToken() 无缓存且是旧版 GET 接口，不能用在每次回调里）。
//  6) 一个应用最多 50 条 Stream 连接、服务端随机挑一条推送 → 调用方要幂等，
//     且两个 profile 绝不能同时跑。

const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const OTO_URL = 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
const GROUP_URL = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';

const MAX_FAILS = 3;              // 连续错误几次算 down（与其它通道一致）
const READY_TIMEOUT_MS = 15000;   // 就绪判定超时
const REGISTER_WAIT_MS = 3000;    // 连上后再等注册的时间（不阻塞成功）
const REQ_TIMEOUT_MS = 15000;     // 单次 HTTP 超时
const TOKEN_SAFETY_MS = 300000;   // token 提前 5 分钟过期
const HEALTH_INTERVAL_MS = 30000; // 健康巡检间隔
const RECONNECT_LOG_GAP_MS = 30000;
const MAX_SEEN = 200;             // msgId 去重集合上限

/** 钉钉文本消息分片长度（群聊 msgParam 上限 15000 字节，中文 3 字节/字，4000 字足够安全） */
export const DINGTALK_MAX_TEXT = 4000;

/**
 * 清洗钉钉文本消息内容。
 *
 * 官方样例显示：群聊 @机器人 时**服务端已把「@机器人名」剥掉**，只留一个前导空格，
 * 官方教程一律只做 trim()。这里保持同样的行为，只加一层很保守的软兜底：
 * 仅当行首残留 `@xxx ` 且剩下的是**命令**（/ 开头）时才剥掉 ——
 * 避免把用户真想转发的「@张三 看下这个」吃掉。
 */
export function stripDingTalkMention(text) {
  const raw = String(text == null ? '' : text).replace(/[\u200b\ufeff]/g, '');
  const trimmed = raw.trim();
  const m = trimmed.match(/^@[^\s@]+\s+([\s\S]*)$/);
  if (m && /^\//.test(m[1].trim())) return m[1].trim();
  return trimmed;
}

/** 按长度分片（优先在换行处切），返回数组 */
export function splitForDingTalk(text, limit) {
  const max = Math.max(200, Number(limit) || DINGTALK_MAX_TEXT);
  const s = String(text == null ? '' : text);
  if (s.length <= max) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) parts.push(rest);
  return parts;
}

/** 目标是否变化（判断必须用覆盖前的旧值，所以放在通道内，别在调用方的 onMessage 里比） */
export function targetChanged(prev, next) {
  const p = prev || {};
  const n = next || {};
  return String(p.scope || '') !== String(n.scope || '') || String(p.targetId || '') !== String(n.targetId || '');
}

/** 错误归类：面板据此给出人话提示 */
export function classifyDingTalkError(e) {
  const msg = String((e && (e.message || e.errmsg)) || e || '');
  const code = String((e && (e.code || e.status)) || '');
  const all = code + ' ' + msg;
  if (/AccessDenied|Forbidden|没有调用该接口的权限|requiredScopes|权限/i.test(all)) return 'permission';
  if (/invalidClientId|invalidClientSecret|appkey|appsecret|clientId or clientSecret|凭证/i.test(all)) return 'credential';
  if (/access_token|accessToken|40001|40014|invalid.*token|令牌/i.test(all)) return 'token';
  if (/sessionWebhook|sendBySession|41050|过期/i.test(all)) return 'webhook';
  if (/FlowControl|flowControl|限流|too many|90018/i.test(all)) return 'rate-limit';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|aborted|socket hang up|fetch failed|timeout|超时|network/i.test(all)) return 'network';
  return 'unknown';
}

/** 统一 HTTP 请求（带超时 + JSON 解析，不抛网络以外的错） */
async function httpJson(url, opts) {
  const o = opts || {};
  const ctl = new AbortController();
  const timer = setTimeout(function () { try { ctl.abort(); } catch (e) { /* ignore */ } }, o.timeout || REQ_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: o.method || 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, o.headers || {}),
      body: o.body === undefined ? undefined : (typeof o.body === 'string' ? o.body : JSON.stringify(o.body)),
      signal: ctl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { _raw: text }; }
    return { status: res.status, ok: res.ok, data: data, text: text };
  } finally {
    clearTimeout(timer);
  }
}

/** 把非 2xx / 业务错误码统一成一个带 code 的 Error */
function apiError(label, r) {
  const d = (r && r.data) || {};
  const code = d.code || d.errcode || (r && r.status) || '';
  const detail = d.message || d.errmsg || (r && r.text) || '';
  const e = new Error(label + '：' + (code ? code + ' ' : '') + String(detail).slice(0, 300));
  e.code = code;
  e.status = r && r.status;
  e.body = d;
  return e;
}

/**
 * 创建钉钉通道。
 *
 * @param {object} [options]
 * @param {(msg: object) => Promise<string|null>} [options.onMessage] 收到消息，返回回复文本
 * @param {(target: {scope: string, targetId: string, robotCode?: string}) => void} [options.onTargetChange]
 * @param {(level: string, text: string) => void} [options.onLog]
 * @param {boolean} [options.sdkDebug]
 */
export function createDingTalkChannel(options) {
  const opt = options || {};
  const onMessage = typeof opt.onMessage === 'function' ? opt.onMessage : null;
  const onTargetChange = typeof opt.onTargetChange === 'function' ? opt.onTargetChange : null;
  const onLog = typeof opt.onLog === 'function' ? opt.onLog : function () {};
  const sdkDebug = !!opt.sdkDebug;

  const state = {
    running: false,
    health: 'ok',        // 'ok' | 'degraded' | 'down'
    fails: 0,
    lastError: '',
    lastErrorKind: '',
    appKey: '',
    robotCode: '',
    lastTarget: null,    // { scope:'c2c'|'group', targetId }
    lastTargetAt: 0,
    messages: 0,
    replies: 0,
    lastMessageAt: 0,
    lastSentAt: 0,
    // 主动推送（OpenAPI）诊断：与 replyTo 的被动回复分开记账 ——
    // 否则「监听通知到底推没推」分不清（排查时吃过亏）
    pushCount: 0,
    lastPushAt: 0,
    lastPushTarget: null,
    lastPushError: '',
    startedAt: 0,
  };

  let sdk = null;                 // 动态加载的 SDK 模块
  let client = null;              // DWClient 实例
  let starting = false;
  let stopping = false;
  let healthTimer = null;
  let lastReconnectLogAt = 0;
  // 凭据与 token 只存闭包（不进 state，避免 status()/接口把它带出去）
  let creds = { appKey: '', appSecret: '' };
  let token = { value: '', expireAt: 0 };
  const seen = new Set();

  function log(text) { try { onLog('info', text); } catch (e) { /* ignore */ } }
  function logErr(text) { try { onLog('error', text); } catch (e) { /* ignore */ } }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function setOk(reason) {
    if (state.health !== 'ok') log('已恢复连接' + (reason ? '（' + reason + '）' : ''));
    state.health = 'ok';
    state.fails = 0;
    state.lastError = '';
    state.lastErrorKind = '';
  }

  function noteError(e) {
    state.lastError = String((e && e.message) || e || '');
    state.lastErrorKind = classifyDingTalkError(e);
  }

  function bumpFail(e) {
    state.fails += 1;
    noteError(e);
    if (state.fails >= MAX_FAILS) {
      state.health = 'down';
      state.running = false;
      stopHealthTimer();
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
    noteError(e);
  }

  function markSeen(msgId) {
    seen.add(msgId);
    if (seen.size > MAX_SEEN) {
      const first = seen.values().next().value;
      seen.delete(first);
    }
  }

  // ── access_token（必须自己缓存：SDK 自带的无缓存且走旧版接口）──
  async function fetchToken(appKey, appSecret) {
    try {
      const r = await httpJson(TOKEN_URL, { method: 'POST', body: { appKey: appKey, appSecret: appSecret } });
      if (r.ok && r.data && r.data.accessToken) {
        return { ok: true, token: String(r.data.accessToken), expireIn: Number(r.data.expireIn) || 7200 };
      }
      const err = apiError('获取 access_token 失败', r);
      return { ok: false, error: err.message, kind: classifyDingTalkError(err) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), kind: classifyDingTalkError(e) };
    }
  }

  async function ensureToken(force) {
    if (!force && token.value && Date.now() < token.expireAt) return token.value;
    const v = await fetchToken(creds.appKey, creds.appSecret);
    if (!v.ok) {
      const e = new Error(v.error);
      e.code = v.kind;
      throw e;
    }
    token = { value: v.token, expireAt: Date.now() + Math.max(60, v.expireIn - TOKEN_SAFETY_MS / 1000) * 1000 };
    return token.value;
  }

  // ── 主动推送（OpenAPI）──
  async function apiSendOnce(target, text) {
    const robotCode = target.robotCode || state.robotCode;
    if (!robotCode) throw new Error('缺少 robotCode（机器人编码）—— 先给机器人发一条消息即可自动记录');
    const isGroup = target.scope === 'group';
    const body = isGroup
      ? {
        robotCode: robotCode,
        openConversationId: target.targetId,
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: text }),
      }
      : {
        robotCode: robotCode,
        userIds: [target.targetId],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: text }),
      };
    const tk = await ensureToken(false);
    const r = await httpJson(isGroup ? GROUP_URL : OTO_URL, {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': tk },
      body: body,
    });
    if (!r.ok) throw apiError(isGroup ? '群聊推送失败' : '单聊推送失败', r);
    return r.data || {};
  }

  async function apiSend(target, text) {
    try {
      return await apiSendOnce(target, text);
    } catch (e) {
      // token 失效 → 强制刷新后重试一次
      if (classifyDingTalkError(e) === 'token') {
        token = { value: '', expireAt: 0 };
        return await apiSendOnce(target, text);
      }
      throw e;
    }
  }

  // ── 被动回复（sessionWebhook，1.5 小时内有效，不需要 token/权限）──
  async function replyViaWebhook(msg, text) {
    const url = msg.sessionWebhook;
    if (!url) throw new Error('消息里没有 sessionWebhook');
    if (msg.sessionWebhookExpiredTime && Date.now() > msg.sessionWebhookExpiredTime) {
      throw new Error('sessionWebhook 已过期（有效期 1.5 小时）');
    }
    const body = { msgtype: 'text', text: { content: text } };
    if (msg.isGroup) {
      // 群里回复时 @ 一下提问的人。atUserIds 要的是企业内 userId（senderStaffId），
      // 而 senderId 是加密 ID —— 用它 @ 不到人，还可能让整条回复返回错误码，
      // 所以拿不到 staffId 时干脆不加 at（宁可不 @，也不能把回复搞失败）。
      // 应用没发布时 senderStaffId 不返回，这也符合官方文档。
      const atId = String(msg.senderStaffId || '');
      if (atId) body.at = { atUserIds: [atId], isAtAll: false };
    }
    const r = await httpJson(url, { method: 'POST', body: body });
    // 返回体 {errcode, errmsg}：HTTP 200 不代表成功
    if (r.data && typeof r.data.errcode === 'number' && r.data.errcode !== 0) throw apiError('被动回复失败', r);
    if (!r.ok) throw apiError('被动回复失败', r);
    return r.data || {};
  }

  /** 回复：优先 sessionWebhook，失败/过期自动回落 OpenAPI 主动推送 */
  async function replyTo(msg, text) {
    const parts = splitForDingTalk(text);
    let sent = 0;
    let viaWebhook = true;
    try {
      for (const p of parts) {
        await replyViaWebhook(msg, p);
        sent += 1;
      }
    } catch (e) {
      viaWebhook = false;
      logErr('sessionWebhook 回复失败（' + ((e && e.message) || e) + '），改用 OpenAPI 主动推送');
    }
    if (!viaWebhook) {
      const target = { scope: msg.scope, targetId: msg.targetId, robotCode: msg.robotCode || state.robotCode };
      if (!target.targetId) throw new Error('无法回落推送：缺少会话目标');
      for (let i = sent; i < parts.length; i++) await apiSend(target, parts[i]);
    }
    state.replies += 1;
    state.lastSentAt = Date.now();
  }

  // ── 消息处理 ──
  async function handleMessage(raw) {
    let m = null;
    try {
      m = JSON.parse(raw.data);
    } catch (e) {
      logErr('消息 data 解析失败：' + ((e && e.message) || e));
      return;
    }
    if (!m || !m.msgId) return;
    if (seen.has(m.msgId)) { log('忽略重复消息 ' + m.msgId); return; }
    markSeen(m.msgId);

    const msgtype = String(m.msgtype || '');
    const isGroup = String(m.conversationType || '') === '2';
    const scope = isGroup ? 'group' : 'c2c';
    const targetId = isGroup
      ? String(m.conversationId || '')
      : String(m.senderStaffId || m.senderId || '');
    if (m.robotCode) state.robotCode = String(m.robotCode);

    state.messages += 1;
    state.lastMessageAt = Date.now();

    // 目标变更：先判断（要用覆盖前的旧值）再覆盖，最后才通知调用方落盘
    if (targetId) {
      const nextTarget = { scope: scope, targetId: targetId };
      const changed = targetChanged(state.lastTarget, nextTarget);
      state.lastTarget = nextTarget;
      state.lastTargetAt = Date.now();
      if (changed && onTargetChange) {
        try {
          const r = onTargetChange({ scope: scope, targetId: targetId, robotCode: state.robotCode || '' });
          if (r && typeof r.catch === 'function') r.catch((e) => logErr('目标变更回调失败：' + ((e && e.message) || e)));
        } catch (e) {
          logErr('目标变更回调异常：' + ((e && e.message) || e));
        }
      }
    }

    const payload = {
      scope: scope,
      targetId: targetId,
      isGroup: isGroup,
      text: msgtype === 'text' ? stripDingTalkMention(m.text && m.text.content) : '',
      msgtype: msgtype,
      messageId: String(m.msgId),
      senderId: String(m.senderStaffId || m.senderId || ''),
      senderStaffId: String(m.senderStaffId || ''),
      senderName: String(m.senderNick || ''),
      conversationId: String(m.conversationId || ''),
      conversationTitle: String(m.conversationTitle || ''),
      robotCode: String(m.robotCode || ''),
      sessionWebhook: String(m.sessionWebhook || ''),
      sessionWebhookExpiredTime: Number(m.sessionWebhookExpiredTime || 0),
      atUsers: Array.isArray(m.atUsers) ? m.atUsers : [],
      raw: m,
    };

    if (!payload.text) {
      // 非文本消息没有 text 字段（picture/audio/video/file/richText），直接取会抛
      log('收到非文本消息（' + (msgtype || '未知') + '），暂不支持');
      try {
        await replyTo(payload, '暂不支持该消息类型（目前只处理文本），请发送文字或命令。');
      } catch (e) {
        logErr('提示回复失败：' + ((e && e.message) || e));
      }
      return;
    }

    log('收到消息 from ' + (payload.senderName || payload.senderId || '?')
      + (isGroup ? ' (群)' : ' (私聊)') + ': ' + payload.text.slice(0, 60));

    let reply = null;
    if (onMessage) {
      try {
        reply = await onMessage(payload);
      } catch (e) {
        logErr('命令处理出错：' + ((e && e.message) || e));
        reply = '[处理出错: ' + ((e && e.message) || e) + ']';
      }
    }
    if (reply) {
      try {
        await replyTo(payload, String(reply));
      } catch (e) {
        logErr('回复失败：' + ((e && e.message) || e));
      }
    }
  }

  /**
   * 机器人消息回调。
   * ⚠️ 必须**同步**返回、且立刻 ACK：CALLBACK 不会自动 ACK，钉钉收不到响应会重推。
   * 真正的处理丢到 ACK 之后异步跑，绝不阻塞回调。
   */
  function onRobotCallback(msg) {
    try {
      if (client && msg && msg.headers && msg.headers.messageId) {
        client.socketCallBackResponse(msg.headers.messageId, { response: null });
      }
    } catch (e) {
      logErr('ACK 失败：' + ((e && e.message) || e));
    }
    handleMessage(msg).catch((e) => logErr('消息处理异常：' + ((e && e.message) || e)));
    return { status: 'SUCCESS' };
  }

  function stopHealthTimer() {
    if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  }

  function startHealthTimer() {
    stopHealthTimer();
    healthTimer = setInterval(function () {
      if (!client || stopping || !state.running) return;
      if (client.connected) { setOk(); return; }
      if (client.reconnecting) {
        const now = Date.now();
        if (now - lastReconnectLogAt > RECONNECT_LOG_GAP_MS) {
          lastReconnectLogAt = now;
          log('连接断开，SDK 正在重连（间隔 1 秒、无退避）…');
        }
        return;
      }
      bumpFail(new Error('Stream 连接已断开'));
    }, HEALTH_INTERVAL_MS);
    if (healthTimer && typeof healthTimer.unref === 'function') healthTimer.unref();
  }

  /** 就绪判定：connect() 永不 reject，只能轮询 SDK 的公开状态字段 */
  async function waitReady() {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (client && client.connected) {
        const regDeadline = Date.now() + REGISTER_WAIT_MS;
        while (Date.now() < regDeadline && client && !client.registered) await sleep(200);
        return true;
      }
      await sleep(200);
    }
    return false;
  }

  return {
    /** 凭证预检（只验 AppKey/AppSecret，不建连接）：面板「验证」按钮与配置接口用 */
    async verify(appKey, appSecret) {
      const key = String(appKey || '').trim();
      const secret = String(appSecret || '').trim();
      if (!key || !secret) return { ok: false, error: '请填写 AppKey 与 AppSecret', kind: 'credential' };
      const v = await fetchToken(key, secret);
      if (v.ok) return { ok: true };
      return { ok: false, error: v.error, kind: v.kind };
    },

    async start(appKey, appSecret) {
      if (state.running) return this.status();
      if (starting) throw new Error('正在连接中，请稍候');
      const key = String(appKey || creds.appKey || state.appKey || '').trim();
      const secret = String(appSecret || creds.appSecret || '').trim();
      if (!key || !secret) throw new Error('缺少 AppKey 或 AppSecret，请重新配置');
      starting = true;
      stopping = false;
      creds = { appKey: key, appSecret: secret };
      token = { value: '', expireAt: 0 };
      state.appKey = key;
      try {
        if (!sdk) {
          try {
            sdk = await import('dingtalk-stream');
          } catch (e) {
            throw new Error('钉钉 SDK 未安装（dingtalk-stream）：' + ((e && e.message) || e));
          }
        }
        // 凭证预检：SDK 的 connect() 会把错误全吞掉，先自己验一次，报错才说得清
        const v = await fetchToken(key, secret);
        if (!v.ok) {
          const err = new Error(v.error);
          err.code = v.kind;
          setDown(err);
          throw err;
        }
        token = { value: v.token, expireAt: Date.now() + Math.max(60, v.expireIn - TOKEN_SAFETY_MS / 1000) * 1000 };

        try { if (client) client.disconnect(); } catch (e) { /* ignore */ }
        client = new sdk.DWClient({ clientId: key, clientSecret: secret, keepAlive: true, debug: sdkDebug });
        // 机器人消息是 CALLBACK：必须 registerCallbackListener，才会订阅该 topic
        client.registerCallbackListener(sdk.TOPIC_ROBOT, onRobotCallback);
        client.registerAllEventListener(() => ({ status: 'SUCCESS' }));

        await client.connect(); // 永不 reject，真正的判定在 waitReady()

        const ready = await waitReady();
        if (!ready) {
          const err = new Error('连接超时（' + Math.round(READY_TIMEOUT_MS / 1000) + ' 秒未就绪）：请确认应用已发布、机器人已开启 Stream 模式');
          err.code = 'timeout';
          setDown(err);
          try { client.disconnect(); } catch (e) { /* ignore */ }
          client = null;
          throw err;
        }

        state.running = true;
        state.startedAt = Date.now();
        setOk();
        startHealthTimer();
        log('已连接（AppKey ' + key + '，registered=' + !!(client && client.registered) + '）');
        return this.status();
      } catch (e) {
        if (state.health !== 'down') setDown(e);
        throw e;
      } finally {
        starting = false;
      }
    },

    /** 停止通道（幂等，不抛错） */
    stop() {
      stopping = true;
      state.running = false;
      stopHealthTimer();
      try { if (client) client.disconnect(); } catch (e) { /* ignore */ }
      client = null;
      return state;
    },

    /** 手动重连：销毁旧实例、清空错误计数、重建连接 */
    async reconnect(appKey, appSecret) {
      const key = appKey || creds.appKey || state.appKey;
      const secret = appSecret || creds.appSecret;
      this.stop();
      await sleep(300);
      state.fails = 0;
      state.health = 'ok';
      state.lastError = '';
      state.lastErrorKind = '';
      if (!key || !secret) {
        const e = new Error('缺少 AppKey 或 AppSecret，请重新配置');
        setDown(e);
        throw e;
      }
      return this.start(key, secret);
    },

    /** 主动推送（OpenAPI，不带 sessionWebhook）。target 形如 { scope, targetId, robotCode? } */
    async send(target, text) {
      if (!state.running) throw new Error('钉钉通道未启动');
      if (!target || !target.targetId) throw new Error('发送目标无效');
      const parts = splitForDingTalk(text);
      let last = null;
      // 记账：调用方（监听通知）据此判断"到底推没推" —— 与被动回复分开
      state.lastPushAt = Date.now();
      state.lastPushTarget = { scope: target.scope, targetId: String(target.targetId) };
      state.lastPushError = '';
      for (const p of parts) {
        try {
          last = await apiSend(target, p);
          setOk();
        } catch (e) {
          const kind = classifyDingTalkError(e);
          state.lastPushError = String((e && e.message) || e);
          // 只有网络/超时/token 类算连接故障；权限、凭证类只记错误，不要把通道判死
          if (kind === 'network' || kind === 'timeout' || kind === 'token') bumpFail(e);
          else noteError(e);
          throw e;
        }
      }
      state.pushCount += 1;
      state.lastSentAt = Date.now();
      return last;
    },

    /** 回复某条消息（优先 sessionWebhook，过期自动回落主动推送） */
    async reply(msg, text) {
      return replyTo(msg, text);
    },

    /** 最近一次会话目标（监听通知推送用） */
    getLastTarget() {
      return state.lastTarget
        ? { scope: state.lastTarget.scope, targetId: state.lastTarget.targetId, robotCode: state.robotCode || '' }
        : null;
    },

    /** 恢复上次的会话目标（调用方启动时从持久化里取出后注入） */
    setLastTarget(target) {
      try {
        if (!target || !target.scope || !target.targetId) return false;
        if (target.scope !== 'c2c' && target.scope !== 'group') return false;
        state.lastTarget = { scope: target.scope, targetId: String(target.targetId) };
        state.lastTargetAt = Date.now();
        if (target.robotCode) state.robotCode = String(target.robotCode);
        return true;
      } catch (e) {
        return false;
      }
    },

    status() {
      return {
        running: state.running,
        health: state.health,
        fails: state.fails,
        appKey: state.appKey,
        robotCode: state.robotCode,
        connected: !!(client && client.connected),
        registered: !!(client && client.registered),
        lastError: state.lastError,
        lastErrorKind: state.lastErrorKind,
        lastTarget: state.lastTarget,
        lastTargetAt: state.lastTargetAt,
        messages: state.messages,
        replies: state.replies,
        lastMessageAt: state.lastMessageAt,
        lastSentAt: state.lastSentAt,
        pushCount: state.pushCount,
        lastPushAt: state.lastPushAt,
        lastPushTarget: state.lastPushTarget,
        lastPushError: state.lastPushError,
        startedAt: state.startedAt,
        starting: starting,
      };
    },
  };
}
