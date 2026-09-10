# AGENTS.md — AudioVizNext

专业音频可视化 / 歌词视频桌面应用（Electron 43 + electron-vite 5 + React 19 + PixiJS 8 + mediabunny）。  
从零重建：小步推进，main 永远可跑，阶段打 tag（`stage-N-name`）。

## 命令（Windows / PowerShell）

```powershell
npm install
npm run dev          # electron-vite dev
npm run build        # 产物到 out/
npm start            # electron-vite preview（跑 out/）
npm run typecheck    # tsc -p tsconfig.web.json && tsc -p tsconfig.node.json（两份都要过）
npm test             # model + avnpre + keyframes + audio（node --experimental-strip-types）
# 单测：npm run test:model | test:avnpre | test:keyframes | test:audio
```

无 lint/format 脚本。依赖已锁 `package-lock.json`。

**环境**
- 本地 `bin/ffmpeg.exe` + `bin/ffprobe.exe`（MediaCache 代理转码；`.gitignore` 忽略 `bin/`，文件仍在盘上）。可用 `AVS_FFMPEG_PATH` / `AVS_FFPROBE_PATH` 覆盖。
- 某些沙箱默认 `ELECTRON_RUN_AS_NODE=1`：启动 Electron 前必须清掉，否则 Node 模式、GUI 起不来。
- 烟雾：`AVS_SMOKE=1` → 页面加载后打印 `SMOKE_OK` 并退出。
- E2E：`test/e2e/run.ps1 -Spec test\e2e\spec-*.json`（必须 UTF8 读 spec；脚本已清 `ELECTRON_RUN_AS_NODE`）。详见 `test/e2e/README.md`。

## 架构（改代码前必知）

```
src/main/     窗口 / avn-file:// 协议 / MediaCache 代理 / 预设导入 / mb 导出落盘 / 文件日志 / GPU 偏好
src/preload/  window.api（IPC 白名单；路径用 webUtils.getPathForFile，Electron≥32 无 File.path）
src/shared/   avnpre.ts（预设包编解码，主进程导入校验共用）
src/renderer/src/
  model/      timeline.ts 纯逻辑：整数帧、resolveTimeline(frame,project)→同一 Scene
  pixi/       PixiRenderer 预览 + layout.ts（预览与导出共用几何，禁止两端各自手写）
  export/     mbExport.ts（主线程编排）+ mbExportWorker.ts（Worker 画帧）+ e2eRunner.ts
  media/      audioAlgorithms.ts（可单测）+ audioAnalysis.ts（逐帧音频数据）
  presets/    types / registry / keyframes / drawers
presets/      内置预设（visualizations|images|effects/<id>/preset.json）
```

- **UI / 时间轴 / 预览 / 分析全在同一渲染进程**；主进程只做 FFmpeg spawn、IPC、文件系统。
- **铁律「导出 = 预览」**：几何只来自 `pixi/layout.ts`；改布局只改这一处。
- **正式导出 = mediabunny**（`runMbExport`，Worker + OffscreenCanvas；App 与 e2e 均走此路径）。旧 WebCodecs/rawvideo/ffmpeg 逐帧链路已退役，勿复活。
- 预览视频是时间轴的“奴隶”：`sourceFrame/projectFps` 钉帧，禁止无条件 play+loop。
- `project.design`（冻结设计基准）决定内容字号/布局；`project.stage` 只是输出画框。切分辨率勿重算 design。

## 高代价坑（会静默坏掉）

1. **Pixi v8**：纹理就绪看 `texture.width/height>=1`，**绝不写 `texture.valid`**（v7 API，恒 undefined → 永黑）。离屏导出 `Application` 必须 `autoStart:false` + 显式 `ticker.stop()`。多 Application 共存时 `destroy` 用 `{ releaseGlobalResources:false }`，否则预览导出后崩（共享 TexturePool）。
2. **`avn-file://`**：主进程响应需 `Access-Control-Allow-Origin: *`；WebGL 消费端 `<video>/<img>` 设 src 前 `crossOrigin='anonymous'`。`fetch(avn-file)` 还要 CSP `connect-src` 放行（见 `src/renderer/index.html`）。Range 须支持 `bytes=-N` 后缀区间。
3. **本地音频**：Chromium 对自定义协议 `<audio>` 会 PIPELINE_ERROR_READ。走 `readFileBytes` → Blob URL（`media/audioBlob.ts`）。**不要**拿 MediaCache 视频代理喂 `<audio>`。
4. **轨道双事实源**：UI 顺序 = `tracks` **按 `order` sort**；渲染 zIndex = `(maxOrder-order)*1000`。建视频轨插 zone 前（order=0 最顶）；建音频轨 append。`createTrack({kind:'audio'})` **不会**推断 zone，必须显式 `zone:'audio'`。
5. **MediaCache**：改转码参数必须 +1 `PROXY_VERSION`（`mediaCache.ts`），否则旧代理一直命中。
6. **Node strip-types 测试**：被 `node --experimental-strip-types` import 的模块**禁止** `constructor(private x)` 参数属性 → ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
7. **H.264 偶数边**：`stageSizeFor` / 导出画布宽高必须偶数，否则色带/编码器拒绝。
8. **类私有方法**类内调用必须 `this.foo()`；React 内联 style 属性名不要写进值里。
9. **native ffmpeg.exe** 不认 Git-Bash `/tmp/...` MSYS 路径 → 用真实 Windows 路径。

## Git / 协作

- `docs/git-workflow.md`（本地）：main + `feature/<name>`，一条提交一事，**中文**提交 `feat|fix|refactor|test|chore|docs: ...`，合并 `--no-ff`，阶段 tag。
- 默认**不要主动跑 `npm test` / smoke / E2E** 交付后由用户目视验收；除非用户明确要求跑测试。
- 不要提交 `bin/`、`out/`、`reference/`、`.workbuddy/`、`docs/*`（仅 `preset-authoring.md`、`audio-algorithms.md` 发布）。

## 任务边界（用户可见约定）

- 简单改动小步提交；复杂/多文件改动先对齐方向再动手。
- 素材路径、GPU 偏好（独显/核显）等本机环境相关能力勿硬编码绝对路径入库。
- 第三方预设：`.avnpre` 只带声明/参数/资源；脚本实现需用户确认。格式见 `src/shared/avnpre.ts` + `docs/preset-authoring.md`。
