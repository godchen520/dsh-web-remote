// dsh-web-remote — 自签名证书生成 + 局域网 IP 探测（零依赖）
import crypto from 'node:crypto';
import os from 'node:os';

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
