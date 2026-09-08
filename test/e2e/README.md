# 导出 E2E 测试台

在真实 Electron 渲染进程（真 WebCodecs / GPU / Worker）里跑一次完整导出，验证产物与时间轴映射。

## 用法

```powershell
$env:AVS_E2E_SPEC = (Get-Content -Raw -Encoding UTF8 test\e2e\spec-mb.json)   # 必须 -Encoding UTF8
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node_modules\.bin\electron.cmd .
```

主进程读到 `AVS_E2E_SPEC` 后，渲染层（`src/renderer/src/main.tsx` → `export/e2eRunner.ts`）接管，
跑完把报告打到 stdout（`E2E_RESULT_BEGIN … E2E_RESULT_END`）后退出。未设该变量时零影响。

## spec 字段

| 字段 | 说明 |
|---|---|
| `out` | 输出 mp4 绝对路径 |
| `seconds` / `fps` / `stage` | 时长 / 帧率 / 画幅（默认 20 / 30 / 1920x1080） |
| `video` / `audio` / `lrc` / `text` | 素材绝对路径 |
| `bitrate` | 视频码率（默认 20Mbps） |
| `presets` | 预设层 `[{ id, seconds, image, params, keyframes }]` |
| `presetsBelowLyrics` | true = 预设轨道放到歌词下面 |
| `frameChecks` | 时间轴映射检查 `[{ a, b, expect:'same'\|'differ', min?, max? }]` |
| `mode` | `mb`（默认，完整导出）/ `preview`（Pixi 渲染回归 + 截图） |
| `benchFrames` | preview 模式渲染帧数 |

## 已有 spec

| 文件 | 用途 |
|---|---|
| `spec-mb.json` | 20s 完整导出 + 循环检查 |
| `spec-mb-long.json` | 210s 长跑 + 4 项检查 |
| `spec-mb-hevc.json` | HEVC 源 |
| `spec-oddheight.json` | 21:9 奇数尺寸 |
| `spec-blur.json` | 关键帧高斯模糊 |
| `spec-preset-export.json` / `spec-preset-export2.json` | 4 预设共存导出 |
| `spec-preset-preview.json` | 预设预览渲染回归 |
| `spec-preview-blur.json` / `spec-preview-blur2.json` | 调整层预览（模糊在歌词上/下） |

## 报告内容

- `[E2E-verify]` 容器包数 vs 解出帧数（不等 = 码流被写坏）
- `[E2E-frames]` 两个时间点的 SSIM 与期望对比
- `[E2E-preview]` 渲染异常捕获 + 预览截图落盘（`<out 同目录>/preview-shot.png`）
- `[Export-perf-mediabunny]` 解码 / 绘制 / 编码复用占比

## 手动复核

```powershell
# 包数 vs 解出帧数
bin\ffmpeg.exe -v verbose -i out.mp4 -map 0:v -f null - 2>&1 | Select-String 'packets read'
# 逐帧块效应（找离群尖峰）
bin\ffmpeg.exe -y -i out.mp4 -lavfi "blockdetect,metadata=print:file=blk.log" -f null -
```
