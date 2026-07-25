# OpenCut Classic 中文 Windows 桌面版

该目录把 OpenCut Classic 的 Next.js standalone 产物封装为 Electron Windows 应用。

## 已包含的增强

- 简体中文界面翻译层
- 安装版和免安装版 EXE
- 视频片段内嵌音频波形
- MP4、MOV、AAC 等容器音轨的流式波形分析
- 大型媒体波形 IndexedDB 持久化缓存
- 文字连续输入与中文输入法修复
- 修改文字后拖动位置不会恢复旧内容
- 双击或右键预览视频、音频和图片素材
- 素材在中间内置播放器中预览，可设置入点、出点并将选区添加到时间线
- 大型视频素材使用浏览器原生流式播放与进度拖动

## 构建环境

- Windows 10/11 x64
- Bun 1.2.18
- Node.js 与 npm

## 构建步骤

在仓库根目录执行：

```powershell
bun install
$env:NEXT_PUBLIC_SITE_URL = "http://127.0.0.1:3210"
bun run --cwd apps/web build
cd desktop-wrapper
npm install
npm run dist
```

生成文件位于 `desktop-wrapper/dist/`：

- `OpenCut Classic Setup <version>.exe`：安装版
- `OpenCut Classic <version>.exe`：免安装版

`web/`、`node_modules/` 和 `dist/` 是生成目录，不提交到 Git。

## 本地服务

桌面应用启动后会自动在 `127.0.0.1:3210` 启动内置 Next.js 服务，关闭应用时自动停止。登录、在线音效等联网功能仍需要相应数据库、Redis 与 API 配置；本地剪辑功能不依赖这些服务。
