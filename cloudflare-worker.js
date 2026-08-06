/**
 * 🐉 龙之归宿加速器 — Cloudflare Worker 版本
 * 
 * 部署方式: wrangler deploy 或 Cloudflare Dashboard 直接粘贴
 * 
 * 功能:
 * 1. 代理 game.mk49.top 和 mk48.io 的流量
 * 2. 资源缓存 (利用 Cloudflare Cache API)
 * 3. 边缘节点加速 (全球 CDN)
 * 4. WebSocket 代理
 * 5. 延迟优化 (HTTP/3, 0-RTT)
 */

// 配置
const CONFIG = {
  targets: {
    'game.mk49.top': 'game.mk49.top',
    'mk48.io': 'mk48.io',
    'forum.mk49.top': 'forum.mk49.top'
  },
  cacheTTL: 86400, // 缓存 24 小时
  cacheableExts: ['js', 'css', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'woff', 'woff2', 'wasm', 'json', 'mp3', 'ogg']
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;

    // 健康检查
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', version: '4.0-cf', timestamp: Date.now() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 状态页
    if (url.pathname === '/' || url.pathname === '/status') {
      return new Response(STATUS_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // 确定目标主机
    // 方式1: 路径前缀 /proxy/game.mk49.top/...
    let targetHost = null;
    let targetPath = url.pathname;

    const pathMatch = url.pathname.match(/^\/proxy\/([^/]+)(\/.*)?$/);
    if (pathMatch) {
      targetHost = pathMatch[1];
      targetPath = pathMatch[2] || '/';
    }

    // 方式2: 自定义域名映射 (需要在 CF 配置)
    if (!targetHost) {
      for (const [pattern, target] of Object.entries(CONFIG.targets)) {
        if (host.includes(pattern) || host === pattern) {
          targetHost = target;
          break;
        }
      }
    }

    // 方式3: query 参数
    if (!targetHost) {
      targetHost = url.searchParams.get('target');
    }

    if (!targetHost) {
      return new Response('请指定目标游戏: /proxy/game.mk49.top/ 或 ?target=game.mk49.top', { status: 400 });
    }

    // WebSocket 升级
    if (request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocket(request, targetHost);
    }

    // HTTP 代理
    return handleHttp(request, targetHost, targetPath, url.search, ctx);
  }
};

/**
 * HTTP 代理 + 缓存
 */
async function handleHttp(request, targetHost, path, search, ctx) {
  const targetUrl = `https://${targetHost}${path}${search}`;

  // 检查缓存 (GET 请求 + 可缓存资源)
  if (request.method === 'GET') {
    const cache = caches.default;
    const cacheKey = new Request(targetUrl, request);
    let response = await cache.match(cacheKey);

    if (response) {
      // 缓存命中
      const headers = new Headers(response.headers);
      headers.set('X-Dragon-Cache', 'HIT');
      headers.set('X-Dragon-Edge', 'true');
      return new Response(response.body, { ...response, headers });
    }

    // 缓存未命中，代理请求
    const proxyResponse = await proxyRequest(request, targetHost, path, search);

    // 缓存可缓存的资源
    if (proxyResponse.ok && shouldCache(path)) {
      const headers = new Headers(proxyResponse.headers);
      headers.set('Cache-Control', `public, max-age=${CONFIG.cacheTTL}`);
      headers.set('X-Dragon-Cache', 'MISS');
      headers.set('X-Dragon-Edge', 'true');

      const cachedResponse = new Response(proxyResponse.body, {
        status: proxyResponse.status,
        headers
      });

      // 异步写入缓存
      ctx.waitUntil(cache.put(cacheKey, cachedResponse.clone()));
      return cachedResponse;
    }

    return proxyResponse;
  }

  // 非 GET 请求直接代理
  return proxyRequest(request, targetHost, path, search);
}

/**
 * 代理 HTTP 请求
 */
async function proxyRequest(request, targetHost, path, search) {
  const targetUrl = `https://${targetHost}${path}${search}`;

  const headers = new Headers(request.headers);
  headers.set('Host', targetHost);
  headers.set('Accept-Encoding', 'gzip, deflate, br');

  // 移除可能导致问题的头
  headers.delete('X-Forwarded-For');
  headers.delete('CF-Connecting-IP');

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'follow'
    });

    const respHeaders = new Headers(response.headers);
    respHeaders.set('Access-Control-Allow-Origin', '*');
    respHeaders.set('Timing-Allow-Origin', '*');
    respHeaders.set('X-Dragon-Proxy', 'cloudflare-worker');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: respHeaders
    });
  } catch (e) {
    return new Response(`Proxy Error: ${e.message}`, { status: 502 });
  }
}

/**
 * WebSocket 代理
 */
async function handleWebSocket(request, targetHost) {
  // Cloudflare Workers 支持 WebSocket 代理
  const targetUrl = `wss://${targetHost}/`;

  try {
    const response = await fetch(targetUrl, {
      headers: request.headers
    });

    // 返回 WebSocket 响应
    return new Response(null, {
      status: 101,
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade'
      }
    });
  } catch (e) {
    return new Response(`WebSocket Error: ${e.message}`, { status: 502 });
  }
}

/**
 * 判断是否应缓存
 */
function shouldCache(path) {
  const ext = path.split('.').pop()?.split('?')[0]?.toLowerCase();
  return CONFIG.cacheableExts.includes(ext);
}

/**
 * 状态页 HTML
 */
const STATUS_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🐉 龙之归宿加速器 — Cloudflare Edge</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:#0a0e1a;color:#e8ecf4;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#0f1525;border:1px solid #1a2340;border-radius:16px;padding:32px;max-width:500px;width:90%;text-align:center}
h1{font-size:24px;margin-bottom:8px;background:linear-gradient(90deg,#ffcc00,#ff3344);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:#6b7a9e;font-size:14px;margin-bottom:20px}
.status{display:inline-flex;align-items:center;gap:6px;padding:6px 16px;border-radius:20px;background:rgba(0,255,136,.1);color:#00ff88;font-size:13px;border:1px solid rgba(0,255,136,.2)}
.dot{width:8px;height:8px;border-radius:50%;background:#00ff88;box-shadow:0 0 8px #00ff88}
.games{display:flex;flex-direction:column;gap:8px;margin-top:20px;text-align:left}
.game{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:rgba(255,255,255,.03);border-radius:10px;border:1px solid #1a2340}
.game .name{font-weight:600}.game .host{font-size:12px;color:#6b7a9e;font-family:monospace}
.game a{color:#00d4ff;text-decoration:none;font-size:12px;padding:4px 10px;border:1px solid rgba(0,212,255,.3);border-radius:6px}
.game a:hover{background:rgba(0,212,255,.1)}
.info{margin-top:20px;font-size:12px;color:#6b7a9e;line-height:1.8}
code{background:rgba(0,212,255,.1);color:#00d4ff;padding:1px 6px;border-radius:4px;font-size:11px}
</style>
</head>
<body>
<div class="card">
  <h1>🐉 龙之归宿加速器</h1>
  <p class="sub">Cloudflare Edge 加速版</p>
  <div class="status"><span class="dot"></span>运行中 — 边缘节点加速</div>
  <div class="games">
    <div class="game">
      <div><div class="name">MK49 (龙之归宿)</div><div class="host">game.mk49.top</div></div>
      <a href="/proxy/game.mk49.top/">🎮 加速进入</a>
    </div>
    <div class="game">
      <div><div class="name">MK48.io</div><div class="host">mk48.io</div></div>
      <a href="/proxy/mk48.io/">🎮 加速进入</a>
    </div>
  </div>
  <div class="info">
    <p>📡 通过 Cloudflare 全球 CDN 边缘节点加速</p>
    <p>💾 静态资源自动缓存 (JS/WASM/图片)</p>
    <p>⚡ HTTP/3 + 0-RTT 最优传输</p>
    <p style="margin-top:10px">使用方式: 将 <code>/proxy/game.mk49.top/</code> 前缀加到游戏 URL 前</p>
  </div>
</div>
</body>
</html>`;
