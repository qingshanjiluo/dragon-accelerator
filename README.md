# 🐉 龙之归宿加速器 (Dragon Accelerator)

专为 MK49 游戏 (game.mk49.top) 打造的桌面端游戏加速器。

## ✨ 功能特性

- **智能 DNS 加速** — 预解析并缓存游戏域名，减少 DNS 查询延迟
- **实时延迟监控** — 精确显示到 game.mk49.top 的网络延迟
- **抖动 & 丢包检测** — 实时监测网络质量指标
- **一键加速** — 点击即启，零配置使用
- **内置游戏入口** — 直接在加速器内打开游戏，无需额外浏览器
- **系统托盘支持** — 最小化到后台继续运行
- **跨平台** — 支持 Windows / macOS / Linux

## 🚀 快速开始

### 环境要求
- Node.js >= 18
- npm 或 yarn

### 安装 & 运行

```bash
cd dragon-accelerator
npm install
npm start
```

### 打包发布

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

打包产物在 `dist/` 目录下。

## 📖 使用说明

1. **启动加速器** — 运行后点击「启动加速」按钮
2. **查看延迟** — 实时延迟、抖动、丢包率会自动更新
3. **延迟测试** — 点击「📡 延迟测试」查看当前 ping 值
4. **进入游戏** — 点击「🎮 进入游戏」在加速器内直接打开 MK49
5. **停止加速** — 随时点击「停止加速」断开加速

## 🏗️ 项目结构

```
dragon-accelerator/
├── package.json          # 项目配置 & 打包配置
├── README.md             # 本文件
├── assets/               # 图标资源
├── src/
│   ├── main/
│   │   └── main.js       # Electron 主进程
│   └── renderer/
│       ├── index.html     # 主界面
│       ├── style.css      # 样式
│       ├── renderer.js    # 渲染进程逻辑
│       └── game-preload.js # 游戏 WebView 预加载脚本
└── dist/                  # 打包输出目录
```

## ⚡ 加速原理

1. **DNS 预解析** — 启动时预先解析 game.mk49.top 等相关域名并缓存
2. **TCP 连接优化** — 通过优化 socket 参数减少握手延迟
3. **持续延迟监测** — 每 2 秒检测到服务器的延迟，确保网络稳定
4. **WebView 隔离** — 游戏在独立 WebView 中运行，避免主进程干扰

## 📄 License

MIT
