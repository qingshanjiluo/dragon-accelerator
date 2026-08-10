const fs = require('fs');
const path = require('path');
const CFG = path.join(__dirname, '../../dragon-config.json');

const DEFAULTS = {
  httpPort: 9527, wsPort: 9528, dashboardPort: 3949,
  games: [
    { name: 'MK49', host: 'game.mk49.top', enabled: true },
    { name: 'MK48.io', host: 'mk48.io', enabled: true },
    { name: 'MK49 论坛', host: 'forum.mk49.top', enabled: false }
  ],
  cacheEnabled: true, cacheMaxMB: 500, cacheDir: './.cache',
  dnsPrefetch: true, prefetchOnStart: true, tcpNoDelay: true, keepAlive: true, connectionPool: 12,
  mitmEnabled: true,
  autoAim: false, autoFire: false, autoDodge: false, autoCollect: false,
  multiAccountEnabled: false, accounts: [],
  keepLogin: true, keepLoginInterval: 300,
  smartDns: true, smartDnsInterval: 60,
  activeGame: 'game.mk49.top',
  autoProxy: false,
  setupDone: false
};

class Settings {
  constructor() { this.config = { ...DEFAULTS }; this.load(); }
  load() { try { if (fs.existsSync(CFG)) this.config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CFG, 'utf-8')) }; } catch {} }
  save() { try { fs.writeFileSync(CFG, JSON.stringify(this.config, null, 2)); } catch {} }
  get(k) { return this.config[k]; }
  set(k, v) { this.config[k] = v; this.save(); }
  update(p) {
    // 支持点路径写入，如 "games.0.enabled"
    for (const [k, v] of Object.entries(p)) {
      const parts = k.split('.');
      let cur = this.config;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!cur[part] || typeof cur[part] !== 'object') cur[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
        cur = cur[part];
      }
      cur[parts[parts.length - 1]] = v;
    }
    this.save();
  }
  getAll() { return { ...this.config }; }
  getEnabledHosts() { return this.config.games.filter(g => g.enabled).map(g => g.host); }
  markSetupDone() { this.config.setupDone = true; this.save(); }
}

module.exports = { Settings, DEFAULTS };
