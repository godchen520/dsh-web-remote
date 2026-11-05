// 自签名证书回归测试：生成的 PEM 必须能被 BoringSSL / OpenSSL 正常解析。
//
// 历史 bug：证书 PEM 用 `base64.replace(/(.{64})/g, '$1\n')` 折行，当 base64 长度
// 恰好是 64 的整数倍时末尾会多一个换行，拼出 `-----\n\n-----END CERTIFICATE-----`，
// 解析直接报 ERR_OSSL_PEM_NO_DATA（Electron 运行时里 https.createServer 失败）。
// 是否命中取决于 DER 长度，而 DER 长度随随机序列号浮动，所以表现为"时好时坏"。
//
// 这里循环生成：单次命中概率约四成，30 次全过的漏报概率可以忽略。
import crypto from 'node:crypto';
import tls from 'node:tls';
import { generateSelfSignedCert, lanIPs } from '../lib/cert.mjs';

const ips = lanIPs();
const ROUNDS = 30;
let checked = 0;

for (let i = 0; i < ROUNDS; i++) {
  const { key, cert } = generateSelfSignedCert(ips);

  // 明显形态：END 之前不允许出现空行
  if (cert.includes('\n\n-----END CERTIFICATE-----')) {
    console.error(`✗ round ${i}: 证书 PEM 在 END 前出现空行`);
    process.exit(1);
  }
  // 每行不超过 64 字符，且不允许空行
  for (const line of cert.split('\n').slice(0, -1)) {
    if (!line || line.length > 64) {
      console.error(`✗ round ${i}: 非法的 PEM 行（长度 ${line.length}）`);
      process.exit(1);
    }
  }

  try {
    new crypto.X509Certificate(cert);
    crypto.createPrivateKey(key);
    tls.createSecureContext({ key, cert });
  } catch (e) {
    console.error(`✗ round ${i}: PEM 解析失败 ${e.code || e.message}`);
    process.exit(1);
  }
  checked++;
}

console.log(`✓ 自签名证书 PEM 解析正常（${checked}/${ROUNDS}）`);
