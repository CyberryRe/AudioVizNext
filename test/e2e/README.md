# 导出 E2E 测试台（Chrome / Electron 渲染进程模式）

Node 模式（`node --experimental-strip-types`）没有 `VideoEncoder` / canvas / GPU / Worker，测不了导出链路。
本测试台把导出跑在**真实渲染进程**里（真 WebCodecs、真 GPU、真 Worker），用真实素材验证产物完整性。

## 用法

```powershell
# Windows PowerShell 5.1（本机无 pwsh）
$env:AVS_E2E_SPEC = (Get-Content -Raw -Encoding UTF8 test\e2e\spec-mb.json)   # ← 必须 -Encoding UTF8，否则中文路径变乱码
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
node_modules\.bin\electron.cmd .
```

主进程检测到 `AVS_E2E_SPEC` 后：渲染层（`src/renderer/src/main.tsx` → `export/e2eRunner.ts`）挂载前接管，
跑一次 `runMbExport`，把报告经 `avs:e2e:report` 打回 stdout（`E2E_RESULT_BEGIN … E2E_RESULT_END`），然后退出。
未设该环境变量时**零影响**（正常启动 React 应用）。

## spec 字段

| 字段 | 说明 |
|---|---|
| `out` | 输出 mp4 绝对路径 |
| `seconds` / `fps` / `stage` | 导出时长 / 帧率 / 画幅（默认 20 / 30 / 1920x1080） |
| `video` / `audio` / `lrc` / `text` | 素材绝对路径（背景视频、音频、LRC 歌词、纯文本） |
| `bitrate` | 视频码率（默认 20Mbps） |
| `frameChecks` | 时间轴映射检查：比较导出文件两个时间点的 SSIM，`expect:'same'\|'differ'` + `min`/`max` |
| `mode` | `mb`（默认，完整导出）/ `preview`（挂载 PixiRenderer 渲染回归） |

### frameChecks：抓"循环/定格/时间轴错位"

循环素材的 `t` 与 `t+源时长` 必须≈同一画面（`same`），`t` 与 `t+几秒` 必须明显不同（`differ`）。
**画面冻结**的特征是 `same` 通过但 `differ` 也接近 1.0 → 立刻暴露。实测基线（RGB 通道 SSIM，
歌词叠加会让"同背景"停在 0.88-0.97）：`same ≥0.85`、`differ ≤0.8`；冻结态约 0.97-0.99。

> ⚠ 用**精确循环周期**取点：源 12.08s 时 `t=2` 的对照点是 `14.067`（不是 14）——按整秒取会差 2 帧，
> 把正确的循环误判成 ❌。

## 已建 spec

| 文件 | 用途 |
|---|---|
| `spec-mb.json` | 完整导出（视频+歌词+音频），20s，含循环/运动 frameChecks |
| `spec-mb-long.json` | 210s 长跑（真实背景 12.08s 循环 18 段），含 4 项 frameChecks |
| `spec-mb-hevc.json` | 非 H.264（HEVC）源 |
| `spec-oddheight.json` | 21:9 → 1920×823 奇数尺寸（验证取偶兜底） |
| `spec-preview.json` | `mode:'preview'`：PixiRenderer 渲染回归（含 clip 移除的 retire 路径） |

## 产物自检（每次 E2E 自动跑）

报告里的 `integrity` 与日志 `[E2E-verify]` 由主进程 `verifyVideoIntegrity()` 给出：
用 ffmpeg 解一遍视频轨，比较**容器包数**与**实际解出帧数**——两者不等或 `errors>0`
即表示码流被写坏（画面会大面积色块崩坏 / 丢帧），必须当成失败处理。

手动复核（更细，含逐帧 blockiness）：

```powershell
# 1) 包数 vs 解出帧数（关键）
bin\ffmpeg.exe -v verbose -i out.mp4 -map 0:v -f null - 2>&1 | Select-String 'packets read'
# 2) 逐帧块效应，看是否有离群尖峰（正常应接近中位数）
bin\ffmpeg.exe -y -i out.mp4 -lavfi "blockdetect,metadata=print:file=blk.log" -f null -
```

## 当前管线：mediabunny（2026-09-08 迁移完成）

```
mbExport.ts（主线程：OfflineAudioContext 混音 + 起 Worker + 进度/取消 + 落盘协调）
  └─ mbExportWorker.ts（Worker：mediabunny CanvasSink 顺序解码 → 2D 绘制 → CanvasSource 编码 → Mp4Output 复用）
       └─ postMessage({position,data}) → 主线程 → avs:mbWrite → 主进程按偏移随机写盘
```

渲染几何仍复用本仓 `resolveTimeline` + `mediaBox` + `drawTextLayer`（与预览同源 → 「导出=预览」）。

| 210s / 6300 帧 | 耗时 | fps | 产物完整性 | HEVC 源 |
|---|---|---|---|---|
| mediabunny（现管线） | **~34s** | ~186 | 6300/6300 ✅ | ✅ 正常 |
| 旧 WebCodecs + ffmpeg mux | 81.4s | 77 | 6300/6300（修后） | ❌ 黑底 |
| 旧 rawvideo + NVENC | 288.4s | 22 | 6300/6300 | ❌ 黑底 |

已验证事实：
- **模块 Worker 在 `file://` 源下可用**（`ok(pong:ping)`）→ 导出跑在 Worker，不卡 UI。
- 编码+复用占 68-78%，解码 13-23%，绘制 8-10% → 瓶颈只剩编码器本身。
- ffmpeg 从导出链路中完全移除（MediaCache 素材代理转码仍用 ffmpeg）。

## 历史「色块崩坏」根因（旧管线，已随迁移删除）

1. **编码器缓冲池复用**：chunk 拷进池化缓冲后 `flush()` 立刻把同一块内存还池，消费方尚未发送就被覆盖
   → 600 包只解出 409 帧（缺失呈爆发式、越到后面越严重）。现管线不再有自研缓冲池。
2. **奇数画幅尺寸**：`stageSizeFor(21/9,1920)=1920×823` → 色度面错位 → 底部绿色色块。
   现由 `exportTypes.evenUp()` + Worker 内取偶告警兜底。
