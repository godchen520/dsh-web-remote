// dsh-web-remote — cloudflared 自动下载
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';

// ───────────────────────── cloudflared 自动下载 ─────────────────────────

// 嗅探 gzip 魔数（1f 8b）。darwin 的资产是 .tgz，若被直接当作可执行文件落地，
// spawn 会抛 ENOEXEC（Exec format error），且 existsSync 会让坏文件被永久复用。
function isGzipFile(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(2);
    fs.readSync(fd, b, 0, 2, 0);
    fs.closeSync(fd);
    return b[0] === 0x1f && b[1] === 0x8b;
  } catch (e) { return false; }
}

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
  // 已缓存：仅当它不是被误落的压缩包时才复用
  if (fs.existsSync(target)) {
    if (!isGzipFile(target)) return target;
    try { fs.rmSync(target, { force: true }); } catch (e) { /* 清除坏包，走重新下载 */ }
  }

  // 直接使用 latest/download 直链（302 到最新版），不依赖 GitHub API
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${assetName}`;
  const tmp = target + '.download';
  await downloadFile(url, tmp);

  // darwin 的资产是 tar.gz，必须先解压再落地，否则 spawn 报 ENOEXEC
  if (assetName.endsWith('.tgz')) {
    const outDir = path.join(dir, '.cloudflared-extract');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    execFileSync('tar', ['-xzf', tmp, '-C', outDir]);
    let bin = path.join(outDir, exeName);
    if (!fs.existsSync(bin)) {
      const name = fs.readdirSync(outDir).find((f) => !f.startsWith('.'));
      bin = path.join(outDir, name || exeName);
    }
    fs.chmodSync(bin, 0o755);
    fs.renameSync(bin, target);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(tmp, { force: true });
    return target;
  }

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
