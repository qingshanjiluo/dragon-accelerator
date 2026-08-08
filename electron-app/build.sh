#!/bin/bash
# 🐉 龙之归宿加速器 — 一键构建脚本
# 支持: Windows (.exe/.msi), macOS (.dmg), Linux (.AppImage)

set -e
echo "🐉 龙之归宿加速器 — 构建脚本"
echo "================================"

cd "$(dirname "$0")"

# 1. 安装依赖
echo ""
echo "[1/4] 安装依赖..."
npm install

# 2. 下载 Electron 二进制
echo ""
echo "[2/4] 下载 Electron..."
npx electron --version 2>/dev/null || npm rebuild

# 3. 构建
echo ""
echo "[3/4] 开始打包..."

case "$(uname -s)" in
    Linux*)
        echo "检测到 Linux，构建 Linux + Windows 版本..."
        npx electron-builder --linux AppImage --win nsis msi --x64
        ;;
    Darwin*)
        echo "检测到 macOS，构建 macOS + Windows 版本..."
        npx electron-builder --mac dmg --win nsis msi --x64
        ;;
    MINGW*|MSYS*)
        echo "检测到 Windows，构建 Windows 版本..."
        npx electron-builder --win nsis msi --x64
        ;;
    *)
        echo "未知系统，尝试构建所有平台..."
        npx electron-builder --win nsis msi --x64
        ;;
esac

# 4. 输出
echo ""
echo "[4/4] 构建完成！"
echo "================================"
echo "输出目录: dist/"
ls -lh dist/*.exe dist/*.msi dist/*.dmg dist/*.AppImage 2>/dev/null || echo "请检查 dist/ 目录"
