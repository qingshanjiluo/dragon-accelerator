/**
 * 龙之归宿加速器 v5.0
 * MITM + Cookie持久化 + WS解析 + 多开隔离 + 智能DNS + 自动操作
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Settings } = require('../config/settings');
const { MitmProxy } = require('../proxy/mitm-proxy');
const { CookieManager } = require('../proxy/cookie-manager');
const { WsFrameParser } = require('../parser/ws-parser');
const { MultiManager } = require('../multi/multi-manager');
const { FingerprintIsolator } = require('../multi/isolation');
const { NodeSelector } = require('../dns/node-selector');

const sse = new Set();
function broadcast(type, data) { const m = `data: ${JSON.stringify({ type, ...data })}\n\n`; for (const c of sse) try { c.write(m); } catch { sse.delete(c); } }

async function main() {
  const settings = new Settings();
  const cookies = new CookieManager();
  const wsParser = new WsFrameParser();
  const isolator = new FingerprintIsolator();
  const nodeSelector = new NodeSelector(settings);

  console.log('');
  console.log('  🐉 ════════════════════════════════════════════════════════');
  console.log('     龙之归宿加速器 v5.0 — MITM + 智能DNS + 多开隔离');
  console.log('  ═══════════════════════════════════════════════════════════');
  console.log('');

  if (!settings.get('setupDone')) {
    console.log('  📖 首次运行，自动配置中...');
    settings.markSetupDone();
  }

  // 1. MITM 代理
  const proxy = new MitmProxy(settings);
  await proxy.start();

  // 2. 多开管理
  const multi = new MultiManager(settings, isolator);
  if (settings.get('multiAccountEnabled')) await multi.startAll();

  // 3. 智能 DNS
  if (settings.get('smartDns')) {
    await nodeSelector.start();
  }

  // 4. 保持登录
  if (settings.get('keepLogin')) {
    for (const host of settings.getEnabledHosts()) {
      cookies.startKeepAlive(host, settings.get('keepLoginInterval') * 1000);
    }
  }

  // 5. 预加载
  if (settings.get('prefetchOnStart')) {
    for (const game of settings.get('games').filter(g => g.enabled)) {
      prefetch(game.host).catch(() => {});
    }
  }

  // 6. 仪表盘
  startDashboard(settings, proxy, cookies, wsParser, multi, isolator, nodeSelector);

  console.log('');
  console.log('  ✅ 加速器已启动！');
  console.log(`  📡 代理:      127.0.0.1:${settings.get('httpPort')}`);
  console.log(`  🌐 仪表盘:    http://localhost:${settings.get('dashboardPort')}`);
  console.log(`  🔐 MITM:      ${settings.get('mitmEnabled') ? '已启用' : '隧道模式'}`);
  console.log(`  🍪 Cookie:    ${cookies.getAllInfo() ? Object.keys(cookies.getAllInfo()).length + ' 个域名' : '无'}`);
  console.log(`  🌍 智能DNS:   ${settings.get('smartDns') ? '已启用' : '关闭'}`);
  console.log(`  👥 多开:      ${settings.get('multiAccountEnabled') ? '已启用' : '关闭'}`);
  console.log('');

  // 定时广播
  setInterval(() => {
    broadcast('stats', {
      proxy: proxy.getStats(),
      parser: wsParser.getStats(),
      multi: multi.getStats(),
      cookies: cookies.getAllInfo(),
      dns: nodeSelector.getStatus(),
      settings: settings.getAll()
    });
  }, 1000);
}

async function prefetch(host) {
  const https = require('https');
  return new Promise((resolve) => {
    https.get(`https://${host}/`, { rejectUnauthorized: false }, (res) => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => {
        const html = Buffer.concat(c).toString();
        const re = /(?:src|href)=["']([^"']+\.(js|css|png|jpg|wasm|json)[^"']*)/gi;
        let m; const urls = new Set();
        while ((m = re.exec(html)) !== null) {
          let u = m[1];
          if (u.startsWith('//')) u = 'https:' + u;
          else if (u.startsWith('/')) u = `https://${host}${u}`;
          if (u.includes(host)) urls.add(u);
        }
        console.log(`[Prefetch] ${host}: ${urls.size} 个资源`);
        for (const u of urls) https.get(u, { rejectUnauthorized: false }, r => { r.resume(); r.on('end', () => {}); }).on('error', () => {});
        resolve();
      });
    }).on('error', () => resolve());
  });
}

function startDashboard(settings, proxy, cookies, wsParser, multi, isolator, nodeSelector) {
  const html = fs.readFileSync(path.join(__dirname, '../../dashboard.html'), 'utf-8');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      sse.add(res); req.on('close', () => sse.delete(res)); return;
    }

    if (url.pathname === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proxy: proxy.getStats(), parser: wsParser.getStats(), multi: multi.getStats(), cookies: cookies.getAllInfo(), dns: nodeSelector.getStatus() }));
      return;
    }

    if (url.pathname === '/api/settings' && req.method === 'POST') {
      let b = ''; req.on('data', d => b += d); req.on('end', () => {
        try { settings.update(JSON.parse(b)); res.writeHead(200); res.end('{"ok":true}'); } catch { res.writeHead(400); res.end(); }
      }); return;
    }

    if (url.pathname === '/api/multi/add' && req.method === 'POST') {
      let b = ''; req.on('data', d => b += d); req.on('end', () => {
        try { const { alias, server: srv } = JSON.parse(b); const acc = multi.addAccount(alias, srv); res.writeHead(200); res.end(JSON.stringify(acc)); } catch { res.writeHead(400); res.end(); }
      }); return;
    }

    if (url.pathname === '/api/multi/start' && req.method === 'POST') {
      let b = ''; req.on('data', d => b += d); req.on('end', async () => {
        try { const { id } = JSON.parse(b); const acc = multi.accounts.find(a => a.id === id); if (acc) { await multi.startInstance(acc); res.writeHead(200); res.end('{"ok":true}'); } else { res.writeHead(404); res.end(); } } catch { res.writeHead(400); res.end(); }
      }); return;
    }

    if (url.pathname === '/api/clear-cache') {
      proxy.memCache.clear(); proxy.memCacheBytes = 0;
      res.writeHead(200); res.end('{"ok":true}'); return;
    }

    if (url.pathname === '/api/dns/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nodeSelector.getStatus())); return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  server.listen(settings.get('dashboardPort'), '127.0.0.1', () => {
    console.log(`[Dashboard] 仪表盘 → http://localhost:${settings.get('dashboardPort')}`);
  });
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
main().catch(e => { console.error('[Fatal]', e); process.exit(1); });
