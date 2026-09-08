# AudioVizNext

音频可视化 / 歌词视频制作工具（Electron 桌面应用）。

## 快速开始

```bash
npm install
npm run dev        # 开发
npm run build      # 构建到 out/
npm start          # 运行构建产物
npm run typecheck  # 类型检查（web + node）
npm test           # 单元测试（模型 / .avnpre / 关键帧 / 音频算法）
```

需要 `bin/ffmpeg.exe` + `bin/ffprobe.exe`（素材代理转码用），或用环境变量
`AVS_FFMPEG_PATH` / `AVS_FFPROBE_PATH` 指定。

## 技术栈

| 层 | 选型 |
|---|---|
| 壳 | Electron 43 |
| 构建 | electron-vite 5 + TypeScript |
| UI | React 19 |
| 预览 | PixiJS 8（DOM 为兜底） |
| 导出 | Worker + mediabunny（WebCodecs 编码 + MP4 复用） |
| 音频分析 | 内置算法库（FFT / 频谱 / 波形 / 包络 / 节拍） |

## 目录

```
src/main/         主进程：窗口 / avn-file:// 协议 / 素材代理 / 预设安装 / 导出落盘 / 文件日志
src/preload/      window.api（IPC 白名单）
src/renderer/src/
  model/          时间轴数据模型（纯逻辑）
  components/     UI：Monitor / Timeline / EffectsPanel / EffectControls / MenuBar
  pixi/           预览渲染器 + layout.ts（预览与导出共用的几何/排版）
  export/         mbExport.ts（主线程编排）+ mbExportWorker.ts（Worker 导出）+ e2eRunner.ts
  media/          audioAlgorithms.ts（算法库）+ audioAnalysis.ts（逐帧数据）
  presets/        types / registry / keyframes / drawers
presets/          内置预设样式（随应用打包）
test/             单元测试 + e2e/（Chrome 模式导出测试台）
docs/             文档
```

## 功能

- **时间轴**：多视频/音频轨、拖拽/缩放/吸附、跨轨移动、轨道折叠
- **预览**：PixiJS 实时预览；与导出共用同一套布局函数与音频分析数据
- **歌词**：LRC 解析、卡拉OK 滚动、辉光
- **预设样式**：粒子波形 / 圆角矩形 / 圆形 / 贴纸 / 高斯模糊（调整层）；支持第三方 `.avnpre` 导入
- **关键帧**：任意数值参数可在播放头打点
- **导出**：Worker + mediabunny，1920×1080@30fps 约 186fps（210s / 6300 帧 ≈ 34s）

## 文档

- [第三方样式制作指南](docs/preset-authoring.md)
- [音频算法 API](docs/audio-algorithms.md)
- [导出测试台](test/e2e/README.md)

## 依赖许可

- **mediabunny** — MPL-2.0（仅作为依赖使用，不修改其源码）
- PixiJS / React / Electron — MIT
