#!/bin/bash
echo "========================================"
echo "   🐉 龙之归宿加速器 - MK49 游戏加速"
echo "========================================"
echo ""
echo "正在启动加速器..."

# Detect OS and open in browser
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "$(dirname "$0")/standalone/index.html"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "$(dirname "$0")/standalone/index.html" 2>/dev/null || echo "请手动打开 standalone/index.html"
else
    echo "请手动打开 standalone/index.html"
fi

echo "加速器已在浏览器中打开！"
