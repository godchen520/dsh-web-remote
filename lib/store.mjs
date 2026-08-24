// dsh-web-remote — 统一持久化存储（单文件 plugin-state.json + 旧散文件自动迁移）
import fs from 'node:fs';
import path from 'node:path';

/**
 * 创建插件状态存储。
 * 单一文件 toolsDir/plugin-state.json；首次加载时自动从旧的散 JSON 文件迁移（旧文件保留不删，回滚安全）。
 */
export function createStore(toolsDir) {
  const file = path.join(toolsDir, 'plugin-state.json');
  let cache = null;

  function deepMerge(target, patch) {
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
        deepMerge(target[k], v);
      } else {
        target[k] = v;
      }
    }
  }

  function persist() {
    try {
      fs.mkdirSync(toolsDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(cache, null, 2), 'utf-8');
    } catch (e) { console.error('[store] save failed:', e.message); }
  }

  function readOld(name) {
    try { return JSON.parse(fs.readFileSync(path.join(toolsDir, name), 'utf-8')); } catch (e) { return null; }
  }

  function migrate(s) {
    // 微信 token
    const wt = readOld('weixin-token.json');
    if (wt && wt.botToken) { s.weixin = s.weixin || {}; s.weixin.botToken = wt.botToken; s.weixin.savedAt = wt.savedAt; }
    // 飞书凭证 + 最后会话
    const fc = readOld('feishu-config.json');
    if (fc && fc.appId) { s.feishu = s.feishu || {}; s.feishu.appId = fc.appId; s.feishu.appSecret = fc.appSecret; }
    const fl = readOld('feishu-last-chat.json');
    if (fl && fl.chatId) { s.feishu = s.feishu || {}; s.feishu.lastChatId = fl.chatId; }
    // 监听开关（兼容两种旧格式：新 {weixin,feishu} / 旧 {enabled,userId,contextToken}）
    const mon = readOld('monitor-mode.json');
    if (mon) {
      let wx = mon.weixin || null;
      if (!wx && mon.enabled) wx = { enabled: true, userId: mon.userId || '', contextToken: mon.contextToken || '' };
      if (wx || mon.feishu) {
        s.monitor = s.monitor || {};
        if (wx) s.monitor.weixin = wx;
        if (mon.feishu) s.monitor.feishu = mon.feishu;
      }
    }
    // 自定义公网链接 / 端口
    const cu = readOld('custom-public-url.json');
    if (cu && cu.url) s.customPublicUrl = cu.url;
    const cp = readOld('custom-port.json');
    if (cp && cp.port) s.customPort = cp.port;
  }

  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf-8')) || {}; } catch (e) { cache = {}; }
    if (!cache._migrated) {
      migrate(cache);
      cache._migrated = true;
      persist();
      console.log('[store] migrated legacy files ->', file);
    }
    return cache;
  }

  function save(patch) {
    const s = load();
    deepMerge(s, patch);
    persist();
    return s;
  }

  return { load, save, file };
}
