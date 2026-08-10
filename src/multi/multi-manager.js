/**
 * 多开管理器 — 独立代理端口 + Cookie + 指纹隔离 + 内嵌页面
 * 每个账号一个本地 HTTP 端口，转发到目标游戏并注入独立 Cookie/指纹，
 * HTML 内容中的资源链接被重写指向本地端口，实现完全隔离的内嵌多开。
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

  /**
   * 添加账号
   * @param {string} alias 别名
   * @param {string} server 目标服务器
   * @param {string} mode 'ai' 或 'manual'，页面 AI操作/人工操作
   * @param {string} url 可选登录链接（可带 mk49Token 等 token 参数）
   */
  addAccount(alias, server = 'game.mk49.top', mode = 'manual', url = '') {
    const id = `acc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const account = { id, alias, server, mode, url, autoSpawn: false, enabled: true };
    this.accounts.push(account);
    this.saveAccounts();

    // 生成独立指纹
    this.isolator.generate(id);

    console.log(`[Multi] 添加账号: ${alias} (${server}) [${mode}]`);
    return account;
  }

  /**
   * 更新账号配置（模式 / 登录链接 / 别名 / 服务器）
   */
  updateAccount(id, patch) {
    const acc = this.accounts.find(a => a.id === id);
    if (!acc) return null;
    if (patch.mode !== undefined) acc.mode = patch.mode;
    if (patch.url !== undefined) acc.url = patch.url;
    if (patch.alias !== undefined) acc.alias = patch.alias;
    if (patch.server !== undefined) acc.server = patch.server;
    this.saveAccounts();
    console.log(`[Multi] 更新账号: ${acc.alias} (${acc.server}) [${acc.mode}]`);
    return acc;
  }

  removeAccount(id) {
    this.accounts = this.accounts.filter(a => a.id !== id);
    this.stopInstance(id);
    this.saveAccounts();
    console.log(`[Multi] 删除账号: ${id}`);
  }

  /**
   * 账号对应的本地内嵌页面地址
   */
  getLocalUrl(account) {
    const inst = this.instances.get(account.id);
    if (!inst) return null;
    // 优先使用自定义登录链接的 path+query，否则根路径
    let suffix = '';
    if (account.url) {
      try {
        const u = new URL(account.url);
        suffix = u.pathname + u.search;
      } catch {}
    }
    return `http://127.0.0.1:${inst.port}${suffix || '/'}`;
  }

  async startInstance(account) {
    if (this.instances.has(account.id)) return;

    const port = this.basePort + this.instances.size;
    const fp = this.isolator.generate(account.id);
    const cookieFile = path.join(this.cookieDir, `${account.id}.json`);
    const targetHost = account.server || 'game.mk49.top';

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const localHost = `${req.headers.host || `127.0.0.1:${port}`}`;

      // 注入指纹头
      const fpHeaders = this.isolator.getHeaders(account.id);
      // 注入保存的 Cookie
      const savedCookies = this.loadCookies(cookieFile);
      const headers = { ...req.headers, ...fpHeaders, host: targetHost };
      if (savedCookies) headers['cookie'] = savedCookies;
      delete headers['accept-encoding'];

      const opts = {
        hostname: targetHost, port: 443, path: url.pathname + url.search,
        method: req.method, headers, rejectUnauthorized: false
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
          try {
            const enc = pres.headers['content-encoding'];
            if (enc === 'gzip') body = zlib.gunzipSync(body);
            else if (enc === 'br') body = zlib.brotliDecompressSync(body);
            else if (enc === 'deflate') body = zlib.inflateSync(body);
          } catch {}

          // 文本内容重写：把目标域名的绝对资源链接指向本地端口 → 内嵌隔离
          const ct = (pres.headers['content-type'] || '').toString();
          if (/html|javascript|css/.test(ct)) {
            let text = body.toString('utf-8');
            const outHeaders = { ...pres.headers, 'content-encoding': undefined, 'content-length': undefined };
            // https://host/... 与 //host/... → 本地端口
            text = text.split(`https://${targetHost}`).join(localHost);
            text = text.split(`http://${targetHost}`).join(localHost);
            text = text.split(`//${targetHost}`).join(`//${localHost}`);
            res.writeHead(pres.statusCode, outHeaders);
            res.end(text);
          } else {
            res.writeHead(pres.statusCode, pres.headers);
            res.end(body);
          }
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
        console.log(`[Multi] "${account.alias}" → 127.0.0.1:${port} (${this.getLocalUrl(account)})`);
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
  cookieCount(id) { const o = this.loadCookiesRaw(path.join(this.cookieDir, `${id}.json`)); return o ? Object.keys(o).length : 0; }

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
      accounts: this.accounts.map(a => {
        const inst = this.instances.get(a.id);
        return {
          id: a.id, alias: a.alias, server: a.server, enabled: a.enabled,
          mode: a.mode || 'manual', url: a.url || '',
          running: !!inst,
          port: inst?.port || null,
          localUrl: inst ? this.getLocalUrl(a) : null,
          cookies: this.cookieCount(a.id),
          fingerprint: this.isolator.instances.get(a.id) ? '已生成' : '无'
        };
      })
    };
  }
}

module.exports = { MultiManager };
