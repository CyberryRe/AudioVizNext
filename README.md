# AudioVizNext

专业**音频可视化 / 歌词视频**制作工具（Electron 桌面应用）。
时间轴剪编 → 预览即所得 → 一键导出成品 MP4。

> 定位：把"游戏录制 / 壁纸视频 + 音乐 + LRC 歌词 + 可视化特效"合成一支可直接发布的视频。
> 从零重建（吸取旧项目「无 Git、改典一发动全身」的教训），main 永远可运行。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 壳 | Electron 43（主进程只做：原生对话框 / IPC / 文件系统 / 素材代理转码） |
| 构建 | electron-vite 5 + TypeScript 5.6（主/预加载/渲染三进程） |
| UI | React 19 |
| 预览渲染 | **PixiJS 8**（WebGL；DOM 仅作初始化失败兜底） |
| 导出 | **Worker + mediabunny**：`CanvasSink` 顺序解码 → Canvas2D 合成 → `CanvasSource` + `Mp4OutputFormat` 编码复用 |
| 音频分析 | 自研内置算法库（FFT / 频谱 / 波形 / 包络 / 起音 / 节拍），见 [`docs/audio-algorithms.md`](docs/audio-algorithms.md) |
| 素材代理 | 内嵌 ffmpeg（`bin/`，不入库）后台转码 H.264 代理 |

## 快速开始

```bash
npm install
npm run dev            # 开发（热更新）
npm run build          # 构建到 out/
npm start              # 预览构建产物
npm run typecheck      # 类型检查（web + node 两个 project，真检查）
npm test               # 单元测试：模型 / .avnpre / 关键帧 / 音频算法（88 项）
```

> 需要 `bin/ffmpeg.exe` + `bin/ffprobe.exe`（素材代理转码用；`bin/` 已在 `.gitignore`，请自行放置
> 或用 `AVS_FFMPEG_PATH` / `AVS_FFPROBE_PATH` 指定）。

## 目录结构

```
src/
  main/            主进程：窗口 / avn-file:// 协议 / 素材代理 / 预设安装 / 导出落盘 / 文件日志
  preload/         contextBridge 暴露的 window.api（IPC 白名单）
  renderer/src/
    model/         时间轴数据模型（纯逻辑）：timeline.ts / demo.ts
    components/    Pr 风格 UI：Monitor / Timeline / EffectsPanel / EffectControls / MenuBar …
    pixi/          预览渲染器（PixiJS）与布局纯函数 layout.ts（预览与导出共用）
    export/        mbExport.ts（主线程编排）+ mbExportWorker.ts（Worker 导出）+ 测试台
    media/         音频算法库 audioAlgorithms.ts + 工程级逐帧分析 audioAnalysis.ts
    presets/       预设体系：types / registry / keyframes / drawers/*
presets/           内置预设样式（每个样式一个文件夹，随应用打包）
test/              单元测试（node 模式）+ e2e/（Chrome 模式导出测试台）
docs/              文档
```

## 关键设计

### 1. 预览 ≡ 导出
导出渲染器（Worker 内的 Canvas2D）与 Pixi 预览**共用同一套几何/排版函数**
（`pixi/layout.ts` 的 `mediaBox` / `resolveTextRows`）与**同一份音频分析数据**
（`media/audioAnalysis.ts`，主线程算一次 → 传给 Worker）。
预设样式更是同一个 `drawer` 函数：预览画到离屏 canvas 贴成纹理，导出直接画到输出画布。

### 2. 预设样式体系（组件化）
新增一个样式 = 写一个 `presets/<分类>/<id>/preset.json`（声明参数 schema）+ 一个绘制器。
检查器 UI 由 schema **自动生成**，不用改任何 UI 代码。
实现有两种来源：内置 drawer（安全默认）或**预设自带脚本**（`.avnpre` 携带，导入需确认）。
→ 详见 [`docs/preset-authoring.md`](docs/preset-authoring.md)

### 3. 关键帧（内置能力，暴露 API）
`clip.keyframes[参数键] = [{ t, v }]`（`t` 为 clip 内相对时长 0..1，拖动/缩放 clip 自动跟随）。
预设通过 `paramAt(params, keyframes, key, tRel, 默认值)` 取值，检查器给 `"keyframe": true`
的参数自动加 ◆/◇ 打点按钮。→ 见 `src/renderer/src/presets/keyframes.ts`

### 4. 音频算法库
FFT / 幅度谱 / 对数频段 / 波形峰值 / RMS 包络 / 平滑 / 起音 / 自相关节拍估计，
一处实现、组件与第三方脚本共用。→ 详见 [`docs/audio-algorithms.md`](docs/audio-algorithms.md)

### 5. 导出管线（2026-09 迁移后）
```
主线程  mbExport.ts
  ├─ OfflineAudioContext 混音 → 音频分析（波形/频谱/电平/节拍）→ transfer 进 Worker
  ├─ new Worker(mbExportWorker.ts, { type:'module' })
  └─ 进度/取消 + 落盘协调（Worker 无 preload API，MP4 字节回主线程代写）
Worker  mbExportWorker.ts
  ├─ mediabunny Input/CanvasSink.canvasesAtTimestamps(...)  顺序解码（每包只解一次，不逐帧随机 seek）
  ├─ resolveTimeline + layout + drawTextLayer + 预设 drawer   与预览同源的合成
  └─ CanvasSource + Mp4OutputFormat + StreamTarget            进程内编码复用（无 ffmpeg、无逐帧 IPC）
主进程  avs:mbBegin / mbWrite / mbEnd                           按 {position,data} 随机写盘
```

**性能基线**（1920×1080@30fps，210s / 6300 帧，RTX 4060 Laptop）：
约 **34s（≈186fps）**；成本分解 编码+复用 80% / 解码 10% / 绘制 5%。

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/preset-authoring.md`](docs/preset-authoring.md) | **第三方样式制作指南**：preset.json schema、drawer/脚本契约、关键帧与音频 API、`.avnpre` 打包分发 |
| [`docs/audio-algorithms.md`](docs/audio-algorithms.md) | **音频可视化算法 API 使用指南**：FFT/频谱/波形/包络/节拍 的调用与示例 |
| [`docs/presets.md`](docs/presets.md) | 预设体系架构（目录结构、实现解析、安全模型） |
| [`test/e2e/README.md`](test/e2e/README.md) | 导出 E2E 测试台（Chrome 模式）：产物自检、时间轴映射检查、预览截图 |
| [`docs/export-gpu.md`](docs/export-gpu.md) | 导出设备与 Windows GPU 路由（Optimus / 虚拟显示适配器） |
| [`docs/roadmap.md`](docs/roadmap.md) | 阶段规划 |

## 已知限制

- **调整层（如高斯模糊）只在 Pixi 预览后端渲染**；DOM 兜底模式会提示切到 Pixi。
- 含脚本的 `.avnpre` 以**渲染进程权限**运行（同 VS Code 扩展信任模型），导入时会弹确认框；
  只做参数定制、引用内置 drawer 的预设永远是安全默认。
- 导出依赖 Chromium 的 WebCodecs 编码器；目标机器不支持时会以明确错误中止。

## 第三方依赖许可

- **mediabunny** — MPL-2.0。本项目**只作为依赖使用、不修改其源码**，因此无开源义务；
  若将来需要改动其源码，那些改动文件必须公开。
- PixiJS — MIT；React — MIT；Electron — MIT。
