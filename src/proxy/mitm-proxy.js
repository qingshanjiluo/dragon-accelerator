/**
 * MITM 代理 — 解密 HTTPS 流量实现缓存
 * 
 * 原理:
 * 1. 浏览器连接代理 → 代理返回 200 Connection Established
 * 2. 代理与浏览器建立 TLS（用本地证书）
 * 3. 代理与真实服务器建立 TLS
 * 4. 代理在中间解密→缓存→再加密转发
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CERT_DIR = path.join(__dirname, '../../certs');

class MitmProxy {
  constructor(settings) {
    this.port = settings.get('httpPort');
    this.hosts = settings.getEnabledHosts();
    this.cacheDir = settings.get('cacheDir');
    this.running = false;

    // 证书缓存
    this.certCache = new Map();

    // 内存缓存
    this.memCache = new Map();
    this.memCacheBytes = 0;
    this.maxMemBytes = 50 * 1024 * 1024;

    // 磁盘缓存索引
    this.diskIndex = new Map();
    this.loadDiskIndex();

    // 连接池
    this.agents = new Map();

    this.stats = { requests: 0, hits: 0, misses: 0, bytes: 0, errors: 0, https: 0, http: 0 };

    // 初始化 CA
    this.initCA();
  }

  initCA() {
    if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

    const caKeyPath = path.join(CERT_DIR, 'ca-key.pem');
    const caCertPath = path.join(CERT_DIR, 'ca-cert.pem');

    if (fs.existsSync(caKeyPath) && fs.existsSync(caCertPath)) {
      this.caKey = fs.readFileSync(caKeyPath);
      this.caCert = fs.readFileSync(caCertPath);
      console.log('[MITM] 已加载 CA 证书');
    } else {
      // 生成 CA
      try {
        const { execSync } = require('child_process');
        execSync(`openssl req -x509 -new -nodes -keyout "${caKeyPath}" -out "${caCertPath}" -days 3650 -subj "/CN=Dragon Accelerator CA" 2>/dev/null`, { timeout: 5000 });
        this.caKey = fs.readFileSync(caKeyPath);
        this.caCert = fs.readFileSync(caCertPath);
        console.log('[MITM] 已生成 CA 证书 (安装 certs/ca-cert.pem 到浏览器信任列表)');
      } catch {
        console.warn('[MITM] openssl 不可用，HTTPS 缓存降级为隧道模式');
        this.caKey = null;
        this.caCert = null;
      }
    }
  }

  isTarget(host) {
    host = (host || '').split(':')[0].toLowerCase();
    return this.hosts.some(h => host === h || host.endsWith('.' + h));
  }

  hasCA() { return this.caKey && this.caCert; }

  async start() {
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on('connect', (req, sock, head) => this.onConnect(req, sock, head));

    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        this.running = true;
        console.log(`[MITM] 代理 → 127.0.0.1:${this.port} ${this.hasCA() ? '(HTTPS 解密已启用)' : '(隧道模式)'}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async stop() {
    this.running = false;
    for (const [, agent] of this.agents) agent.destroy();
    this.server?.close();
    this.saveDiskIndex();
  }

  // HTTP 请求
  onRequest(req, res) {
    this.stats.requests++;
    this.stats.http++;
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (this.isTarget(url.hostname)) {
      this.proxyWithCache(req, res, url);
    } else {
      this.passthrough(req, res, url);
    }
  }

  // HTTPS CONNECT 隧道
  onConnect(req, clientSocket, head) {
    const [host, port] = req.url.split(':');
    const targetPort = parseInt(port) || 443;

    if (this.isTarget(host) && this.hasCA()) {
      // MITM 模式：解密 HTTPS
      this.handleMitm(clientSocket, host, targetPort, head);
    } else {
      // 普通隧道
      this.handleTunnel(clientSocket, host, targetPort, head);
    }
  }

  // MITM 解密处理
  handleMitm(clientSocket, host, port, head) {
    this.stats.https++;

    // 为该域名生成/获取证书
    const cert = this.getServerCert(host);
    if (!cert) {
      this.handleTunnel(clientSocket, host, port, head);
      return;
    }

    // 1. 告诉客户端连接已建立
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // 2. 与客户端建立 TLS（用我们生成的证书）
    const tlsServer = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: cert.key,
      cert: cert.cert
    });

    // 3. 创建本地 HTTP 服务器处理解密后的请求
    const localServer = http.createServer();

    localServer.on('request', (req, res) => {
      // 重新构造完整 URL
      const url = new URL(req.url, `https://${host}`);

      if (this.isTarget(host)) {
        this.proxyWithCache(req, res, url, host);
      } else {
        this.proxyHttps(req, res, url, host, port);
      }
    });

    // 用 net.createServer 接收 TLS 连接
    const tmpServer = net.createServer((socket) => {
      const tlsSocket = new tls.TLSSocket(socket, {
        isServer: true,
        key: cert.key,
        cert: cert.cert
      });

      // 解析 HTTP 请求
      let requestData = Buffer.alloc(0);
      tlsSocket.on('data', (chunk) => {
        requestData = Buffer.concat([requestData, chunk]);

        // 检查是否收到完整的 HTTP 请求头
        const headerEnd = requestData.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const headerStr = requestData.slice(0, headerEnd).toString();
        const firstLine = headerStr.split('\r\n')[0];
        const [method, urlPath] = firstLine.split(' ');

        const reqUrl = new URL(urlPath, `https://${host}`);
        const fakeReq = {
          method,
          url: urlPath,
          headers: this.parseHeaders(headerStr),
          on: (event, cb) => {
            if (event === 'data') cb(requestData.slice(headerEnd + 4));
            if (event === 'end') cb();
          },
          pipe: (stream) => { stream.end(requestData.slice(headerEnd + 4)); }
        };

        const fakeRes = {
          statusCode: 200,
          headers: {},
          setHeader(k, v) { this.headers[k] = v; },
          writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
          end(data) {
            const statusLine = `HTTP/1.1 ${fakeRes.statusCode} OK\r\n`;
            const headerLines = Object.entries(fakeRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
            tlsSocket.write(statusLine + headerLines + '\r\n\r\n');
            if (data) tlsSocket.write(data);
            tlsSocket.end();
          },
          on: () => {}
        };

        if (this.isTarget(host)) {
          this.proxyWithCache(fakeReq, fakeRes, reqUrl, host);
        } else {
          this.proxyHttps(fakeReq, fakeRes, reqUrl, host, port);
        }
      });
    });

    tmpServer.listen(0, '127.0.0.1', () => {
      const localPort = tmpServer.address().port;
      // 转发原始 head 数据到 TLS 服务器
      if (head.length > 0) {
        tlsSocket.write(head);
      }
    });

    // 超时清理
    setTimeout(() => { try { tmpServer.close(); } catch {} }, 60000);
    clientSocket.on('close', () => { try { tmpServer.close(); } catch {} });
  }

  // 普通隧道（不解密）
  handleTunnel(clientSocket, host, port, head) {
    const serverSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => clientSocket.end());
    clientSocket.on('error', () => serverSocket.end());
  }

  parseHeaders(headerStr) {
    const headers = {};
    const lines = headerStr.split('\r\n').slice(1);
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
    }
    return headers;
  }

  getServerCert(host) {
    if (this.certCache.has(host)) return this.certCache.get(host);

    const certPath = path.join(CERT_DIR, `${host}.pem`);
    const keyPath = path.join(CERT_DIR, `${host}-key.pem`);

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const cert = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
      this.certCache.set(host, cert);
      return cert;
    }

    // 生成新证书
    try {
      const { execSync } = require('child_process');
      execSync(`openssl req -x509 -new -nodes -sha256 -days 365 -out "${certPath}" -keyout "${keyPath}" -subj "/CN=${host}" -addext "subjectAltName=DNS:${host}" 2>/dev/null`, { timeout: 5000 });
      const cert = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
      this.certCache.set(host, cert);
      return cert;
    } catch {
      return null;
    }
  }

  getAgent(host) {
    if (!this.agents.has(host)) {
      this.agents.set(host, new https.Agent({
        keepAlive: true, keepAliveMsecs: 30000,
        maxSockets: 10, maxFreeSockets: 5, scheduling: 'lifo'
      }));
    }
    return this.agents.get(host);
  }

  proxyWithCache(req, res, url, forceHost) {
    const key = url.pathname + url.search;

    // 缓存命中
    if (req.method === 'GET') {
      const cached = this.getFromCache(key);
      if (cached) {
        this.stats.hits++;
        res.writeHead(200, {
          'Content-Type': cached.ct, 'Content-Length': cached.data.length,
          'X-Dragon-Cache': 'HIT', 'Cache-Control': 'public, max-age=31536000'
        });
        return res.end(cached.data);
      }
    }

    // 代理请求
    const t0 = Date.now();
    const host = forceHost || url.hostname;
    const opts = {
      hostname: host, port: url.port || 443, path: url.pathname + url.search,
      method: req.method, agent: this.getAgent(host),
      headers: { ...req.headers, host, 'Accept-Encoding': 'gzip, deflate, br' },
      rejectUnauthorized: false
    };

    const preq = https.request(opts, (pres) => {
      const chunks = [];
      pres.on('data', c => chunks.push(c));
      pres.on('end', () => {
        let body = Buffer.concat(chunks);
        try {
          const enc = pres.headers['content-encoding'];
          if (enc === 'gzip') body = zlib.gunzipSync(body);
          else if (enc === 'br') body = zlib.brotliDecompressSync(body);
        } catch {}

        this.stats.bytes += body.length;
        this.stats.misses++;

        if (req.method === 'GET' && this.shouldCache(url.pathname)) {
          this.putCache(key, body, pres.headers['content-type'] || 'application/octet-stream');
        }

        res.writeHead(pres.statusCode, {
          'Content-Type': pres.headers['content-type'], 'Content-Length': body.length,
          'X-Dragon-Cache': 'MISS', 'X-Latency': `${Date.now() - t0}ms`
        });
        res.end(body);
      });
    });

    preq.on('error', () => { this.stats.errors++; if (!res.headersSent) { res.writeHead(502); res.end(); } });
    if (req.pipe) req.pipe(preq); else preq.end();
  }

  proxyHttps(req, res, url, host, port) {
    const opts = {
      hostname: host, port, path: url.pathname + url.search,
      method: req.method, headers: { ...req.headers, host },
      rejectUnauthorized: false
    };
    const preq = https.request(opts, (pres) => {
      const chunks = [];
      pres.on('data', c => chunks.push(c));
      pres.on('end', () => {
        res.writeHead(pres.statusCode, pres.headers);
        res.end(Buffer.concat(chunks));
      });
    });
    preq.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
    if (req.pipe) req.pipe(preq); else preq.end();
  }

  passthrough(req, res, url) {
    const proto = url.protocol === 'https:' ? https : http;
    const opts = { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: req.method, headers: req.headers };
    const preq = proto.request(opts, (pres) => { res.writeHead(pres.statusCode, pres.headers); pres.pipe(res); });
    preq.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
    req.pipe(preq);
  }

  shouldCache(p) {
    const ext = p.split('.').pop()?.split('?')[0]?.toLowerCase();
    return ['js','css','png','jpg','jpeg','gif','webp','svg','woff','woff2','wasm','json','mp3','ogg'].includes(ext);
  }

  getFromCache(key) {
    const m = this.memCache.get(key);
    if (m) { m.hits++; return m; }
    const d = this.diskIndex.get(key);
    if (d) {
      const fp = path.join(this.cacheDir, d.file);
      if (fs.existsSync(fp)) {
        const data = fs.readFileSync(fp);
        this.setMemCache(key, data, d.ct);
        return { data, ct: d.ct };
      }
    }
    return null;
  }

  putCache(key, data, ct) {
    this.setMemCache(key, data, ct);
    if (data.length > 1024) {
      const hash = crypto.createHash('md5').update(key).digest('hex').slice(0, 10);
      const ext = this.getExt(ct);
      const file = hash + ext;
      try {
        if (!fs.existsSync(this.cacheDir)) fs.mkdirSync(this.cacheDir, { recursive: true });
        fs.writeFileSync(path.join(this.cacheDir, file), data);
        this.diskIndex.set(key, { file, size: data.length, ct, hits: 0, ts: Date.now() });
      } catch {}
    }
  }

  setMemCache(key, data, ct) {
    while (this.memCacheBytes + data.length > this.maxMemBytes) {
      const oldest = this.memCache.keys().next().value;
      if (!oldest) break;
      this.memCacheBytes -= this.memCache.get(oldest).data.length;
      this.memCache.delete(oldest);
    }
    this.memCache.set(key, { data, ct, hits: 0 });
    this.memCacheBytes += data.length;
  }

  getExt(ct) {
    if (ct?.includes('javascript')) return '.js';
    if (ct?.includes('css')) return '.css';
    if (ct?.includes('png')) return '.png';
    if (ct?.includes('wasm')) return '.wasm';
    if (ct?.includes('json')) return '.json';
    return '.bin';
  }

  loadDiskIndex() {
    try {
      const f = path.join(this.cacheDir, '_index.json');
      if (fs.existsSync(f)) {
        for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf-8')))) this.diskIndex.set(k, v);
      }
    } catch {}
  }

  saveDiskIndex() {
    try { fs.writeFileSync(path.join(this.cacheDir, '_index.json'), JSON.stringify(Object.fromEntries(this.diskIndex))); } catch {}
  }

  getStats() { return { ...this.stats, memItems: this.memCache.size, memSize: fmt(this.memCacheBytes), diskItems: this.diskIndex.size, hasCA: this.hasCA() }; }
}

function fmt(b) { return b < 1024 ? b+'B' : b < 1048576 ? (b/1024).toFixed(1)+'KB' : (b/1048576).toFixed(1)+'MB'; }

module.exports = { MitmProxy };
