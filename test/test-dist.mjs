// 分发包集成测试：起一个假的"DSH 服务器"(127.0.0.1:18080)，
// 用 createProxyServer 起 HTTP(18081)+HTTPS(18082)，验证鉴权/302/gzip/WS/HTTPS。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
// 注意：lib/index.mjs 是 composition 插件，只导出 name/inject/apply；
// 这些可测工具函数在各自的模块里。
import { createProxyServer } from '../lib/proxy.mjs';
import { generateSelfSignedCert, lanIPs } from '../lib/cert.mjs';
import { INJECT_SCRIPT } from '../lib/panel.mjs';
import { createQQBotChannel, targetChanged } from '../lib/qqbot.mjs';

const TARGET = 18080;
const HTTP_PORT = 18081;
const HTTPS_PORT = 18082;
const QQ_PORT = 18083;

// 假 DSH 服务器
const target = http.createServer((req, res) => {
  if (req.url === '/big') {
    const body = 'x'.repeat(100000);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ hello: 'dsh', url: req.url, host: req.headers.host }));
});
let wsAccepted = false;
target.on('upgrade', (req, socket) => {
  wsAccepted = true;
  const key = req.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.write(Buffer.from([0x81, 0x02, 0x6f, 0x6b])); // text "ok"
});

await new Promise(r => target.listen(TARGET, '127.0.0.1', r));

// 代理服务器
const cert = generateSelfSignedCert(lanIPs());
fs.writeFileSync('E:/DeepSeek Harness/.dsh/tools/t-key.pem', cert.key);
fs.writeFileSync('E:/DeepSeek Harness/.dsh/tools/t-cert.pem', cert.cert);
const proxy = createProxyServer({ targetPort: TARGET, pfxPath: '', pfxPass: '' });
await proxy.start(HTTP_PORT, HTTPS_PORT);
const TOKEN = proxy.token;
console.log('proxy started, token =', TOKEN);

// 1. 无 token → 403
await new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: HTTP_PORT, path: '/api/x' }, r => {
    console.log('1. no-token status:', r.statusCode, '(expect 403)');
    r.resume(); r.on('end', res);
  }).on('error', rej);
});

// 2. ?token= → 302 + set-cookie
await new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: HTTP_PORT, path: '/api/x?token=' + TOKEN }, r => {
    console.log('2. token-query status:', r.statusCode, '(expect 302)');
    console.log('   set-cookie:', JSON.stringify(r.headers['set-cookie']));
    r.resume(); r.on('end', res);
  }).on('error', rej);
});

// 3. cookie → 200 且转发到目标
const cookie = 'dshr_token=' + TOKEN;
await new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: HTTP_PORT, path: '/api/x', headers: { Cookie: cookie } }, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      console.log('3. cookie status:', r.statusCode, '(expect 200)');
      console.log('   body:', d.slice(0, 80));
      res();
    });
  }).on('error', rej);
});

// 4. gzip 大响应
await new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: HTTP_PORT, path: '/big', headers: { Cookie: cookie, 'Accept-Encoding': 'gzip' } }, r => {
    let d = Buffer.alloc(0);
    r.on('data', c => d = Buffer.concat([d, c]));
    r.on('end', () => {
      console.log('4. gzip status:', r.statusCode, 'encoding:', r.headers['content-encoding'], 'size:', d.length, '(expect gzip, <100000)');
      res();
    });
  }).on('error', rej);
});

// 5. HTTPS 握手 + cookie
await new Promise((res, rej) => {
  https.get({ host: '127.0.0.1', port: HTTPS_PORT, path: '/api/x', headers: { Cookie: cookie }, rejectUnauthorized: false }, r => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      console.log('5. https status:', r.statusCode, '(expect 200) body:', d.slice(0, 60));
      res();
    });
  }).on('error', rej);
});

// 6. WS 升级（简化验证）
await new Promise((res, rej) => {
  const timer = setTimeout(() => { console.log('6. WS TIMEOUT'); rej(new Error('ws timeout')); }, 5000);
  const ws = http.request({
    host: '127.0.0.1', port: HTTP_PORT, path: '/ws', method: 'GET',
    headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': 13, 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Cookie: cookie },
  });
  ws.on('upgrade', (r, socket) => {
    clearTimeout(timer);
    console.log('6. ws upgrade OK, target accepted:', wsAccepted);
    socket.destroy();
    res();
  });
  ws.on('response', (r) => { console.log('6. got response status', r.statusCode, 'instead of upgrade'); r.resume(); clearTimeout(timer); rej(new Error('no upgrade')); });
  ws.on('error', (e) => { clearTimeout(timer); rej(e); });
  ws.end();
});

// 7. QQ(NapCat) 桥已移除 —— 改为断言代码库里不再残留它的引用，
//    避免以后有人把 qq.mjs 加回来却忘了同步面板/文档。
{
  const files = ['../lib/index.mjs', '../lib/panel.mjs'];
  for (const rel of files) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const needle of ['createQQServer', 'qqServer', 'qqPortStart', 'NapCat', 'OneBot']) {
      if (src.includes(needle)) {
        console.error(`7. ${rel} 仍残留已移除的 QQ(NapCat) 引用：${needle}`);
        process.exit(1);
      }
    }
  }
  if (fs.existsSync(new URL('../lib/qq.mjs', import.meta.url))) {
    console.error('7. lib/qq.mjs 仍存在 —— 该通道已移除');
    process.exit(1);
  }
  console.log('7. QQ(NapCat) 移除守卫 OK（无残留引用、文件已删）');
}

// 8. INJECT_SCRIPT 语法校验（关键回归测试）
// panel.mjs 里 INJECT_SCRIPT 是模板字面量：任何 \n 之类的转义会被模板引擎
// 提前解释成真实字符，导致注入到浏览器的脚本跨行/崩溃——表现是"Dsh 界面上按钮全没了"。
// node --check panel.mjs 只验证外层模块，抓不到这个错误，故在此对内层脚本单独编译。
{
  const src = String(INJECT_SCRIPT || '');
  if (!src.length) { console.error('8. INJECT_SCRIPT 为空'); process.exit(1); }
  try {
    // eslint-disable-next-line no-new-func
    new Function(src); // 仅编译不执行 —— 编译器就是权威：真实的换行/转义事故会在此报语法错误
    console.log('8. INJECT_SCRIPT 编译通过，长度', src.length);
  } catch (e) {
    console.error('8. INJECT_SCRIPT 语法错误:', e.message);
    process.exit(1);
  }
  // 关键入口必须仍在（防止整体结构被改坏）
  for (const marker of ['function create', 'function openPanel', 'function renderBotPage', 'function renderStatus']) {
    if (src.indexOf(marker) < 0) { console.error('8. INJECT_SCRIPT 缺少入口:', marker); process.exit(1); }
  }
  console.log('8. 注入脚本完整性 OK');
}

// 9. 作用域守卫：if(webServer){} 块内声明的函数，不能在块外被使用
// 背景（真实踩过的两个坑）：
//   a) channelHealthSnapshot 定义在 if(webServer){} 内，被块外的 snapshot() 调用
//      → /remote/info 抛 ReferenceError → webServer 直接断连（面板"获取状态失败"）
//   b) telegramStop 同样被块外的销毁清理调用 → 卸载时抛错
// 注意：不能用"缩进"判断作用域（函数体内部的调用缩进也 >2），必须按块的行范围判断。
{
  const src = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  const lines = src.split('\n');
  const ifIdx = lines.findIndex((l) => /^  if \(webServer\) \{\s*$/.test(l));
  if (ifIdx < 0) { console.error('9. 找不到 `if (webServer) {` 块'); process.exit(1); }
  let endIdx = ifIdx + 1;
  while (endIdx < lines.length && !/^  \}\s*$/.test(lines[endIdx])) endIdx++;
  if (endIdx >= lines.length) { console.error('9. if(webServer) 块未闭合'); process.exit(1); }

  // 块内声明的函数名
  const inner = new Set();
  for (let i = ifIdx + 1; i < endIdx; i++) {
    const m = lines[i].match(/^\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (m) inner.add(m[1]);
  }
  if (!inner.size) { console.error('9. if(webServer) 块内未检出函数声明（守卫可能失效）'); process.exit(1); }

  // 在块外查找这些名字的使用
  const problems = [];
  lines.forEach((l, i) => {
    if (i > ifIdx && i < endIdx) return;                 // 块内，跳过
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;            // 注释，跳过
    inner.forEach((name) => {
      if (new RegExp('\\b' + name + '\\b').test(l)) {
        problems.push(name + '：第 ' + (i + 1) + ' 行在 if(webServer) 块外被使用，但只在块内（第 ' + (ifIdx + 1) + '-' + (endIdx + 1) + ' 行）声明');
      }
    });
  });
  if (problems.length) {
    console.error('9. 作用域守卫失败:\n  ' + problems.join('\n  '));
    process.exit(1);
  }
  console.log('9. 作用域守卫 OK（块内 ' + inner.size + ' 个函数声明，块外无误用）');
}

// 10. QQ 推送目标：变更判断（纯函数真值表）
// 背景：3.2.1 曾在调用方的 onMessage 里用 getLastTarget() 与来消息比较去做去重，
// 但通道在那之前已把新值写进 state → 比较恒等 → 目标永远不落盘（静默失效）。
// 判断必须基于"覆盖前的旧值"，即本函数。
{
  const cases = [
    // [prev, next, 期望 changed, 说明]
    [null, { scope: 'c2c', targetId: 'A' }, true, '首次（无旧值）'],
    [{ scope: 'c2c', targetId: 'A' }, { scope: 'c2c', targetId: 'A' }, false, '完全相同 → 不该落盘'],
    [{ scope: 'c2c', targetId: 'A' }, { scope: 'c2c', targetId: 'B' }, true, 'targetId 变了'],
    [{ scope: 'c2c', targetId: 'A' }, { scope: 'group', targetId: 'A' }, true, 'scope 变了'],
    [{ scope: 'c2c', targetId: 123 }, { scope: 'c2c', targetId: '123' }, false, '数字/字符串应视为同一目标'],
    [null, null, false, '非法 next 不算变化'],
    [null, { scope: 'c2c', targetId: '' }, false, '空 targetId 不算变化'],
    [null, { scope: '', targetId: 'A' }, false, '空 scope 不算变化'],
    [{ scope: 'c2c', targetId: 'A' }, undefined, false, 'undefined next 不算变化'],
  ];
  let pass = 0;
  const fails = [];
  for (const [prev, next, want, desc] of cases) {
    const got = targetChanged(prev, next);
    if (got === want) pass++; else fails.push(desc + '：期望 ' + want + ' 实得 ' + got);
  }
  if (fails.length) { console.error('10. targetChanged 失败:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('10. targetChanged 真值表 OK（' + pass + '/' + cases.length + '）');
}

// 11. QQ 推送目标：setLastTarget 入参校验（恢复持久化目标时必须拒绝脏数据）
{
  const ch = createQQBotChannel({});
  const cases = [
    [null, false, 'null'],
    [{}, false, '空对象'],
    [{ scope: 'c2c', targetId: '' }, false, '缺 targetId'],
    [{ scope: 'bad', targetId: 'x' }, false, '非法 scope'],
    [{ scope: 'c2c', targetId: 'ABC' }, true, '合法 c2c'],
    [{ scope: 'group', targetId: 'G1' }, true, '合法 group'],
  ];
  let pass = 0;
  const fails = [];
  for (const [inp, want, desc] of cases) {
    const got = ch.setLastTarget(inp);
    if (got === want) pass++; else fails.push(desc + '：期望 ' + want + ' 实得 ' + got);
  }
  const final = ch.getLastTarget();
  if (!final || final.scope !== 'group' || final.targetId !== 'G1') {
    fails.push('最终目标应为最后一次合法值 group/G1，实得 ' + JSON.stringify(final));
  }
  if (fails.length) { console.error('11. setLastTarget 校验失败:\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('11. setLastTarget 校验 OK（' + pass + '/' + cases.length + '）');
}

// 12. 结构守卫：lastTarget 落盘只能走 onTargetChange，不得写在 onMessage 里
// 这是第 10 项那个 bug 的形态守卫 —— 一旦有人把落盘挪回 onMessage（那里拿不到旧值），此处失败。
{
  const src = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  // 用带冒号的属性写法判断，避免注释里提到 onTargetChange 就误判为"已接线"
  if (src.indexOf('onTargetChange:') < 0) {
    console.error('12. index.mjs 缺少 onTargetChange 回调 —— 推送目标持久化没有接线');
    process.exit(1);
  }
  // 提取 QQ 通道的 onMessage 回调体。
  // 注意：文件里 onMessage 不止一处（Telegram 通道也有），必须先锚定 createQQBotChannel，
  // 否则会取到别的通道的回调体 —— 守卫会永远"通过"（自己踩过一次）。
  const chStart = src.indexOf('createQQBotChannel(');
  if (chStart < 0) { console.error('12. 找不到 createQQBotChannel 调用'); process.exit(1); }
  const start = src.indexOf('onMessage:', chStart);
  if (start < 0) { console.error('12. qqbot 通道缺少 onMessage'); process.exit(1); }
  let depth = 0, began = false, end = start;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { depth++; began = true; }
    else if (c === '}') { depth--; if (began && depth === 0) { end = i; break; } }
  }
  const body = src.slice(start, end + 1);
  // 去掉注释再判断 —— 否则解释性注释里提到 getLastTarget 就会误报
  // （`//` 前是反斜杠时不是注释，见第 15 项的说明）
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\\])\/\/[^\n]*/gm, '$1');
  if (code.indexOf('qqbotSaveConfig') >= 0) {
    console.error('12. onMessage 里出现 qqbotSaveConfig —— 那里拿不到覆盖前的旧值，去重必然失效；请改用 onTargetChange');
    process.exit(1);
  }
  if (code.indexOf('getLastTarget') >= 0) {
    console.error('12. onMessage 里出现 getLastTarget —— 通道此时已写入新值，比较恒等，会导致目标永不落盘');
    process.exit(1);
  }
  console.log('12. 落盘路径守卫 OK（仅在 onTargetChange 内落盘）');
}

// 13. 反引号守卫：panel.mjs 整体是**模板字符串**（INJECT_SCRIPT = `...`）
// 注释或字符串里一旦出现反引号，就会提前截断模板字符串 →
// 模块本身解析失败，或注入脚本语法错误（浏览器端整个面板脚本不执行）。
// 这个坑踩过两次（一次是注释里写反引号，一次是把 \n 写成真换行），
// 所以用一条明确的守卫代替"靠人记得"。
{
  const src = fs.readFileSync(new URL('../lib/panel.mjs', import.meta.url), 'utf8');
  const ticks = (src.match(/`/g) || []).length;
  if (ticks !== 2) {
    const bad = [];
    src.split('\n').forEach((line, i) => { if (line.includes('`')) bad.push(`L${i + 1}: ${line.trim().slice(0, 90)}`); });
    console.error(`13. panel.mjs 反引号数量异常：${ticks} 个（应为 2 个，即模板字符串首尾定界符）`);
    console.error('    多出来的反引号会截断 INJECT_SCRIPT 模板字符串。出现位置：');
    bad.forEach((l) => console.error('      ' + l));
    process.exit(1);
  }
  // 顺带确认导出确实是个能解析的脚本（真正的语法校验在 8 里做）
  if (src.indexOf('export const INJECT_SCRIPT = `') < 0) {
    console.error('13. panel.mjs 里找不到 INJECT_SCRIPT 的模板字符串声明');
    process.exit(1);
  }
  console.log('13. 反引号守卫 OK（2 个定界符，模板字符串未被截断）');
}

// 14. 钉钉通道模块：导出、纯函数、API 形状
// 关键点：dingtalk.mjs 内部用**动态 import** 加载 SDK，所以这里 import 它不需要装 dingtalk-stream。
{
  const dt = await import('../lib/dingtalk.mjs');
  const need = ['createDingTalkChannel', 'stripDingTalkMention', 'splitForDingTalk', 'classifyDingTalkError', 'targetChanged'];
  const miss = need.filter((k) => typeof dt[k] !== 'function');
  if (miss.length) { console.error('14. dingtalk.mjs 缺少导出：' + miss.join(', ')); process.exit(1); }

  // 群聊 @ 前缀：官方样例是「服务端已剥离，只留前导空格」→ 只 trim；
  // 若真残留 @机器人 前缀且后面是命令，则剥掉；但「@张三 帮我看下」这类正文不能被吃掉。
  const cases = [
    [' 你好', '你好', '私聊/群聊前导空格'],
    ['/帮助', '/帮助', '命令原样'],
    ['@DSH机器人 /状态', '/状态', '残留 @机器人 + 命令 → 剥'],
    ['@张三 帮我看下这个', '@张三 帮我看下这个', '正文里的 @ 不能吃'],
    ['@张三', '@张三', '只有 @名字 时原样'],
    ['', '', '空串'],
  ];
  const bad = [];
  for (const [inp, want, desc] of cases) {
    const got = dt.stripDingTalkMention(inp);
    if (got !== want) bad.push(desc + '：期望 ' + JSON.stringify(want) + ' 实得 ' + JSON.stringify(got));
  }
  if (bad.length) { console.error('14. stripDingTalkMention 行为不符:\n  ' + bad.join('\n  ')); process.exit(1); }

  // 分片：短文本原样；长文本必须切且不丢内容
  const short = dt.splitForDingTalk('短');
  if (short.length !== 1 || short[0] !== '短') { console.error('14. 短文本不该分片'); process.exit(1); }
  const long = 'a'.repeat(9000);
  const parts = dt.splitForDingTalk(long);
  if (parts.length < 2 || parts.join('') !== long) { console.error('14. 长文本分片丢内容：' + parts.length + ' 片'); process.exit(1); }
  if (parts.some((p) => p.length > 4000)) { console.error('14. 分片超过 4000 字上限'); process.exit(1); }

  // 错误归类：面板靠它给"人话"提示，映射不能退化
  const kinds = [
    [{ message: 'Forbidden.AccessDenied.AccessTokenPermissionDenied 没有调用该接口的权限' }, 'permission'],
    [{ message: 'invalidClientId' }, 'credential'],
    [{ message: 'code 40001 invalid access_token' }, 'token'],
    [{ message: 'sessionWebhook 已过期' }, 'webhook'],
    [{ message: 'ECONNRESET socket hang up' }, 'network'],
    [{ message: '莫名其妙' }, 'unknown'],
  ];
  const kbad = [];
  for (const [err, want] of kinds) {
    const got = dt.classifyDingTalkError(err);
    if (got !== want) kbad.push(JSON.stringify(err.message) + ' → ' + got + '（期望 ' + want + '）');
  }
  if (kbad.length) { console.error('14. classifyDingTalkError 归类错误:\n  ' + kbad.join('\n  ')); process.exit(1); }

  // API 形状：index.mjs 依赖这些方法名
  const ch = dt.createDingTalkChannel({});
  const api = ['start', 'stop', 'reconnect', 'send', 'reply', 'verify', 'getLastTarget', 'setLastTarget', 'status'];
  const amiss = api.filter((k) => typeof ch[k] !== 'function');
  if (amiss.length) { console.error('14. 通道实例缺少方法：' + amiss.join(', ')); process.exit(1); }
  const st = ch.status();
  if (typeof st.running !== 'boolean' || typeof st.health !== 'string' || st.health !== 'ok') {
    console.error('14. status() 形状异常：' + JSON.stringify(st)); process.exit(1);
  }
  // 未连接时 send 必须抛错（不能静默丢弃通知）
  let threw = false;
  try { await ch.send({ scope: 'c2c', targetId: 'u1' }, 'x'); } catch (e) { threw = true; }
  if (!threw) { console.error('14. 未启动时 send 应该抛错'); process.exit(1); }
  // 空凭证的 verify 不能打网络，直接返回失败
  const v = await ch.verify('', '');
  if (v.ok) { console.error('14. 空凭证 verify 不应通过'); process.exit(1); }
  console.log('14. 钉钉通道模块 OK（导出/纯函数/API 形状）');
}

// 15. 五通道命令对齐矩阵
// 用户要求"按微信的指令把其他端都补全"——这个守卫保证新增通道（以及以后重构）不会漏掉共享命令。
// 之前 QQ官方 就漏了 8 项，靠人肉 review 才发现。
{
  const src = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  function bodyOf(marker) {
    const start = src.indexOf(marker);
    if (start < 0) return null;
    let depth = 0, began = false, end = start;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (c === '{') { depth++; began = true; }
      else if (c === '}') { depth--; if (began && depth === 0) { end = i; break; } }
    }
    return src.slice(start, end + 1);
  }
  const handlers = {
    'Telegram': 'async function telegramHandleCommand(',
    'QQ官方': 'async function qqbotHandleCommand(',
    '飞书': 'async function feishuHandleCommand(',
    '钉钉': 'async function dingtalkHandleCommand(',
  };
  const shared = [
    'channelHelp(',
    'cmdSessionList(',
    'cmdSelectSession(',
    'cmdCurrentSession(',
    'cmdHistory(',
    'cmdCurrentModel(',
    'cmdSwitchModel(',
    'cmdPickEffort(',
    'cmdRelayToSession(',
  ];
  const problems = [];
  for (const [name, marker] of Object.entries(handlers)) {
    const body = bodyOf(marker);
    if (!body) { problems.push(name + '：找不到 ' + marker); continue; }
    // 去注释时注意：`//` 前面是反斜杠的情况（例如 !/^\//.test(t)）不是注释，
    // 早先的 /\/\/[^\n]*/ 会把那一行的 relay 调用一起吃掉，导致守卫误报（踩过）。
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\\])\/\/[^\n]*/gm, '$1');
    const lack = shared.filter((k) => code.indexOf(k) < 0);
    if (lack.length) problems.push(name + ' 缺少共享命令：' + lack.join(', '));
  }
  if (problems.length) { console.error('15. 通道命令对齐失败:\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('15. 五通道命令对齐 OK（4 个非微信通道 × ' + shared.length + ' 项共享命令）');
}

// 16. 监听守卫完整性：禁止再出现"只列两三个通道"的字面量判断
// 存量 bug：关掉飞书会把 Telegram/QQ 的监听一起停掉（`if (!weixinMonitorMode)` 一处写漏）。
// 现在统一走 anyMonitorOn()，这里守住"不许回退"。
{
  const src = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  const flags = ['weixinMonitorMode', 'feishuMonitorMode', 'telegramMonitorMode', 'qqbotMonitorMode', 'dingtalkMonitorMode'];

  const amIdx = src.indexOf('function anyMonitorOn(');
  if (amIdx < 0) { console.error('16. 找不到 anyMonitorOn() —— 监听守卫被回退了'); process.exit(1); }
  const amBody = src.slice(amIdx, src.indexOf('}', amIdx));
  const lack = flags.filter((f) => amBody.indexOf(f) < 0);
  if (lack.length) { console.error('16. anyMonitorOn() 漏了通道：' + lack.join(', ')); process.exit(1); }

  // 字面量组合守卫：!xxxMonitorMode && !yyyMonitorMode 这种写法一律不允许
  const literal = src.match(/![a-z]+MonitorMode\s*&&\s*![a-z]+MonitorMode/g) || [];
  if (literal.length) {
    console.error('16. 又出现了字面量监听判断（漏通道的老 bug）：' + literal.join(' / '));
    console.error('    请改用 anyMonitorOn()');
    process.exit(1);
  }

  // 每个 stopMonitor() 调用点都必须在 anyMonitorOn() 的守卫内
  const lines = src.split('\n');
  let sites = 0;
  const unguarded = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('stopMonitor()') < 0) continue;
    if (lines[i].indexOf('function stopMonitor') >= 0) continue;
    sites++;
    const win = lines.slice(Math.max(0, i - 4), i + 1).join('\n');
    if (win.indexOf('anyMonitorOn()') < 0) unguarded.push('L' + (i + 1) + ': ' + lines[i].trim());
  }
  if (unguarded.length) {
    console.error('16. 以下 stopMonitor() 调用没有被 anyMonitorOn() 守卫：\n  ' + unguarded.join('\n  '));
    process.exit(1);
  }
  if (sites < 5) { console.error('16. stopMonitor() 调用点只有 ' + sites + ' 处（预期 ≥5），守卫可能失效'); process.exit(1); }
  console.log('16. 监听守卫完整性 OK（5 通道统一判定，' + sites + ' 处调用全被守卫）');
}

// 17. 钉钉接线：路由 + 面板入口
{
  const idx = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  const pan = fs.readFileSync(new URL('../lib/panel.mjs', import.meta.url), 'utf8');
  const routes = ['/remote/dingtalk/status', '/remote/dingtalk/config', '/remote/dingtalk/reconnect', '/remote/dingtalk/disconnect'];
  const miss = routes.filter((r) => idx.indexOf(r) < 0);
  if (miss.length) { console.error('17. index.mjs 缺少钉钉路由：' + miss.join(', ')); process.exit(1); }
  const pneed = ['/remote/dingtalk/config', '/remote/dingtalk/reconnect', '/remote/dingtalk/disconnect'];
  const pmiss = pneed.filter((r) => pan.indexOf(r) < 0);
  if (pmiss.length) { console.error('17. panel.mjs 缺少钉钉接口调用：' + pmiss.join(', ')); process.exit(1); }
  if (pan.indexOf("ch.id === 'dingtalk'") < 0) { console.error('17. panel.mjs 没有钉钉通道分支'); process.exit(1); }
  // 判断"有没有 selfManaged 排除 / 功能开发中占位"必须先去注释：
  // 演进说明的注释里正当地提到了这两个词，否则守卫会自己误报。
  const panCode = pan.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\\])\/\/[^\n]*/gm, '$1');
  if (panCode.indexOf('selfManaged') >= 0) {
    console.error('17. panel.mjs 又出现了 selfManaged 排除 —— 钉钉会再次失去「绑定/断开」入口');
    process.exit(1);
  }
  if (panCode.indexOf('功能开发中') >= 0) {
    console.error('17. panel.mjs 里仍有「功能开发中」占位文案');
    process.exit(1);
  }
  console.log('17. 钉钉接线 OK（4 条路由 + 面板绑定/断开/表单）');
}

// 18. 钉钉 SDK 用法守卫（踩错就"静默收不到消息"，必须靠断言守住）
//  ① 机器人消息是 CALLBACK 类型：必须 registerCallbackListener(TOPIC_ROBOT, ...)，
//     只调 registerAllEventListener 收不到消息；
//  ② CALLBACK 不自动 ACK：必须自己 socketCallBackResponse；
//  ③ keepAlive 默认 false（半死连接发现不了）→ 必须显式 true；
//  ④ 不能用 SDK 自带的 getAccessToken()（无缓存 + 旧版 GET 接口，每次回调都调会被限流）；
//  ⑤ sessionWebhook 回复的返回体是 {errcode,errmsg}，HTTP 200 不算成功 → 必须判 errcode。
{
  const src = fs.readFileSync(new URL('../lib/dingtalk.mjs', import.meta.url), 'utf8');
  // 只对**代码行**做判断：整行注释（// 和块注释的 * 行）剔除。
  // 这一点很关键 —— 文件顶部说明注释里正当地写了 registerCallbackListener / getAccessToken
  // 等字样，若拿原文判断，守卫会被注释"满足"（自检时真的踩到了）。
  // 用整行剔除而不是正则去 //，否则代码里 'https://…' 会被当成注释截掉。
  const codeOnly = src.split('\n')
    .filter((l) => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
    .join('\n');
  const need = [
    ['registerCallbackListener(', '机器人消息是 CALLBACK，必须注册 callback 监听'],
    ['TOPIC_ROBOT', '必须订阅机器人 topic'],
    ['socketCallBackResponse(', 'CALLBACK 不会自动 ACK，必须手动回'],
    ['keepAlive: true', 'keepAlive 默认 false，必须显式打开'],
    ['errcode', 'sessionWebhook 返回 {errcode,errmsg}，HTTP 200 不代表成功'],
    ['oauth2/accessToken', '主动推送用新版 access_token 接口'],
    ['openConversationId', '群聊推送字段'],
    ['userIds', '单聊推送字段'],
  ];
  const miss = need.filter(([k]) => codeOnly.indexOf(k) < 0).map(([k, why]) => k + '（' + why + '）');
  if (miss.length) { console.error('18. dingtalk.mjs 缺少关键实现：\n  ' + miss.join('\n  ')); process.exit(1); }
  if (codeOnly.indexOf('getAccessToken(') >= 0) {
    console.error('18. 用到了 SDK 自带的 getAccessToken()（无缓存 + 旧版接口）—— 自己缓存 token，别用它');
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (!pkg.dependencies || !pkg.dependencies['dingtalk-stream']) {
    console.error('18. package.json 未声明 dingtalk-stream 依赖');
    process.exit(1);
  }
  console.log('18. 钉钉 SDK 用法守卫 OK（CALLBACK 注册/ACK/keepAlive/token 缓存）');
}

// 19. 同步脚本必须带上新模块 —— 漏一个文件，部署副本就是旧的（踩过）
{
  const syncPath = 'E:/DeepSeek Harness/.dsh/tools/sync-dsh-web-remote.ps1';
  if (!fs.existsSync(syncPath)) {
    console.log('19. 同步脚本不在预期位置，跳过（非本机环境）');
  } else {
    const sync = fs.readFileSync(syncPath, 'utf8');
    // 每个 lib/ 下的模块都必须在清单里 —— 漏一个，部署副本就是旧代码（踩过：dingtalk.mjs）
    const libs = fs.readdirSync(new URL('../lib/', import.meta.url)).filter((f) => f.endsWith('.mjs'));
    const missing = libs.filter((f) => sync.indexOf('lib\\' + f) < 0);
    if (missing.length) {
      console.error('19. sync-dsh-web-remote.ps1 的文件清单缺少：' + missing.map((f) => 'lib\\' + f).join(', ')
        + ' —— 部署副本不会更新');
      process.exit(1);
    }
    // ⚠️ 必须带 UTF-8 BOM：脚本里有中文，Windows PowerShell 5.1 无 BOM 时会按 GBK 读，
    // 中文被解析坏 → 脚本**根本跑不起来**（踩过两次：一次是初次修复，一次是编辑器改写丢了 BOM）。
    const head = fs.readFileSync(syncPath).subarray(0, 3);
    if (!(head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF)) {
      console.error('19. sync-dsh-web-remote.ps1 丢了 UTF-8 BOM —— PowerShell 5.1 会按 GBK 读中文，脚本会直接报语法错');
      process.exit(1);
    }
    console.log('19. 同步脚本 OK（lib/ 下 ' + libs.length + ' 个模块全在清单里 + UTF-8 BOM 在）');
  }
}

// 20. 监听结果记账守卫：每个通道写入 monitorLastSendResult 都必须"追加"，不能直接赋值
// 起因：微信分支是直接赋值（覆盖），其余通道是追加 —— 于是"最后一条结果"里
// 可能整段看不到钉钉/QQ 的记录，我据此误判过"钉钉没推"。通道结果只能追加。
{
  const src = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  // 注意按 /\r?\n/ 切：仓库里是 CRLF，而 `.` 不匹配 \r、`$` 又必须在串尾，
  // 用 (.*)$ 会一行都匹配不到（守卫会假绿，我自己踩过一次）
  const lines = src.split(/\r?\n/);
  const bad = [];
  let writes = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*let\s+monitorLastSendResult/.test(lines[i])) continue; // 声明行（可能带行尾注释）
    const m = lines[i].match(/monitorLastSendResult\s*=\s*(.*)$/);
    if (!m) continue;
    const rhs = m[1].trim();
    if (rhs.startsWith("''")) continue; // 轮次开始时的重置
    writes++;
    if (lines[i].indexOf("monitorLastSendResult ? monitorLastSendResult + ' | ' : ''") < 0) {
      bad.push('L' + (i + 1) + ': ' + lines[i].trim().slice(0, 110));
    }
  }
  if (bad.length) {
    console.error('20. 以下写入直接覆盖了 monitorLastSendResult（必须追加，否则会抹掉别的通道的结果）：\n  ' + bad.join('\n  '));
    process.exit(1);
  }
  if (writes < 6) {
    console.error('20. 只找到 ' + writes + ' 处通道写入，预期 ≥6（5 通道 + 跳过分支）');
    process.exit(1);
  }
  if (src.indexOf('monitorSendHistory.push(') < 0) {
    console.error('20. 缺少 monitorSendHistory 归档 —— 间歇性"没推"的那一轮查不到');
    process.exit(1);
  }
  console.log('20. 监听结果记账 OK（' + writes + ' 处写入全部追加，最近 5 轮有归档）');
}

// 21. 版本号守卫：面板徽标显示的版本必须"自动跟随" package.json
// index.mjs 运行时读同包上一级的 package.json（读不到才退回兜底常量），
// 所以这里直接 import 那个解析结果来验，而不是去源码里正则抠字面量。
{
  const idx = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (idx.indexOf("new URL('../package.json', import.meta.url)") < 0) {
    console.error('21. index.mjs 没有运行时读 package.json —— 版本号不会自动跟随');
    process.exit(1);
  }
  const fb = idx.match(/const\s+PLUGIN_VERSION_FALLBACK\s*=\s*'([^']+)'/);
  if (!fb) { console.error('21. index.mjs 里找不到 PLUGIN_VERSION_FALLBACK 兜底常量'); process.exit(1); }
  // 兜底常量只要求"看起来是个版本号"：它只在 package.json 读不到时才生效，
  // 不该因为发版时忘记同步它就让测试失败（那等于又变成"要改两处"）。
  // 真正重要的是下面那条运行时断言 —— 解析结果必须等于 package.json。
  if (!/^\d+\.\d+\.\d+/.test(fb[1])) {
    console.error('21. 兜底常量不是合法的版本号形态：' + fb[1]);
    process.exit(1);
  }
  // 真·运行时验证：import 插件的实际解析结果
  const mod = await import('../lib/index.mjs');
  if (typeof mod.PLUGIN_VERSION !== 'string' || !mod.PLUGIN_VERSION) {
    console.error('21. index.mjs 没有导出解析后的 PLUGIN_VERSION');
    process.exit(1);
  }
  if (mod.PLUGIN_VERSION !== pkg.version) {
    console.error('21. 运行时解析出的版本（' + mod.PLUGIN_VERSION + '）与 package.json（' + pkg.version + '）不一致 —— 自动跟随失效');
    process.exit(1);
  }
  if (idx.indexOf('version: PLUGIN_VERSION') < 0) {
    console.error('21. snapshot() 没有把 version 暴露给面板（面板徽标会一直是空的）');
    process.exit(1);
  }
  const pan = fs.readFileSync(new URL('../lib/panel.mjs', import.meta.url), 'utf8');
  if (pan.indexOf("getElementById('webrm-ver')") < 0 || pan.indexOf('info.version') < 0) {
    console.error('21. panel.mjs 没有读取 /remote/info 的 version 去填徽标');
    process.exit(1);
  }
  // 徽标/下划线样式（用户逐轮定下来的，别再"优化"回去）：
  //  · 字号 .5em（标题的一半）、内边距 1px（一个笔画宽）
  //  · 徽标圆角 2px 2px 2px 0：上两角与右下圆、左下直角（左下要与下划线接上）
  //  · 下划线走容器 ::after（border-bottom 贴不到字形）
  //  · ⚠️ 线必须画在容器的 padding 区：容器 padding-bottom:2px + 线的 bottom:0。
  //    19px 中文字形墨迹几乎占满 22px 行框，线若画在容器内部（bottom:2px）会压进字形
  //    —— 实测线盖住字底 3 行、字的底边还会从线下面露出来。这条几何关系必须守住。
  if (pan.indexOf('#webrm-head-left{display:flex;align-items:flex-end;gap:4px;min-width:0;position:relative;padding-bottom:2px}') < 0) {
    console.error('21. 徽标容器样式不对：应为 position:relative + padding-bottom:2px（把下划线放到容器外）');
    process.exit(1);
  }
  if (pan.indexOf('#webrm-head-left::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px') < 0) {
    console.error('21. 下划线不对：应为 bottom:0（落在 padding 区；bottom:2px 会压进字形）+ height:2px');
    process.exit(1);
  }
  if (pan.indexOf('background:var(--dsw-alias-label-primary,#1d1d1f);border-bottom-right-radius:2px}') < 0) {
    console.error('21. 下划线右端应带 2px 圆角（与徽标右下圆角对齐，否则交界处留小台阶）');
    process.exit(1);
  }
  if (pan.indexOf('#webrm-ver{display:inline-flex;align-items:center;font-size:.5em') < 0) {
    console.error('21. 徽标样式不对：字号应为 .5em（标题的一半）');
    process.exit(1);
  }
  if (pan.indexOf('letter-spacing:.02em;padding:1px;border-radius:2px 2px 2px 0;') < 0) {
    console.error('21. 徽标应为 padding:1px + 圆角 2px 2px 2px 0');
    process.exit(1);
  }
  if (pan.indexOf('border-radius:2px 2px 2px 0;margin-bottom:') >= 0) {
    console.error('21. 徽标不该再有 margin-bottom —— 线移到 padding 区后，徽标底边天然就坐在线上');
    process.exit(1);
  }
  if (pan.indexOf('transform:translateY(-1px)') >= 0 && pan.indexOf('#webrm-ver') >= 0) {
    // 贴底对齐后不需要再手动位移
    console.error('21. 徽标还带着 translateY 位移 —— 贴底对齐后应移除');
    process.exit(1);
  }
  if (pan.indexOf('body[data-ds-dark-theme] #webrm-ver') < 0) {
    console.error('21. 徽标缺少深色主题反色规则');
    process.exit(1);
  }
  console.log('21. 版本徽标 OK（v' + pkg.version + '，与 package.json 一致，深浅主题可反色）');
}

// 22. P2P（Tailscale）接入守卫
//  · isPrivateAddress 必须认 100.64.0.0/10（Tailscale/CGNAT），否则走 P2P 还要带 token
//  · 100.64/10 之外的 100.x 不能被误判成私网
//  · 面板要把 P2P 那条链接单独标注（用户才知道手机得开着 Tailscale）
//  · ips 必须每次取状态时重算（Tailscale 网卡常在宿主启动之后才出现）
{
  const { isPrivateAddress } = await import('../lib/proxy.mjs');
  const { isTailscaleRange } = await import('../lib/index.mjs');
  const cases = [
    ['100.103.130.41', true, 'Tailscale 实机地址'],
    ['100.64.0.1', true, 'CGNAT 段起点'],
    ['100.127.255.254', true, 'CGNAT 段终点'],
    ['100.128.0.1', false, 'CGNAT 段之外'],
    ['100.63.255.255', false, 'CGNAT 段之外（下方）'],
    ['192.168.31.111', true, '普通局域网'],
    ['10.1.2.3', true, '10 段'],
    ['172.16.0.1', true, '172.16 段'],
    ['172.32.0.1', false, '172.32 不属于私网'],
    ['169.254.1.1', true, 'link-local'],
    ['127.0.0.1', true, '本机（调用方会另行排除）'],
    ['8.8.8.8', false, '公网'],
    ['::ffff:100.103.130.41', true, 'IPv4-mapped 形式'],
    ['', false, '空值'],
  ];
  const bad = [];
  for (const [ip, want, desc] of cases) {
    const got = isPrivateAddress(ip);
    if (got !== want) bad.push(desc + ' ' + JSON.stringify(ip) + '：期望 ' + want + ' 实得 ' + got);
  }
  if (bad.length) { console.error('22. isPrivateAddress 真值表不符:\n  ' + bad.join('\n  ')); process.exit(1); }

  const tsCases = [['100.103.130.41', true], ['100.64.0.1', true], ['100.127.255.255', true], ['100.128.0.1', false], ['192.168.31.111', false], ['', false]];
  const tsBad = tsCases.filter(([ip, want]) => isTailscaleRange(ip) !== want);
  if (tsBad.length) { console.error('22. isTailscaleRange 不符: ' + JSON.stringify(tsBad)); process.exit(1); }

  const pan = fs.readFileSync(new URL('../lib/panel.mjs', import.meta.url), 'utf8');
  // P2P 链接放在「公网」页（定位：在外面访问家里），且不能混进「局域网」页。
  // 标签就是 'P2P（Tailscale）'：用户明确要求去掉后面的 IP 与长提示（地址在下一行已经有了）。
  if (pan.indexOf("label: 'P2P（Tailscale）'") < 0) {
    console.error('22. panel.mjs 没有把 P2P 链接渲染到「公网」页（标签应为 P2P（Tailscale））');
    process.exit(1);
  }
  if (pan.indexOf('function lanOnlyIps(') < 0 || pan.indexOf('function p2pOnlyIps(') < 0) {
    console.error('22. panel.mjs 缺少 lanOnlyIps / p2pOnlyIps 拆分函数');
    process.exit(1);
  }
  if (pan.indexOf('for (var ui = 0; ui < lanIps.length; ui++)') < 0) {
    console.error('22. 「局域网」页没有改用 lanIps（Tailscale 地址会混进去）');
    process.exit(1);
  }
  if (pan.indexOf('for (var pi = 0; pi < p2pList.length; pi++)') < 0) {
    console.error('22. 「公网」页没有渲染 P2P 地址');
    process.exit(1);
  }
  const idx = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  if (idx.indexOf('ips: currentIps()') < 0) {
    console.error('22. snapshot() 没有用 currentIps() 重算地址 —— Tailscale 起来后不重启看不到链接');
    process.exit(1);
  }
  console.log('22. P2P 接入 OK（免 token 段 + 公网页 P2P 链接 + 局域网过滤 + 地址重算，' + cases.length + ' 例真值表）');
}

// 23. 已删除功能的残留守卫
// 「自定义公网链接」是半成品（只有显示/复制用，二维码和机器人 /链接 都绕过它），
// 用户确认删除。这里守住"别又长回来"，同时守住机器人页签的精简文案。
{
  const files = ['../lib/index.mjs', '../lib/panel.mjs', '../lib/store.mjs'];
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;            // 注释里提到"已删除"是允许的
      if (line.indexOf('customPublicUrl') >= 0) bad.push(f.replace('../lib/', '') + ':' + (i + 1) + ' customPublicUrl');
      if (line.indexOf('custom-url') >= 0) bad.push(f.replace('../lib/', '') + ':' + (i + 1) + ' custom-url');
      if (line.indexOf('#webrm-custom-url') >= 0) bad.push(f.replace('../lib/', '') + ':' + (i + 1) + ' #webrm-custom-url');
      if (line.indexOf('自定义公网链接') >= 0) bad.push(f.replace('../lib/', '') + ':' + (i + 1) + ' 自定义公网链接');
    });
  }
  if (bad.length) {
    console.error('23. 已删除的「自定义公网链接」又出现了:\n  ' + bad.join('\n  '));
    process.exit(1);
  }
  const pan = fs.readFileSync(new URL('../lib/panel.mjs', import.meta.url), 'utf8');
  if (pan.indexOf('通过聊天机器人遥控 DSH') < 0) {
    console.error('23. 机器人页签少了那一句说明');
    process.exit(1);
  }
  if (pan.indexOf('支持指令：/帮助') >= 0) {
    console.error('23. 机器人页签的长命令列表文案又回来了（用户要求删掉）');
    process.exit(1);
  }
  console.log('23. 已删功能无残留 OK（自定义公网链接彻底移除 + 机器人页签文案精简）');
}

// 24. Tailscale 状态探测守卫
// 面板要能直接回答「开没开 / 手机在不在线 / 直连还是中继（哪个节点）」。
// 踩过的坑：status --json 里 peer 的 Relay 是**字符串**（"tok"）不是数组，
// 早期按数组判断 → path 恒为 unknown。真值表两种形态都覆盖。
{
  const ts = await import('../lib/tailscale.mjs');
  const cases = [
    [null, (r) => r.cli === false, '没有 CLI 数据时 cli=false'],
    [{ BackendState: 'NeedsLogin', Self: {}, Peer: {} }, (r) => r.stateText === '未登录' && r.connected === false, '未登录'],
    [{ BackendState: 'Stopped' }, (r) => r.stateText === '未运行', '未运行'],
    [{ BackendState: 'Running', Self: { TailscaleIPs: ['fd7a::1'] }, Peer: {} }, (r) => r.connected === true && r.selfIp === null, '无 IPv4 时 selfIp 为空'],
    [
      { BackendState: 'Running', Self: { TailscaleIPs: ['100.1.2.3'] }, Peer: { a: { HostName: 'x', OS: 'android', Online: true, CurAddr: '1.2.3.4:5' } } },
      (r) => r.pathSummary === '直连' && r.peers[0].path === 'direct', '直连',
    ],
    [
      { BackendState: 'Running', Self: {}, Peer: { a: { HostName: 'x', OS: 'android', Online: true, Relay: 'sin' } } },
      (r) => r.pathSummary === '中继' && r.relay === 'sin', '中继（Relay 为字符串）',
    ],
    [
      { BackendState: 'Running', Self: {}, Peer: { a: { HostName: 'x', OS: 'android', Online: true, Relay: ['hkg'] } } },
      (r) => r.relay === 'hkg', '中继（Relay 为数组，兼容）',
    ],
    [
      { BackendState: 'Running', Self: {}, Peer: { a: { HostName: 'x', OS: 'android', Online: false, Relay: 'tok' }, b: { OS: 'windows', Online: true, CurAddr: '5.6.7.8:9' } } },
      (r) => r.onlinePeers === 1 && r.peers.length === 2 && r.pathSummary === '直连', '在线 peer 优先做路径摘要',
    ],
  ];
  const bad = [];
  for (const [raw, check, desc] of cases) {
    const r = ts.summarizeStatus(raw);
    if (!check(r)) bad.push(desc + ' → ' + JSON.stringify(r));
  }
  if (bad.length) { console.error('24. summarizeStatus 不符:\n  ' + bad.join('\n  ')); process.exit(1); }

  const ipCases = [['100.64.0.1', true], ['100.127.255.255', true], ['100.128.0.1', false], ['100.63.255.255', false], ['192.168.1.1', false], ['', false], [null, false]];
  const ipBad = ipCases.filter(([ip, want]) => ts.isTailscaleIp(ip) !== want);
  if (ipBad.length) { console.error('24. isTailscaleIp 不符: ' + JSON.stringify(ipBad)); process.exit(1); }

  if (ts.cliFromImagePath('"E:\\Tailscale IPN\\tailscaled.exe" -service') !== 'E:\\Tailscale IPN\\tailscale.exe') {
    console.error('24. cliFromImagePath 没能从服务 ImagePath 推出 CLI（便携版装在任意目录时全靠它）');
    process.exit(1);
  }
  if (ts.cliFromImagePath('') !== null) { console.error('24. cliFromImagePath 空输入应返回 null'); process.exit(1); }

  const idx = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  if (idx.indexOf('createTailscaleProbe') < 0 || idx.indexOf('tailscale: tailscaleProbe.snapshot()') < 0) {
    console.error('24. index.mjs 没有把 Tailscale 状态放进 /remote/info');
    process.exit(1);
  }
  const pan = fs.readFileSync(new URL('../lib/panel.mjs', import.meta.url), 'utf8');
  // 用户定稿的版式：状态**跟在「P2P（Tailscale）」同一行后面**；
  // 没有「Tailscale 状态」标题、没有「Tailscale：」前缀；
  // 未运行/未登录**套用同一套模板**（只有标签行、没有链接行），不再有独立的前缀行。
  if (pan.indexOf('function tailscaleNote(') < 0) {
    console.error('24. panel.mjs 缺少 tailscaleNote');
    process.exit(1);
  }
  if (pan.indexOf('note: tsNote,') < 0 || pan.indexOf('tailscaleNote(info && info.tailscale)') < 0) {
    console.error('24. Tailscale 状态没有挂在「P2P（Tailscale）」那一行上');
    process.exit(1);
  }
  if (pan.indexOf('if (!p2pList.length && tsNote) {') < 0) {
    console.error('24. Tailscale 没跑时没有套用同一套版式（应仍显示「P2P（Tailscale）」标签行）');
    process.exit(1);
  }
  if (pan.indexOf('tailscaleStandalone') >= 0) {
    console.error('24. 还留着独立前缀行 tailscaleStandalone —— 用户要求未运行也套用手机离线那套模板');
    process.exit(1);
  }
  if (pan.indexOf('Tailscale：已连接') >= 0 || pan.indexOf('Tailscale：未运行') >= 0) {
    console.error('24. 状态文案还带着「Tailscale：」前缀 —— 它紧跟在 P2P（Tailscale）后面，前缀是多余的');
    process.exit(1);
  }
  // 用户要求：不要在 P2P 后面写「已连接」；也不要用「手机在线/离线」这种过度断言
  // —— Online 只表示对端连着控制面，不代表隧道建立（实测 LastHandshake 常为 0）。
  // 现在只描述**通道**：通道已连通 / 通道未连通（对端不在线）。
  if (pan.indexOf('通道已连通') < 0 || pan.indexOf('通道未连通') < 0) {
    console.error('24. 状态行没有改成描述「通道」状态');
    process.exit(1);
  }
  if (/return '已连接 · ' \+ who/.test(pan) || pan.indexOf("'已连接 · ' + who") >= 0) {
    console.error('24. 状态行还写着「已连接 · 」—— 用户要求 P2P 后面不要写已连接');
    process.exit(1);
  }
  if (pan.indexOf("'手机在线'") >= 0 || pan.indexOf("'手机离线'") >= 0) {
    console.error('24. 状态行还在写「手机在线/离线」—— 用户指出这个断言不准确');
    process.exit(1);
  }
  // 未运行时链接行要**保留**（用记住的上次地址）
  if (pan.indexOf('info.tailscale.lastIp') < 0 || pan.indexOf('var p2pList = p2pIps.length ? p2pIps') < 0) {
    console.error('24. 未运行时没有保留链接行（缺少"上次记住的地址"兜底）');
    process.exit(1);
  }
  if (pan.indexOf('上次地址，启动后可用') < 0) {
    console.error('24. 未运行但保留链接时，提示文案没说清是"上次地址"');
    process.exit(1);
  }
  if (pan.indexOf("if (!ts.cli && !ts.viaInterface) return '';") < 0) {
    console.error('24. 没装 Tailscale 的用户不该看到状态行（缺少过滤）');
    process.exit(1);
  }
  console.log('24. Tailscale 状态探测 OK（' + cases.length + ' 例真值表 + CLI 路径推导 + 面板/宿主接线）');
}

// 25. /链接 命令：公网 + P2P 双链接，P2P 没打通要写明原因
// 用户要求：`/链接` 同时发公网链接和 P2P 链接；检测到 P2P 没建立时，
// P2P 那半写成「p2p未打通」，而不是给一个点了打不开的地址。
// 其中包含**手机端有没有开 Tailscale**（读 peer 的 Online）——这是用户明确问过的能力。
{
  const ts = await import('../lib/tailscale.mjs');
  const ip = '100.103.130.41';
  const connected = { cli: true, connected: true, peers: [{ os: 'android', online: true }], onlinePeers: 1 };
  const notConnected = { cli: true, connected: false, stateText: '未登录', peers: [], onlinePeers: 0 };
  const phoneOff = { cli: true, connected: true, peers: [{ os: 'android', online: false }], onlinePeers: 0 };
  const otherOff = { cli: true, connected: true, peers: [{ os: 'windows', online: false }], onlinePeers: 0 };
  const noPeers = { cli: true, connected: true, peers: [], onlinePeers: 0 };
  const cases = [
    // [ips, ts, opts, 期望 url, 期望 reason, 说明]
    [['192.168.31.111'], connected, { port: 5566, lanOpen: true }, null, '本机没有 Tailscale 地址', '没有 100.x'],
    [null, connected, { port: 5566, lanOpen: true }, null, '本机没有 Tailscale 地址', 'ips 为空'],
    [[ip], notConnected, { port: 5566, lanOpen: true }, null, '未登录', '有网卡地址但未登录'],
    [[ip], phoneOff, { port: 5566, lanOpen: true }, null, '对端不在线', '★ 有对端但全离线'],
    [[ip], otherOff, { port: 5566, lanOpen: true }, null, '对端不在线', '非手机对端离线（同一句，不断言"手机没开"）'],
    [[ip], noPeers, { port: 5566, lanOpen: true }, null, '没有其它设备', 'tailnet 里只有本机'],
    [[ip], connected, { port: 5566, lanOpen: true }, 'http://' + ip + ':5566', '', '已连接 + 有对端在线 + 免 token'],
    [[ip], connected, { port: 5566, lanOpen: false, token: 'T' }, 'http://' + ip + ':5566/?token=T', '', '关掉免 token 要带 token'],
    [[ip], null, { port: 5566, lanOpen: true }, 'http://' + ip + ':5566', '', '没有探测数据时退回网卡判断'],
    [[ip], connected, { port: null, lanOpen: true }, null, '代理未运行', '没端口'],
  ];
  const bad = [];
  for (const [ips, t, opts, wantUrl, wantReason, desc] of cases) {
    const got = ts.p2pState(ips, t, opts);
    if (got.url !== wantUrl || got.reason !== wantReason) {
      bad.push(desc + '：期望 {' + wantUrl + ' / ' + wantReason + '} 实得 ' + JSON.stringify(got));
    }
  }
  if (bad.length) { console.error('25. p2pState 不符:\n  ' + bad.join('\n  ')); process.exit(1); }
  // p2pUrl 必须与 p2pState 同源（不许各写一份判定）
  if (ts.p2pUrl([ip], phoneOff, { port: 5566, lanOpen: true }) !== null) {
    console.error('25. p2pUrl 与 p2pState 判定不一致（对端不在线时仍给出链接）');
    process.exit(1);
  }

  const idx = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  if (idx.indexOf("'p2p未打通'") < 0) {
    console.error('25. index.mjs 里没有「p2p未打通」文案 —— P2P 没建立时会给一个打不开的地址');
    process.exit(1);
  }
  if (idx.indexOf('p2p.reason') < 0) {
    console.error('25. index.mjs 没把未打通的原因拼进文案（用户要能看出是"手机端没开"）');
    process.exit(1);
  }
  if (idx.indexOf('function linkCommandText(prefix)') < 0 || idx.indexOf('function p2pStateNow()') < 0) {
    console.error('25. index.mjs 缺少 linkCommandText / p2pStateNow 共用实现');
    process.exit(1);
  }
  const returns = (idx.match(/return linkCommandText\(/g) || []).length;
  if (returns < 5) {
    console.error('25. 只有 ' + returns + ' 处返回共用文案 —— 5 个通道（微信/飞书/纸飞机/QQ官方/钉钉）都要用');
    process.exit(1);
  }
  if (idx.indexOf("return '公网链接") >= 0) {
    console.error('25. 还有通道在用旧的「只发公网链接」写法');
    process.exit(1);
  }
  console.log('25. /链接 双链接 OK（' + cases.length + ' 例真值表含"对端不在线" + ' + returns + ' 处共用文案）');
}

// 26. 二维码：必须**本地生成**（不许再有外部图床），且真能解码
{
  const p = fs.readFileSync(new URL('../lib/panel.mjs', import.meta.url), 'utf8');

  // 26a 不许残留任何外部二维码图床
  const banned = ['api.pwmqr.com', 'api.qrserver.com', 'QR_SOURCES', 'qrserver'];
  for (const b of banned) {
    if (p.indexOf(b) >= 0) {
      console.error('26. 还残留外部二维码图床「' + b + '」—— 必须本地生成（断网可用 + ?token= 不外发）');
      process.exit(1);
    }
  }

  // 26b 本地实现必须齐备
  for (const fn of ['function qrEncode', 'function qrGenPoly', 'function qrRsEncode', 'function qrInterleave', 'function qrMatrix', 'function setQrImage']) {
    if (p.indexOf(fn) < 0) {
      console.error('26. 本地二维码实现缺少 ' + fn);
      process.exit(1);
    }
  }
  const uses = (p.match(/setQrImage\(/g) || []).length;
  if (uses < 3) {
    console.error('26. setQrImage 只有 ' + (uses - 1) + ' 处调用 —— 面板 / 微信绑定 / QQ 扫码都要走它');
    process.exit(1);
  }

  // 26c 真正的硬标准：把面板里那份 qrEncode 抠出来跑，再用独立解码器读回来。
  // 只做字符串断言是不够的 —— 二维码"看着像"但扫不出来太容易了（开发时就踩过：
  // 格式信息位序写反，图完全正常、任何扫码器都读不出）。
  const start = p.indexOf('  // ===== 本地二维码生成');
  const endMark = '  var currentBotChannel = null;';
  const end = p.indexOf(endMark);
  if (start < 0 || end < 0 || end <= start) {
    console.error('26. 找不到本地二维码实现段（注释锚点被改了？）');
    process.exit(1);
  }
  const seg = p.slice(start, end);

  let qrEncode;
  try {
    qrEncode = new Function(seg + '\n; return qrEncode;')();
  } catch (e) {
    console.error('26. 本地二维码实现无法求值: ' + e.message);
    process.exit(1);
  }

  const cases = [
    'https://type-agent-ball-essay.trycloudflare.com/?token=TOK123',
    'http://100.103.130.41:5566',
    'http://100.103.130.41:5566/?token=abcd1234efgh5678',
    'http://192.168.1.100:5566/?token=abc123',
    'https://example.com/',
    'A',
    // 下面这些落在版本 8~20：这两组块的**数据长度不同**（组1比组2少1字节），
    // 按"所有块等长"处理会算出错误交织 —— 图看着完全正常、任何扫码器都读不出。
    'a'.repeat(137) + 'v8', 'a'.repeat(196) + 'v10', 'a'.repeat(303) + 'v13', 'a'.repeat(466) + 'v17'
  ];

  let jsQR = null;
  try { jsQR = (await import('jsqr')).default; } catch (e) { /* 见下 */ }

  const render = (mat, scale, quiet) => {
    const n = mat.length;
    const size = (n + quiet * 2) * scale;
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const mr = Math.floor(y / scale) - quiet;
        const mc = Math.floor(x / scale) - quiet;
        const dark = (mr >= 0 && mc >= 0 && mr < n && mc < n) && mat[mr][mc] === 1;
        const o = (y * size + x) * 4;
        const v = dark ? 0 : 255;
        data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
      }
    }
    return { data, width: size, height: size };
  };

  for (const text of cases) {
    let mat;
    try { mat = qrEncode(text); } catch (e) {
      console.error('26. qrEncode 抛异常（' + text.slice(0, 30) + '）: ' + e.message);
      process.exit(1);
    }
    if (!mat || !mat.length) {
      console.error('26. qrEncode 返回空（' + text.slice(0, 30) + '）');
      process.exit(1);
    }
    const n = mat.length;
    if ((n - 17) % 4 !== 0) {
      console.error('26. 矩阵尺寸非法 ' + n + '（应为 4v+17）');
      process.exit(1);
    }
    // 三个角定位图案外环必须实心
    for (let i = 0; i < 7; i++) {
      if (mat[0][i] !== 1 || mat[6][i] !== 1 || mat[i][0] !== 1 || mat[i][6] !== 1) {
        console.error('26. 定位图案外环有洞（' + text.slice(0, 30) + '）');
        process.exit(1);
      }
    }
    if (jsQR) {
      const img = render(mat, 4, 4);
      const dec = jsQR(img.data, img.width, img.height);
      if (!dec) {
        console.error('26. 生成的二维码无法解码（画出来但扫不出）: ' + text.slice(0, 40));
        process.exit(1);
      }
      if (dec.data !== text) {
        console.error('26. 解码内容不符: 期望 ' + JSON.stringify(text) + ' 实得 ' + JSON.stringify(dec.data));
        process.exit(1);
      }
    }
  }

  // 26d 渲染分辨率：位图必须 >=「显示尺寸 × devicePixelRatio」。
  // 血泪史（两轮用户反馈"二维码糊"）：
  //   第一版 1 模块 1 像素 → 版本4 才 41px，显示 174px → 放大 4.2 倍，糊到手机上扫不出；
  //   第二版拍脑袋取 400px → 手机 DPR 3 时需 200x3=600px，仍被放大 1.5 倍，还是糊。
  // 结论：不能写死常量，要按真实布局尺寸 × DPR 算（面板内容区 174、微信 200）。
  {
    const fnAt = p.indexOf('function setQrImage');
    const fn = p.slice(fnAt, fnAt + 4000);
    if (/fillRect\(c \+ quiet, r \+ quiet, 1, 1\)/.test(fn)) {
      console.error('26. setQrImage 又变回「1 模块 1 像素」了 —— 二维码会糊');
      process.exit(1);
    }
    if (/\(c \+ quiet\) \* scale, \(r \+ quiet\) \* scale, scale, scale/.test(fn) === false) {
      console.error('26. setQrImage 没有按 scale 画模块');
      process.exit(1);
    }
    if (/imageRendering\s*=\s*'pixelated'/.test(fn)) {
      console.error('26. 别给二维码设 image-rendering:pixelated —— 位图与显示尺寸非整数比时反而发毛');
      process.exit(1);
    }
    // 必须考虑设备像素比，否则高分屏上一定糊
    if (!/devicePixelRatio/.test(fn)) {
      console.error('26. setQrImage 没有考虑 devicePixelRatio —— 手机 DPR 3 时位图会不够，必然糊');
      process.exit(1);
    }
    // 必须按真实显示尺寸算，而不是写死常量
    if (!/getBoundingClientRect/.test(fn)) {
      console.error('26. setQrImage 没有按真实显示尺寸算分辨率 —— 面板 174px 与微信 200px 需求不同');
      process.exit(1);
    }
    // 实际算一遍：模拟 DPR 3 下的两种显示尺寸，位图必须够且不失控
    const calc = (cssPx, dpr) => {
      let needPx = Math.ceil(cssPx * dpr * 1.1);
      if (needPx < 400) needPx = 400;
      if (needPx > 1600) needPx = 1600;
      return needPx;
    };
    const checks = [
      ['面板 174 CSS px @DPR3', 174, 3, 522],
      ['微信 200 CSS px @DPR3', 200, 3, 600],
      ['面板 174 CSS px @DPR2', 174, 2, 348],
      ['小屏 120 CSS px @DPR1', 120, 1, 120]
    ];
    for (const [label, cssPx, dpr, required] of checks) {
      const needPx = calc(cssPx, dpr);
      if (needPx < required) {
        console.error('26. ' + label + ' 需要 ' + required + 'px，但只算了 ' + needPx + 'px —— 会被放大变糊');
        process.exit(1);
      }
      if (needPx > 1600) {
        console.error('26. ' + label + ' 算出 ' + needPx + 'px，过大');
        process.exit(1);
      }
    }
    // 各版本都要有足够分辨率
    for (const [ver, modules] of [[1, 21], [4, 33], [10, 57], [20, 97]]) {
      const total = modules + 8;
      const needPx = calc(200, 3);
      let s = Math.ceil(needPx / total);
      if (s < 4) s = 4;
      const px = total * s;
      if (px < 522) {
        console.error('26. 版本 ' + ver + ' 位图只有 ' + px + 'px，小于 DPR3 所需 522px');
        process.exit(1);
      }
      if (px > 1800) {
        console.error('26. 版本 ' + ver + ' 位图 ' + px + 'px 过大，PNG 体积无谓膨胀');
        process.exit(1);
      }
    }
  }

  const how = jsQR ? 'jsQR 实测解码 ' + cases.length + ' 例通过' : '未装 jsqr，仅结构校验（跑 npm i 后才是完整验证）';
  console.log('26. 本地二维码 OK（零外部图床 + ' + (uses - 1) + ' 处共用 + 高分辨率渲染 + ' + how + '）');
}

// 27. 帮助文本：**只列一级指令**
// 用户反馈「有的指令是二级甚至三级，但都在帮助里显示出来了，帮助里只显示一级指令」。
// 一级 10 条；二级(/选择 N)、三级(/切换模型 N、/选强度 N) 收进所属一级的说明里。
// /启动 故意不列（/链接 已兼作启动），但命令本身仍须可用。
{
  const p = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');

  const m = p.match(/const HELP_LINES = \[([\s\S]*?)\];/);
  if (!m) {
    console.error('27. 找不到 HELP_LINES —— 帮助文本应有一份共用清单（原先微信与其它通道各写一份，会改一处漏一处）');
    process.exit(1);
  }
  const lines = m[1].split('\n')
    .map((s) => s.trim())
    .filter((s) => s.startsWith("'"))
    .map((s) => { const mm = s.match(/^'([\s\S]*)',?$/); return mm ? mm[1] : ''; })
    .filter(Boolean);

  // 二级/三级用法不许单独占行
  const flat = lines.filter((l) => /^·\s*\/\s*(选择|选强度)/.test(l) || /^·\s*\/\s*切换模型\s*N\b/.test(l));
  if (flat.length) {
    console.error('27. 帮助里把二级/三级指令单独列行了：' + flat.join(' | ') + '\n    应并进所属一级指令的说明里（如「· /切换模型 —— 列出模型，回复「/切换模型 N」选中」）');
    process.exit(1);
  }

  // 一级指令必须齐（10 条）
  const required = ['/帮助', '/链接', '/停止', '/监听', '/状态', '/会话列表', '/当前会话', '/历史内容', '/当前模型', '/切换模型'];
  for (const cmd of required) {
    if (!lines.some((l) => l.startsWith('· ' + cmd + ' '))) {
      console.error('27. 帮助里缺一级指令 ' + cmd);
      process.exit(1);
    }
  }
  const listed = lines.filter((l) => /^·\s*\//.test(l));
  if (listed.length !== required.length) {
    console.error('27. 帮助里的一级指令有 ' + listed.length + ' 条，应为 ' + required.length + ' 条：\n    ' + listed.join('\n    '));
    process.exit(1);
  }

  // /启动 不列，但命令必须仍然可用（4 个通道有实现）
  if (lines.some((l) => /^·\s*\/\s*启动/.test(l))) {
    console.error('27. 帮助里又列了 /启动 —— /链接 已兼作启动（未启动会自动拉起），列出来会让用户困惑');
    process.exit(1);
  }
  const startImpl = (p.match(/\^\\\/\?\(启动\|/g) || []).length;
  if (startImpl < 3) {
    console.error('27. /启动 的实现只剩 ' + startImpl + ' 处 —— 帮助里不列 ≠ 可以删掉命令，老用户会突然收到「未知命令」');
    process.exit(1);
  }

  // 二级用法的「发现性」不能丢：必须在一级说明里提到
  if (!lines.some((l) => l.indexOf('/会话列表') === 2 && l.indexOf('/选择 N') > 0)) {
    console.error('27. /会话列表 的说明里没提「/选择 N」—— 二级用法收进说明，但不能消失');
    process.exit(1);
  }
  if (!lines.some((l) => l.indexOf('/切换模型') === 2 && l.indexOf('思考强度') > 0)) {
    console.error('27. /切换模型 的说明里没提「思考强度」—— 三级用法 /选强度 N 会变得无人可知（此前 5 份帮助里一处都没写）');
    process.exit(1);
  }

  // 两个通道入口都必须用这份共用清单
  if (!/const WEIXIN_HELP = [^;]*HELP_LINES\.join/.test(p)) {
    console.error('27. 微信帮助没有用共用的 HELP_LINES');
    process.exit(1);
  }
  if (!/function channelHelp\(channelName\)\s*\{[\s\S]{0,200}?HELP_LINES\.join/.test(p)) {
    console.error('27. channelHelp 没有用共用的 HELP_LINES');
    process.exit(1);
  }

  console.log('27. 帮助文本 OK（只列 ' + required.length + ' 条一级指令 + 二三级收进说明 + 不列 /启动 但命令仍可用）');
}

// 28. 转发与监听不能重复推送
// 用户报告：「开启监听 + 选择会话」时，被选会话输出结果会给机器人发 2 次。
// 根因：转发（cmdRelayToSession → sendToSession）会把回复直接 return 给机器人，
// 与此同时监听定时器也发现该会话 running→idle 并再推一条「【会话】思考完毕」。
// 修法：sendToSession 在 whenIdle() 之后把监听快照对齐到当前事件数（suppressMonitorFor）。
{
  const p = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');

  if (!/function suppressMonitorFor\(/.test(p)) {
    console.error('28. 缺少 suppressMonitorFor —— 转发后没有抑制监听，同一次输出会被推 2 次');
    process.exit(1);
  }

  // 必须在 sendToSession 里、whenIdle() 之后调用（早了会被监听抢跑，等于没抑制）
  const fnAt = p.indexOf('async function sendToSession(');
  if (fnAt < 0) { console.error('28. 找不到 sendToSession'); process.exit(1); }
  const fn = p.slice(fnAt, fnAt + 1800);
  const idleAt = fn.indexOf('await agent.whenIdle()');
  const supAt = fn.indexOf('suppressMonitorFor(');
  if (idleAt < 0) { console.error('28. sendToSession 里找不到 await agent.whenIdle()'); process.exit(1); }
  if (supAt < 0) {
    console.error('28. sendToSession 没有调用 suppressMonitorFor —— 「监听 + 选会话」会收到 2 条');
    process.exit(1);
  }
  if (supAt < idleAt) {
    console.error('28. suppressMonitorFor 调在 whenIdle() 之前 —— 会话还在跑，监听随后仍会判定新一轮并补推一条');
    process.exit(1);
  }

  // 快照必须写到监听用的那个 key（会话 id），且置为「已结束 + 当前事件数」
  const sfn = p.slice(p.indexOf('function suppressMonitorFor('), p.indexOf('function suppressMonitorFor(') + 900);
  if (!/weixinMonitorSnapshots\[sid\]\s*=\s*\{\s*wasRunning:\s*false/.test(sfn)) {
    console.error('28. suppressMonitorFor 没有把快照写成 wasRunning:false —— 监听仍会判定 running→idle');
    process.exit(1);
  }
  if (!/sessionEvents\(session\)\.length/.test(sfn)) {
    console.error('28. suppressMonitorFor 没有对齐 eventsLen —— 监听仍会判定「有新事件」');
    process.exit(1);
  }
  if (!/session\.header/.test(sfn)) {
    console.error('28. suppressMonitorFor 没用 session.header.id 取 key —— 会与监听循环用的 key 对不上，抑制失效');
    process.exit(1);
  }

  // 监听循环仍需保留「running→idle 且事件变多」的判定（别为了修重复把监听改坏）
  if (!/snap\.wasRunning\s*&&\s*!isRunning\s*&&\s*evts\.length\s*>\s*snap\.eventsLen/.test(p)) {
    console.error('28. 监听的核心判定被改了 —— 未选会话时的主动通知会失效');
    process.exit(1);
  }

  console.log('28. 转发/监听去重 OK（sendToSession 在 whenIdle 后抑制监听快照 + 监听判定未被改坏）');
}

// 29. 微信收消息必须与处理解耦
// 用户报告「微信接收消息很慢」，并且长期以为是"微信接口休眠/挤压消息"。
// 根因：收消息与处理消息写在**同一个 while 循环里串行 await** ——
//   收到 A →（await 会话跑完，几十秒）→ 回复 A → 才回去拉下一条。
// 后果不只是慢：每条消息自带的 context_token 有有效期，等得越久越可能过期，
// 发送报 iLink "prepare failed" 只能入队积压 —— 这就是"挤压消息"的由来。
// 修法：收消息只入队 + 立刻回执，消费者另起一条链按顺序处理。
{
  const p = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');

  if (!/var weixinInbox = \[\]/.test(p)) {
    console.error('29. 缺少 weixinInbox 队列 —— 收消息与处理没有解耦');
    process.exit(1);
  }
  if (!/async function weixinDrainInbox\(/.test(p)) {
    console.error('29. 缺少 weixinDrainInbox 消费者');
    process.exit(1);
  }

  // 收消息循环里**绝不能**出现会话处理逻辑（就是它把收消息堵住的）
  const a = p.indexOf('async function weixinPollLoop()');
  const b = p.indexOf('let feishuToken', a);
  if (a < 0 || b < 0 || b <= a) {
    console.error('29. 找不到 weixinPollLoop 的范围');
    process.exit(1);
  }
  const poll = p.slice(a, b);
  if (/weixinGenerateReply/.test(poll)) {
    console.error('29. 收消息循环里又出现了 weixinGenerateReply —— 处理会再次堵住收消息（"接收慢/挤压消息"会复发）');
    process.exit(1);
  }
  if (/await\s+agent\.whenIdle|whenIdle/.test(poll)) {
    console.error('29. 收消息循环里出现了 whenIdle —— 会话思考期间会收不到新消息');
    process.exit(1);
  }
  if (!/weixinInbox\.push/.test(poll)) {
    console.error('29. 收消息循环没有入队');
    process.exit(1);
  }
  if (!/weixinDrainInbox\(\)/.test(poll)) {
    console.error('29. 收消息循环没有唤起消费者');
    process.exit(1);
  }
  // 收消息循环里**不许**发回执：回执统一由 handleWeixinCommand 发一条。
  // 早先两处都发，用户收到两条：「已收到，正在处理…」+「已收到指令，AI 思考中…」。
  // 注意只匹配真正的发送调用 —— 注释里提到这段文案（"早先这里也发了一条…"）不算。
  if (/weixinSendMsg\([^)]*已收到，正在处理/.test(p)) {
    console.error('29. 又出现了收消息循环里的回执发送「已收到，正在处理…」—— 会和 handleWeixinCommand 的回执撞车，用户收到两条');
    process.exit(1);
  }
  if (!/已收到指令，AI 思考中/.test(p)) {
    console.error('29. 找不到回执「已收到指令，AI 思考中，请稍等…」—— 长任务会没有任何反馈');
    process.exit(1);
  }
  // 回执必须在进入会话（sendToSession）之前发，否则等于没有反馈
  const cmdStart = p.indexOf('async function handleWeixinCommand(');
  const cmdFn = p.slice(cmdStart, p.indexOf('(async function () {', cmdStart));
  const ackAt = cmdFn.indexOf('已收到指令，AI 思考中');
  const relayAt = cmdFn.lastIndexOf('sendToSession(');
  if (ackAt < 0 || relayAt < 0) {
    console.error('29. handleWeixinCommand 里找不到回执或 sendToSession');
    process.exit(1);
  }
  if (ackAt > relayAt) {
    console.error('29. 回执发在 sendToSession 之后 —— 那时会话都跑完了，等于没有反馈');
    process.exit(1);
  }

  // 消费者里必须真的干活（生成回复 + 发送），否则消息进了队列没人处理
  const d = p.slice(p.indexOf('async function weixinDrainInbox('), p.indexOf('async function weixinDrainInbox(') + 2600);
  if (!/weixinGenerateReply\(item\.text\)/.test(d)) {
    console.error('29. 消费者没有调用 weixinGenerateReply —— 队列里的消息没人处理');
    process.exit(1);
  }
  if (!/weixinSendMsg\(weixinState\.botToken, item\.fromUserId, reply, item\.contextToken\)/.test(d)) {
    console.error('29. 消费者没有把回复发回去');
    process.exit(1);
  }
  // 顺序处理：一条失败不能吞掉后面的
  if (!/while \(weixinInbox\.length > 0\)/.test(d)) {
    console.error('29. 消费者不是"取空队列"的循环 —— 处理期间新来的消息会漏');
    process.exit(1);
  }

  console.log('29. 微信收发解耦 OK（收消息只入队 / 消费者顺序处理 / 收消息循环不再被堵 / 回执只有一条）');
}

// 30. 通道没配凭证时，监听不该每轮白试
// 用户日志里每轮都刷「[feishu] monitor send failed: 未配置飞书凭证」。
// 根因两处：
//   ① 启动时无条件把 feishuMonitorMode 恢复成开，没查凭证是否还在；
//   ② 监听发送分支只判断了 feishuMonitorMode && feishuLastChatId，没查凭证。
// 对照：微信查了 botToken/userId、TG/QQ 查了 channel 与 health、钉钉有整套 dtSkip。
{
  const p = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');

  // ① 启动恢复必须查凭证：`feishuMonitorMode = true` 之前必须出现过 feishuLoadConfig
  const restoreAt = p.indexOf('// 飞书监听恢复');
  if (restoreAt < 0) {
    console.error('30. 找不到「飞书监听恢复」段');
    process.exit(1);
  }
  // 取到下一个 setTimeout/启动块之前，够覆盖这一段
  const restore = p.slice(restoreAt, restoreAt + 1200);
  const setTrueAt = restore.indexOf('feishuMonitorMode = true');
  if (setTrueAt < 0) {
    console.error('30. 飞书监听恢复段里找不到 feishuMonitorMode = true');
    process.exit(1);
  }
  // 只看真正把开关打开那一段的前文里有没有查凭证
  const before = restore.slice(0, setTrueAt);
  if (!/feishuLoadConfig\(\)/.test(before)) {
    console.error('30. 飞书监听恢复没有先检查凭证就打开 —— 凭证没了开关还留着，监听每轮白试并刷屏报错');
    process.exit(1);
  }

  // ② 监听发送分支必须查凭证（并允许"跳过"）
  if (!/未配置飞书凭证（appId\/appSecret）/.test(p)) {
    console.error('30. 监听发送分支没有"未配置飞书凭证"的跳过判断');
    process.exit(1);
  }
  if (!/feishu 跳过: /.test(p)) {
    console.error('30. 飞书跳过的原因没有记进 monitorLastSendResult —— /remote/diag 里看不出为什么没推');
    process.exit(1);
  }
  // 跳过日志要去重，否则每轮刷屏（这正是用户遇到的问题）
  if (!/let feishuMonitorSkipLogged/.test(p)) {
    console.error('30. 缺少 feishuMonitorSkipLogged —— 跳过的日志会每轮刷屏');
    process.exit(1);
  }
  if (!/feishuMonitorSkipLogged !== fsSkip/.test(p)) {
    console.error('30. 跳过日志没有去重判断');
    process.exit(1);
  }
  // 不能因为加了跳过就把"能发的时候"也跳过
  if (!/feishuSendText\(feishuLastChatId, text\)/.test(p)) {
    console.error('30. 飞书正常发送的调用不见了 —— 配了凭证也推不出去');
    process.exit(1);
  }

  console.log('30. 监听跳过判断 OK（飞书没凭证不再每轮白试 + 跳过原因记进诊断 + 日志去重）');
}

proxy.close();
target.close();
console.log('ALL TESTS DONE');
process.exit(0);
