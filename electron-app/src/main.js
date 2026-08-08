const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const dns = require('dns');
const fs = require('fs');

let mainWindow = null;
let tray = null;
let proxyServer = null;
let isAccelerated = false;

// 配置
const CONFIG = {
  proxyPort: 9527,
  dashboardPort: 3949,
  targets: ['game.mk49.top', 'mk48.io', 'forum.mk49.top'],
  cacheDir: path.join(app.getPath('userData'), '.cache'),
  cacheMaxMB: 500
};

// 缓存
const memCache = new Map();
let memCacheBytes = 0;
const diskIndex = new Map();

// DNS 缓存
const dnsCache = new Map();

// 统计
let stats = { requests: 0, hits: 0, misses: 0, bytes: 0, errors: 0, startTime: 0 };

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    transparent: false,
    resizable: true,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#121820',
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0D1218',
      symbolColor: '#8892A0',
      height: 32
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  // 加载缓存索引
  loadDiskIndex();
  preloadDNS();
}

function createTray() {
  try {
    const icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip('龙之归宿加速器');
    const ctx = Menu.buildFromTemplate([
      { label: '打开加速器', click: () => mainWindow?.show() },
      { label: '退出', click: () => app.quit() }
    ]);
    tray.setContextMenu(ctx);
    tray.on('click', () => mainWindow?.show());
  } catch {}
}

// DNS 预解析
function preloadDNS() {
  for (const host of CONFIG.targets) {
    dns.resolve4(host, (err, addresses) => {
      if (!err && addresses.length > 0) {
        dnsCache.set(host, addresses[0]);
      }
    });
  }
}

// 测量延迟
function measureLatency(host) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.get({
      host, port: 443, path: '/', method: 'HEAD',
      timeout: 5000, rejectUnauthorized: false
    }, () => {
      resolve(Date.now() - start);
      req.destroy();
    });
    req.on('error', () => resolve(-1));
    req.on('timeout', () => { req.destroy(); resolve(-1); });
  });
}

// 启动代理
async function startProxy() {
  if (proxyServer) return;

  // 确保缓存目录存在
  if (!fs.existsSync(CONFIG.cacheDir)) fs.mkdirSync(CONFIG.cacheDir, { recursive: true });

  proxyServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (isTarget(url.hostname)) {
      proxyWithCache(req, res, url);
    } else {
      passthrough(req, res, url);
    }
  });

  proxyServer.on('connect', (req, clientSocket, head) => {
    const [host, port] = req.url.split(':');
    const serverSocket = net.connect(parseInt(port) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => clientSocket.end());
    clientSocket.on('error', () => serverSocket.end());
  });

  proxyServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log('端口被占用，尝试其他端口');
      CONFIG.proxyPort++;
      proxyServer.listen(CONFIG.proxyPort, '127.0.0.1');
    }
  });

  proxyServer.listen(CONFIG.proxyPort, '127.0.0.1', () => {
    console.log(`代理已启动: 127.0.0.1:${CONFIG.proxyPort}`);
  });
}

function stopProxy() {
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
  }
}

function isTarget(host) {
  host = (host || '').split(':')[0].toLowerCase();
  return CONFIG.targets.some(h => host === h || host.endsWith('.' + h));
}

function proxyWithCache(req, res, url) {
  stats.requests++;
  const key = url.pathname + url.search;

  // 检查缓存
  if (req.method === 'GET') {
    const cached = getFromCache(key);
    if (cached) {
      stats.hits++;
      res.writeHead(200, {
        'Content-Type': cached.ct,
        'Content-Length': cached.data.length,
        'X-Dragon-Cache': 'HIT'
      });
      return res.end(cached.data);
    }
  }

  // 代理请求
  const t0 = Date.now();
  const opts = {
    hostname: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: req.method,
    headers: { ...req.headers, host: url.hostname, 'Accept-Encoding': 'gzip, deflate, br' },
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

      stats.bytes += body.length;
      stats.misses++;

      if (req.method === 'GET' && shouldCache(url.pathname)) {
        putCache(key, body, pres.headers['content-type'] || 'application/octet-stream');
      }

      res.writeHead(pres.statusCode, {
        'Content-Type': pres.headers['content-type'],
        'Content-Length': body.length,
        'X-Dragon-Cache': 'MISS',
        'X-Latency': `${Date.now() - t0}ms`
      });
      res.end(body);
    });
  });

  preq.on('error', () => {
    stats.errors++;
    if (!res.headersSent) { res.writeHead(502); res.end('Proxy Error'); }
  });
  req.pipe(preq);
}

function passthrough(req, res, url) {
  const proto = url.protocol === 'https:' ? https : http;
  const opts = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers: req.headers
  };
  const preq = proto.request(opts, (pres) => {
    res.writeHead(pres.statusCode, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end(); } });
  req.pipe(preq);
}

function shouldCache(p) {
  const ext = p.split('.').pop()?.split('?')[0]?.toLowerCase();
  return ['js','css','png','jpg','jpeg','gif','webp','svg','woff','woff2','wasm','json','mp3','ogg'].includes(ext);
}

function getFromCache(key) {
  const m = memCache.get(key);
  if (m) { m.hits++; return m; }
  const d = diskIndex.get(key);
  if (d) {
    const fp = path.join(CONFIG.cacheDir, d.file);
    if (fs.existsSync(fp)) {
      const data = fs.readFileSync(fp);
      setMemCache(key, data, d.ct);
      return { data, ct: d.ct };
    }
  }
  return null;
}

function putCache(key, data, ct) {
  setMemCache(key, data, ct);
  if (data.length > 1024) {
    const hash = require('crypto').createHash('md5').update(key).digest('hex').slice(0, 10);
    const ext = getExt(ct);
    const file = hash + ext;
    try {
      fs.writeFileSync(path.join(CONFIG.cacheDir, file), data);
      diskIndex.set(key, { file, size: data.length, ct, hits: 0, ts: Date.now() });
    } catch {}
  }
}

function setMemCache(key, data, ct) {
  const maxBytes = 50 * 1024 * 1024;
  while (memCacheBytes + data.length > maxBytes) {
    const oldest = memCache.keys().next().value;
    if (!oldest) break;
    memCacheBytes -= memCache.get(oldest).data.length;
    memCache.delete(oldest);
  }
  memCache.set(key, { data, ct, hits: 0 });
  memCacheBytes += data.length;
}

function getExt(ct) {
  if (ct?.includes('javascript')) return '.js';
  if (ct?.includes('css')) return '.css';
  if (ct?.includes('png')) return '.png';
  if (ct?.includes('wasm')) return '.wasm';
  if (ct?.includes('json')) return '.json';
  return '.bin';
}

function loadDiskIndex() {
  try {
    const f = path.join(CONFIG.cacheDir, '_index.json');
    if (fs.existsSync(f)) {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf-8')))) diskIndex.set(k, v);
    }
  } catch {}
}

function saveDiskIndex() {
  try { fs.writeFileSync(path.join(CONFIG.cacheDir, '_index.json'), JSON.stringify(Object.fromEntries(diskIndex))); } catch {}
}

// IPC 处理
ipcMain.handle('start-acceleration', async () => {
  if (isAccelerated) return { success: false, error: '已在加速中' };
  isAccelerated = true;
  stats.startTime = Date.now();
  await startProxy();
  return { success: true, port: CONFIG.proxyPort };
});

ipcMain.handle('stop-acceleration', async () => {
  isAccelerated = false;
  stopProxy();
  return { success: true };
});

ipcMain.handle('ping-test', async () => {
  const results = [];
  for (const host of CONFIG.targets) {
    const latency = await measureLatency(host);
    results.push({ host, latency });
  }
  return results;
});

ipcMain.handle('get-stats', () => ({
  ...stats,
  isAccelerated,
  proxyPort: CONFIG.proxyPort,
  cacheItems: memCache.size,
  cacheSize: memCacheBytes,
  diskItems: diskIndex.size,
  uptime: stats.startTime ? Math.floor((Date.now() - stats.startTime) / 1000) : 0
}));

ipcMain.handle('clear-cache', () => {
  memCache.clear();
  memCacheBytes = 0;
  diskIndex.clear();
  try {
    const files = fs.readdirSync(CONFIG.cacheDir);
    for (const f of files) {
      if (f !== '_index.json') fs.unlinkSync(path.join(CONFIG.cacheDir, f));
    }
  } catch {}
  return { success: true };
});

ipcMain.handle('window-minimize', () => mainWindow?.minimize());
ipcMain.handle('window-close', () => mainWindow?.hide());
ipcMain.handle('open-url', (e, url) => shell.openExternal(url));

// 应用生命周期
app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', () => {
  saveDiskIndex();
  stopProxy();
});
