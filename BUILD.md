# 🐉 龙之归宿加速器 — 构建指南

## 一、Windows (.exe / .msi)

### 环境要求
- Node.js >= 18
- npm

### 构建步骤
```bash
cd electron-app
npm install
npm run build:win
```

### 输出
- `electron-app/dist/龙之归宿加速器 Setup 5.0.0.exe` — 安装包
- `electron-app/dist/龙之归宿加速器 5.0.0.msi` — MSI 安装包

---

## 二、macOS (.dmg)

### 环境要求
- Node.js >= 18
- macOS 系统

### 构建步骤
```bash
cd electron-app
npm install
npm run build:mac
```

### 输出
- `electron-app/dist/龙之归宿加速器-5.0.0.dmg`

### 注意
- 在 macOS 上构建的 .dmg 只能在 macOS 上运行
- 如果需要在 Linux/Windows 上交叉构建 macOS 版本，需要额外配置

---

## 三、Android (.apk)

### 环境要求
- Node.js >= 18
- Android Studio (或单独安装 Android SDK)
- Java JDK 17+

### 构建步骤
```bash
cd android-app
npm install
npx cap init "龙之归宿加速器" "com.mk49.dragonaccelerator" --web-dir www
npx cap add android
npx cap sync
cd android
./gradlew assembleDebug
```

### 输出
- `android-app/android/app/build/outputs/apk/debug/app-debug.apk`

### 签名发布版
```bash
./gradlew assembleRelease
# 输出: android-app/android/app/build/outputs/apk/release/app-release-unsigned.apk
```

---

## 四、一键构建脚本

```bash
chmod +x electron-app/build.sh
./electron-app/build.sh
```

自动检测操作系统并构建对应平台的安装包。

---

## 五、项目结构

```
dragon-accelerator/
├── electron-app/          ← Windows/macOS/Linux 桌面版
│   ├── package.json
│   ├── build.sh           ← 一键构建脚本
│   ├── src/
│   │   ├── main.js        ← Electron 主进程
│   │   └── index.html     ← UI 界面
│   └── assets/
│       └── icon.png
│
├── android-app/           ← Android 移动版
│   ├── package.json
│   ├── capacitor.config.json
│   └── www/
│       └── index.html     ← 移动端 UI
│
└── BUILD.md               ← 本文件
```
