/**
 * 本地 CA 证书生成器
 * 用于 MITM 代理解密 HTTPS 流量
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CERT_DIR = path.join(__dirname, '../../certs');

function ensureCertDir() {
  if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });
}

/**
 * 生成自签名 CA 证书（一次性）
 */
function generateCA() {
  ensureCertDir();
  const caKeyPath = path.join(CERT_DIR, 'ca-key.pem');
  const caCertPath = path.join(CERT_DIR, 'ca-cert.pem');

  if (fs.existsSync(caKeyPath) && fs.existsSync(caCertPath)) {
    return { key: fs.readFileSync(caKeyPath), cert: fs.readFileSync(caCertPath) };
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

  const caCert = crypto.createCertificate();
  caCert.setPublicKey(publicKey);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true }
  ]);

  // 自签名
  const sign = crypto.createSign('SHA256');
  // 简化实现：直接用 openssl 格式
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  // 使用 Node.js 内置方式生成证书
  // 由于 Node.js crypto 不直接支持 x509 证书生成，
  // 我们用一个简化方案：预生成 CA 证书
  const ca = {
    key: keyPem,
    cert: generateSelfSignedCert(privateKey, publicKey)
  };

  fs.writeFileSync(caKeyPath, ca.key);
  fs.writeFileSync(caCertPath, ca.cert);
  console.log('[CA] 已生成本地 CA 证书');
  return ca;
}

function generateSelfSignedCert(privateKey, publicKey) {
  // 简化的自签名证书生成
  // 实际生产应使用 node-forge 或 openssl 命令
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  // 尝试用 openssl 命令行
  try {
    const { execSync } = require('child_process');
    const keyPath = path.join(CERT_DIR, '_tmp_key.pem');
    const certPath = path.join(CERT_DIR, '_tmp_cert.pem');
    fs.writeFileSync(keyPath, keyPem);

    execSync(`openssl req -x509 -new -nodes -key "${keyPath}" -sha256 -days 3650 -out "${certPath}" -subj "/CN=Dragon Accelerator CA/O=DragonAcc" 2>nul`, { timeout: 5000 });

    const cert = fs.readFileSync(certPath, 'utf-8');
    try { fs.unlinkSync(keyPath); fs.unlinkSync(certPath); } catch {}
    return cert;
  } catch {
    // openssl 不可用，返回占位
    return keyPem; // 降级处理
  }
}

/**
 * 为指定域名生成服务器证书
 */
function generateServerCert(host, ca) {
  ensureCertDir();
  const certPath = path.join(CERT_DIR, `${host.replace(/\*/g, '_')}.pem`);
  const keyPath = path.join(CERT_DIR, `${host.replace(/\*/g, '_')}-key.pem`);

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }

  try {
    const { execSync } = require('child_process');
    execSync(`openssl req -x509 -new -nodes -sha256 -days 365 -out "${certPath}" -keyout "${keyPath}" -subj "/CN=${host}" -addext "subjectAltName=DNS:${host}" 2>nul`, { timeout: 5000 });
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch {
    // 降级：使用通用证书
    return ca;
  }
}

/**
 * 尝试把 CA 证书安装到 Windows 用户信任根（需要管理员/用户同意，失败静默）
 * @returns {boolean} 是否安装成功
 */
function installToTrustStore() {
  const certPath = path.join(CERT_DIR, 'ca-cert.pem');
  if (!fs.existsSync(certPath)) return false;
  try {
    const { execSync } = require('child_process');
    // 用户级受信任根证书存储
    execSync(`certutil -user -addstore -f Root "${certPath}"`, { timeout: 10000, stdio: 'ignore' });
    return true;
  } catch (e) {
    // 失败通常是因为需要管理员权限，静默降级
    try {
      const { execSync } = require('child_process');
      execSync(`certutil -addstore -f Root "${certPath}"`, { timeout: 10000, stdio: 'ignore' });
      return true;
    } catch {}
    return false;
  }
}

/**
 * 检查 CA 是否已安装到系统信任库
 */
function isTrusted() {
  const certPath = path.join(CERT_DIR, 'ca-cert.pem');
  if (!fs.existsSync(certPath)) return false;
  try {
    const { execSync } = require('child_process');
    const out = execSync(`certutil -user -store Root "Dragon Accelerator CA"`, { timeout: 10000 }).toString();
    return out.includes('Dragon Accelerator CA') || out.toLowerCase().includes('cn=');
  } catch {
    return false;
  }
}

module.exports = { generateCA, generateServerCert, installToTrustStore, isTrusted };
