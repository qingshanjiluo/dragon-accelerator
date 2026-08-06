/**
 * 多开实例隔离器
 * 为每个实例生成独立的浏览器指纹
 */

class FingerprintIsolator {
  constructor() {
    this.instances = new Map(); // id → fingerprint
  }

  /**
   * 生成独立指纹
   */
  generate(instanceId) {
    const ua = this.randomUA();
    const fp = {
      userAgent: ua,
      viewport: this.randomViewport(),
      webglVendor: this.randomWebGL(),
      canvasNoise: Math.random().toString(36).slice(2),
      audioNoise: Math.random() * 0.001,
      timezone: this.randomTimezone(),
      language: this.randomLanguage(),
      platform: ua.includes('Windows') ? 'Win32' : ua.includes('Mac') ? 'MacIntel' : 'Linux x86_64',
      hardwareConcurrency: [2, 4, 8, 12, 16][Math.floor(Math.random() * 5)],
      deviceMemory: [2, 4, 8, 16][Math.floor(Math.random() * 4)],
      maxTouchPoints: 0,
      colorDepth: 24,
      pixelRatio: [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)]
    };

    this.instances.set(instanceId, fp);
    return fp;
  }

  /**
   * 获取注入脚本
   */
  getInjectScript(instanceId) {
    const fp = this.instances.get(instanceId);
    if (!fp) return '';

    return `
      // Dragon Accelerator Fingerprint Override
      (function() {
        // UA
        Object.defineProperty(navigator, 'userAgent', { get: () => '${fp.userAgent}' });
        Object.defineProperty(navigator, 'platform', { get: () => '${fp.platform}' });
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${fp.hardwareConcurrency} });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => ${fp.deviceMemory} });
        Object.defineProperty(navigator, 'maxTouchPoints', { get: () => ${fp.maxTouchPoints} });
        
        // Canvas noise
        const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function() {
          const ctx = this.getContext('2d');
          if (ctx) {
            const imgData = ctx.getImageData(0, 0, this.width, this.height);
            for (let i = 0; i < imgData.data.length; i += 4) {
              imgData.data[i] ^= ${Math.floor(Math.random() * 2)};
            }
            ctx.putImageData(imgData, 0, 0);
          }
          return origToDataURL.apply(this, arguments);
        };

        // WebGL
        const origGetParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(p) {
          if (p === 37445) return '${fp.webglVendor}';
          if (p === 37446) return 'ANGLE (Dragon)';
          return origGetParam.call(this, p);
        };

        // Audio noise
        const origCreateOsc = AudioContext.prototype.createOscillator;
        AudioContext.prototype.createOscillator = function() {
          const osc = origCreateOsc.call(this);
          osc.frequency.value += ${fp.audioNoise};
          return osc;
        };
      })();
    `;
  }

  /**
   * 为实例生成代理请求头
   */
  getHeaders(instanceId) {
    const fp = this.instances.get(instanceId);
    if (!fp) return {};

    return {
      'User-Agent': fp.userAgent,
      'Accept-Language': fp.language,
      'Sec-CH-UA-Platform': `"${fp.platform === 'Win32' ? 'Windows' : fp.platform === 'MacIntel' ? 'macOS' : 'Linux'}"`,
      'Sec-CH-UA-Mobile': '?0'
    };
  }

  randomUA() {
    const uas = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    return uas[Math.floor(Math.random() * uas.length)];
  }

  randomViewport() {
    const sizes = [[1920,1080],[1366,768],[1536,864],[1440,900],[1280,720],[2560,1440]];
    return sizes[Math.floor(Math.random() * sizes.length)];
  }

  randomWebGL() {
    const vendors = ['Google Inc. (NVIDIA)', 'Google Inc. (AMD)', 'Google Inc. (Intel)', 'Apple'];
    return vendors[Math.floor(Math.random() * vendors.length)];
  }

  randomTimezone() {
    const tz = ['America/New_York','Europe/London','Asia/Shanghai','Asia/Tokyo','Europe/Berlin'];
    return tz[Math.floor(Math.random() * tz.length)];
  }

  randomLanguage() {
    const langs = ['en-US,en;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.8', 'en-GB,en;q=0.9', 'ja,en-US;q=0.9'];
    return langs[Math.floor(Math.random() * langs.length)];
  }
}

module.exports = { FingerprintIsolator };
