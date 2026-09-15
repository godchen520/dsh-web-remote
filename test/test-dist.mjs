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
import { createQQServer } from '../lib/qq.mjs';
import { INJECT_SCRIPT } from '../lib/panel.mjs';

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

// 7. QQ 桥
const qq = createQQServer({ infoUrls: ['http://127.0.0.1:' + TARGET + '/remote/info'] });
await qq.start(QQ_PORT);
console.log('7. QQ bridge listening on', QQ_PORT);
qq.close();

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

proxy.close();
target.close();
console.log('ALL TESTS DONE');
process.exit(0);
