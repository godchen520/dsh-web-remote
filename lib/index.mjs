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
  const s = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '').replace('Z', 'Z');
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
  const bs = Buffer.concat([Buffer.from([0x03]), derLen(body.length + 1), body]);
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
  const { targetPort, pfxPath, pfxPass } = options;
  const token = crypto.randomBytes(18).toString('base64url');
  const TARGET_HOST = '127.0.0.1';
  const TARGET_PORT = targetPort;

  function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
      const idx = part.indexOf('=');
      if (idx > -1) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return out;
  }
  function isAuthed(req) {
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
    const proxy = http.request({ host: TARGET_HOST, port: TARGET_PORT, path: req.url, method: req.method, headers: forwardHeaders(req, true) }, (pres) => {
      const gz = shouldGzip(req, pres.headers);
      const outHeaders = {};
      for (const [k, v] of Object.entries(pres.headers)) {
        const lk = k.toLowerCase();
        if (lk === 'connection' || lk === 'keep-alive' || lk === 'transfer-encoding' || lk === 'upgrade') continue;
        if (gz && lk === 'content-length') continue;
        outHeaders[lk] = v;
      }
      if (gz) outHeaders['content-encoding'] = 'gzip';
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
  function saveTab() {
    try { localStorage.setItem('webrm-tab', currentTab); } catch (e) {}
  }
  function loadTab() {
    var t = 'public';
    try { if (localStorage.getItem('webrm-tab') === 'lan') t = 'lan'; } catch (e) {}
    return t;
  }
  function style() {
    var css = '#webrm-native{position:fixed;left:10px;bottom:96px;z-index:99999;width:36px;height:36px;color:var(--dsw-alias-label-secondary,#999);cursor:pointer;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,#ddd);border-radius:50%;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 4px 16px rgba(0,0,0,.2)}#webrm-native:hover{background:var(--dsw-alias-interactive-bg-hover,#eee)}#webrm-mask{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45)}#webrm-panel{position:fixed;z-index:100001;left:50%;top:50%;transform:translate(-50%,-50%);width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:var(--dsw-alias-bg-layer-2,#fff);border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.3);padding:20px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#111);font-size:14px;line-height:22px;font-family:inherit}#webrm-panel h2{margin:0 0 12px;font-size:16px;font-weight:500;display:flex;align-items:center;justify-content:space-between}#webrm-close{background:none;border:none;cursor:pointer;font-size:18px;color:var(--dsw-alias-label-secondary,#888);padding:2px 6px;border-radius:8px}#webrm-close:hover{background:rgba(127,127,127,.15)}#webrm-tabs{display:flex;justify-content:center;gap:10px;margin:4px 0 10px}#webrm-tabs button{cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#ccc);background:transparent;color:var(--dsw-alias-label-secondary,#888);border-radius:999px;padding:5px 18px;font-size:13px;font-family:inherit}#webrm-tabs button.webrm-tab-active{background:#4f7cff;border-color:transparent;color:#fff}#webrm-status{display:flex;align-items:center;gap:8px;margin:8px 0}#webrm-dot{width:8px;height:8px;border-radius:50%;display:inline-block}#webrm-urlbox{background:rgba(127,127,127,.12);border-radius:10px;padding:10px 12px;margin:10px 0;cursor:pointer;word-break:break-all}#webrm-label{font-size:12px;color:var(--dsw-alias-label-secondary,#888);margin-bottom:4px}#webrm-url{font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:18px}#webrm-row{display:flex;gap:8px;margin:12px 0}#webrm-btn{cursor:pointer;border:1px solid var(--dsw-alias-border-l2,#ccc);background:transparent;color:var(--dsw-alias-label-primary,#111);border-radius:8px;padding:6px 14px;font-size:13px;font-family:inherit}#webrm-btn:hover{background:rgba(127,127,127,.12)}#webrm-btn-primary{background:#4f7cff;border-color:transparent;color:#fff}#webrm-btn:disabled{opacity:.5;cursor:default}#webrm-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#888);margin-top:10px;white-space:pre-wrap}#webrm-error{font-size:12px;color:#ef4444;margin-top:8px;white-space:pre-wrap}#webrm-qr{width:180px;height:180px;border-radius:8px;margin:10px auto;display:block}';
    var tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
  }
  function create() {
    if (document.getElementById('webrm-native')) return;
    style();
    var btn = document.createElement('button');
    btn.id = 'webrm-native';
    btn.type = 'button';
    btn.title = '远程访问';
    btn.setAttribute('aria-label', '远程访问');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg>';
    btn.addEventListener('click', openPanel);
    document.body.appendChild(btn);
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function fetchInfo() {
    return fetch('/remote/info', { cache: 'no-store' }).then(function (res) { return res.json(); });
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
  function renderStatus(panel, info, hint) {
    var st = document.getElementById('webrm-status');
    if (st) {
      st.textContent = '';
      var dot = el('span', '', '');
      dot.id = 'webrm-dot';
      dot.style.background = info && info.running ? '#22c55e' : '#ef4444';
      st.appendChild(dot);
      st.appendChild(el('span', '', info && info.running ? '运行中' : '已停止'));
    }
    var box = document.getElementById('webrm-urlbox');
    if (!box) return;
    box.textContent = '';
    var urls = [];
    if (currentTab === 'lan' && info && info.ips && info.ips.length) {
      urls = info.ips.map(function (ip) { return { label: '局域网直连 ' + ip + '（点击复制）', url: (info.httpsPort ? 'https://' : 'http://') + ip + ':' + (info.httpsPort || info.port) + '/?token=' + info.token }; });
    } else if (info && info.url && info.token) {
      urls = [{ label: '公网访问链接（点击复制）', url: info.url + '/?token=' + info.token }];
    }
    if (urls.length === 0) {
      box.appendChild(el('div', '', '尚未启动'));
    }
    urls.forEach(function (item) {
      var labelEl = el('div', '', item.label);
      labelEl.className = 'webrm-label';
      var linkEl = el('div', '', item.url);
      linkEl.className = 'webrm-url';
      linkEl.style.marginBottom = '6px';
      box.appendChild(labelEl);
      box.appendChild(linkEl);
      box.addEventListener('click', function () { copyText(item.url, labelEl, '已复制 ✓'); });
    });
    var qr = document.getElementById('webrm-qr');
    if (qr && qr.parentNode) qr.parentNode.removeChild(qr);
    var qrTarget = currentTab === 'lan' && info && info.ips && info.ips.length ? (info.httpsPort ? 'https://' : 'http://') + info.ips[0] + ':' + (info.httpsPort || info.port) + '/?token=' + info.token : (info && info.url && info.token ? info.url + '/?token=' + info.token : null);
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
        q.src = QR_SOURCES[qi] + encodeURIComponent(qrTarget);
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
      parts.push('QQ 通道：' + (info && info.qq === 'listening' ? '已就绪' : '等待 NapCat 连接'));
      parts.push('注意：链接含访问令牌，请勿泄露。插件重启后链接与令牌会更新。');
      h2.textContent = parts.join(NL + NL);
    }
    var err = document.getElementById('webrm-error');
    if (err) {
      if (info && info.error) err.textContent = String(info.error);
      else err.textContent = '';
    }
  }
  function setTab(tab, publicBtn, lanBtn, panel, hint) {
    currentTab = tab;
    saveTab();
    publicBtn.className = tab === 'public' ? 'webrm-tab-active' : '';
    lanBtn.className = tab === 'lan' ? 'webrm-tab-active' : '';
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
    lanBtn.type = 'button';
    tabs.appendChild(publicBtn);
    tabs.appendChild(lanBtn);
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
    var stopBtn = el('button', 'webrm-btn', '停止');
    stopBtn.type = 'button';
    var refreshBtn = el('button', 'webrm-btn', '刷新');
    refreshBtn.type = 'button';
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
    publicBtn.addEventListener('click', function () { setTab('public', publicBtn, lanBtn, panel, hint); });
    lanBtn.addEventListener('click', function () { setTab('lan', publicBtn, lanBtn, panel, hint); });
    startBtn.addEventListener('click', function () { control('start'); });
    stopBtn.addEventListener('click', function () { control('stop'); });
    refreshBtn.addEventListener('click', refresh);
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
  };

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
      proxy = createProxyServer({ targetPort: config.targetPort, pfxPath: config.pfxPath, pfxPass: config.pfxPass });
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
      tunnelHandle = subprocess.spawn(spec([cloudflaredPath, 'tunnel', '--url', 'http://127.0.0.1:' + httpPort, '--no-autoupdate']));
      const url = await waitForPattern(tunnelHandle, /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/, 30000);
      state.url = url;

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

  const snapshot = () => ({ running: state.running, url: state.url, token: state.token, port: state.port, httpsPort: state.httpsPort, ips: state.ips, qq: state.qq, error: state.error });

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
      else {
        res.writeHead(400);
        res.end('bad action');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(snapshot()));
    };
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/info', handler: infoHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/access', handler: infoHandler }));
    ctx.effect(() => webServer.register({ kind: 'exact', path: '/remote/control', handler: controlHandler }));
    ctx.effect(() => webServer.tapIndex((transform) => {
      if (transform.indexOf('webrm-native') !== -1) return transform;
      return transform.replace('</body>', '<script>' + INJECT_SCRIPT + '</scr' + 'ipt></body>');
    }));
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
