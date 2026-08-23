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

// ───────────────────────── 自签名证书生成（零依赖） ─────────────────────────

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function derSeq(...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30]), derLen(body.length), body]);
}
function derInt(value) {
  // value: Buffer（大端正整数）；必要时补前导 0 避免被解析为负数
  let bytes = value;
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return Buffer.concat([Buffer.from([0x02]), derLen(bytes.length), bytes]);
}
function derOid(oid) {
  const parts = oid.split('.').map(Number);
  const body = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack = [v & 0x7f];
    v >>>= 7;
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>>= 7; }
    body.push(...stack);
  }
  return Buffer.concat([Buffer.from([0x06]), derLen(body.length), Buffer.from(body)]);
}
function derNull() { return Buffer.from([0x05, 0x00]); }
function derBitString(bytes) {
  return Buffer.concat([Buffer.from([0x03]), derLen(bytes.length + 1), Buffer.from([0]), bytes]);
}
function derOctetString(bytes) {
  return Buffer.concat([Buffer.from([0x04]), derLen(bytes.length), bytes]);
}
function derUtcTime(date) {
  const s = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '').replace('T', '').replace('Z', 'Z');
  const y = Number(s.slice(0, 4));
  const body = Buffer.from(String(y % 100).padStart(2, '0') + s.slice(4), 'utf8');
  return Buffer.concat([Buffer.from([0x17]), derLen(body.length), body]);
}
function derUtf8String(text) {
  const bytes = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([0x0c]), derLen(bytes.length), bytes]);
}
function derName(cn) {
  // RDNSequence: SEQUENCE { SET { SEQUENCE { OID 2.5.4.3, UTF8String } } }
  const attr = derSeq(derOid('2.5.4.3'), derUtf8String(cn));
  const set = Buffer.concat([Buffer.from([0x31]), derLen(attr.length), attr]);
  return derSeq(set);
}
function derGeneralNameIp(ip) {
  // [7] IMPLICIT OCTET STRING（4 字节）
  const bytes = Buffer.from(ip.split('.').map(Number));
  return Buffer.concat([Buffer.from([0x87]), derLen(bytes.length), bytes]);
}
function derGeneralNameDns(name) {
  const bytes = Buffer.from(name, 'utf8');
  return Buffer.concat([Buffer.from([0x82]), derLen(bytes.length), bytes]);
}
function derSan(ips, dnsNames) {
  const names = [];
  for (const ip of ips) names.push(derGeneralNameIp(ip));
  for (const d of dnsNames) names.push(derGeneralNameDns(d));
  const seq = derSeq(...names);
  return derSeq(derOid('2.5.29.17'), derOctetString(seq));
}
function derBasicConstraints() {
  // cA=FALSE：SEQUENCE {}（空）→ 隐含 all FALSE
  const seq = derSeq();
  return derSeq(derOid('2.5.29.19'), derOctetString(seq));
}
function derKeyUsage() {
  // digitalSignature(0) + keyEncipherment(2)
  const body = Buffer.from([0x05, 0xa0]); // unused bits=0, bits: 10100000 → 0=digitalSignature, 2=keyEncipherment
  const bs = Buffer.concat([Buffer.from([0x03]), derLen(body.length), body]);
  return derSeq(derOid('2.5.29.15'), derOctetString(bs));
}
/**
 * 生成自签名 X.509 v3 证书（RSA-2048 / SHA-256）。
 * @param ips 要写入 SAN 的 IPv4 地址列表
 * @returns {{ key: string, cert: string }} PEM
 */
export function generateSelfSignedCert(ips = []) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const serial = crypto.randomBytes(16);
  const notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  const notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
  const sigAlg = derSeq(derOid('1.2.840.113549.1.1.11'), derNull());
  const sanNames = [...new Set([...ips, '127.0.0.1'])];
  const dnsNames = ['localhost'];
  const extSeq = derSeq(derSan(sanNames, dnsNames), derBasicConstraints(), derKeyUsage());
  const tbsWithoutExt = derSeq(
    Buffer.concat([Buffer.from([0xa0]), derLen(3), Buffer.from([0x02, 0x01, 0x02])]), // version v3
    derInt(serial),
    sigAlg,
    derName('dsh-remote'),
    derSeq(derUtcTime(notBefore), derUtcTime(notAfter)),
    derName('dsh-remote'),
    spki, // SubjectPublicKeyInfo（完整 SEQUENCE，原样）
    Buffer.concat([Buffer.from([0xa3]), derLen(extSeq.length), extSeq]), // [3] EXPLICIT Extensions
  );
  const signature = crypto.sign('sha256', tbsWithoutExt, privateKey);
  const certDer = derSeq(tbsWithoutExt, sigAlg, derBitString(signature));
  const certPem = '-----BEGIN CERTIFICATE-----\n' + certDer.toString('base64').replace(/(.{64})/g, '$1\n') + '\n-----END CERTIFICATE-----\n';
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { key: keyPem, cert: certPem };
}

// ───────────────────────── 局域网 IP 探测 ─────────────────────────

export function lanIPs() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

// ───────────────────────── 反向代理服务器 ─────────────────────────

export function createProxyServer(options) {
  const { targetPort, pfxPath, pfxPass, lanOpen = true } = options;
  const token = crypto.randomBytes(18).toString('base64url');
  const TARGET_HOST = '127.0.0.1';
  const TARGET_PORT = targetPort;

  /** 判断来源地址是否为私网/本机地址（局域网免 token 用） */
  function isPrivateAddress(addr) {
    if (!addr) return false;
    const ip = addr.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
    const parts = ip.split('.');
    if (parts.length === 4) {
      const a = Number(parts[0]);
      const b = Number(parts[1]);
      if (a === 127) return true;                       // 127.x.x.x
      if (a === 10) return true;                        // 10.x.x.x
      if (a === 192 && b === 168) return true;          // 192.168.x.x
      if (a === 172 && b >= 16 && b <= 31) return true; // 172.16-31.x.x
      if (a === 169 && b === 254) return true;          // 169.254.x.x link-local
    }
    return false;
  }

  function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
      const idx = part.indexOf('=');
      if (idx > -1) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return out;
  }
  function isAuthed(req) {
    // 局域网免 token：私网来源直接放行（公网隧道来源是 127.0.0.1 也会放行？
    // 注意：cloudflared 隧道从 127.0.0.1 转发进来，无法与"本机直连"区分。
    // 因此公网访问仍必须带 token（否则隧道等于裸奔）。这里仅放行"非 127.0.0.1 的私网来源"。
    if (lanOpen) {
      const addr = req.socket.remoteAddress || '';
      const ip = addr.replace(/^::ffff:/, '');
      if (ip !== '127.0.0.1' && ip !== '::1' && isPrivateAddress(ip)) return true;
    }
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.dshr_token === token) return true;
    try { return new URL(req.url, 'http://x').searchParams.get('token') === token; } catch (e) { return false; }
  }
  function forwardHeaders(req, dropOrigin) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding' || lk === 'upgrade' || (dropOrigin && lk === 'origin')) continue;
      headers[lk] = v;
    }
    headers.host = TARGET_HOST + ':' + TARGET_PORT;
    return headers;
  }
  function upgradeHeaders(req) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'origin' || lk === 'keep-alive' || lk === 'transfer-encoding') continue;
      headers[lk] = v;
    }
    headers.host = TARGET_HOST + ':' + TARGET_PORT;
    return headers;
  }
  function shouldGzip(req, presHeaders) {
    if (!/gzip/.test(String(req.headers['accept-encoding'] || ''))) return false;
    if (presHeaders['content-encoding']) return false;
    const ctype = String(presHeaders['content-type'] || '');
    return ctype.indexOf('text/') === 0 || ctype.indexOf('application/json') === 0 || ctype.indexOf('application/javascript') === 0;
  }
  /** 静态资源（带 rev 的 bundle/assets）加一年 immutable 缓存，手机二次打开秒开 */
  function isCacheable(req) {
    const u = req.url || '';
    if (u.indexOf('/assets/') === 0 || u.indexOf('/plugins/') === 0 || u.indexOf('rev=') !== -1) return true;
    if (u.indexOf('/favicon.svg') === 0 || u.indexOf('/manifest.webmanifest') === 0) return true;
    return false;
  }
  /** 复用到 DSH 的连接（keep-alive），减少几十个 bundle 的 TCP 握手 */
  const proxyAgent = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 16 });
  function handleRequest(req, res) {
    if (!isAuthed(req)) {
      console.error('[dsh-web-remote] 403 ' + req.method + ' ' + req.url + ' cookie=' + (req.headers.cookie ? 'yes' : 'no'));
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    const cookies = parseCookies(req.headers.cookie);
    if (req.method === 'GET' && cookies.dshr_token !== token) {
      try {
        const url = new URL(req.url, 'http://x');
        if (url.searchParams.get('token') === token) {
          url.searchParams.delete('token');
          const q = url.searchParams.toString();
          res.writeHead(302, { location: url.pathname + (q ? '?' + q : ''), 'set-cookie': 'dshr_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400' });
          res.end();
          return;
        }
      } catch (e) { /* ignore */ }
    }
    const proxy = http.request({ host: TARGET_HOST, port: TARGET_PORT, path: req.url, method: req.method, headers: forwardHeaders(req, true), agent: proxyAgent }, (pres) => {
      const gz = shouldGzip(req, pres.headers);
      const outHeaders = {};
      for (const [k, v] of Object.entries(pres.headers)) {
        const lk = k.toLowerCase();
        if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding' || lk === 'upgrade') continue;
        if (gz && lk === 'content-length') continue;
        outHeaders[lk] = v;
      }
      if (gz) outHeaders['content-encoding'] = 'gzip';
      // 静态资源：一年 immutable 缓存（URL 带 rev，内容变了 URL 就变，缓存绝对安全）
      if (isCacheable(req)) {
        outHeaders['cache-control'] = 'public, max-age=31536000, immutable';
        // CDN-Cache-Control 让 Cloudflare 边缘缓存静态资源（否则 cf-cache-status: DYNAMIC，
        // 手机每个 bundle 都要走隧道往返 ~2.5s，几十个 bundle 就非常慢）
        outHeaders['cdn-cache-control'] = 'public, max-age=86400';
      }
      res.writeHead(pres.statusCode, outHeaders);
      if (gz) {
        const gzStream = createGzip();
        pres.pipe(gzStream).pipe(res);
        gzStream.on('error', () => res.destroy());
      } else {
        pres.pipe(res);
      }
    });
    proxy.on('error', () => { try { if (!res.headersSent) { res.writeHead(502); res.end('bad gateway'); } else { res.destroy(); } } catch (e2) { /* ignore */ } });
    req.pipe(proxy);
  }
  function handleUpgrade(req, socket, head) {
    if (!isAuthed(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    const headers = upgradeHeaders(req);
    const proxy = http.request({ host: TARGET_HOST, port: TARGET_PORT, path: req.url, method: 'GET', headers }, (pres) => { socket.destroy(); });
    proxy.on('upgrade', (pres, psocket, phead) => {
      let resp = 'HTTP/1.1 101 Switching Protocols\r\n';
      const h = pres.headers;
      if (h.upgrade) resp += 'Upgrade: ' + h.upgrade + '\r\n';
      if (h.connection) resp += 'Connection: ' + h.connection + '\r\n';
      if (h['sec-websocket-accept']) resp += 'Sec-WebSocket-Accept: ' + h['sec-websocket-accept'] + '\r\n';
      if (h['sec-websocket-protocol']) resp += 'Sec-WebSocket-Protocol: ' + h['sec-websocket-protocol'] + '\r\n';
      resp += '\r\n';
      socket.write(resp);
      if (phead && phead.length) psocket.unshift(phead);
      psocket.pipe(socket);
      socket.pipe(psocket);
      psocket.on('error', () => socket.destroy());
      socket.on('error', () => psocket.destroy());
    });
    proxy.on('error', () => socket.destroy());
    proxy.end();
  }

  const httpServer = createServer(handleRequest);
  httpServer.on('upgrade', handleUpgrade);

  let httpsServer = null;
  let tlsOptions = null;
  if (pfxPath && fs.existsSync(pfxPath)) {
    tlsOptions = { pfx: fs.readFileSync(pfxPath), passphrase: pfxPass || undefined };
  } else {
    const cert = generateSelfSignedCert(lanIPs());
    tlsOptions = { key: cert.key, cert: cert.cert };
  }
  httpsServer = createHttpsServer(tlsOptions, handleRequest);
  httpsServer.on('upgrade', handleUpgrade);

  return {
    token,
    httpServer,
    httpsServer,
    start(port, httpsPort) {
      return new Promise((resolve, reject) => {
        let httpDone = false;
        let httpsDone = false;
        const onErr = (e) => {
          console.error('[dsh-web-remote] proxy listen error:', e && e.message || e);
          if (!httpDone || (httpsPort !== null && !httpsDone)) reject(e);
        };
        httpServer.on('error', onErr);
        httpsServer.on('error', onErr);
        const cleanup = () => { httpServer.removeListener('error', onErr); httpsServer.removeListener('error', onErr); };
        httpServer.listen(port, '0.0.0.0', () => {
          httpDone = true;
          if (httpsPort === null || httpsDone) { cleanup(); resolve(); }
        });
        if (httpsPort === null) return;
        httpsServer.listen(httpsPort, '0.0.0.0', () => {
          httpsDone = true;
          if (httpDone) { cleanup(); resolve(); }
        });
      });
    },
    close() {
      try { httpServer.close(); } catch (e) { /* ignore */ }
      try { httpsServer.close(); } catch (e) { /* ignore */ }
    },
  };
}

// ───────────────────────── QQ OneBot 11 反向 WS 桥 ─────────────────────────

export function createQQServer(options) {
  const { infoUrls } = options;
  const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

  function encodeFrame(payload) {
    const buf = Buffer.from(payload, 'utf8');
    const len = buf.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81; header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81; header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, buf]);
  }
  function parseFrames(buffer, onText, onClose, onPing) {
    let offset = 0;
    while (offset + 2 <= buffer.length) {
      const b0 = buffer[offset];
      const b1 = buffer[offset + 1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let headerLen = 2;
      if (len === 126) {
        if (offset + 4 > buffer.length) return buffer.subarray(offset);
        len = buffer.readUInt16BE(offset + 2);
        headerLen = 4;
      } else if (len === 127) {
        if (offset + 10 > buffer.length) return buffer.subarray(offset);
        len = Number(buffer.readBigUInt64BE(offset + 2));
        headerLen = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (offset + headerLen + maskLen + len > buffer.length) return buffer.subarray(offset);
      let payload = buffer.subarray(offset + headerLen + maskLen, offset + headerLen + maskLen + len);
      if (masked) {
        const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      offset += headerLen + maskLen + len;
      if (opcode === 0x1) onText(payload.toString('utf8'));
      else if (opcode === 0x8) { onClose(); return buffer.subarray(offset); }
      else if (opcode === 0x9 && onPing) onPing(payload);
    }
    return buffer.subarray(offset);
  }
  function fetchInfo() {
    return new Promise((resolve) => {
      const tryUrl = (idx) => {
        if (idx >= infoUrls.length) { resolve(null); return; }
        const req = http.get(infoUrls[idx], (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed && parsed.url && parsed.token) resolve(parsed);
              else tryUrl(idx + 1);
            } catch (e) { tryUrl(idx + 1); }
          });
        });
        req.on('error', () => tryUrl(idx + 1));
        req.setTimeout(3000, () => { req.destroy(); tryUrl(idx + 1); });
      };
      tryUrl(0);
    });
  }
  function handlePrivate(evt, send) {
    const userId = evt.user_id;
    const message = String(evt.message || '');
    const reply = (text) => {
      try { send(JSON.stringify({ action: 'send_private_msg', params: { user_id: userId, message: text }, echo: 'dsh-remote' })); } catch (e) { /* ignore */ }
    };
    if (/远程|链接|网址|token|地址/.test(message)) {
      fetchInfo().then((info) => {
        if (info && info.url && info.token) {
          reply('DSH 远程访问链接：' + info.url + '/?token=' + info.token + '\n手机浏览器打开即可使用。插件重启后链接会变化，可再次发送本指令获取。');
        } else {
          reply('远程通道尚未启动，请在电脑 GUI 侧栏点击手机图标启动。');
        }
      });
    } else {
      reply('发送「给我链接」获取 DSH 远程访问地址。');
    }
  }
  function handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    let buffer = Buffer.alloc(0);
    const send = (text) => { try { socket.write(encodeFrame(text)); } catch (e) { /* ignore */ } };
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      buffer = parseFrames(buffer, (text) => {
        let evt;
        try { evt = JSON.parse(text); } catch (e) { return; }
        if (evt && evt.post_type === 'message' && evt.message_type === 'private') handlePrivate(evt, send);
      }, () => { socket.end(); }, (payload) => {
        const pong = Buffer.from([0x8a, payload.length]);
        try { socket.write(Buffer.concat([pong, payload])); } catch (e) { /* ignore */ }
      });
    });
    socket.on('error', () => { /* ignore */ });
  }

  const server = createServer((req, res) => { res.writeHead(200); res.end('dsh qq-bridge'); });
  server.on('upgrade', handleUpgrade);
  return {
    server,
    start(port) {
      return new Promise((resolve, reject) => {
        server.on('error', (e) => { server.removeAllListeners('error'); reject(e); });
        server.listen(port, '127.0.0.1', () => { server.removeAllListeners('error'); resolve(); });
      });
    },
    close() { try { server.close(); } catch (e) { /* ignore */ } },
  };
}

// ───────────────────────── cloudflared 自动下载 ─────────────────────────

export async function downloadCloudflared(dir) {
  const platform = process.platform;
  const arch = process.arch;
  let assetName;
  let exeName;
  if (platform === 'win32') {
    assetName = arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe';
    exeName = 'cloudflared.exe';
  } else if (platform === 'linux') {
    assetName = arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64';
    exeName = 'cloudflared';
  } else if (platform === 'darwin') {
    assetName = arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
    exeName = 'cloudflared';
  } else {
    throw new Error('unsupported platform: ' + platform);
  }
  const target = path.join(dir, exeName);
  if (fs.existsSync(target)) return target;

  // 直接使用 latest/download 直链（302 到最新版），不依赖 GitHub API
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${assetName}`;
  const tmp = target + '.download';
  await downloadFile(url, tmp);
  if (platform !== 'win32') {
    try { fs.chmodSync(tmp, 0o755); } catch (e) { /* ignore */ }
  }
  fs.renameSync(tmp, target);
  return target;
}

export function downloadFile(url, dest, attemptsLeft = 2) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'user-agent': 'dsh-web-remote' }, rejectUnauthorized: false }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        file.close();
        fs.rmSync(dest, { force: true });
        downloadFile(new URL(res.headers.location, url).href, dest, attemptsLeft).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('download failed: HTTP ' + res.statusCode));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    });
    req.on('error', (e) => {
      file.close();
      fs.rmSync(dest, { force: true });
      if (attemptsLeft > 0) {
        setTimeout(() => downloadFile(url, dest, attemptsLeft - 1).then(resolve, reject), 1500);
      } else {
        reject(e);
      }
    });
    req.setTimeout(60000, () => { req.destroy(new Error('download timeout')); });
  });
}

// ───────────────────────── 注入脚本（浏览器面板） ─────────────────────────

const INJECT_SCRIPT = `(function () {
  var NL = String.fromCharCode(10);
  var CHECK = 0;
  var currentTab = 'public';
  var lastInfo = null;
  var QR_SOURCES = ['https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=', 'https://api.pwmqr.com/qrcode/create/?url='];
  var currentBotChannel = null;
  function saveTab() {
    try { localStorage.setItem('webrm-tab', currentTab); } catch (e) {}
  }
  function loadTab() {
    var t = 'public';
    try {
      var v = localStorage.getItem('webrm-tab');
      if (v === 'lan') t = 'lan';
      else if (v === 'bot') t = 'bot';
    } catch (e) {}
    return t;
  }
  function style() {
    var css = '#webrm-native{z-index:1;height:34px;margin:0;flex:0 0 auto;color:var(--dsw-alias-label-secondary,#6e6e73);cursor:pointer;background:transparent;border:none;border-radius:8px;display:flex;align-items:center;justify-content:center;gap:4px;padding:0 8px;font-size:13px;font-weight:500;font-family:inherit;transition:background .15s ease,color .15s ease}#webrm-native:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.1));color:var(--dsw-alias-label-primary,#1d1d1f)}#webrm-native:active{background:var(--dsw-alias-interactive-bg-hover-accent,rgba(120,120,128,.2))}#webrm-mask{position:fixed;inset:0;z-index:100000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);}#webrm-panel{position:fixed;z-index:100001;left:50%;top:50%;transform:translate(-50%,-50%);width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 80%,transparent);-webkit-backdrop-filter:blur(30px) saturate(180%);backdrop-filter:blur(30px) saturate(180%);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:24px;box-shadow:0 24px 70px var(--dsw-alias-bg-mask-3,rgba(0,0,0,.3)),0 4px 16px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.1));padding:22px 20px 18px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1d1d1f);font-size:14px;line-height:22px;font-family:-apple-system,BlinkMacSystemFont,\\'SF Pro Text\\',\\'Segoe UI\\',Roboto,\\'PingFang SC\\',\\'Microsoft YaHei\\',sans-serif;-webkit-font-smoothing:antialiased}#webrm-panel h2{margin:0 0 14px;font-size:19px;font-weight:600;letter-spacing:-.2px;display:flex;align-items:center;justify-content:space-between;color:var(--dsw-alias-label-primary,#1d1d1f)}#webrm-close{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.14));border:none;cursor:pointer;width:26px;height:26px;border-radius:50%;font-size:15px;line-height:1;color:var(--dsw-alias-label-secondary,#48484a);display:flex;align-items:center;justify-content:center;padding:0;transition:background .15s}#webrm-close:hover{background:var(--dsw-alias-interactive-bg-hover-accent,rgba(120,120,128,.26))}#webrm-tabs{display:flex;justify-content:center;gap:2px;margin:2px 0 12px;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.1));border-radius:10px;padding:2px;width:fit-content;margin-left:auto;margin-right:auto}#webrm-tabs button{cursor:pointer;border:0!important;outline:none!important;appearance:none;-webkit-appearance:none;background:transparent;color:var(--dsw-alias-label-secondary,#6e6e73);border-radius:8px;padding:5px 22px;font-size:13px;font-weight:500;font-family:inherit;transition:all .18s ease}#webrm-tabs button.webrm-tab-active{background:#fff;color:var(--dsw-alias-label-primary,#1d1d1f);box-shadow:0 1px 4px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.1))}body[data-ds-dark-theme] #webrm-tabs button.webrm-tab-active{background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 85%,#fff)}#webrm-status{display:flex;align-items:center;gap:8px;margin:6px 0 4px;font-size:13px;color:var(--dsw-alias-label-secondary,#6e6e73)}#webrm-dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--dsw-alias-state-success-primary,#34c759);box-shadow:0 0 6px var(--dsw-alias-state-success-primary,#34c759)}.webrm-urlbox{background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 70%,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));border-radius:14px;padding:12px 14px;margin:10px 0;cursor:pointer;word-break:break-all;box-shadow:0 1px 4px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.04));transition:background .15s}.webrm-urlbox:hover{background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 90%,transparent)}.webrm-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#86868b);margin-bottom:4px}.webrm-url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#1d1d1f)}#webrm-row{display:flex;gap:2px;margin:16px 0 6px;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.1));border-radius:10px;padding:2px}.webrm-btn{cursor:pointer;border:0!important;outline:none!important;appearance:none;-webkit-appearance:none;background:transparent;color:var(--dsw-alias-label-secondary,#6e6e73);border-radius:8px;padding:6px 0;font-size:13px;font-weight:500;font-family:inherit;flex:1;text-align:center;transition:all .18s ease;-webkit-tap-highlight-color:transparent}.webrm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.1));color:var(--dsw-alias-label-primary,#1d1d1f)}.webrm-btn:active{transform:none}.webrm-btn-primary{background:#fff;color:var(--dsw-alias-label-primary,#1d1d1f);box-shadow:0 1px 4px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.1))}body[data-ds-dark-theme] .webrm-btn-primary{background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 85%,#fff)}.webrm-btn-primary:hover{background:#fff;color:var(--dsw-alias-label-primary,#1d1d1f)}body[data-ds-dark-theme] .webrm-btn-primary:hover{background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 85%,#fff)}.webrm-btn:disabled{opacity:.45;cursor:default}#webrm-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#86868b);margin-top:12px;white-space:pre-wrap;line-height:19px}#webrm-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#ff3b30);margin-top:8px;white-space:pre-wrap}#webrm-qr{width:190px;height:190px;border-radius:14px;margin:12px auto;display:block;background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 85%,#fff);padding:8px;box-sizing:border-box;box-shadow:0 2px 10px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.06))}#webrm-bot-grid{display:flex;justify-content:center;gap:2px;margin:2px 0 12px;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.12));border-radius:10px;padding:2px;width:fit-content;margin-left:auto;margin-right:auto}.webrm-bot-chip{cursor:pointer;border:0!important;outline:none!important;appearance:none;-webkit-appearance:none;background:transparent;color:var(--dsw-alias-label-secondary,#6e6e73);border-radius:8px;padding:5px 14px;font-size:13px;font-weight:500;font-family:inherit;transition:all .18s ease;-webkit-tap-highlight-color:transparent}.webrm-bot-chip:hover{color:var(--dsw-alias-label-primary,#1d1d1f)}.webrm-bot-chip-active{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1d1d1f);box-shadow:0 1px 4px var(--dsw-alias-bg-mask-1,rgba(0,0,0,.1))}.webrm-bot-ic{display:inline-flex;align-items:center;justify-content:center;margin-right:4px;vertical-align:middle}.webrm-bot-ic svg{width:14px;height:14px}.webrm-bot-name{display:inline-block}#webrm-bot-detail{margin-top:4px}#webrm-bot-strow{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary,#6e6e73);margin:6px 0}#webrm-bot-dot{width:8px;height:8px;border-radius:50%;display:inline-block}#webrm-bot-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#86868b);margin:4px 0 8px}.webrm-bot-actions{display:flex;gap:2px;margin:14px 0 6px;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.12));border-radius:10px;padding:2px}.webrm-bot-actions .webrm-btn{flex:1;padding:6px 0;font-size:13px;font-weight:500;border-radius:8px;white-space:nowrap;background:transparent;color:var(--dsw-alias-label-secondary,#6e6e73)}.webrm-bot-actions .webrm-btn-primary{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1d1d1f);box-shadow:0 1px 4px var(--dsw-alias-bg-mask-1,rgba(0,0,0,.1))}#webrm-bot-qr{margin:10px 0;padding:14px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;text-align:center;color:var(--dsw-alias-label-secondary,#86868b);font-size:12px}#webrm-bot-empty{font-size:13px;color:var(--dsw-alias-label-secondary,#86868b);text-align:center;padding:14px 0}';
    var tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
    var extraCss = '#webrm-custom-url{margin-top:10px;padding-top:10px;border-top:1px solid rgba(0,0,0,.1)}#webrm-custom-url .webrm-label2{font-size:12px;color:#8e8e93;margin-bottom:6px}#webrm-custom-url .webrm-edit-row{display:flex;gap:6px;align-items:center}#webrm-custom-url input{flex:1;padding:6px 8px;background:#f2f2f7;border:1px solid #d1d1d6;border-radius:6px;color:#1d1d1f;font-size:13px;outline:none;font-family:inherit}#webrm-custom-url input:focus{border-color:#0a84ff}#webrm-custom-url .webrm-btn-sm{padding:5px 10px;border-radius:6px;border:none;font-size:12px;font-weight:500;cursor:pointer;background:transparent;color:#8e8e93;font-family:inherit}#webrm-custom-url .webrm-btn-sm-primary{background:#0a84ff;color:#fff}#webrm-custom-url .webrm-placeholder{cursor:pointer;padding:6px 0;border-bottom:1px dashed rgba(120,120,128,.4);color:#636366;font-size:13px;display:flex;align-items:center;transition:border-color .2s}#webrm-custom-url .webrm-placeholder:hover{border-bottom-color:#0a84ff}#webrm-port-box{margin-top:10px;padding-top:10px;border-top:1px solid rgba(0,0,0,.1)}#webrm-port-box .webrm-label2{font-size:12px;color:#8e8e93;margin-bottom:6px}#webrm-port-box .webrm-port-row{display:flex;align-items:center;gap:6px}#webrm-port-box .webrm-port-fixed{color:#8e8e93;font-size:13px;white-space:nowrap}#webrm-port-box .webrm-port-editable{cursor:pointer;padding:2px 0;border-bottom:1px dashed rgba(120,120,128,.4);color:#0a84ff;font-weight:500;font-size:13px}#webrm-port-box .webrm-port-editable:hover{border-bottom-color:#0a84ff}#webrm-port-box input{width:70px;padding:5px 8px;background:#f2f2f7;border:1px solid #d1d1d6;border-radius:6px;color:#1d1d1f;font-size:13px;outline:none;font-family:inherit}body[data-ds-dark-theme] #webrm-custom-url input,body[data-ds-dark-theme] #webrm-port-box input{background:rgba(120,120,128,.2);border-color:rgba(255,255,255,.2);color:#fff}body[data-ds-dark-theme] #webrm-custom-url .webrm-btn-sm{background:rgba(120,120,128,.2);color:#8e8e93}body[data-ds-dark-theme] #webrm-port-box .webrm-port-editable{color:#0a84ff}';
    var extraTag = document.createElement('style');
    extraTag.textContent = extraCss;
    document.head.appendChild(extraTag);
    // 移动端视觉缩小（不覆盖 viewport）
    var mobileTag = document.createElement('style');
    mobileTag.textContent = '@media(max-width:768px){html{zoom:80%}}';
    document.head.appendChild(mobileTag);
  }
  function findSidebarRoot() {
    // 精确找侧边栏根：计算样式含 --dsh-sidebar-inline-padding 的元素
    var all = document.querySelectorAll('div');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      try {
        var v = window.getComputedStyle(el).getPropertyValue('--dsh-sidebar-inline-padding');
        if (v && v.trim() !== '') return el;
      } catch (e) { /* ignore */ }
    }
    return null;
  }
  function findSettingsArea() {
    // 优先：设置按钮（aria-label/title 含设置相关词）的父容器
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.textContent || '');
      if (/setting|设置|preference|偏好/i.test(label)) {
        var parent = b.parentNode;
        if (parent) return parent;
      }
    }
    // 兜底：侧边栏根元素的最后一个直接子容器（footArea）
    var root = findSidebarRoot();
    if (root && root.children.length) {
      var foot = root.children[root.children.length - 1];
      if (foot && foot.children.length) return foot;
      return foot;
    }
    return null;
  }
  function updateVisibility() {
    var btn = document.getElementById('webrm-native');
    if (!btn) return;
    var root = findSidebarRoot();
    var collapsed = root && (root.className || '').indexOf('collapsed') !== -1;
    btn.style.display = collapsed ? 'none' : '';
  }
  function syncGearColor() {
    // 重新读取设置按钮当前颜色并应用到远程按钮（主题/皮肤切换后颜色会变）
    var btn = document.getElementById('webrm-native');
    if (!btn) return;
    var area = findSettingsArea();
    if (!area) return;
    var buttons = area.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i] !== btn) {
        try { btn.style.color = window.getComputedStyle(buttons[i]).color; } catch (e) { /* ignore */ }
        return;
      }
    }
  }
  function attachButton(btn) {
    // 插入设置按钮旁（同一容器）
    var area = findSettingsArea();
    if (area) {
      // 容器改为横向 flex，靠左对齐：设置按钮贴左边框，手机按钮在它右侧
      try {
        area.style.display = 'flex';
        area.style.flexDirection = 'row';
        area.style.alignItems = 'center';
        area.style.justifyContent = 'flex-start';
        area.style.gap = '2px';
        // 设置按钮紧凑化：保留文字但缩短按钮体（内容宽、缩小内边距）
        var siblings = area.querySelectorAll('button');
        for (var si = 0; si < siblings.length; si++) {
          if (siblings[si] !== btn) {
            siblings[si].style.flex = '0 0 auto';
            siblings[si].style.width = 'auto';
            siblings[si].style.height = '34px';
            siblings[si].style.padding = '0 8px';
            siblings[si].style.fontSize = '13px';
            siblings[si].style.justifyContent = 'center';
            siblings[si].style.display = 'flex';
            siblings[si].style.alignItems = 'center';
            siblings[si].style.gap = '4px';
          }
        }
        syncGearColor();
      } catch (e) { /* ignore */ }
      // 手机按钮放设置按钮右侧（紧随其后）
      area.appendChild(btn);
      try { console.log('[webrm] inserted into:', area.tagName, area.className.slice(0, 80)); } catch (e) {}
      // 监听侧边栏根元素 class 变化（展开/收起）
      var root = findSidebarRoot();
      if (root && window.MutationObserver) {
        var obs = new MutationObserver(updateVisibility);
        obs.observe(root, { attributes: true, attributeFilter: ['class'] });
      }
      // 监听主题/皮肤变化：body/html 的 class/data/style 属性变化时重新同步颜色
      if (window.MutationObserver) {
        var themeObs = new MutationObserver(syncGearColor);
        themeObs.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-ds-dark-theme', 'data-theme', 'style'] });
        if (document.documentElement) {
          themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-ds-dark-theme', 'data-theme', 'style'] });
        }
      }
      // 兜底：每 2 秒同步一次颜色（覆盖纯 CSS 变量变化，开销极小）
      var colorTimer = setInterval(syncGearColor, 2000);
      updateVisibility();
      return true;
    }
    return false;
  }
  function create() {
    if (document.getElementById('webrm-native')) return;
    style();
    var btn = document.createElement('button');
    btn.id = 'webrm-native';
    btn.type = 'button';
    btn.title = '远程访问';
    btn.setAttribute('aria-label', '远程访问');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg><span>远程</span>';
    btn.addEventListener('click', openPanel);
    // 侧边栏由 React 异步渲染：轮询等待（最多 10 秒），找到设置区域再插入
    if (attachButton(btn)) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (attachButton(btn)) {
        clearInterval(timer);
        return;
      }
      if (tries >= 40) {
        clearInterval(timer);
        document.body.appendChild(btn); // 兜底：保留可用性
      }
    }, 250);
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function fetchInfo() {
    // 时间戳参数强制绕过所有缓存（浏览器 + 代理层）
    return fetch('/remote/info?_=' + Date.now(), { cache: 'no-store' }).then(function (res) { return res.json(); });
  }
  function act(action) {
    return fetch('/remote/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: action }) }).then(function (res) { return res.json(); });
  }
  function copyText(text, labelEl, doneLabel) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        if (labelEl) {
          var prev = labelEl.textContent;
          labelEl.textContent = doneLabel || '已复制 ✓';
          setTimeout(function () { labelEl.textContent = prev; }, 1500);
        }
      }).catch(function () {});
    }
  }
  // 白色滑块跟随真实运行状态：运行中→「启动」高亮，已停止→「停止」高亮
  function syncActionButtons(info) {
    var s = document.getElementById('webrm-start');
    var p = document.getElementById('webrm-stop');
    if (!s || !p) return;
    var running = !!(info && info.running);
    s.className = running ? 'webrm-btn webrm-btn-primary' : 'webrm-btn';
    p.className = running ? 'webrm-btn' : 'webrm-btn webrm-btn-primary';
  }
  // 机器人通道定义
  var BOT_CHANNELS = [
    { id: 'weixin', name: '微信', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/></svg>', hint: 'ClawBot / iLink 扫码接入' },
    { id: 'qq', name: 'QQ', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>', hint: 'NapCat（OneBot 11）连接后可用' },
    { id: 'telegram', name: '纸飞机', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>', hint: 'Telegram Bot API 接入' },
    { id: 'dingtalk', name: '钉钉', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/><path d="M10.5 7h3l-1.5 4h4l-6 8 1.5-4H8z" fill="#fff"/></svg>', hint: '钉钉机器人 Webhook 接入' },
    { id: 'feishu', name: '飞书', icon: '<svg viewBox="7 7 26 26" fill="currentColor"><path d="M16.791 30c5.57 0 10.423-3.074 12.955-7.618q.133-.239.258-.484a6 6 0 0 1-.425.699 6 6 0 0 1-.17.23 6 6 0 0 1-.225.274q-.092.105-.188.206a6 6 0 0 1-.407.384 6 6 0 0 1-.24.195 7 7 0 0 1-.292.21q-.094.065-.191.122c-.097.057-.134.081-.204.119q-.21.116-.428.215a6 6 0 0 1-.385.157 6 6 0 0 1-.43.138 6 6 0 0 1-.661.143 6 6 0 0 1-.491.055 6.125 6.125 0 0 1-1.543-.085 7 7 0 0 1-.38-.079l-.2-.051-.555-.155-.275-.081-.41-.125-.334-.107-.317-.104-.215-.073-.26-.091-.186-.066-.367-.134-.212-.081-.284-.11-.299-.119-.193-.079-.24-.1-.185-.078-.192-.084-.166-.073-.152-.067-.153-.07-.159-.073-.2-.093-.208-.099-.222-.108-.189-.093a31.2 31.2 0 0 1-8.822-6.583.202.202 0 0 0-.349.138l.005 9.52v.773c0 .448.222.87.595 1.118A14.75 14.75 0 0 0 16.791 30z"/><path d="M33.151 16.582a8.45 8.45 0 0 0-3.744-.869 8.5 8.5 0 0 0-2.303.317l-.252.075-.177.058-.348.127-.606.265-.617.33-.598.386-.404.306-.419.359-.218.206-.374.37-.269.266-.293.289-.281.278-.299.296-.348.344-.256.254-.085.084-.125.122-.063.06-.095.09-.105.099a15 15 0 0 1-3.072 2.175l.2.093.159.073.153.07.152.067.166.073.192.084.185.078.24.1.193.079.299.119.284.11.212.081.367.134.186.066.26.09.215.073.317.104.334.107.41.125.275.081.555.155.2.051.379.079.433.062.585.037.525-.014.491-.055a6 6 0 0 0 .66-.143l.43-.138.385-.158.427-.215.204-.119.191-.122.292-.21.24-.195.407-.384.188-.206.225-.274.17-.23a6 6 0 0 0 .421-.693l.144-.288 1.305-2.599-.003.006a8.1 8.1 0 0 1 1.697-2.439z"/><path d="M21.069 20.504l.063-.06.125-.122.085-.084.256-.254.348-.344.299-.296.281-.278.293-.289.269-.266.374-.37.218-.206.419-.359.404-.306.598-.386.617-.33.606-.265.348-.127.177-.058a14.78 14.78 0 0 0-2.793-5.603c-.252-.318-.639-.502-1.047-.502H12.221c-.196 0-.277.249-.119.364a31.49 31.49 0 0 1 8.943 10.162c.008-.007.016-.015.025-.023z"/></svg>', hint: '飞书机器人接入' },
  ];
  function botChannelStatus(id, info) {
    if (id === 'qq') return (info && info.qq === 'listening') ? '已就绪' : '等待 NapCat';
    if (id === 'weixin') {
      if (info && info.weixin === 'connected') return '已连接';
      if (info && info.weixin === 'waiting') return '等待扫码';
      return '未连接';
    }
    if (id === 'telegram') return (info && info.telegram === 'connected') ? '\u5df2\u8fde\u63a5' : '\u672a\u8fde\u63a5';
    if (id === 'feishu') {
      if (info && info.feishu === 'connected') return '\u5df2\u8fde\u63a5';
      if (info && info.feishu === 'configured') return '\u5df2\u914d\u7f6e';
      return '\u672a\u914d\u7f6e';
    }
    return '\u672a\u63a5\u5165';
  }
  function renderBotPage(panel, info, hint) {
    var box = document.getElementById('webrm-urlbox');
    if (!box) return;
    box.textContent = '';
    var grid = el('div', '', '');
    grid.id = 'webrm-bot-grid';
    BOT_CHANNELS.forEach(function (ch) {
      var b = el('button', 'webrm-bot-chip' + (currentBotChannel === ch.id ? ' webrm-bot-chip-active' : ''), '');
      b.type = 'button';
      b.setAttribute('data-channel', ch.id);
      var ic = el('span', 'webrm-bot-ic', '');
      ic.innerHTML = ch.icon;
      var nm = el('span', 'webrm-bot-name', ch.name);
      b.appendChild(ic);
      b.appendChild(nm);
      b.addEventListener('click', function () {
        currentBotChannel = (currentBotChannel === ch.id) ? null : ch.id;
        renderBotPage(panel, info, hint);
      });
      grid.appendChild(b);
    });
    box.appendChild(grid);
    var detail = el('div', '', '');
    detail.id = 'webrm-bot-detail';
    if (currentBotChannel) {
      var ch = null;
      for (var i = 0; i < BOT_CHANNELS.length; i++) if (BOT_CHANNELS[i].id === currentBotChannel) { ch = BOT_CHANNELS[i]; break; }
      if (ch) {
        var status = botChannelStatus(ch.id, info);
        var stRow = el('div', 'webrm-bot-strow', '');
        stRow.id = 'webrm-bot-strow';
        var d = el('span', 'webrm-bot-dot', '');
        d.style.background = (status === '已就绪' || status === '已连接') ? '#22c55e' : '#ef4444';
        stRow.appendChild(d);
        stRow.appendChild(el('span', '', status));
        detail.appendChild(stRow);
        var desc = el('div', 'webrm-bot-desc', ch.name + '通道：' + ch.hint);
        detail.appendChild(desc);
        var btns = el('div', 'webrm-bot-actions', '');
        var connectBtn = el('button', 'webrm-btn webrm-btn-primary', '绑定');
        connectBtn.type = 'button';
        connectBtn.addEventListener('click', function () {
          var st2 = document.getElementById('webrm-bot-strow');
          var qr2 = document.getElementById('webrm-bot-qr');
          if (ch.id === 'weixin') {
            // 微信 iLink 扫码绑定
            if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '正在获取二维码…')); }
            if (qr2) qr2.textContent = '';
            fetch('/weixin/qrcode', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (data) {
              if (!data.ok) {
                if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '获取失败: ' + (data.error || '未知错误'))); }
                return;
              }
              if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '用微信扫描下方二维码')); }
              if (qr2) {
                qr2.textContent = '';
                var img = el('img', '', '');
                img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(data.qrcodeUrl);
                img.style.cssText = 'width:200px;height:200px;border-radius:8px;background:#fff';
                qr2.appendChild(img);
                var tip = el('div', '', '打开微信扫描上方二维码');
                tip.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-secondary,#888);margin-top:6px;text-align:center';
                qr2.appendChild(tip);
              }
              // 开始轮询扫码状态
              var pollTimer = setInterval(function () {
                fetch('/weixin/poll').then(function (r) { return r.json(); }).then(function (res) {
                  if (res.status === 'connected') {
                    clearInterval(pollTimer);
                    if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '已连接')); st2.querySelector('span').previousElementSibling.style.background = '#22c55e'; }
                    if (qr2) qr2.textContent = '';
                    renderBotPage(panel, info, hint);
                  } else if (res.status === 'expired') {
                    clearInterval(pollTimer);
                    if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '二维码已过期，请重新绑定')); }
                  }
                }).catch(function () {});
              }, 3000);
            }).catch(function (e) {
              if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '网络错误: ' + e.message)); }
            });
          } else if (ch.id === 'feishu') {
            // 飞书：直接重新渲染飞书面板
            if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u8bf7\u5728\u4e0b\u65b9\u586b\u5199\u51ed\u8bc1')); }
            renderBotPage(panel, info, hint);
          } else {
            if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u7ed1\u5b9a\u4e2d\u2026\uff08\u529f\u80fd\u5f00\u53d1\u4e2d\uff09')); }
          }
        });
        var discBtn = el('button', 'webrm-btn', '\u89e3\u7ed1');
        discBtn.type = 'button';
        discBtn.addEventListener('click', function () {
          var st3 = document.getElementById('webrm-bot-strow');
          var qr3 = document.getElementById('webrm-bot-qr');
          if (ch.id === 'weixin') {
            fetch('/weixin/unbind', { method: 'POST' }).then(function (r) { return r.json(); }).then(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '已解绑')); var dot = st3.querySelector('.webrm-bot-dot'); if (dot) dot.style.background = '#ef4444'; }
              if (qr3) qr3.textContent = '';
            }).catch(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '解绑失败')); }
            });
          } else if (ch.id === 'feishu') {
            fetch('/remote/feishu/disconnect', { method: 'POST' }).then(function (r) { return r.json(); }).then(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '\u5df2\u89e3\u7ed1')); var dot = st3.querySelector('.webrm-bot-dot'); if (dot) dot.style.background = '#ef4444'; }
              info.feishu = null;
              renderBotPage(panel, info, hint);
            }).catch(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '\u89e3\u7ed1\u5931\u8d25')); }
            });
          } else {
            if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '已解绑')); }
          }
        });
        btns.appendChild(connectBtn);
        btns.appendChild(discBtn);
        detail.appendChild(btns);
        var qrZone = el('div', 'webrm-bot-qr', '');
        qrZone.id = 'webrm-bot-qr';
        if (ch.id === 'feishu') {
          var feishuSt = botChannelStatus('feishu', info);
          qrZone.textContent = '';
          var fForm = el('div', '', '');
          fForm.style.cssText = 'padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary,#1d1d1f)';
          if (feishuSt === '\u5df2\u8fde\u63a5') {
            fForm.appendChild(el('div', 'webrm-label2', '\u98de\u4e66\u673a\u5668\u4eba\u5df2\u8fde\u63a5\uff0c\u53ef\u5728\u98de\u4e66\u4e2d\u53d1\u6d88\u606f\u63a7\u5236 DSH'));
          } else if (feishuSt === '\u5df2\u914d\u7f6e') {
            var fReBtn = el('button', 'webrm-btn webrm-btn-primary', '\u91cd\u65b0\u8fde\u63a5');
            fReBtn.type = 'button';
            fReBtn.style.cssText = 'width:100%;margin-top:4px';
            fReBtn.addEventListener('click', function () {
              var st2 = document.getElementById('webrm-bot-strow');
              if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u8fde\u63a5\u4e2d\u2026')); }
              fetch('/remote/feishu/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: '', appSecret: '' }) }).then(function (r) { return r.json(); }).then(function () {
                if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u5df2\u91cd\u8fde')); var dt = st2.querySelector('.webrm-bot-dot'); if (dt) dt.style.background = '#22c55e'; }
              }).catch(function () { if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u91cd\u8fde\u5931\u8d25')); } });
            });
            fForm.appendChild(el('div', 'webrm-label2', '\u98de\u4e66\u5df2\u914d\u7f6e\uff0c\u7b49\u5f85\u8fde\u63a5'));
            fForm.appendChild(fReBtn);
          } else {
            fForm.appendChild(el('div', 'webrm-label2', '\u8bf7\u586b\u5199\u98de\u4e66\u5f00\u653e\u5e73\u53f0\u7684 App ID \u548c App Secret'));
            var fId = el('input', '', '');
            fId.placeholder = 'App ID (cli_xxx)';
            fId.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;margin:6px 0;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.08));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:8px;font-size:13px;outline:none;color:var(--dsw-alias-label-primary,#1d1d1f)';
            fForm.appendChild(fId);
            var fSec = el('input', '', '');
            fSec.type = 'password';
            fSec.placeholder = 'App Secret';
            fSec.style.cssText = fId.style.cssText;
            fForm.appendChild(fSec);
            var fBtn = el('button', 'webrm-btn webrm-btn-primary', '\u786e\u8ba4\u5e76\u9a8c\u8bc1');
            fBtn.type = 'button';
            fBtn.style.cssText = 'margin-top:8px;width:100%';
            fBtn.addEventListener('click', function () {
              var vId = fId.value.trim(), vSec = fSec.value.trim();
              if (!vId || !vSec) { var se = document.getElementById('webrm-bot-strow'); if (se) { se.appendChild(el('span', '', ' \u8bf7\u586b\u5199\u5168\u90e8\u51ed\u8bc1')); se.querySelector('span:last-child').style.color = '#ef4444'; } return; }
              var st2 = document.getElementById('webrm-bot-strow');
              if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u9a8c\u8bc1\u4e2d\u2026')); }
              fetch('/remote/feishu/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: vId, appSecret: vSec }) }).then(function (r) { return r.json(); }).then(function (d) {
                if (d.ok && d.connected) { if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u5df2\u8fde\u63a5')); var dt = st2.querySelector('.webrm-bot-dot'); if (dt) dt.style.background = '#22c55e'; } qrZone.textContent = ''; qrZone.appendChild(el('div', '', '\u98de\u4e66\u673a\u5668\u4eba\u5df2\u8fde\u63a5\uff0c\u53ef\u5728\u98de\u4e66\u4e2d\u53d1\u6d88\u606f\u63a7\u5236 DSH')); }
                else { if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u9a8c\u8bc1\u5931\u8d25: ' + (d.error || '\u672a\u77e5\u9519\u8bef'))); st2.querySelector('span').style.color = '#ef4444'; } }
              }).catch(function (e) { if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u8bf7\u6c42\u5931\u8d25: ' + e.message)); st2.querySelector('span').style.color = '#ef4444'; } });
            });
            var fLink = el('a', '', '\u2192 \u6253\u5f00\u98de\u4e66\u5f00\u653e\u5e73\u53f0');
            fLink.href = 'https://open.feishu.cn';
            fLink.target = '_blank';
            fLink.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);display:inline-block;margin-top:10px';
            fForm.appendChild(fBtn);
            fForm.appendChild(fLink);
          }
          qrZone.appendChild(fForm);
        } else {
          qrZone.appendChild(el('div', '', '\u70b9\u51fb\u300c\u7ed1\u5b9a\u300d\u5f00\u59cb\u626b\u7801'));
        }
        detail.appendChild(qrZone);
      }
    } else {
      detail.appendChild(el('div', 'webrm-bot-empty', '选择一个通道查看详情'));
    }
    box.appendChild(detail);
  }
  function renderStatus(panel, info, hint) {
    syncActionButtons(info);
    var st = document.getElementById('webrm-status');
    if (st) {
      st.textContent = '';
      var dot = el('span', '', '');
      dot.id = 'webrm-dot';
      dot.style.background = info && info.running ? '#22c55e' : '#ef4444';
      st.appendChild(dot);
      st.appendChild(el('span', '', info && info.running ? '运行中' : '已停止'));
    }
        // 机器人标签：渲染四通道页面，隐藏远程控制行与二维码
    var rowEl = document.getElementById('webrm-row');
    var qrEl = document.getElementById('webrm-qr');
    if (currentTab === 'bot') {
      if (rowEl) rowEl.style.display = 'none';
      if (qrEl && qrEl.parentNode) qrEl.parentNode.removeChild(qrEl);
      renderBotPage(panel, info, hint);
      var hb = document.getElementById('webrm-hint');
      if (hb) {
        hb.textContent = '通过聊天机器人遥控 DSH：QQ（NapCat）/ 微信（ClawBot）/ 钉钉 / 飞书。' + NL + '支持指令：状态 / 获取链接 / 启动 / 停止 / 换新链接 / 帮助';
      }
      var eb = document.getElementById('webrm-error');
      if (eb) eb.textContent = '';
      return;
    }
    if (rowEl) rowEl.style.display = '';
    var box = document.getElementById('webrm-urlbox');
    if (!box) return;
    box.textContent = '';
    var urls = [];
    if (currentTab === 'lan' && info && info.ips && info.ips.length) {
      urls = info.ips.map(function (ip) { return { label: '局域网直连 ' + ip + '（点击复制）', url: (info.httpsPort ? 'https://' : 'http://') + ip + ':' + (info.httpsPort || info.port) + (info.lanOpen ? '' : '/?token=' + info.token) }; });
    } else if (info && info.url && info.token) {
      urls = [{ label: '公网访问链接（点击复制）', url: info.url + '/?token=' + info.token }];
    }
    if (urls.length === 0) {
      if (info && info.running && currentTab === 'public') {
        box.appendChild(el('div', '', '隧道已断开：请点「停止」后重新「启动」'));
      } else {
        box.appendChild(el('div', '', '尚未启动'));
      }
    }
    urls.forEach(function (item) {
      var labelEl = el('div', '', item.label);
      labelEl.className = 'webrm-label';
      var linkEl = el('div', '', item.url);
      linkEl.className = 'webrm-url';
      linkEl.style.marginBottom = '6px';
      box.appendChild(labelEl);
      box.appendChild(linkEl);
      box.addEventListener('click', function () { copyText(item.url, labelEl, '\u5df2\u590d\u5236 \u2713'); });
    });
    (function () {
      var oldu = document.getElementById('webrm-custom-url');
      if (oldu && oldu.parentNode) oldu.parentNode.removeChild(oldu);
      var oldp = document.getElementById('webrm-port-box');
      if (oldp && oldp.parentNode) oldp.parentNode.removeChild(oldp);
      if (currentTab === 'public') {
        var con = el('div', '', '');
        con.id = 'webrm-custom-url';
        con.appendChild(el('div', 'webrm-label2', '\u81ea\u5b9a\u4e49\u516c\u7f51\u94fe\u63a5'));
        var wrap = el('div', '', '');
        var renderView = function () {
          wrap.textContent = '';
          if (info && info.customPublicUrl) {
            var uLink = el('div', 'webrm-url', info.customPublicUrl);
            uLink.style.marginBottom = '4px';
            uLink.addEventListener('click', function (e) { e.stopPropagation(); copyText(info.customPublicUrl, uLink, '\u5df2\u590d\u5236 \u2713'); });
            wrap.appendChild(uLink);
            var eBtn = el('button', 'webrm-btn-sm', '\u7f16\u8f91');
            eBtn.addEventListener('click', renderEdit);
            wrap.appendChild(eBtn);
            var dBtn = el('button', 'webrm-btn-sm', '\u6e05\u9664');
            dBtn.addEventListener('click', function () {
              fetch('/remote/custom-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":""}' });
              if (info) info.customPublicUrl = null;
              renderView();
            });
            wrap.appendChild(dBtn);
          } else {
            var ph = el('div', 'webrm-placeholder', '\u70b9\u51fb\u586b\u5199\u81ea\u5b9a\u4e49\u516c\u7f51\u94fe\u63a5');
            ph.addEventListener('click', renderEdit);
            wrap.appendChild(ph);
          }
        };
        var renderEdit = function () {
          wrap.textContent = '';
          var row = el('div', 'webrm-edit-row', '');
          var inp = el('input', '', '');
          inp.type = 'text';
          inp.placeholder = 'https://xxx.ngrok.io';
          if (info && info.customPublicUrl) inp.value = info.customPublicUrl;
          var sBtn = el('button', 'webrm-btn-sm webrm-btn-sm-primary', '\u4fdd\u5b58');
          sBtn.addEventListener('click', function () {
            var v = inp.value.trim();
            fetch('/remote/custom-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"' + v.replace(/"/g, '') + '"}' });
            if (info) info.customPublicUrl = v || null;
            renderView();
          });
          var cBtn = el('button', 'webrm-btn-sm', '\u53d6\u6d88');
          cBtn.addEventListener('click', renderView);
          row.appendChild(inp); row.appendChild(sBtn); row.appendChild(cBtn);
          wrap.appendChild(row);
          inp.focus();
        };
        con.appendChild(wrap);
        box.appendChild(con);
        renderView();
      } else if (currentTab === 'lan' && info && info.ips && info.ips.length) {
        var lip = info.ips[0];
        var pbox = el('div', '', '');
        pbox.id = 'webrm-port-box';
        pbox.appendChild(el('div', 'webrm-label2', '\u81ea\u5b9a\u4e49\u7aef\u53e3'));
        var prow = el('div', 'webrm-port-row', '');
        var renderPortEdit = function () {
          prow.textContent = '';
          var fixed2 = el('span', 'webrm-port-fixed', (info.httpsPort ? 'https://' : 'http://') + lip + ':');
          var pin = el('input', '', '');
          pin.type = 'number'; pin.value = String(info.httpsPort || info.port);
          pin.min = '1024'; pin.max = '65535';
          var abtn = el('button', 'webrm-btn-sm webrm-btn-sm-primary', '\u5e94\u7528');
          abtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var np = parseInt(pin.value, 10);
            if (isNaN(np) || np < 1024 || np > 65535) { pin.style.borderColor = '#ff3b30'; return; }
            fetch('/remote/set-port', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"port":' + np + '}' })
              .then(function (r) { return r.json(); })
              .then(function (d) { if (d.ok) { if (info) info.httpsPort = np; renderStatus(panel, info, hint); } else { alert(d.error || '\u7aef\u53e3\u8bbe\u7f6e\u5931\u8d25'); } })
              .catch(function () { alert('\u8bf7\u6c42\u5931\u8d25'); });
          });
          var cbtn = el('button', 'webrm-btn-sm', '\u53d6\u6d88');
          cbtn.addEventListener('click', renderPortView);
          prow.appendChild(fixed2); prow.appendChild(pin); prow.appendChild(abtn); prow.appendChild(cbtn);
          pin.focus(); pin.select();
        };
        var renderPortView = function () {
          prow.textContent = '';
          var fixed2 = el('span', 'webrm-port-fixed', (info.httpsPort ? 'https://' : 'http://') + lip + ':');
          var ed2 = el('span', 'webrm-port-editable', String(info.httpsPort || info.port));
          ed2.addEventListener('click', renderPortEdit);
          prow.appendChild(fixed2); prow.appendChild(ed2);
        };
        renderPortView();
        pbox.appendChild(prow);
        box.appendChild(pbox);
      }
    })();
    var qr = document.getElementById('webrm-qr');
    if (qr && qr.parentNode) qr.parentNode.removeChild(qr);
    var qrTarget = currentTab === 'lan' && info && info.ips && info.ips.length ? (info.httpsPort ? 'https://' : 'http://') + info.ips[0] + ':' + (info.httpsPort || info.port) + (info.lanOpen ? '' : '/?token=' + info.token) : (info && info.url && info.token ? info.url + '/?token=' + info.token : null);
    if (qrTarget) {
      var qi = 0;
      var q = el('img', '', '');
      q.id = 'webrm-qr';
      q.alt = '扫码访问';
      var loadQr = function () {
        if (qi >= QR_SOURCES.length) {
          if (q.parentNode) q.parentNode.removeChild(q);
          return;
        }
        // 附加时间戳，强制浏览器重新加载二维码（避免缓存显示旧图）
        q.src = QR_SOURCES[qi] + encodeURIComponent(qrTarget) + '&_=' + Date.now();
        qi += 1;
      };
      q.addEventListener('error', loadQr);
      panel.insertBefore(q, hint);
      loadQr();
    } else if (info && info.running && currentTab === 'public') {
      var waitEl = el('div', '', '正在获取公网链接，请稍候…');
      waitEl.id = 'webrm-qr';
      waitEl.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);text-align:center;margin:10px 0';
      panel.insertBefore(waitEl, hint);
    }
    var h2 = document.getElementById('webrm-hint');
    if (h2) {
      var parts = [];
      parts.push('注意：公网链接含访问令牌，请勿泄露。');
      parts.push('提示：换新链接后首次打开较慢（约 10~30 秒），之后秒开；同 Wi-Fi 建议用「局域网」链接，速度更快。');
      h2.textContent = parts.join(NL + NL);
    }
    var err = document.getElementById('webrm-error');
    if (err) {
      if (info && info.error) err.textContent = String(info.error);
      else err.textContent = '';
    }
  }
  function setTab(tab, publicBtn, lanBtn, botBtn, panel, hint) {
    currentTab = tab;
    saveTab();
    publicBtn.className = tab === 'public' ? 'webrm-tab-active' : '';
    lanBtn.className = tab === 'lan' ? 'webrm-tab-active' : '';
    if (botBtn) botBtn.className = tab === 'bot' ? 'webrm-tab-active' : '';
    if (lastInfo) renderStatus(panel, lastInfo, hint);
  }
  function openPanel() {
    if (document.getElementById('webrm-mask')) return;
    currentTab = loadTab();
    var mask = el('div', '', '');
    mask.id = 'webrm-mask';
    var panel = el('div', '', '');
    panel.id = 'webrm-panel';
    var head = el('h2', '', '远程访问');
    var x = el('button', '', '×');
    x.id = 'webrm-close';
    x.setAttribute('aria-label', '关闭');
    head.appendChild(x);
    panel.appendChild(head);
    var tabs = el('div', '', '');
    tabs.id = 'webrm-tabs';
    var publicBtn = el('button', currentTab === 'public' ? 'webrm-tab-active' : '', '公网');
    publicBtn.type = 'button';
    var lanBtn = el('button', currentTab === 'lan' ? 'webrm-tab-active' : '', '局域网');
    var botBtn = el('button', currentTab === 'bot' ? 'webrm-tab-active' : '', '机器人');
    botBtn.type = 'button';
    lanBtn.type = 'button';
    tabs.appendChild(publicBtn);
    tabs.appendChild(lanBtn);
    tabs.appendChild(botBtn);
    panel.appendChild(tabs);
    var statusRow = el('div', '', '加载中…');
    statusRow.id = 'webrm-status';
    panel.appendChild(statusRow);
    var urlBox = el('div', '', '');
    urlBox.id = 'webrm-urlbox';
    panel.appendChild(urlBox);
    var row = el('div', '', '');
    row.id = 'webrm-row';
    row.className = 'webrm-row';
    var startBtn = el('button', 'webrm-btn webrm-btn-primary', '启动');
    startBtn.type = 'button';
    startBtn.id = 'webrm-start';
    var stopBtn = el('button', 'webrm-btn', '停止');
    stopBtn.type = 'button';
    stopBtn.id = 'webrm-stop';
    var refreshBtn = el('button', 'webrm-btn', '换新链接');
    refreshBtn.type = 'button';
    refreshBtn.id = 'webrm-refresh';
    row.appendChild(startBtn);
    row.appendChild(stopBtn);
    row.appendChild(refreshBtn);
    panel.appendChild(row);
    var err = el('div', '', '');
    err.id = 'webrm-error';
    err.className = 'webrm-error';
    panel.appendChild(err);
    var hint = el('div', '', '');
    hint.id = 'webrm-hint';
    hint.className = 'webrm-hint';
    panel.appendChild(hint);
    var retryCount = 0;
    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      lastInfo = null;
    }
    function refresh() {
      startBtn.disabled = true;
      stopBtn.disabled = true;
      refreshBtn.disabled = true;
      fetchInfo().then(function (info) {
        lastInfo = info;
        renderStatus(panel, info, hint);
        if (info && info.running && currentTab === 'public' && !info.url && retryCount < 3) {
          retryCount += 1;
          setTimeout(function () { refresh(); }, 5000);
        }
      }).catch(function () {
        var st2 = document.getElementById('webrm-status');
        if (st2) st2.textContent = '获取状态失败';
      }).finally(function () {
        startBtn.disabled = false;
        stopBtn.disabled = false;
        refreshBtn.disabled = false;
      });
    }
    function control(action) {
      startBtn.disabled = true;
      stopBtn.disabled = true;
      refreshBtn.disabled = true;
      act(action).then(function (info) {
        lastInfo = info;
        renderStatus(panel, info, hint);
      }).catch(function () {
        var st3 = document.getElementById('webrm-status');
        if (st3) st3.textContent = '操作失败';
      }).finally(function () {
        startBtn.disabled = false;
        stopBtn.disabled = false;
        refreshBtn.disabled = false;
      });
    }
    mask.addEventListener('click', close);
    x.addEventListener('click', close);
    publicBtn.addEventListener('click', function () { setTab('public', publicBtn, lanBtn, botBtn, panel, hint); });
    lanBtn.addEventListener('click', function () { setTab('lan', publicBtn, lanBtn, botBtn, panel, hint); });
    botBtn.addEventListener('click', function () { setTab('bot', publicBtn, lanBtn, botBtn, panel, hint); });
    startBtn.addEventListener('click', function () { control('start'); });
    stopBtn.addEventListener('click', function () { control('stop'); });
    refreshBtn.addEventListener('click', function () {
      var st4 = document.getElementById('webrm-status');
      if (st4) st4.textContent = '正在换新链接…';
      control('renew');
    });
    document.body.appendChild(mask);
    document.body.appendChild(panel);
    refresh();
  }
  function tryCreate() {
    if (document.querySelector('.webrm-fab')) return;
    if (document.body) {
      create();
    } else if (CHECK < 40) {
      CHECK += 1;
      setTimeout(tryCreate, 250);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryCreate);
  } else {
    tryCreate();
  }
})();`;

// ───────────────────────── 插件主体 ─────────────────────────

export const name = 'web-remote';
export const inject = ['timer'];

export function apply(ctx, rawConfig) {
  const cfg = rawConfig ?? {};
  const config = {
    targetPort: cfg.targetPort ?? 3080,
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
  };
  // 读取持久化的自定义端口（toolsDir 尚未就绪，用路径拼接）
  try {
    var portDir = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'tools') : path.join(os.homedir(), '.dsh', 'tools');
    var portFile = path.join(portDir, 'custom-port.json');
    if (fs.existsSync(portFile)) {
      var pd = JSON.parse(fs.readFileSync(portFile, 'utf-8'));
      if (pd && pd.port) { config.httpsPortStart = pd.port; }
    }
  } catch (e) {}

  // 等待 webServer / subprocess 服务就绪后再挂载（与官方 dsh-market 同款模式）
  ctx.inject(['subprocess', 'webServer'], (hostCtx) => {
    const subprocess = hostCtx.subprocess;
    const webServer = hostCtx.webServer;

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
      proxy = createProxyServer({ targetPort: config.targetPort, pfxPath: config.pfxPath, pfxPass: config.pfxPass, lanOpen: config.lanOpen });
      const httpPort = await findFreePort(config.httpPortStart, config.httpPortStart + 9);
      const httpsPort = await findFreePort(config.httpsPortStart, config.httpsPortStart + 9);
      await proxy.start(httpPort, httpsPort);
      state.token = proxy.token;
      state.port = httpPort;
      state.httpsPort = httpsPort;
      state.ips = lanIPs();

      // 2. cloudflared 隧道
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
      const url = await waitForPattern(tunnelHandle, /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/, 30000);
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

      // 3. QQ 桥
      qqServer = createQQServer({ infoUrls: ['http://127.0.0.1:' + config.targetPort + '/remote/info', 'http://127.0.0.1:' + config.targetPort + '/remote/access'] });
      qqPort = await findFreePort(config.qqPortStart, config.qqPortStart + 4);
      await qqServer.start(qqPort);
      state.qq = 'listening';

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
  const weixinTokenPath = path.join(toolsDir, 'weixin-token.json');
  const weixinState = { status: 'idle', botToken: null, qrcode: null, qrcodeUrl: null, error: null };
  function saveWeixinToken(token) {
    try { fs.writeFileSync(weixinTokenPath, JSON.stringify({ botToken: token, savedAt: Date.now() })); } catch (e) { console.error('[dsh-weixin] save token failed:', e.message); }
  }
  function loadWeixinToken() {
    try { if (fs.existsSync(weixinTokenPath)) { const d = JSON.parse(fs.readFileSync(weixinTokenPath, 'utf8')); return d.botToken || null; } } catch (e) { /* ignore */ }
    return null;
  }
  function clearWeixinToken() {
    try { if (fs.existsSync(weixinTokenPath)) fs.unlinkSync(weixinTokenPath); } catch (e) { /* ignore */ }
  }
  const ILINK_BASE = 'https://ilinkai.weixin.qq.com';
  function iLinkHeaders(token) {
    const uin = Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF))).toString('base64');
    const h = { 'Content-Type': 'application/json', 'AuthorizationType': 'ilink_bot_token', 'X-WECHAT-UIN': uin };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }
  async function iLinkGet(path, token) {
    const https = await import('node:https');
    return new Promise((resolve, reject) => {
      const req = https.request(ILINK_BASE + path, { method: 'GET', headers: iLinkHeaders(token) }, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
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
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
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
  let weixinMonitorTimer = null;
  let weixinMonitorSnapshots = {}; // { agentId: { eventsLen, wasRunning } }
  let weixinMonitorTitles = {}; // { agentId: title }

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
                weixinState.lastContextToken = msg.context_token;
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
        console.error('[dsh-weixin] poll error:', e.message || e);
        await new Promise(function (r) { setTimeout(r, 5000); });
      }
    }
    weixinPollLoopRunning = false;
    console.log('[dsh-weixin] poll loop stopped');
  }

  let customPublicUrl = null;
  let feishuToken = null;
  const feishuConfigPath_snapshot = path.join(toolsDir, 'feishu-config.json');

  const snapshot = () => {
    var feishuSt = null;
    try {
      if (feishuToken && Date.now() < feishuToken.expireAt) { feishuSt = 'connected'; }
      else {
        var fPath = feishuConfigPath_snapshot;
        console.log('[snapshot] feishu check path:', fPath, 'exists:', fs.existsSync(fPath));
        if (fs.existsSync(fPath)) {
          var fc = JSON.parse(fs.readFileSync(fPath, 'utf-8'));
          console.log('[snapshot] feishu config:', fc.appId ? 'has appId' : 'no appId');
          if (fc && fc.appId) feishuSt = 'configured';
        }
      }
    } catch (e) { console.error('[snapshot] feishu check error:', e.message); }
    return { running: state.running, url: state.url, token: state.token, port: state.port, httpsPort: state.httpsPort, ips: state.ips, qq: state.qq, weixin: weixinState.status, error: state.error, lanOpen: config.lanOpen, customPublicUrl: customPublicUrl || null, feishu: feishuSt };
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
    const feishuConfigPath = path.join(toolsDir, 'feishu-config.json');
    function feishuLoadConfig() {
      try { return JSON.parse(fs.readFileSync(feishuConfigPath, 'utf-8')) || {}; } catch (e) { return {}; }
    }
    function feishuSaveConfig(cfg) {
      try { fs.mkdirSync(toolsDir, { recursive: true }); fs.writeFileSync(feishuConfigPath, JSON.stringify(cfg, null, 2), 'utf-8'); return true; } catch (e) { return false; }
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
          return { ok: true };
        }
        return { ok: false, error: data.msg || ('code=' + data.code) };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    async function feishuEnsureToken() {
      if (feishuToken && Date.now() < feishuToken.expireAt) return { ok: true, token: feishuToken.token };
      const cfg = feishuLoadConfig();
      if (!cfg.appId || !cfg.appSecret) return { ok: false, error: '\u672a\u914d\u7f6e\u98de\u4e66\u51ed\u8bc1' };
      return feishuVerify(cfg.appId, cfg.appSecret);
    }
    async function feishuSendText(chatId, text) {
      const t = await feishuEnsureToken();
      if (!t.ok) throw new Error(t.error);
      const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST', headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t.token },
        body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: String(text || '') }) })
      });
      const data = await res.json();
      if (!(data && data.code === 0)) throw new Error(data.msg || ('code=' + data.code));
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
        if (!appId || !appSecret) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '\u8bf7\u586b\u5199 App ID \u548c App Secret' })); return; }
        const v = await feishuVerify(appId, appSecret);
        feishuSaveConfig({ appId, appSecret });
        if (v.ok) { feishuToken = null; await feishuEnsureToken(); feishuStartWS().catch(function(e){}); console.log('[feishu] \u51ed\u8bc1\u9a8c\u8bc1\u901a\u8fc7'); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, connected: true })); }
        else { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true, connected: false, error: v.error })); }
      } catch (e) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
    };
    const feishuDisconnectHandler = async (req, res) => {
      feishuStopWS();
      try { if (fs.existsSync(feishuConfigPath)) fs.unlinkSync(feishuConfigPath); } catch (e) {}
      feishuToken = null;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: true }));
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/feishu/status', handler: feishuStatusHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/feishu/config', handler: feishuConfigHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/feishu/disconnect', handler: feishuDisconnectHandler }));

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
        try { feishuWSClient.stop(); } catch (e) {}
        feishuWSClient = null;
        console.log('[feishu] WebSocket stopped');
      }
    }
    async function feishuHandleCommand(text, chatId) {
      const t = (text || '').trim();
      if (!t) return null;
      if (/^\/?(help|\u5e2e\u52a9|\u547d\u4ee4)$/i.test(t)) {
        return '\u98de\u4e66\u673a\u5668\u4eba\u5df2\u5728\u7ebf\uff0c\u652f\u6301\u547d\u4ee4\uff1a\n\u2022 \u5e2e\u52a9 - \u663e\u793a\u672c\u5217\u8868\n\u2022 \u94fe\u63a5 - \u83b7\u53d6 DSH \u8fdc\u7a0b\u94fe\u63a5\n\u2022 \u542f\u52a8 - \u542f\u52a8\u8fdc\u7a0b\u670d\u52a1\n\u2022 \u505c\u6b62 - \u505c\u6b62\u8fdc\u7a0b\u670d\u52a1\n\u2022 \u72b6\u6001 - \u67e5\u770b DSH \u8fd0\u884c\u72b6\u6001\n\u2022 \u76d1\u542c - \u5f00\u5173\u76d1\u542c\u6a21\u5f0f\n\u2022 \u4f1a\u8bdd\u5217\u8868 - \u67e5\u770b DSH \u4f1a\u8bdd\n\u2022 \u6a21\u578b - \u67e5\u770b\u5f53\u524d\u6a21\u578b';
      }
      if (/^\/?(\u94fe\u63a5|\u83b7\u53d6\u94fe\u63a5|\u516c\u7f51\u94fe\u63a5|link)$/i.test(t)) {
        if (!state.running) {
          state.error = null;
          console.log('[feishu] starting remote (via feishu command)...');
          try { await start(); } catch (e) {}
        }
        if (state.url && state.token) {
          return '\u516c\u7f51\u94fe\u63a5\uff1a\n' + state.url + '/?token=' + state.token;
        }
        if (state.error) return '\u542f\u52a8\u5931\u8d25\uff1a' + state.error;
        return '\u6b63\u5728\u83b7\u53d6\u94fe\u63a5\uff0c\u8bf7\u7a0d\u5019\uff08\u96a7\u9053\u5efa\u7acb\u7ea6 10~30 \u79d2\uff09\u2026';
      }
      if (/^\/?(\u542f\u52a8|start|\u5f00\u542f)$/i.test(t)) {
        if (state.running) return '\u8fdc\u7a0b\u670d\u52a1\u5df2\u5728\u8fd0\u884c\u4e2d';
        state.error = null;
        try { await start(); } catch (e) {}
        if (state.running) return '\u8fdc\u7a0b\u670d\u52a1\u5df2\u542f\u52a8';
        if (state.error) return '\u542f\u52a8\u5931\u8d25\uff1a' + state.error;
        return '\u6b63\u5728\u542f\u52a8\uff0c\u8bf7\u7a0d\u5019\u2026';
      }
      if (/^\/?(\u505c\u6b62|\u5173\u95ed\u8fdc\u7a0b|stop|\u505c\u6b62\u8fdc\u7a0b)$/i.test(t)) {
        if (!state.running) return '\u8fdc\u7a0b\u670d\u52a1\u672a\u542f\u52a8';
        stop();
        return '\u5df2\u505c\u6b62\u8fdc\u7a0b\u670d\u52a1';
      }
      if (/^\/?(\u72b6\u6001|status)$/i.test(t)) {
        const info = snapshot();
        var s = 'DSH \u72b6\u6001\uff1a' + (info.running ? '\u8fd0\u884c\u4e2d' : '\u5df2\u505c\u6b62');
        if (info.running && info.url) s += '\n\u94fe\u63a5\uff1a' + info.url + '/?token=' + info.token;
        if (info.ips && info.ips.length > 0) s += '\n\u5c40\u57df\u7f51 IP\uff1a' + info.ips.join(', ');
        return s;
      }
      if (/^\/?(\u76d1\u542c|\u76d1\u63a7)$/i.test(t)) {
        weixinMonitorMode = !weixinMonitorMode;
        try {
          var monFile = path.join(toolsDir, 'monitor-mode.json');
          if (weixinMonitorMode) fs.writeFileSync(monFile, JSON.stringify({ enabled: true }), 'utf-8');
          else if (fs.existsSync(monFile)) fs.unlinkSync(monFile);
        } catch (e) {}
        if (weixinMonitorMode) { try { startMonitor(); } catch (e) {} return '\u76d1\u542c\u6a21\u5f0f\u5df2\u5f00\u542f\uff0c\u518d\u6b21\u53d1\u9001 \u76d1\u542c \u53ef\u5173\u95ed'; }
        else { try { stopMonitor(); } catch (e) {} return '\u76d1\u542c\u6a21\u5f0f\u5df2\u5173\u95ed'; }
      }
      if (/^\/?(\u4f1a\u8bdd\u5217\u8868|\u4f1a\u8bdd)$/i.test(t)) {
        if (!sessionQuery) return '\u4f1a\u8bdd\u670d\u52a1\u4e0d\u53ef\u7528';
        const records = await sessionQuery.listSessions();
        if (!records || records.length === 0) return '\u5f53\u524d\u6ca1\u6709\u4f1a\u8bdd';
        const lines = []; let n = 0;
        for (const r of records) {
          if (r.header.origin === 'subagent' || (r.header.delegationDepth || 0) > 0) continue;
          n++; const title = await getSessionTitle(r.header.id);
          lines.push(n + '. ' + (title || '(\u65e0\u6807\u9898)'));
        }
        if (lines.length === 0) return '\u5f53\u524d\u6ca1\u6709\u4f1a\u8bdd';
        return '\u4f1a\u8bdd\u5217\u8868\uff1a\n' + lines.join('\n') + '\n\n\u56de\u590d\u300c\u9009\u62e9 N\u300d\u5207\u6362\u76ee\u6807\u4f1a\u8bdd';
      }
      if (/^\/?(\u9009\u62e9|\u5207\u6362)[\s\u3000]*[0-9]+$/i.test(t)) {
        var numM = t.match(/(\d+)/);
        if (!numM) return '\u8bf7\u8f93\u5165\u7f16\u53f7\uff0c\u5982 \u9009\u62e9 1';
        var idx = parseInt(numM[1], 10) - 1;
        if (!sessionQuery) return '\u4f1a\u8bdd\u670d\u52a1\u4e0d\u53ef\u7528';
        var allRec = await sessionQuery.listSessions();
        var visible = (allRec || []).filter(function (r) { return r.header.origin !== 'subagent' && !(r.header.delegationDepth || 0); });
        if (idx >= 0 && idx < visible.length) {
          weixinSelectedSession = visible[idx].header.id;
          var title = await getSessionTitle(visible[idx].header.id);
          return '\u5df2\u9009\u62e9\u4f1a\u8bdd ' + (idx + 1) + '\uff1a' + (title || '(\u65e0\u6807\u9898)');
        }
        return '\u7f16\u53f7\u65e0\u6548\uff0c\u8bf7\u5148\u67e5\u770b\u300c\u4f1a\u8bdd\u5217\u8868\u300d';
      }
      if (/^\/?(\u5f53\u524d\u4f1a\u8bdd|\u5f53\u524d)$/i.test(t)) {
        if (!weixinSelectedSession) return '\u5f53\u524d\u672a\u9009\u62e9\u4f1a\u8bdd\uff0c\u8bf7\u5148\u300c\u4f1a\u8bdd\u5217\u8868\u300d\u5e76\u300c\u9009\u62e9 N\u300d';
        var ct = await getSessionTitle(weixinSelectedSession);
        return '\u5f53\u524d\u9009\u4e2d\u4f1a\u8bdd\uff1a' + (ct || String(weixinSelectedSession));
      }
      if (/^\/?(\u5386\u53f2\u5185\u5bb9|\u5386\u53f2)$/i.test(t)) {
        if (!weixinSelectedSession) return '\u5f53\u524d\u672a\u9009\u62e9\u4f1a\u8bdd\uff0c\u8bf7\u5148\u300c\u4f1a\u8bdd\u5217\u8868\u300d\u5e76\u300c\u9009\u62e9 N\u300d';
        return await getSessionLastOutput(weixinSelectedSession);
      }
      if (/^\/?(\u6a21\u578b|model)$/i.test(t)) {
        if (!agentDefaultModel) return '\u6a21\u578b\u670d\u52a1\u4e0d\u53ef\u7528';
        const sel = agentDefaultModel.currentSelection();
        return '\u5f53\u524d\u6a21\u578b\uff1a' + (sel.model || '(\u672a\u8bbe\u7f6e)') + ' (' + (sel.provider || '?') + ')' + (sel.reasoningEffort ? '\n\u601d\u8003\u5f3a\u5ea6\uff1a' + sel.reasoningEffort : '');
      }
      // 非命令消息 → 发送到选中会话
      if (weixinSelectedSession) {
        try {
          const result = await activateSession(weixinSelectedSession);
          if (!result) return '\u4f1a\u8bdd\u670d\u52a1\u4e0d\u53ef\u7528';
          const res = await callRpc('session.sendMessage', { sessionId: weixinSelectedSession, content: t });
          if (res && res.body && res.body.result && res.body.result.ok) {
            return '\u5df2\u53d1\u9001\u5230\u4f1a\u8bdd\uff0c\u56de\u590d\u53ef\u80fd\u9700\u8981\u51e0\u79d2\u3002\u53d1\u9001 \u5386\u53f2\u5185\u5bb9 \u67e5\u770b\u6700\u65b0\u56de\u590d';
          }
          return '\u53d1\u9001\u5931\u8d25\uff1a' + (res && res.body ? JSON.stringify(res.body) : '\u672a\u77e5\u9519\u8bef');
        } catch (e) { return '\u53d1\u9001\u5931\u8d25\uff1a' + e.message; }
      }
      return '\u672a\u8bc6\u522b\u7684\u547d\u4ee4\uff0c\u53d1\u9001 \u5e2e\u52a9 \u67e5\u770b\u53ef\u7528\u547d\u4ee4\u3002\u53d1\u9001 \u4f1a\u8bdd\u5217\u8868 \u9009\u62e9\u4f1a\u8bdd\u540e\u53ef\u81ea\u7531\u5bf9\u8bdd\u3002';
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
        const p = path.join(toolsDir, 'custom-public-url.json');
        if (customPublicUrl) fs.writeFileSync(p, JSON.stringify({ url: customPublicUrl }), 'utf-8');
        else if (fs.existsSync(p)) fs.unlinkSync(p);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, url: customPublicUrl }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    };
    try { const p = path.join(toolsDir, 'custom-public-url.json'); if (fs.existsSync(p)) { const d = JSON.parse(fs.readFileSync(p, 'utf-8')); if (d && d.url) customPublicUrl = d.url; } } catch (e) {}
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/custom-url', handler: customUrlHandler }));

    const setPortHandler = async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const np = parseInt(data.port, 10);
        if (isNaN(np) || np < 1024 || np > 65535) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '\u7aef\u53e3\u65e0\u6548\uff081024-65535\uff09' }));
          return;
        }
        const net = await import('node:net');
        const free = await new Promise(function (ok) { var s = net.createServer(); s.once('error', function () { ok(false); }); s.listen(np, '127.0.0.1', function () { s.close(function () { ok(true); }); }); });
        if (!free) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '\u7aef\u53e3 ' + np + ' \u5df2\u88ab\u5360\u7528' }));
          return;
        }
        config.httpsPortStart = np;
        config.httpsPort = np;
        // 持久化端口到文件
        try {
          var portFile = path.join(toolsDir, 'custom-port.json');
          fs.writeFileSync(portFile, JSON.stringify({ port: np }), 'utf-8');
        } catch (pe) {}
        if (state.running) { stop(); await start(); }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, port: np }));
      } catch (e) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/set-port', handler: setPortHandler }));

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
    async function switchModel(provider, model, reasoningEffort) {
      const sel = { provider, model };
      if (reasoningEffort !== undefined) sel.reasoningEffort = reasoningEffort;
      console.log('[dsh-weixin] switchModel called:', JSON.stringify(sel), 'session:', weixinSelectedSession);
      if (weixinSelectedSession) {
        try {
          const res = await callRpc('session.selectModel', { sessionId: weixinSelectedSession, ...sel });
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
      const events = agent.session.events;
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
          if (a && a.session) events = a.session.events;
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

    // 监听模式
    function startMonitor() {
      weixinMonitorSnapshots = {};
      weixinMonitorTimer = setInterval(async function () {
        if (!weixinMonitorMode) { stopMonitor(); return; }
        if (!agents) { return; }
        try {
          var agentList = [];
          if (agents.list) agentList = agents.list();
          else if (agents._agents) agentList = Array.from(agents._agents.values());
          if (!agentList || !agentList.length) return;
          for (var i = 0; i < agentList.length; i++) {
            var a = agentList[i];
            if (!a || !a.session) continue;
            var aid = a.session.header && a.session.header.id ? a.session.header.id : String(i);
            var snap = weixinMonitorSnapshots[aid] || { wasRunning: false, eventsLen: 0 };
            var evts = a.session.events || [];
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
                      try { var _tr = await sessionQuery.readTitle(aid); sessTitle = (typeof _tr === 'string') ? _tr : (_tr && _tr.title) ? _tr.title : ''; } catch (e2) {}
                    }
                    if (!sessTitle) sessTitle = aid.slice(0, 12);
                    weixinMonitorTitles[aid] = sessTitle;
                    var text = '\u3010' + sessTitle + '\u3011\u601d\u8003\u5b8c\u6bd5\uff1a\n' + parts.join('');
                    if (text.length > 1900) text = text.slice(0, 1900) + '\u2026';
                    weixinSendMsg(weixinState.botToken, weixinState.lastFromUserId || '', text, weixinState.lastContextToken || '').catch(function (e) { console.error('[dsh-weixin] monitor send failed:', e.message); });
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
        if (/^\/停止远程$/.test(t) || /^\/关闭远程$/.test(t)) { stop(); return '\u5df2\u505c\u6b62\u8fdc\u7a0b\u670d\u52a1'; }
        // /监听
        if (/^\/监听$/.test(t) || /^\/监控$/.test(t)) {
          weixinMonitorMode = !weixinMonitorMode;
          try {
            var monFile = path.join(toolsDir, 'monitor-mode.json');
            if (weixinMonitorMode) fs.writeFileSync(monFile, JSON.stringify({ enabled: true, userId: weixinState.lastFromUserId || '', contextToken: weixinState.lastContextToken || '' }), 'utf-8');
            else if (fs.existsSync(monFile)) fs.unlinkSync(monFile);
          } catch (e) {}
          if (weixinMonitorMode) {
            startMonitor();
            return '\u76d1\u542c\u6a21\u5f0f\u5df2\u5f00\u542f\uff0c\u4f1a\u8bdd\u601d\u8003\u5b8c\u6bd5\u4f1a\u81ea\u52a8\u901a\u77e5\u4f60\u3002\u518d\u6b21\u53d1\u9001 /监听 \u53ef\u5173\u95ed';
          } else {
            stopMonitor();
            return '\u76d1\u542c\u6a21\u5f0f\u5df2\u5173\u95ed';
          }
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
            var monFile = path.join(toolsDir, 'monitor-mode.json');
            if (fs.existsSync(monFile)) {
              var md = JSON.parse(fs.readFileSync(monFile, 'utf-8'));
              if (md && md.enabled) {
                weixinMonitorMode = true;
                weixinState.lastFromUserId = md.userId || '';
                weixinState.lastContextToken = md.contextToken || '';
                startMonitor();
                weixinSendMsg(weixinState.botToken, weixinState.lastFromUserId, 'DSH\u5df2\u542f\u52a8\uff0c\u4efb\u52a1\u76d1\u542c\u4e2d', weixinState.lastContextToken).catch(function (e) { console.error('[dsh-weixin] startup notify failed:', e.message || e); });
                console.log('[dsh-weixin] monitor auto-restored');
              }
            }
          } catch (e) { console.error('[dsh-weixin] monitor restore error:', e.message || e); }
        }, 3000);
      }
    } catch (e) { console.error('[dsh-weixin] startup restore error:', e.message || e); }
  }

  ctx.effect(() => () => {
    if (tunnelHandle) { try { tunnelHandle.terminate(); } catch (e) { /* ignore */ } }
    if (proxy) { try { proxy.close(); } catch (e) { /* ignore */ } }
    if (qqServer) { try { qqServer.close(); } catch (e) { /* ignore */ } }
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
