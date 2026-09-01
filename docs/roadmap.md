# AudioVizNext — 阶段规划（Roadmap）

> 从零重建的里程碑蓝图。**一个阶段完成并通过验收，才进入下一阶段**。
> 每个阶段都在 main 上打 tag（`stage-N-name`），可随时回滚。

---

## Stage 0 — 基建（已完成 ✅）

- [x] 新建仓库 AudioVizNext，git init main 分支
- [x] .gitignore（node_modules / dist / ffmpeg / env 等）
- [x] Git 工作流约定（docs/git-workflow.md）
- [x] 本规划文档

## Stage 1 — 最小可启动骨架（当前）

**目标**：`npm run dev` 能打开一个 Electron 窗口，显示一个简单的 WebGL 画布。

- [ ] electron-vite 脚手架（主 / preload / renderer 三进程，TypeScript）
- [ ] 窗口能启动，显示 Vite 渲染的页面
- [ ] 一个最简单的 WebGL/Canvas 频谱条（用音频分析数据画几条 bar）
- [ ] 渲染层薄封装：`renderer/render/` 目录，独立于业务
- [ ] 打 tag `stage-1-skeleton`

**验收**：窗口启动、画布能画、`npm run test`（若有）通过。

## Stage 2 — 音频解码与频谱分析

**目标**：能打开本地音频，实时拿到频谱/波形数据。

- [ ] 文件打开对话框（主进程）
- [ ] 音频解码（WebAudio / FFmpeg）
- [ ] 频谱分析模块（FFT，返回可渲染数据）
- [ ] 波形预览

## Stage 3 — 渲染内核（GPU 合成）

**目标**：可视化渲染走 GPU，性能达标（1080p @ 60fps）。

- [ ] WebGL2 渲染管线（自写 shader 起步）
- [ ] 频谱可视化效果（bar / wave / 粒子）
- [ ] 渲染确定性：预览 ≡ 导出
- [ ] 性能基准测试

## Stage 4 — 时间轴与剪辑

**目标**：能把素材拖上时间轴，调整长度、顺序。

- [ ] TimelineModel（纯逻辑，可单测）
- [ ] 时间轴 UI（轨道 / clip / 拖拽 / 缩放）
- [ ] 播放状态机（吸取旧项目教训：单一权威）
- [ ] 播放控制（play / pause / seek）

## Stage 5 — 歌词与合成

**目标**：歌词轨 + 多轨合成。

- [ ] LRC 解析与内化编辑
- [ ] 多轨合成器（视频轨 + 音频轨 + 歌词轨）
- [ ] 预览渲染

## Stage 6 — 导出

**目标**：生成成品视频文件。

- [ ] FFmpeg 硬件编码导出
- [ ] 导出确定性（预览 ≡ 导出）
- [ ] 进度与取消

## Stage 7 — 生态与打磨

**目标**：可生产力使用。

- [ ] 预设 / 效果系统（声明式，可分享）
- [ ] 工程文件保存 / 加载
- [ ] 发布打包（electron-builder）

---

## 技术栈（已定）

- **脚手架**：electron-vite
- **语言**：TypeScript
- **渲染层**：自写薄渲染层起步（验证 GPU 路线），业务复杂后接 PixiJS 画布基座 + Butterchurn 可视化
- **GUI 合成**：WebGL2 / WebGPU
- **Git**：main + feature 分支，阶段打 tag

## 铁律

- 一个阶段没验收通过，不进入下一阶段
- main 永远可运行
- 渲染改动必须保证「预览 ≡ 导出」
- 新功能跑通测试再合并
