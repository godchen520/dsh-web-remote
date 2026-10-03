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
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
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

proxy.close();
target.close();
console.log('ALL TESTS DONE');
process.exit(0);
