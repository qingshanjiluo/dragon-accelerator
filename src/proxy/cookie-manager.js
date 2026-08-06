/**
 * Cookie 持久化管理器
 * 拦截 Set-Cookie 并保存，断线时自动注入
 */
const fs = require('fs');
const path = require('path');

const COOKIE_DIR = path.join(__dirname, '../../.cookies');

class CookieManager {
  constructor() {
    if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR, { recursive: true });
    this.stores = new Map(); // host → { cookies: Map, file }
  }

  /**
   * 从响应头提取并保存 Cookie
   */
  captureCookies(host, headers) {
    const setCookies = headers['set-cookie'] || [];
    if (!setCookies.length) return;

    const store = this.getStore(host);
    for (const sc of setCookies) {
      const [kv, ...attrs] = sc.split(';');
      const eqIdx = kv.indexOf('=');
      if (eqIdx === -1) continue;
      const name = kv.slice(0, eqIdx).trim();
      const value = kv.slice(eqIdx + 1).trim();

      const cookie = { name, value, attrs: {} };
      for (const attr of attrs) {
        const [k, v] = attr.trim().split('=');
        cookie.attrs[k.toLowerCase()] = v || true;
      }

      // 检查过期
      if (cookie.attrs.expires) {
        const expires = new Date(cookie.attrs.expires);
        if (expires < new Date()) {
          store.cookies.delete(name);
          continue;
        }
      }

      store.cookies.set(name, cookie);
    }

    this.saveStore(host);
    console.log(`[Cookie] ${host}: 保存 ${setCookies.length} 个 Cookie`);
  }

  /**
   * 注入保存的 Cookie 到请求头
   */
  injectCookies(host, headers) {
    const store = this.getStore(host);
    if (store.cookies.size === 0) return headers;

    const cookieStr = Array.from(store.cookies.values())
      .map(c => `${c.name}=${c.value}`)
      .join('; ');

    return { ...headers, cookie: cookieStr };
  }

  /**
   * 获取或创建存储
   */
  getStore(host) {
    host = host.split(':')[0].toLowerCase();
    if (this.stores.has(host)) return this.stores.get(host);

    const file = path.join(COOKIE_DIR, `${host.replace(/\./g, '_')}.json`);
    const store = { cookies: new Map(), file };

    // 加载已有 Cookie
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        for (const [name, cookie] of Object.entries(data)) {
          // 检查过期
          if (cookie.attrs?.expires && new Date(cookie.attrs.expires) < new Date()) continue;
          store.cookies.set(name, cookie);
        }
        if (store.cookies.size > 0) {
          console.log(`[Cookie] ${host}: 加载 ${store.cookies.size} 个 Cookie`);
        }
      }
    } catch {}

    this.stores.set(host, store);
    return store;
  }

  saveStore(host) {
    const store = this.stores.get(host);
    if (!store) return;
    try {
      const data = Object.fromEntries(store.cookies);
      fs.writeFileSync(store.file, JSON.stringify(data, null, 2));
    } catch {}
  }

  /**
   * 获取所有保存的 Cookie 信息
   */
  getAllInfo() {
    const info = {};
    for (const [host, store] of this.stores) {
      info[host] = {
        count: store.cookies.size,
        names: Array.from(store.cookies.keys())
      };
    }
    return info;
  }

  /**
   * 清除指定域名的 Cookie
   */
  clear(host) {
    host = host.split(':')[0].toLowerCase();
    const store = this.stores.get(host);
    if (store) {
      store.cookies.clear();
      try { fs.unlinkSync(store.file); } catch {}
    }
  }

  /**
   * 保持登录心跳 — 定期发送请求保持会话
   */
  startKeepAlive(host, intervalMs = 300000) {
    const timer = setInterval(async () => {
      const store = this.getStore(host);
      if (store.cookies.size === 0) return;

      try {
        const https = require('https');
        const req = https.get(`https://${host}/`, {
          headers: this.injectCookies(host, {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) DragonAcc/4.0'
          }),
          rejectUnauthorized: false
        }, (res) => {
          this.captureCookies(host, res.headers);
          res.resume();
          console.log(`[KeepAlive] ${host}: 心跳完成 (${res.statusCode})`);
        });
        req.on('error', () => {});
      } catch {}
    }, intervalMs);

    console.log(`[KeepAlive] ${host}: 每 ${intervalMs / 1000}秒 心跳`);
    return timer;
  }
}

module.exports = { CookieManager };
