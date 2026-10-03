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
    if (sync.indexOf('lib\\dingtalk.mjs') < 0) {
      console.error('19. sync-dsh-web-remote.ps1 的文件清单缺少 lib\\dingtalk.mjs —— 部署副本不会更新');
      process.exit(1);
    }
    console.log('19. 同步脚本文件清单 OK（含 lib\\dingtalk.mjs）');
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

// 21. 版本号守卫：面板标题上的徽标必须与 package.json 的 version 一致
// 版本号硬编码在 index.mjs 里（避免运行时读 package.json），所以必须有守卫防漂移。
{
  const idx = fs.readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const m = idx.match(/const\s+PLUGIN_VERSION\s*=\s*'([^']+)'/);
  if (!m) { console.error('21. index.mjs 里找不到 PLUGIN_VERSION 常量'); process.exit(1); }
  if (m[1] !== pkg.version) {
    console.error('21. PLUGIN_VERSION（' + m[1] + '）与 package.json 的 version（' + pkg.version + '）不一致');
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
  // 徽标样式：字号必须是标题的一半（.5em）、内边距只留一个笔画宽（1px）、
  // 底边与标题文字底边对齐（flex-end），且深浅主题都要能反色
  if (pan.indexOf('#webrm-head-left{display:flex;align-items:flex-end;gap:4px;min-width:0;border-bottom:1px solid var(--dsw-alias-label-primary') < 0) {
    console.error('21. 徽标容器样式不对：应为 flex-end 贴底 + 4px 间距 + 容器上的 1px 下划线（这样才连得到徽标底边）');
    process.exit(1);
  }
  if (pan.indexOf('#webrm-ver{display:inline-flex;align-items:center;font-size:.5em') < 0) {
    console.error('21. 徽标样式不对：字号应为 .5em（标题的一半）');
    process.exit(1);
  }
  if (pan.indexOf('letter-spacing:.02em;padding:1px;border-radius:2px') < 0) {
    console.error('21. 徽标内边距应为 1px（一个笔画宽）、圆角 2px（锐利）');
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

proxy.close();
target.close();
console.log('ALL TESTS DONE');
process.exit(0);
