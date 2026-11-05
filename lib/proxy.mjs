// dsh-web-remote — 反向代理服务器（token 鉴权 + gzip + WebSocket 升级转发）
import { createServer } from 'node:http';
import net from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { createGzip } from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { generateSelfSignedCert, lanIPs } from './cert.mjs';

// ───────────────────────── 反向代理服务器 ─────────────────────────

/**
 * 判断来源地址是否为私网/本机地址（局域网 + P2P 免 token 用）。
 * 放在模块作用域并导出，是为了能写单测（真值表）—— 别挪回 createProxyServer 里面。
 */
export function isPrivateAddress(addr) {
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
    // 100.64.0.0/10 —— CGNAT 段，Tailscale 的 100.x.y.z 地址就在这里。
    // 走 P2P（Tailscale）访问时来源就是它，加进来即可免 token，体验与局域网一致。
    // 注意：公网隧道是从 127.0.0.1 转发进来的，不在这条规则里，仍需 token。
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64-127.x.x
  }
  return false;
}

export function createProxyServer(options) {
  const { targetPort, pfxPath, pfxPass, lanOpen = true, getDshToken = null } = options;
  // 访问令牌（2026-11-05 改成**由外层传入**，可持久化、可自定义）：
   //   · 外层（index.mjs）从 store 读；没有就生成一个并写回 → 重启后书签不失效
   //   · 只允许 URL 安全字符，避免用户输入奇怪东西把 cookie 搞坏
   //   · 传空/非法 → 回退到随机生成（绝不能因为配置坏了就变成"无 token"）
   const CUSTOM_MAX = 64;
   function sanitizeToken(v) {
     const s = String(v == null ? '' : v).trim();
     if (!s || s.length > CUSTOM_MAX) return '';
     if (!/^[A-Za-z0-9_.-]+$/.test(s)) return '';
     return s;
   }
   const token = sanitizeToken(options.token) || crypto.randomBytes(18).toString('base64url');
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
          // 诊断（2026-11-05）：DSH 更新后 WS 连不上，先看这里到底有没有拿到凭据。
          // 只打印 cookie **名**，不打印值（值等同于密码）。
          const names = (sc && sc.length ? sc : []).map((c) => String(c).split('=')[0]).join(',');
          console.log('[proxy] 向 DSH 取凭据：HTTP ' + res.statusCode
            + '  set-cookie 数=' + ((sc && sc.length) || 0)
            + (names ? '  名=' + names : '')
            + '  采用=' + (dshSessionCookie ? String(dshSessionCookie).split('=')[0] : '无'));
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

  // 私网判定用模块作用域的 isPrivateAddress（见文件顶部，已导出便于单测）——
  // 这里不要再放一份副本，否则两处逻辑会漂移。

  function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
      const idx = part.indexOf('=');
      if (idx > -1) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return out;
  }
  function isAuthed(req) {
    // ── 免 token 的三类来源（2026-11-05 重新梳理）──
    //
    // ① 局域网 / P2P **直连**：来源地址是私网（192.168 / 100.64 CGNAT），直接放行。
    //    注意排除 127.0.0.1 —— 公网隧道与 `tailscale serve` 都从本机转发，无法与"本机直连"区分。
    //
    // ② **ts.net（tailscale serve）免 token**：
    //    用户："ts.net 不需要我的 tailscale 账户也能连上吗" —— **不能**。
    //    Tailscale 自己标注 `(tailnet only)`，未登录该 tailnet 的设备连 DNS 都解析不出来。
    //    所以 ts.net 与局域网**同等可信**，没必要再要 token。
    //
    //    判定必须**两条同时满足**，否则会被公网隧道伪造 Host 绕过：
    //      a) Host 是 `.ts.net`（serve 建出来的域名只长这样）
    //      b) **没有** `cf-connecting-ip` —— Cloudflare 隧道一定加这个头，
    //         `tailscale serve` 是本机转发，绝不会带。
    //    攻击者若从公网隧道来，必然带 CF 头 → 走 token 校验 ✗
    //
    // ③ 其余（公网隧道）：必须带 token（cookie 或 ?token=）
    const host = String(req.headers.host || '').toLowerCase();
    const viaCloudflare = !!(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
    if (lanOpen) {
      const addr = req.socket.remoteAddress || '';
      const ip = addr.replace(/^::ffff:/, '');
      if (ip !== '127.0.0.1' && ip !== '::1' && isPrivateAddress(ip)) return true;
      if (!viaCloudflare && /\.ts\.net$/i.test(host)) return true;
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
        // ── HTML 必须禁缓存 ──
        // 面板脚本（INJECT_SCRIPT）是**嵌在 index.html 文本里**的，不是独立文件。
        // 代理原先对 HTML 不设任何缓存头（isCacheable 只匹配 /assets/ /plugins/ rev= 等），
        // 浏览器于是可能缓存整页 → 宿主重启后刷新仍跑**旧脚本**，
        // 表现为"代码明明改了、服务端也确认是新版，但页面就是没变化"（真踩过）。
        // 静态资源不受影响，仍走下面的 immutable 长缓存（URL 带 rev，安全）。
        if (/text\/html/i.test(String(outHeaders['content-type'] || ''))) {
          outHeaders['cache-control'] = 'no-store, no-cache, must-revalidate';
          outHeaders['pragma'] = 'no-cache';
          outHeaders['expires'] = '0';
        }
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
  /**
   * WebSocket 升级：**原始字节透传**（2026-11-05 第四次尝试，也是最终做法）。
   *
   * 前三次都是在"手工拼 101 响应"这条路上修（补 head、补扩展头、补全头部），
   * 每次都被实测推翻 ✗。问题出在**手工重建本身就是错的**：
   *
   *   · 上游 101 里的头是它自己的决定（扩展协商、子协议、cookie 相关等），
   *     代理靠"挑几个头复制"永远可能漏掉关键项；
   *   · 而且一旦漏掉任何协商结果，浏览器与上游对**帧格式**的理解就不一致，
   *     结果就是"握手成功、双向都有帧、但客户端立刻 RST"——正是用户遇到的现象。
   *
   * 所以改成最笨也最可靠的做法：
   *   1. 用 net.connect 直连 DSH
   *   2. 把客户端的**原始请求行 + 原始头**（只改 host 和 cookie）写过去
   *   3. 之后**双向纯字节转发**，不解析、不重建、不干预
   *
   * 这样客户端看到的 101 就是 DSH 亲手写的，一个字节都不差。
   */
  function handleUpgrade(req, socket, head) {
    if (!isAuthed(req)) {
      console.log('[proxy] WS 拒绝（未通过 dshr_token）' + (req.url || ''));
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    const wsT0 = Date.now();
    const wsUrl = req.url || '';
    ensureDshSession().then((dshCookie) => {
      const wsCookieState = dshCookie ? ('有(' + String(dshCookie).slice(0, 18) + '…)') : '无';

      // 重建**请求侧**的原始字节（客户端的头原样带上：扩展、子协议等）
      //
      // ★ 但 **`origin` 必须改写**（2026-11-05 第五次，也是真正的原因）：
      //   DSH 对 WebSocket 做同源校验 —— 浏览器发来的 Origin 是
      //   `https://<手机看到的地址>`（局域网 IP / ts.net / trycloudflare），
      //   与 DSH 自己 `http://127.0.0.1:3080` 不一致 → **直接回 HTTP 403**。
      //   原始透传把 403 暴露出来后，hex 里清楚写着 `48 54 54 50 2f 31 2e 31 20 34 30 33`
      //   = "HTTP/1.1 403"，这才定位到根因（之前手工拼请求时恰好把 origin 丢了，
      //   所以早期测试能拿到 101 —— 那是"两个 bug 互相掩盖"）。
      const wsOrigin = 'http://' + TARGET_HOST + ':' + TARGET_PORT;
      let raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
      let cookieWritten = false;
      let originWritten = false;
      for (const [k, v] of Object.entries(req.headers)) {
        const lk = String(k).toLowerCase();
        if (lk === 'host') { raw += 'host: ' + TARGET_HOST + ':' + TARGET_PORT + '\r\n'; continue; }
        if (lk === 'origin') {
          raw += 'origin: ' + wsOrigin + '\r\n';
          originWritten = true;
          continue;
        }
        if (lk === 'cookie') {
          const vals = Array.isArray(v) ? v : [v];
          const merged = vals.join('; ') + (dshCookie ? '; ' + dshCookie : '');
          raw += 'cookie: ' + merged + '\r\n';
          cookieWritten = true;
          continue;
        }
        const vals = Array.isArray(v) ? v : [v];
        for (const one of vals) raw += lk + ': ' + one + '\r\n';
      }
      if (!originWritten) raw += 'origin: ' + wsOrigin + '\r\n';
      if (!cookieWritten && dshCookie) raw += 'cookie: ' + dshCookie + '\r\n';
      raw += '\r\n';

      const up = net.connect(TARGET_PORT, TARGET_HOST);
      up.setNoDelay(true);
      socket.setNoDelay(true);

      up.on('connect', () => {
        up.write(raw);
        if (head && head.length) up.write(head);
        // 纯字节转发（不解析任何帧）
        up.pipe(socket);
        socket.pipe(up);
        if (Date.now() - wsT0 > 200) console.log('[proxy] WS 建立偏慢：' + (Date.now() - wsT0) + 'ms');
      });

      // 抓首帧（诊断用，只记第一条）
      let c2s = 0;
      let s2c = 0;
      // 首帧字节抓取已移除（2026-11-05 噪音治理）：WS 正常后它只是刷屏
      // （同上）上游首帧也不再打印

      let closed = false;
      const closeOnce = (why) => {
        if (closed) return;
        closed = true;
        const _liveS = Math.round((Date.now() - wsT0) / 1000);
        // 正常关闭（客户端主动关 / 活得够久）不打印，只报异常，避免刷屏
        if (_liveS < 3 || /错误|上游关闭/.test(why)) {
          console.log('[proxy] WS 异常断开：存活 ' + _liveS + 's  原因=' + why);
        }
      };
      up.on('error', (e) => { closeOnce('上游错误 ' + (e && e.message)); socket.destroy(); });
      socket.on('error', (e) => { closeOnce('客户端错误 ' + (e && e.message)); up.destroy(); });
      up.on('close', () => { closeOnce('上游关闭'); socket.destroy(); });
      socket.on('close', () => { closeOnce('客户端关闭'); up.destroy(); });
    });
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
