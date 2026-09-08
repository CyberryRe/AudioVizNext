# 预设样式系统（组件化）与 `.avnpre` 预设包

> 目标：新增一个样式 = **写一个 `preset.json` + 一个 drawer 函数**，不碰 UI、不碰渲染管线。
> 预览（Pixi）与导出（Worker + mediabunny）**共用同一个 drawer**，因此天然满足「预览 ≡ 导出」。

## 1. 目录结构（内置预设随应用打包）

```
presets/
  visualizations/
    particle-waveform/preset.json    # 可视化：粒子波形（对齐 AudioViz Studio）
  images/
    rounded-rect/preset.json         # 图片样式：圆角矩形
    circle/preset.json               # 图片样式：圆形（边框纹理 + 旋转速度）
    sticker/preset.json              # 图片样式：贴纸（PNG 透明通道 + 静态旋转）
src/renderer/src/presets/
  types.ts        # schema 与绘制契约
  registry.ts     # 注册表：内置（import.meta.glob 静态收集）+ 用户导入（userData）
  drawers/
    imageShape.ts      # 圆角矩形 / 圆形 / 贴纸 的绘制
    particleWaveform.ts  # 粒子波形（波形线+频谱副线+喷射粒子）
```

内置预设通过 `import.meta.glob('../../../../presets/**/preset.json', { eager: true })` 在**构建时静态引入**
→ 参与打包（不是运行时读磁盘）；模块加载即注册，Worker 里同样可用。

## 2. `preset.json`（声明式）

```jsonc
{
  "format": "avnpreset", "version": 1,
  "id": "circle",                 // 唯一 id（也用于 .avnpre 安装目录名）
  "name": "圆形",
  "category": "image",            // 效果面板分类：visualization | image
  "clipType": "image",            // 生成的 clip 类型：image（需素材）| visual（生成式）
  "kind": "image",                // 拖拽落轨类型（决定落到视频区/音频区）
  "drawer": "image-shape",        // 内置绘制器 id（见 drawers/）
  "durationFrames": 150,
  "desc": "…",
  "params": [                     // 检查器 UI 由这份 schema 自动生成
    { "key": "radius", "label": "圆角大小", "type": "number", "group": "形状",
      "min": 0, "max": 0.5, "step": 0.005, "default": 0.08, "percent": true },
    { "key": "scaleY", "label": "缩放 Y", "type": "number", "min": 0.1, "max": 4,
      "step": 0.01, "default": 1, "link": "scaleX" },     // link → 检查器显示 🔗 关联按钮
    { "key": "color", "label": "主色", "type": "color", "default": "#3fe0ff" },
    { "key": "borderTexture", "label": "边框纹理", "type": "image", "default": "" },
    { "key": "spinImage", "label": "图片随框旋转", "type": "bool", "default": false }
  ]
}
```

参数类型：`number`（滑块+输入框，`percent` 以 % 显示）、`color`、`bool`、`select`、`image`（引用素材库图片）。
`group` 相同者归入同一节；`link` 让某参数跟随另一参数（当前用于缩放 X/Y 关联）。

## 3. 实现从哪来（内置 drawer / 第三方脚本）

预设的**实现**有两条来源，`registry.drawerFor()` 统一解析（脚本优先，其次内置 drawer）：

| 来源 | 字段 | 谁在用 | 安全性 |
|---|---|---|---|
| 内置绘制器 | `"drawer": "particle-waveform"` | 随 app 编译的 `presets/drawers/*.ts` | 安全默认（纯数据） |
| **预设自带脚本** | `implementation: { type:'script', source:'…js…' }` | `.avnpre` 导入的第三方预设 | ⚠ 以渲染进程权限运行，导入需用户确认 |

### 脚本契约（`.avnpre` 携带的实现）

脚本**正文即绘制体**，作用域内提供 `ctx / env / params / meta / api`：

```js
// render.js —— 第三方预设的实现示例
const tRel = env.tRel || 0
const r = api.paramAt(params, env.keyframes, 'radius', tRel, 40)   // ← 关键帧优先
ctx.save()
ctx.globalAlpha = env.opacity
ctx.strokeStyle = api.hexWithAlpha(params.color || '#3fe0ff', 0.9)
ctx.lineWidth = 3
ctx.beginPath()
for (let x = 0; x <= env.width; x += 4) {
  const y = env.height / 2 + api.waveValue(env.audio, env.frame, x / env.width) * r
  ctx.lineTo(x, y)
}
ctx.stroke()
ctx.restore()
```

`api` 白名单（`registry.PRESET_SCRIPT_API`）：
- **关键帧**：`paramAt` / `evaluateKeyframes` / `setKeyframe` / `removeKeyframeNear`
- **逐帧取样**：`waveValue` / `freqValue` / `levelAt` / `onsetAt` / `isBeatFrame` / `birthFrameOf` / `WAVE_SAMPLES` / `FREQ_BINS`
- **音频算法库**：`api.dsp.*`（FFT / 幅度谱 / 频段 / 波形峰值 / 包络 / 起音 / 节拍 —— 见 docs/audio-algorithms.md）
- **工具**：`mixColor` / `clamp` / `lerp` / `hash` / `hexWithAlpha`

**导入流程（含脚本确认）**：`文件 → 导入预设…` → 主进程 `inspectAvnpreFile` 先解码 →
若 `implementation.type==='script'` 弹**确认框**（说明将以本应用权限运行、仅导入信任来源）→
用户同意才 `importAvnpreFile` 安装到 `<userData>/presets/<id>/`（`preset.json` 内含 `script` 字段）→
注册表 `compileScript()` 用 `new Function` 编译并缓存。

> 安全边界要诚实：脚本运行在渲染进程内，拿到的是受控参数与白名单 api，但**不是真正的沙箱**
> （无法在进程内彻底隔离 JS）。这与 VS Code 扩展的信任模型一致：安装即信任。
> 只做参数定制、不写代码的预设（引用内置 drawer）永远是安全默认。

## 4. 关键帧（内置能力，对外暴露 API）

`src/renderer/src/presets/keyframes.ts`：`clip.keyframes[参数键] = [{ t, v }]`，`t` 为 **clip 内相对时长 0..1**
（拖动/缩放 clip 时关键帧自动跟随）。

| API | 用途 |
|---|---|
| `paramAt(params, keyframes, key, tRel, fallback)` | **预设取值入口**（关键帧优先 → 静态参数 → schema 默认值） |
| `evaluateKeyframes(track, tRel)` | 单轨线性插值（端点夹取、不外推） |
| `setKeyframe` / `removeKeyframeNear` / `hasKeyframeNear` | 编辑（不可变，返回新数组） |
| `isValidKeyframes` | 结构校验（导入/加载时防御） |

预设里给参数加 `"keyframe": true` → 检查器出现 ◆/◇ 打点按钮（播放头处增删关键帧），
滑块显示的是**该时刻的插值结果**。预览与导出共用同一份求值逻辑 → 关键帧动画逐帧一致。

## 5. drawer 契约

```ts
type PresetDrawer = (ctx: PresetCtx, env: PresetRenderEnv, params: Record<string, unknown>, meta: PresetMeta) => void
```

`env` 提供：画布尺寸、帧/秒、`sourceFrame`、**音频能量 `energy`（0..1）与逐帧分析数据 `audio`**、
层透明度、绑定的图片 `image`、参数引用的图片 `images`、预设自带资源 `assets`。

约定：
- **只画自己的内容**，不负责层级/透明度叠加（层透明度由调用方乘）。
- **必须确定性**：同一 `(params, timeSec, audio)` 在任何环境给出同一像素
  （粒子用固定种子 hash + `spawnPrefix` 反查出生帧）。
- 只能用 Canvas2D API（`OffscreenCanvasRenderingContext2D` 兼容子集）。

## 6. 新增一个样式的步骤

1. 建目录 `presets/<分类>/<id>/preset.json`，写元数据 + 参数 schema。
2. 若形状与现有 drawer 不同，在 `src/renderer/src/presets/drawers/` 加一个函数，
   并在 `registry.ts` 的 `DRAWERS` 里登记 id。
3. 完成——效果面板、检查器控件、预览与导出全部自动生效。

## 7. 音频分析数据（可视化驱动信号）

`src/renderer/src/media/audioAnalysis.ts`：主线程离线渲染一次混音 → `analyzePcm` 算出**逐帧**数据：

| 字段 | 含义 |
|---|---|
| `wave[frame*512 + i]` | 该帧波形快照（-1..1）；主波形线按 `x/W` 取样 |
| `freq[frame*256 + i]` | 该帧频谱（对数频段 30Hz..16kHz，逐段按整轨峰值归一化 0..1） |
| `level[frame]` | 整帧电平（RMS + 对数压缩 0..1） |
| `spawnPrefix[frame]` | 到该帧累计发射粒子数（每帧 `max(1, round(level*6))`）→ 粒子出生帧二分反查 |

预览直接用这份数据，导出随消息 transfer 进 Worker —— **同一份数据**，所以粒子出生帧、
波形取样在预览与导出逐帧一致（确定性）。

> 内存量级：3.5 分钟 @30fps ≈ 6300 帧 → wave 12.9MB + freq 6.5MB + level/prefix 各 25KB。

## 8. `.avnpre` 预设包

### 格式（UTF-8 JSON）

```jsonc
{
  "format": "avnpre", "version": 1,
  "createdBy": "AudioVizNext", "createdAt": "…",
  "preset": { …与 preset.json 同构… },
  "assets": [ { "key": "border", "name": "border.png", "mime": "image/png", "data": "<base64>" } ]
}
```

### 安全模型（重要）

`.avnpre` **只携带声明、参数与资源，绝不携带可执行代码**。绘制逻辑一律来自内置 drawer，
`preset.drawer` 必须在白名单内（`src/shared/avnpre.ts` 的 `KNOWN_DRAWERS`），否则导入被拒绝；
另外强制：`id` 只允许 `[A-Za-z0-9-_]`（防路径穿越）、参数类型白名单、资源总量 ≤ 8MB。

### 导入流程

`文件 → 导入预设…(.avnpre)` → 主进程 `dialog.showOpenDialog` → `decodeAvnpre`（严格校验）→
安装到 `<userData>/presets/<id>/`（`preset.json` + `assets/`）→ 渲染层 `initPresetRegistry()` 刷新 →
效果面板立刻出现该预设（检查器标注「（导入的预设）」）。

### 编解码实现

`src/shared/avnpre.ts`（不依赖 DOM/Node，主进程与渲染层共用）：
`encodeAvnpre` / `decodeAvnpre` / `bytesToBase64` / `base64ToBytes`。
单测：`test/avnpre.test.mjs`（往返一致性 + 12 项防御性校验），`npm test` 覆盖。
