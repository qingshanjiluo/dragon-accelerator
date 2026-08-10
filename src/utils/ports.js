/**
 * 端口检测工具 — 检查端口占用、自动寻找空闲端口
 */
const net = require('net');

/**
 * 检查指定端口是否空闲（未被监听）
 */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/**
 * 从起始端口开始寻找一个空闲端口
 * @returns {Promise<number>} 找到的空闲端口
 */
async function findFreePort(start, maxTries = 50) {
  for (let p = start; p < start + maxTries; p++) {
    if (await isPortFree(p)) return p;
  }
  return start + maxTries;
}

module.exports = { isPortFree, findFreePort };
