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

/**
 * QQ markdown 的**发送前处理**（纯字符串，不调模型、不耗 token、不发网络请求）。
 *
 * ⚠ 这里只做两件确实必要的事。**不要再加"降级"了** —— 踩过一次大坑：
 *
 *   官方文档的"支持格式"清单**只列了**：标题、加粗/下划线加粗/斜体/加粗斜体/删除线、
 *   链接、图片、有序与无序列表、列表嵌套、块引用、水平分割线。
 *   表格 / 代码块 / 行内代码 / 任务列表**都不在清单里**。
 *
 *   我据此写了"降级"（表格→列表、代码块→去围栏缩进、行内代码→去反引号、任务列表→✅⬜），
 *   **结果真机实测把每一条都推翻了**（2026-10-19，msg_type=2 原样发送）：
 *     · 表格        → 「表格」卡片（带 复制/保存/全屏）；三种写法都行；单元格内联 markdown 也生效
 *     · 代码块      → 代码卡片：语言标注 + 语法高亮 + 复制按钮
 *     · 四空格缩进  → 同样识别成代码卡片
 *     · 行内代码    → 等宽 + 底色
 *     · 任务列表    → 真正的 ☑ / ☐ 勾选框
 *     · HTML        → `<b>` 变粗体、`<br>` 变换行（标签被吃掉）
 *   也就是说那些"降级"全是在**把好东西降成差东西**。
 *
 *   ⚠ 教训：官方那份清单**不完整**，不能拿它当"不支持"的依据。要判断某个语法，
 *     **真机发一条比查文档可靠**。
 *
 * 保留的两件事：
 *   1) **删除图片引用** —— 理由与文档无关：通知里的图片多是本地路径（`E:\pic\x.png`），
 *      QQ 抓不到会显示成坏图；而且图片本来就由富媒体消息（sendImage）单独发送，不删会重复。
 *   2) `---` / `___` → `***` —— 官方文档明确写水平分割线是 `***`（已实测渲染成功）。
 */
export function toQQMarkdown(input) {
  let s = String(input == null ? '' : input);
  if (!s) return s;

  // 1) 图片引用删掉（图片走富媒体 sendImage，不在这里重复；本地路径留着只会是坏图）
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // 裸图片 URL / 本地图片路径也删 —— 但**尖括号里的不算**：`<https://a.com/x.png>` 是
  // 官方支持的"链接"写法，用户拿它当链接用，不该被当成图片资源删掉。
  s = s.replace(/(^|[^<])(https?:\/\/[^\s"'()<>\[\]]+\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s"'()<>\[\]]*)?)/gi, '$1');
  // 本地路径必须限定在"token 开头"：早先的正则太贪，会把 URL 的路径段（/x.png）也吃掉，
  // 于是 `<https://a.com/x.png>` 被啃成 `<http>`（单测抓到过）。
  s = s.replace(/(^|[\s"'(\[（【])((?:[A-Za-z]:[\\/]|\/)[^\s"'()<>\[\]]*?\.(?:png|jpe?g|gif|webp|bmp))/gim, '$1');

  // 2) 水平分割线统一成官方文档里写的 ***
  s = s.replace(/^([ \t]*)(?:-{3,}|_{3,})[ \t]*$/gm, '$1***');

  // 3) 收拾删图片之后留下的多余空行与行尾空格
  s = s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '');
  return s.trim();
}

// 这里原本有 splitQQRow / isQQTableRow / isQQTableSep / convertQQTables 一整套
// "表格 → 列表"的降级（连"列表前要补空行""二级列表缩进 4 空格"都按文档实现了）。
//
// 2026-10-19 真机实测证明：**QQ 完整支持 markdown 表格**（渲染成带 复制/保存/全屏 的
// 「表格」卡片），而且标准写法、`> ` 引用里的写法、不带首尾竖线的写法**三种都行**，
// 单元格内的 `**加粗**` 也生效。那套降级纯属多余，还把表格卡片降级成了纯列表。
//
// 所以整段删掉。**别再照着官方文档的"支持格式"清单加降级了** —— 那份清单不完整，
// 判断某个语法请用真机实测（见上面 toQQMarkdown 的注释）。

/**
 * 指令菜单 —— 帮助里列出的每条指令都做成一个按钮（点一下直接发出，不用打字）。
 *
 * 2026-10-29 用户要求："把所有指令都做成按钮，帮助里的"。
 *
 * 和 index.mjs 的 HELP_LINES 一一对应（守卫 #46 会逐条比对，防止两边漂移）：
 *   /帮助 /链接 /停止 /监听 /状态 /会话列表 /当前会话 /历史内容 /当前模型 /切换模型
 * 唯一没做成按钮的是 `/选择 N` —— 它需要带序号，按钮没法替你填参数
 * （帮助文本里仍然写着"回复「/选择 N」选中"）。
 *
 * 排布原则：常用的靠前，危险操作（/停止）单独放最后一行，避免误点。
 * label 都在 10 字符以内（QQ 硬限制）。
 */
export const QQ_COMMAND_MENU = [
  [{ label: '📖 帮助', data: '/帮助' }, { label: '📋 会话列表', data: '/会话列表' }, { label: '📜 历史内容', data: '/历史内容' }],
  [{ label: '📍 当前会话', data: '/当前会话' }, { label: '🤖 当前模型', data: '/当前模型' }, { label: '🔄 切换模型', data: '/切换模型' }],
  [{ label: '👂 监听', data: '/监听' }, { label: '📊 状态', data: '/状态' }, { label: '🔗 链接', data: '/链接' }],
  // 「停止」是唯一的破坏性操作 → 挂二次确认（2026-10-31 真机验证 modal 有效），
  // style 3 = 白底红字，视觉上也是"危险按钮"。
  [{
    label: '⏹ 停止', data: '/停止', style: 3,
    modal: {
      content: '确定要停止远程服务吗？停止后手机就访问不了 DSH 了。',
      confirm_text: '停止',
      cancel_text: '取消',
    },
  }],
];

/**
 * 监听通知用的精简按钮 —— 通知是高频的，挂整个菜单会太吵，只放三个最常用的。
 */
export const QQ_NOTIFY_MENU = [
  [{ label: '📜 最近回复', data: '/历史内容' }, { label: '📋 会话列表', data: '/会话列表' }],
  [{ label: '🤖 当前模型', data: '/当前模型' }],
];

/**
 * 构造一条消息的内嵌键盘（按钮）。
 *
 * 用法（2026-10-29 真机实测通过，行为与第三方机器人「貂貂」一致）：
 *   const kb = makeQQKeyboard([
 *     [{ label: '📜 最近回复', data: '/历史' }, { label: '📋 会话列表', data: '/会话' }],
 *     [{ label: '🤖 当前模型', data: '/模型' }],
 *   ]);
 *   await ch.send(target, text, { md: true, keyboard: kb });
 *
 * ⚠ 两个**必须**知道的坑（都踩过）：
 *
 * 1) **`permission` 必须给**。官方 API 字段表把它标成"非必填"，但**不传的后果是
 *    "点了提示没有权限"** —— 实测：不传 permission 时，电脑端宽松地把指令填进输入框，
 *    手机端直接报"没有权限"。不传 ≈ 指定用户名单为空 → 谁都不能点。
 *    所以这里默认 `{ type: 2 }`（所有人）。要限定范围再自己传 permission。
 *
 * 2) **想"点一下直接发送"必须 `enter: true`**。否则只是把指令塞进输入框，要用户再点发送。
 *    `enter` **仅单聊（c2c）有效**，群聊里仍然只能填入。需要手机 QQ 8983+。
 *
 * 另外：`label` **最多 10 字符**（超了服务端会拒），所以这里做截断；
 * 图标只能靠 emoji 拼进 label（`render_data` 不支持图片）。
 *
 * @param {Array<Array<object>>} rows 每行一组按钮
 * @param {object} [defaults] 覆盖默认值：permission / enter / unsupport_tips
 * @returns {{content:{rows:Array<{buttons:Array<object>}>}}}
 */
export function makeQQKeyboard(rows, defaults) {
  const d = defaults || {};
  const permission = d.permission || { type: 2 };
  const enter = d.enter !== false; // 默认 true —— 点一下直接发（单聊）
  const tips = typeof d.unsupport_tips === 'string' ? d.unsupport_tips : '请升级手机QQ后使用按钮';
  const clamp = function (s) {
    const t = String(s == null ? '' : s);
    // 按字符数截断（label 上限 10 字符，emoji 也算字符）
    return Array.from(t).slice(0, 10).join('');
  };
  // ⚠ 按钮 ID 必须**整个键盘内唯一**（官方原话："id 按钮 ID。同一键盘内唯一"）。
  // 踩过的坑（2026-10-30，用户："没有按钮"）：这里原先是 `'b' + idx`，idx 是**行内**序号，
  // 于是 4 行 10 个按钮只有 b0/b1/b2 三个不同 ID —— 撞车后**整块键盘被静默丢弃**：
  // 接口照样返回 HTTP 200，消息正常送达，但一个按钮都不显示，也没有任何报错。
  // 现在用**全局递增**计数，并对调用方传进来的重复 id 自动加后缀去重。
  const used = Object.create(null);
  const uniqId = function (want) {
    let id = String(want == null || want === '' ? '' : want);
    if (!id) {
      let k = 0;
      while (used['auto' + k]) k++;
      id = 'auto' + k;
    }
    let final = id;
    let n = 1;
    while (used[final]) final = id + '_' + (n++);
    used[final] = true;
    return final;
  };
  return {
    content: {
      rows: (rows || []).map(function (btns) {
        return {
          buttons: (btns || []).map(function (b) {
            return {
              id: uniqId(b.id),
              render_data: {
                label: clamp(b.label),
                visited_label: clamp(b.visited_label || b.label),
                style: typeof b.style === 'number' ? b.style : 1,
              },
              action: {
                type: typeof b.type === 'number' ? b.type : 2, // 0=跳转 1=回调 2=指令
                permission: b.permission || permission,
                data: String(b.data == null ? '' : b.data),
                enter: enter,
                unsupport_tips: tips,
                // 二次确认弹窗（2026-10-31 真机验证通过）：
                // 点按钮先弹确认框，确定后才执行 —— 危险操作（/停止）防误点用。
                // content ≤40 字；confirm_text/cancel_text 可省略（默认「确定/取消」）。
                ...(b.modal && typeof b.modal === 'object' ? { modal: b.modal } : {}),
              },
            };
          }),
        };
      }),
    },
  };
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
 * 判断会话目标是否发生变化（纯函数，便于单测）。
 *
 * 为什么需要它：持久化推送目标时必须去重（否则群聊活跃时每条消息都同步落盘一次
 * 整个状态文件 = 写放大）。而"旧值"只有通道自己在覆盖前才知道 ——
 * 所以判断放在通道内，不要在调用方的 onMessage 里拿 getLastTarget() 去比：
 * 那时通道已经把新值写进 state 了，比较恒等 → 永远不会落盘（真实踩过的坑）。
 */
export function targetChanged(prev, next) {
  if (!next || !next.scope || !next.targetId) return false; // 非法目标不算"变化"
  if (!prev || !prev.scope || !prev.targetId) return true;
  return prev.scope !== next.scope || String(prev.targetId) !== String(next.targetId);
}

/**
 * 创建 QQ 官方机器人通道实例。
 * @param {object} options
 * @param {(msg: object) => Promise<string|null>} [options.onMessage] 收到消息，返回回复文本
 * @param {(target: {scope: string, targetId: string}) => void} [options.onTargetChange]
 *        会话目标**真正发生变化**时才回调（调用方据此持久化，天然去重）
 * @param {(level: string, text: string) => void} [options.onLog] 日志回调
 * @param {string} [options.sessionsDir] 会话持久化目录（用于 RESUME 补发；留空则用内存）
 * @param {boolean} [options.sdkDebug] 是否把 SDK 内部日志转发到 onLog（默认关闭，避免刷屏）
 */
export function createQQBotChannel(options) {
  const opt = options || {};
  const onMessage = typeof opt.onMessage === 'function' ? opt.onMessage : null;
  const onTargetChange = typeof opt.onTargetChange === 'function' ? opt.onTargetChange : null;
  // 由调用方按"回复文本"决定要不要挂按钮（例如「会话列表」→ 每个会话一个按钮）。
  // 通道自己不碰 sessionQuery，保持职责单一；拿不到就返回 null。
  const replyKeyboardFor = typeof opt.replyKeyboardFor === 'function' ? opt.replyKeyboardFor : null;
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
      // 记录主动推送目标（去掉 msgId → 后续推送走 proactive）。
      // 注意顺序：先分辨"是否变化"（要用覆盖前的旧值），再覆盖，
      // 最后才通知调用方落盘 —— 调用方拿不到旧值，判断必须在这里做。
      const prevTarget = state.lastTarget;
      const nextTarget = { scope: scope, targetId: targetId };
      const changed = targetChanged(prevTarget, nextTarget);
      state.lastTarget = nextTarget;
      state.lastTargetAt = Date.now();
      if (changed && onTargetChange) {
        try {
          const r = onTargetChange({ scope: scope, targetId: targetId });
          // 回调若返回 Promise，兜住可能的 rejection，绝不让它冒泡进 SDK
          if (r && typeof r.catch === 'function') {
            r.catch((e) => logErr('目标变更回调失败：' + ((e && e.message) || e)));
          }
        } catch (e) {
          logErr('目标变更回调异常：' + ((e && e.message) || e));
        }
      }

      const text = String(msg.content == null ? '' : msg.content).trim();
      const isGroup = scope === 'group' || msg.kind === 'group';
      // 图片/语音/文件等附件由 SDK 解析在 msg.attachments（每项含 content_type + url）。
      // 此前只读 msg.content，于是**纯图片消息**（没有文字）被下面那行 `if (!text) return`
      // 直接丢掉 —— 实测日志印证过：`[qqbot] 收到消息 from 某人 (群):`（冒号后为空）。
      const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
      log('收到消息 from ' + (msg.senderName || msg.senderId || '?') + (isGroup ? ' (群)' : ' (私聊)')
        + (attachments.length ? ' [附件 ' + attachments.length + ']' : '') + ': ' + text.slice(0, 60));
      // 没文字**也没有附件**才丢；有附件就继续往上走
      if (!text && attachments.length === 0) return;

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
            attachments: attachments,
            raw: msg,
          });
        } catch (e) {
          logErr('命令处理出错：' + ((e && e.message) || e));
          reply = '[处理出错: ' + ((e && e.message) || e) + ']';
        }
      }
      if (reply) {
        try {
          // 回复时带上 msgId，QQ 侧显示为"引用回复"。
          // md: true → 指令回复也走 QQ markdown（用户 2026-10-19 决定"指令回复也走"）：
          // /历史内容 这类会把会话正文（可能带表格）发回来，纯文本会满屏符号。
          // 转换（表格→列表等）由 sendRaw 里的 toQQMarkdown 统一处理。
          //
          // 按钮（2026-10-29 用户要求"把所有指令都做成按钮"）：
          //   · /帮助 的回复 → 挂上 QQ_COMMAND_MENU（帮助里列的每条指令一个按钮）
          //   · 其它回复     → 不挂，避免每条回执都拖一排按钮
          // 判断方式：帮助文本里必定含 `· /帮助` 这一行（HELP_LINES 的第一条），
          // 其它回复不会出现这个片段 —— 比让 onMessage 改返回值省事得多，
          // 而且不会影响另外四个通道（它们共用同一个 onMessage 契约：返回字符串）。
          const _isHelp = typeof reply === 'string' && reply.indexOf('· /帮助') >= 0;
          // 「会话列表」这类回复的按钮由调用方给（它才知道会话 id/标题）：
          //   replyKeyboardFor(reply) → keyboard | null
          let _kb = _isHelp ? makeQQKeyboard(QQ_COMMAND_MENU) : null;
          if (!_kb && replyKeyboardFor) {
            try { _kb = replyKeyboardFor(reply) || null; } catch (e) { _kb = null; }
          }
          await sendRaw({ scope: scope, targetId: targetId, msgId: target && target.msgId }, reply, {
            md: true,
            keyboard: _kb,
          });
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

  /**
   * 底层发送（自动分片）；target 带 msgId = 回复，不带 = 主动推送。
   *
   * `opts.md === true` → 走 **QQ markdown 消息**（`msg_type=2`），并先用 `toQQMarkdown`
   * 把 QQ 不支持的语法（表格等）降级。默认仍走纯文本，避免影响指令回复等既有行为。
   *
   * 若 SDK 版本没有 `sendMarkdown`，自动退回 `sendText` —— 绝不因为缺方法而发不出去。
   */
  async function sendRaw(target, text, opts) {
    if (!bot) throw new Error('QQ 通道未启动');
    if (!target || !target.targetId) throw new Error('发送目标无效');
    const useMd = !!(opts && opts.md) && typeof bot.sendMarkdown === 'function';
    const body = useMd ? toQQMarkdown(text) : text;
    const parts = splitForQQ(body);
    // 内嵌键盘（按钮）只挂在**最后一片**上 —— 分片时前面几片是正文续接，
    // 每片都挂一排按钮很吵，而且同一键盘重复出现没有意义。
    const kb = (opts && opts.keyboard) || null;
    let last = null;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await sleep(CHUNK_GAP_MS); // 分片间隔，避免限流
      const tgt = {
        scope: target.scope || 'c2c',
        targetId: target.targetId,
        msgId: target.msgId || undefined, // 不带 msgId → proactive
      };
      // ⚠ SDK 的参数名踩过坑（2026-10-29，用户报"帮助没有按钮"）：
      //   bot.sendMarkdown(target, content, opts) 里字段叫 **opts.keyboard**，
      //   不是 `inlineKeyboard`（那是更底层 protocol 层的字段名，写错了会被当成 undefined，
      //   消息照发、**按钮静默丢失**，日志里也看不出任何异常）。
      //   而 bot.sendText(target, content) **根本没有 opts 参数** —— 纯文本要带按钮
      //   得用专门的 sendTextWithKeyboard(target, content, inlineKeyboard)。
      const hasKb = !!(kb && i === parts.length - 1);
      if (useMd) {
        last = await bot.sendMarkdown(tgt, parts[i], hasKb ? { keyboard: kb } : undefined);
      } else if (hasKb && typeof bot.sendTextWithKeyboard === 'function') {
        last = await bot.sendTextWithKeyboard(tgt, parts[i], kb);
      } else {
        last = await bot.sendText(tgt, parts[i]);
      }
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
            // 这里原来打一条「已连接 QQ 机器人（AppID …）」，与 index.mjs 启动路径的
            // 「[qqbot] 已连接（AppID …，监听 开/关）」**完全重复**（每次启动两行说同一件事）。
            // 连接状态在 /remote/info 与面板里都有；启动那条带监听状态、信息更全，所以静默这条。
            // 重连/断线恢复另有 resumed 事件（"连接已恢复（RESUME…）"），不会丢信号。
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

    /** 主动发送（不带 msgId → proactive）；target 形如 { scope, targetId }
     *  opts.md = true 时按 QQ markdown 消息发送（表格等自动降级） */
    async send(target, text, opts) {
      if (!bot || !state.running) throw new Error('QQ 通道未启动');
      return sendRaw(target, text, opts);
    },

    /**
     * 主动发送图片（上传 + 发送一步到位，SDK 的 sendImage 封装）。
     *
     * source 形如 { localPath } | { url } | { buffer }。
     * 已实测（2026-10-07）：**主动消息可带图**，本地文件与网络 URL 都成功，
     * 不需要额外权限 —— 上传 /v2/groups/{openid}/files 拿 file_info，
     * 再用 msg_type=7 发送，两步都由 SDK 内部完成。
     */
    async sendImage(target, source, content) {
      if (!bot || !state.running) throw new Error('QQ 通道未启动');
      if (!target || !target.targetId) throw new Error('发送目标无效');
      if (!source || (!source.localPath && !source.url && !source.buffer)) throw new Error('图片来源无效');
      const r = await bot.sendImage(
        { scope: target.scope || 'c2c', targetId: target.targetId },
        source,
        content ? { content: String(content) } : undefined
      );
      state.lastSentAt = Date.now();
      return r;
    },

    /** 最近一次会话目标（监听通知推送用） */
    getLastTarget() {
      return state.lastTarget ? { scope: state.lastTarget.scope, targetId: state.lastTarget.targetId } : null;
    },

    /**
     * 恢复上次的会话目标（调用方在启动时从持久化里取出后注入）。
     * 这样重启 DSH 后无需再给机器人发一条消息，监听通知也能主动推送。
     */
    setLastTarget(target) {
      try {
        if (!target || !target.scope || !target.targetId) return false;
        if (target.scope !== 'c2c' && target.scope !== 'group') return false;
        state.lastTarget = { scope: target.scope, targetId: String(target.targetId) };
        state.lastTargetAt = Date.now();
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
