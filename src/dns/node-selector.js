/**
 * 智能节点选择器
 * 定期 ping 所有可用节点，选择最优路径
 */
const dns = require('dns');
const https = require('https');
const { execSync } = require('child_process');

class NodeSelector {
  constructor(settings) {
    this.hosts = settings.getEnabledHosts();
    this.nodes = new Map(); // host → { ips, bestIp, latency, lastCheck }
    this.checkInterval = 60000; // 1分钟检测一次
    this.timer = null;

    // 备用 DNS 服务器
    this.dnsServers = ['8.8.8.8', '1.1.1.1', '223.5.5.5', '114.114.114.114'];
  }

  async start() {
    await this.checkAll();
    this.timer = setInterval(() => this.checkAll(), this.checkInterval);
    console.log(`[DNS] 节点选择器已启动 (每 ${this.checkInterval / 1000}秒 检测)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * 检测所有节点
   */
  async checkAll() {
    for (const host of this.hosts) {
      await this.checkHost(host).catch(() => {});
    }
  }

  /**
   * 检测单个主机的所有 IP
   */
  async checkHost(host) {
    // 1. DNS 解析获取所有 IP
    const ips = await this.resolveAll(host);
    if (ips.length === 0) return;

    // 2. 并发 ping 所有 IP
    const results = await Promise.all(ips.map(ip => this.pingIP(ip, host)));

    // 3. 选择最优
    const valid = results.filter(r => r.latency > 0).sort((a, b) => a.latency - b.latency);
    const best = valid[0];

    this.nodes.set(host, {
      ips,
      bestIp: best?.ip || ips[0],
      bestLatency: best?.latency || -1,
      allResults: valid,
      lastCheck: Date.now()
    });

    if (best) {
      console.log(`[DNS] ${host}: 最优 ${best.ip} (${best.latency}ms), 共 ${ips.length} 个IP`);
    }
  }

  /**
   * 多 DNS 服务器解析
   */
  async resolveAll(host) {
    const allIps = new Set();

    // 标准解析
    const standard = await this.resolve(host);
    standard.forEach(ip => allIps.add(ip));

    // 尝试用不同 DNS 服务器
    for (const dnsServer of this.dnsServers.slice(0, 2)) {
      try {
        const output = execSync(`nslookup ${host} ${dnsServer} 2>/dev/null`, { timeout: 3000 }).toString();
        const matches = output.match(/Address:\s*(\d+\.\d+\.\d+\.\d+)/g);
        if (matches) {
          matches.forEach(m => {
            const ip = m.replace('Address:', '').trim();
            if (ip && !ip.includes('#')) allIps.add(ip);
          });
        }
      } catch {}
    }

    return Array.from(allIps);
  }

  resolve(host) {
    return new Promise((resolve) => {
      dns.resolve4(host, (err, addresses) => {
        resolve(err ? [] : addresses);
      });
    });
  }

  /**
   * Ping 单个 IP (TCP 连接时间)
   */
  pingIP(ip, host) {
    return new Promise((resolve) => {
      const start = Date.now();
      const req = https.get({
        host: ip, port: 443, path: '/', method: 'HEAD',
        timeout: 5000, rejectUnauthorized: false,
        servername: host // SNI
      }, () => {
        resolve({ ip, latency: Date.now() - start });
        req.destroy();
      });
      req.on('error', () => resolve({ ip, latency: -1 }));
      req.on('timeout', () => { req.destroy(); resolve({ ip, latency: -1 }); });
    });
  }

  /**
   * 获取最优 IP
   */
  getBestIP(host) {
    const node = this.nodes.get(host);
    return node?.bestIp || null;
  }

  /**
   * 获取节点状态
   */
  getStatus() {
    const status = {};
    for (const [host, node] of this.nodes) {
      status[host] = {
        bestIP: node.bestIp,
        latency: node.bestLatency,
        totalIPs: node.ips.length,
        reachableIPs: node.allResults.length,
        lastCheck: new Date(node.lastCheck).toLocaleTimeString()
      };
    }
    return status;
  }
}

module.exports = { NodeSelector };
