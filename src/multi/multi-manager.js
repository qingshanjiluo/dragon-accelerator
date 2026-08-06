/**
 * 多开管理器 — 独立代理端口 + Cookie + 指纹隔离
 */
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

class MultiManager {
  constructor(settings, isolator) {
    this.enabled = settings.get('multiAccountEnabled');
    this.accounts = settings.get('accounts') || [];
    this.instances = new Map();
    this.basePort = settings.get('httpPort') + 100;
    this.isolator = isolator;
    this.cookieDir = path.join(__dirname, '../../.cookies');
    if (!fs.existsSync(this.cookieDir)) fs.mkdirSync(this.cookieDir, { recursive: true });
  }

  addAccount(alias, server = 'game.mk49.top') {
    const id = `acc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const account = { id, alias, server, autoSpawn: false, enabled: true };
    this.accounts.push(account);
    this.saveAccounts();

    // 生成独立指纹
    this.isolator.generate(id);

    console.log(`[Multi] 添加账号: ${alias} (${server})`);
    return account;
  }

  removeAccount(id) {
    this.accounts = this.accounts.filter(a => a.id !== id);
    this.stopInstance(id);
    this.saveAccounts();
  }

  async startInstance(account) {
    if (this.instances.has(account.id)) return;

    const port = this.basePort + this.instances.size;
    const fp = this.isolator.generate(account.id);
    const cookieFile = path.join(this.cookieDir, `${account.id}.json`);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // 注入指纹头
      const fpHeaders = this.isolator.getHeaders(account.id);
      Object.assign(req.headers, fpHeaders);

      // 注入保存的 Cookie
      const savedCookies = this.loadCookies(cookieFile);
      if (savedCookies) req.headers['cookie'] = savedCookies;

      const opts = {
        hostname: url.hostname, port: 443, path: url.pathname + url.search,
        method: req.method, headers: { ...req.headers, host: url.hostname },
        rejectUnauthorized: false
      };

      const preq = https.request(opts, (pres) => {
        // 保存 Cookie
        if (pres.headers['set-cookie']) {
          const existing = this.loadCookiesRaw(cookieFile) || {};
          for (const sc of pres.headers['set-cookie']) {
            const [kv] = sc.split(';');
            const eqIdx = kv.indexOf('=');
            if (eqIdx > 0) existing[kv.slice(0, eqIdx).trim()] = kv.slice(eqIdx + 1).trim();
          }
          fs.writeFileSync(cookieFile, JSON.stringify(existing, null, 2));
        }

        const chunks = [];
        pres.on('data', c => chunks.push(c));
        pres.on('end', () => {
          let body = Buffer.concat(chunks);
          try { const enc = pres.headers['content-encoding']; if (enc === 'gzip') body = zlib.gunzipSync(body); } catch {}
          res.writeHead(pres.statusCode, pres.headers);
          res.end(body);
        });
      });

      preq.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
      req.pipe(preq);
    });

    server.on('connect', (req, sock, head) => {
      const [host, p] = req.url.split(':');
      const s = net.connect(parseInt(p) || 443, host, () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        s.write(head); s.pipe(sock); sock.pipe(s);
      });
      s.on('error', () => sock.end()); sock.on('error', () => s.end());
    });

    return new Promise((resolve, reject) => {
      server.listen(port, '127.0.0.1', () => {
        this.instances.set(account.id, { port, server, account, fp, ts: Date.now() });
        console.log(`[Multi] "${account.alias}" → 127.0.0.1:${port} (指纹隔离)`);
        resolve({ port });
      });
      server.on('error', reject);
    });
  }

  stopInstance(id) {
    const inst = this.instances.get(id);
    if (inst) { inst.server.close(); this.instances.delete(id); console.log(`[Multi] "${inst.account.alias}" 已停止`); }
  }

  async startAll() {
    for (const acc of this.accounts) {
      if (acc.enabled) await this.startInstance(acc).catch(() => {});
    }
  }

  stopAll() { for (const [id] of this.instances) this.stopInstance(id); }

  loadCookiesRaw(file) { try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; } }
  loadCookies(file) { const o = this.loadCookiesRaw(file); return o ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join('; ') : null; }

  saveAccounts() {
    try {
      const cfgPath = path.join(__dirname, '../../dragon-config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      cfg.accounts = this.accounts;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    } catch {}
  }

  getStats() {
    return {
      enabled: this.enabled,
      accounts: this.accounts.map(a => ({
        id: a.id, alias: a.alias, server: a.server, enabled: a.enabled,
        running: this.instances.has(a.id),
        port: this.instances.get(a.id)?.port || null,
        fingerprint: this.isolator.instances.get(a.id) ? '已生成' : '无'
      }))
    };
  }
}

module.exports = { MultiManager };
