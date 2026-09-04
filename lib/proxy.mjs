// dsh-web-remote — 反向代理服务器（token 鉴权 + gzip + WebSocket 升级转发）
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createGzip } from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { generateSelfSignedCert, lanIPs } from './cert.mjs';

// ───────────────────────── 反向代理服务器 ─────────────────────────

export function createProxyServer(options) {
  const { targetPort, pfxPath, pfxPass, lanOpen = true, getDshToken = null } = options;
  const token = crypto.randomBytes(18).toString('base64url');
  const TARGET_HOST = '127.0.0.1';
  const TARGET_PORT = targetPort;
  let dshSessionCookie = null;
  let dshAuthPromise = null;

  // 懒加载：首次转发需要时实时读 DSH token 换取 session cookie（消除启动竞态）
  async function ensureDshSession() {
    if (dshSessionCookie) return dshSessionCookie;
    if (!getDshToken) return null;
    if (!dshAuthPromise) {
      dshAuthPromise = new Promise((resolve) => {
        let dshToken = '';
        try { dshToken = getDshToken() || ''; } catch (e) {}
        if (!dshToken) { dshAuthPromise = null; resolve(null); return; }
        const req = http.request({
          host: TARGET_HOST, port: TARGET_PORT,
          path: '/?token=' + encodeURIComponent(dshToken),
          method: 'GET',
          headers: { host: TARGET_HOST + ':' + TARGET_PORT },
        }, (res) => {
          const sc = res.headers['set-cookie'];
          if (sc && sc.length > 0) dshSessionCookie = sc[0].split(';')[0];
          res.resume();
          resolve(dshSessionCookie);
        });
        req.on('error', () => { dshAuthPromise = null; resolve(null); });
        req.end();
      });
    }
    const cookie = await dshAuthPromise;
    // 失败后重置，允许下次请求重试
    if (cookie) dshAuthPromise = null;
    return cookie;
  }

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
    ensureDshSession().then((dshCookie) => {
      const fwdHeaders = forwardHeaders(req, true);
      if (dshCookie) {
        const existing = fwdHeaders.cookie || '';
        fwdHeaders.cookie = existing ? existing + '; ' + dshCookie : dshCookie;
      }
      const proxy = http.request({ host: TARGET_HOST, port: TARGET_PORT, path: req.url, method: req.method, headers: fwdHeaders, agent: proxyAgent }, (pres) => {
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
    });
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
