// dsh-web-remote — Tailscale 状态探测
//
// 目的：面板上直接告诉用户「Tailscale 开没开 / 手机在不在线 / 到手机走的是直连还是中继」，
// 不用再去敲命令行。数据来源两条：
//   ① 零成本：本机网卡里有没有 100.64.0.0/10 的地址（有 ≈ 在跑且已登录）
//   ② 精确：`tailscale status --json` 的 BackendState、peer 的 CurAddr（直连）| Relay（中继）、Online
//
// CLI 定位顺序（便携版装在任意目录时，只有注册表这条能找到）：
//   PATH → Windows 服务 ImagePath 同目录 → 常见安装路径
//
// 注意：Tailscale 官方在中国大陆没有 DERP 节点，中继大概率落在 tok / sin / hkg ——
// 把中继节点名显示出来，用户一眼就知道流量有没有出境。

import fs from 'node:fs';
import path from 'node:path';

/** 是否是 Tailscale / CGNAT 段（100.64.0.0/10）的地址 */
export function isTailscaleIp(ip) {
  const p = String(ip || '').split('.');
  if (p.length !== 4) return false;
  return Number(p[0]) === 100 && Number(p[1]) >= 64 && Number(p[1]) <= 127;
}

/** BackendState → 中文短语 */
export function stateText(backendState) {
  switch (String(backendState || '')) {
    case 'Running': return '已连接';
    case 'Starting': return '启动中';
    case 'NeedsLogin': return '未登录';
    case 'NeedsMachineAuth': return '待设备授权';
    case 'Stopped': return '未运行';
    default: return '未知';
  }
}

/**
 * 把 `tailscale status --json` 的原始对象整理成面板要用的形状（纯函数，可单测）。
 * 传 null / 非对象 → cli:false（表示"没拿到 CLI 数据"）。
 */
export function summarizeStatus(raw) {
  const out = {
    cli: true, backendState: '', stateText: '未知', connected: false,
    selfIp: null, magicDns: false, peers: [], onlinePeers: 0, pathSummary: null, relay: null,
  };
  if (!raw || typeof raw !== 'object') return Object.assign({}, out, { cli: false });
  const bs = String(raw.BackendState || '');
  out.backendState = bs;
  out.stateText = stateText(bs);
  out.connected = bs === 'Running';
  const self = raw.Self || {};
  const selfIps = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  out.selfIp = selfIps.find(isTailscaleIp) || null;
  out.magicDns = !!(raw.CurrentTailnet && raw.CurrentTailnet.MagicDNSEnabled);
  const peerMap = (raw.Peer && typeof raw.Peer === 'object') ? raw.Peer : {};
  for (const key of Object.keys(peerMap)) {
    const p = peerMap[key] || {};
    // ⚠️ Relay 在 status --json 里是**字符串**（如 "tok"），不是数组 ——
    // 早期按数组判断导致 path 恒为 unknown（实测踩到）。这里两种形态都兼容。
    const relayRaw = p.Relay;
    const relay = Array.isArray(relayRaw)
      ? (relayRaw.length ? String(relayRaw[0]) : '')
      : (relayRaw ? String(relayRaw) : '');
    const direct = !!p.CurAddr;
    out.peers.push({
      host: p.HostName || key,
      os: p.OS || '',
      online: !!p.Online,
      path: direct ? 'direct' : (relay ? 'relay' : 'unknown'),
      relay,
    });
    if (p.Online) out.onlinePeers += 1;
  }
  // 路径摘要优先取"在线的那个 peer"，否则取第一个
  const p0 = out.peers.find((x) => x.online) || out.peers[0] || null;
  if (p0) {
    if (p0.path === 'direct') out.pathSummary = '直连';
    else if (p0.path === 'relay') { out.pathSummary = '中继'; out.relay = p0.relay || null; }
    else out.pathSummary = '未知';
  }
  return out;
}

/** 从服务 ImagePath 推出同目录的 CLI 路径（纯函数） */
export function cliFromImagePath(imagePath) {
  const raw = String(imagePath || '').trim().replace(/^"([^"]+)".*$/, '$1').replace(/^([^\s]+\.exe).*$/i, '$1');
  if (!raw) return null;
  return path.join(path.dirname(raw), 'tailscale.exe');
}

/**
 * 挑出可用于 P2P 访问的本机地址；**没打通返回 null**（纯函数，可单测）。
 * 判定"打通"= 网卡里有 100.64/10 地址，且（没探测数据 或 探测说已连接）。
 * 注意：有网卡地址但 BackendState 不是 Running（未登录/未运行）→ 视为没打通，
 * 免得给用户一个点了打不开的地址。
 */
export function pickP2pIp(ips, ts) {
  const list = Array.isArray(ips) ? ips : [];
  const ip = list.find(isTailscaleIp) || null;
  if (!ip) return null;
  if (ts && ts.cli && !ts.connected) return null;
  return ip;
}

/**
 * P2P 访问链接；没打通返回 null（纯函数，可单测）。
 * 免 token 口径与 proxy.mjs 的 isPrivateAddress 一致：lanOpen 打开时才免。
 */
export function p2pUrl(ips, ts, opts) {
  const o = opts || {};
  const ip = pickP2pIp(ips, ts);
  if (!ip || !o.port) return null;
  const suffix = o.lanOpen ? '' : ('/?token=' + (o.token || ''));
  return 'http://' + ip + ':' + o.port + suffix;
}

/** 常见安装路径（Windows / macOS / Linux 都给上，找不到就算了） */
export function cliCandidates(env = process.env) {
  const out = [];
  if (process.platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA || '';
    out.push(path.join(pf, 'Tailscale', 'tailscale.exe'));
    out.push(path.join(pf86, 'Tailscale', 'tailscale.exe'));
    if (local) out.push(path.join(local, 'Tailscale', 'tailscale.exe'));
  } else if (process.platform === 'darwin') {
    out.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    out.push('/usr/local/bin/tailscale');
  } else {
    out.push('/usr/bin/tailscale', '/usr/local/bin/tailscale');
  }
  return out;
}

/**
 * 创建一个带缓存的状态探测器。
 * opts: { subprocess, spec, ips, cacheMs?, timeoutMs?, cliRetryMs?, log? }
 *   subprocess —— DSH 的 subprocess 服务（resolveExecutable / spawn）
 *   spec(argv) —— 由调用方提供（stdio/grace 配置与插件其它子进程保持一致）
 *   ips()      —— 返回当前本机地址列表（用于"没有 CLI 时的兜底判断"）
 * 返回 { snapshot(), refresh(), start(), stop() }
 */
export function createTailscaleProbe(opts) {
  const subprocess = opts.subprocess;
  const spec = opts.spec;
  const ips = opts.ips || (() => []);
  const cacheMs = opts.cacheMs || 20000;
  const timeoutMs = opts.timeoutMs || 5000;
  const cliRetryMs = opts.cliRetryMs || 300000;
  const log = opts.log || (() => {});

  let cache = { at: 0, data: null };
  let cliPath = null;
  let cliCheckedAt = 0;
  let refreshing = false;
  let timer = null;

  /** 跑一条命令并收集输出（一次性） */
  async function runOnce(argv, ms) {
    let handle;
    try { handle = subprocess.spawn(spec(argv)); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    let timedOut = false;
    const outcome = await Promise.race([
      handle.done.then((o) => o, (e) => ({ error: String((e && e.message) || e) })),
      new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, ms)),
    ]);
    if (timedOut) { try { handle.terminate(); } catch (e) { /* ignore */ } return { ok: false, error: 'timeout' }; }
    let text = '';
    try { const r = handle.collected.stdout.readFrom(0); text = r.text || ''; } catch (e) { /* ignore */ }
    if (outcome && outcome.error) return { ok: false, error: outcome.error, text };
    return { ok: true, text, exitCode: outcome ? outcome.exitCode : null };
  }

  /** 定位 CLI：PATH → 服务注册表 ImagePath → 常见路径（负结果缓存 5 分钟，别每次刷新都查注册表） */
  async function resolveCli() {
    if (cliPath) return cliPath;
    if (cliCheckedAt && Date.now() - cliCheckedAt < cliRetryMs) return null;
    cliCheckedAt = Date.now();
    try { const p = await subprocess.resolveExecutable('tailscale'); if (p) { cliPath = p; return p; } } catch (e) { /* 不在 PATH */ }
    if (process.platform === 'win32') {
      try {
        const r = await runOnce(['reg', 'query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tailscale', '/v', 'ImagePath'], 4000);
        const m = /ImagePath\s+REG_[A-Z_]+\s+(.+)$/m.exec(r.text || '');
        if (m) {
          const cand = cliFromImagePath(m[1]);
          if (cand && fs.existsSync(cand)) { cliPath = cand; return cand; }
        }
      } catch (e) { /* ignore */ }
    }
    for (const cand of cliCandidates()) {
      try { if (fs.existsSync(cand)) { cliPath = cand; return cand; } } catch (e) { /* ignore */ }
    }
    return null;
  }

  /** 没有 CLI 时的兜底：只看网卡里有没有 100.64/10 地址 */
  function interfaceOnly() {
    let ip = null;
    try { ip = (ips() || []).find(isTailscaleIp) || null; } catch (e) { /* ignore */ }
    return {
      cli: false, viaInterface: !!ip, backendState: '', stateText: ip ? '已连接' : '未检测到',
      connected: !!ip, selfIp: ip, magicDns: false, peers: [], onlinePeers: 0, pathSummary: null, relay: null,
    };
  }

  async function refresh() {
    if (refreshing) return cache.data;
    refreshing = true;
    try {
      const cli = await resolveCli();
      if (!cli) { cache = { at: Date.now(), data: interfaceOnly() }; return cache.data; }
      const r = await runOnce([cli, 'status', '--json'], timeoutMs);
      if (!r.ok || !r.text) {
        // CLI 在但命令失败（服务没起来等）→ 退回网卡判断，并把原因带上
        const fb = interfaceOnly();
        fb.cli = true;
        fb.cliPath = cli;
        fb.error = r.error || 'empty output';
        cache = { at: Date.now(), data: fb };
        return cache.data;
      }
      let raw = null;
      try { raw = JSON.parse(r.text); } catch (e) { log('[tailscale] status --json 解析失败:', e.message); }
      const data = summarizeStatus(raw);
      data.cliPath = cli;
      cache = { at: Date.now(), data };
      return data;
    } catch (e) {
      log('[tailscale] 探测失败:', (e && e.message) || e);
      cache = { at: Date.now(), data: interfaceOnly() };
      return cache.data;
    } finally {
      refreshing = false;
    }
  }

  function snapshot() {
    // 过期就在后台刷（不阻塞调用方），本次仍返回旧值
    if (!cache.data || Date.now() - cache.at > cacheMs) {
      refresh().catch(() => {});
    }
    return cache.data;
  }

  function start() {
    if (timer) return;
    refresh().catch(() => {});
    timer = setInterval(() => { refresh().catch(() => {}); }, cacheMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  return { snapshot, refresh, start, stop };
}
