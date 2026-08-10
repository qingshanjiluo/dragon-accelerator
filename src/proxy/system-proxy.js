/**
 * Windows 系统代理管理器
 * 自动写入/恢复系统代理（HKCU Internet Settings），
 * 保存并恢复原代理配置，避免与 VPN/其它代理冲突。
 */
const { execFileSync } = require('child_process');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

class SystemProxy {
  constructor() {
    this.saved = null;   // 应用前的系统代理原值
    this.applied = false;
  }

  /**
   * 读取当前系统代理设置
   */
  getCurrent() {
    const out = {};
    try {
      const text = execFileSync('reg', ['query', REG_KEY], { encoding: 'utf8' });
      const pick = (name) => {
        const m = text.match(new RegExp('\\s' + name + '\\s+REG_(\\w+)\\s+(\\S.*)'));
        return m ? m[2].trim() : '';
      };
      out.enable = pick('ProxyEnable');
      out.server = pick('ProxyServer');
      out.override = pick('ProxyOverride');
      out.auto = pick('AutoConfigURL');
    } catch {}
    return out;
  }

  /**
   * 应用系统代理指向本地加速端口
   */
  apply(port) {
    if (!port) return false;
    this.saved = this.getCurrent();
    const set = (v, type, d) => execFileSync('reg', ['add', REG_KEY, '/v', v, '/t', type, '/d', d, '/f']);
    try {
      set('ProxyEnable', 'REG_DWORD', '1');
      set('ProxyServer', 'REG_SZ', `127.0.0.1:${port}`);
      // 本地地址与局域网直连，避免影响本地/内网
      set('ProxyOverride', 'REG_SZ', '<local>;localhost;127.0.0.1;*.local;10.*;192.168.*;172.16.*;172.17.*;172.18.*;172.19.*;172.2*;172.3*');
      this.notify();
      this.applied = true;
      return true;
    } catch (e) {
      console.warn('[SysProxy] 设置系统代理失败:', e.message);
      return false;
    }
  }

  /**
   * 恢复之前保存的系统代理设置（用于停止加速时还原 VPN 等）
   */
  restore() {
    const set = (v, type, d) => execFileSync('reg', ['add', REG_KEY, '/v', v, '/t', type, '/d', d, '/f']);
    try {
      if (this.saved && this.saved.enable) {
        set('ProxyEnable', 'REG_DWORD', this.saved.enable);
        set('ProxyServer', 'REG_SZ', this.saved.server || '');
        set('ProxyOverride', 'REG_SZ', this.saved.override || '');
      } else {
        set('ProxyEnable', 'REG_DWORD', '0');
      }
      this.notify();
      this.applied = false;
      return true;
    } catch (e) {
      console.warn('[SysProxy] 恢复系统代理失败:', e.message);
      return false;
    }
  }

  /**
   * 通知 WinINet 代理设置已变更
   */
  notify() {
    try {
      const ps = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport("wininet.dll",SetLastError=true)]public static extern bool InternetSetOption(IntPtr a,int b,IntPtr c,int d);}';[W]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0);[W]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)`;
      execFileSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 15000 });
    } catch {}
  }
}

module.exports = { SystemProxy };
