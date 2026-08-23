// dsh-web-remote — QQ 机器人通道（OneBot 11 反向 WS，供 NapCat 连接后取链接）
import { createServer } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

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
