# 第三方样式制作指南

> 目标：让你（或第三方）做出一个可分发、可导入的**可视化/图片/效果样式**，并保证
> **预览与导出逐帧一致**。全流程不需要改动本仓库的任何 UI 或渲染代码。

---

## 0. 30 秒速览

```
presets/<分类>/<id>/preset.json      ← 声明：元数据 + 参数 schema + 用哪个实现
```
实现二选一：
- `"drawer": "内置绘制器 id"` —— 只做参数定制（**零代码，最安全**）；
- `implementation: { type:'script', source:'…js…' }` —— 自带绘制脚本（**需要用户确认后运行**）。

打包成 `.avnpre` 分发给别人 → 对方 `文件 → 导入预设…` 即可。

---

## 1. 目录与分类

```
presets/
  visualizations/<id>/preset.json     可视化（无素材，生成式）
  images/<id>/preset.json             图片样式（需绑定图片素材）
  effects/<id>/preset.json            效果（调整层，作用于其下已合成画面）
```

三个字段共同决定它落在哪：
| 字段 | 取值 | 含义 |
|---|---|---|
| `category` | `visualization` / `image` / `effect` | 效果面板里的分类 |
| `clipType` | `visual` / `image` / `effect` | 生成的 clip 类型 |
| `kind` | `visual` / `image` | 拖拽落轨的类型（决定落到视频区还是音频区） |

---

## 2. `preset.json` 完整字段

```jsonc
{
  "format": "avnpreset",          // 必填，固定值
  "version": 1,                    // 必填
  "id": "my-style",                // 必填，[A-Za-z0-9-_]，也是 .avnpre 安装目录名
  "name": "我的样式",               // 必填，面板显示名
  "category": "visualization",
  "clipType": "visual",
  "kind": "visual",
  "drawer": "particle-waveform",   // 引用内置绘制器（或改用 implementation）
  "durationFrames": 300,           // 拖到时间轴的默认时长
  "color": "#1f6f8b",              // 面板色块
  "desc": "一句话说明",
  "adjust": false,                 // true = 调整层（作用于其下画面）
  "adjustKind": "blur",            // 调整层类型（预览端据此用 GPU 实现；可选）
  "params": [ /* 见下 */ ],
  "assets": [ { "key": "border", "path": "border.png", "mime": "image/png" } ]
}
```

### 参数 schema

检查器 UI **完全由它生成**（滑块/颜色/开关/下拉/图片引用 + 分组 + 关联按钮 + 关键帧按钮）。

| 字段 | 适用类型 | 说明 |
|---|---|---|
| `key` / `label` | 全部 | 参数键（存进 `clip.params`）/ 显示名 |
| `group` | 全部 | 分节标题（同名归入一节） |
| `type` | 全部 | `number` \| `color` \| `bool` \| `select` \| `image` |
| `min` / `max` / `step` / `default` | number | 取值范围与默认值（**drawer 缺参数时用它兜底**） |
| `percent` | number | 以 % 显示（内部仍存 0..1） |
| `unit` | number | 单位后缀（px / ° / 圈/秒…） |
| `keyframe` | number | **true = 支持关键帧**（出现 ◆/◇ 打点按钮） |
| `link` | number | 关联到另一个参数键（如缩放 Y 跟随 X，显示 🔗） |
| `options` | select | `[{ "value": "...", "label": "..." }]` |

示例：
```jsonc
"params": [
  { "key": "radius", "label": "模糊半径", "type": "number", "group": "模糊",
    "min": 0, "max": 160, "step": 1, "default": 24, "unit": "px", "keyframe": true },
  { "key": "color",  "label": "主色", "type": "color", "group": "粒子", "default": "#3fe0ff" },
  { "key": "spin",   "label": "旋转速度", "type": "number", "group": "动画",
    "min": -1, "max": 1, "step": 0.01, "default": 0.05, "unit": "圈/秒" }
]
```

---

## 3. 写实现

### 3.1 契约

```ts
type PresetDrawer = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
                    env: PresetRenderEnv,
                    params: Record<string, unknown>,
                    meta: PresetMeta) => void
```

`env` 提供（**预览与导出是同一份语义**）：

| 字段 | 说明 |
|---|---|
| `width` / `height` | 输出画布尺寸（= 工程 stage） |
| `frame` / `fps` / `timeSec` | 时间轴帧 / 帧率 / 秒 |
| `sourceFrame` | clip 内源帧 |
| `tRel` | clip 内相对进度 0..1（**关键帧求值用**） |
| `opacity` | 层透明度（**由调用方乘，drawer 不要自己再乘**） |
| `energy` | 当前帧电平 0..1 |
| `audio` | 逐帧分析数据（波形/频谱/电平/起音/节拍），见第 5 节 |
| `keyframes` | 关键帧轨道 |
| `image` | image 类预设绑定的图片（`CanvasImageSource`） |
| `images` | 参数字段引用的图片（key = 参数值 src） |
| `assets` | 预设自带资源 URL（key = asset.key） |

**三条铁律**：
1. 只画自己的内容（层级/透明度由调用方处理）；
2. **必须确定性**：同一 `(params, timeSec, audio, frame)` 在任何环境给出同一像素
   （用 `api.hash(n)` 而非 `Math.random()`）；
3. 只用 Canvas2D API（要兼容 `OffscreenCanvasRenderingContext2D`，导出在 Worker 里跑）。

### 3.2 脚本实现（`.avnpre` 自带代码）

脚本**正文即绘制体**，作用域内是 `ctx / env / params / meta / api`：

```js
// render.js
const tRel = env.tRel || 0
const radius = api.paramAt(params, env.keyframes, 'radius', tRel, 40)   // 关键帧优先
const color = params.color || '#3fe0ff'

ctx.save()
ctx.globalAlpha = env.opacity
ctx.strokeStyle = api.hexWithAlpha(color, 0.9)
ctx.lineWidth = 3
ctx.beginPath()
for (let x = 0; x <= env.width; x += 4) {
  const y = env.height / 2 + api.waveValue(env.audio, env.frame, x / env.width) * radius
  ctx.lineTo(x, y)
}
ctx.stroke()
ctx.restore()
```

打包进 `.avnpre` 时写成：
```jsonc
"implementation": { "type": "script", "source": "<上面的 JS 源码字符串>" }
```

### 3.3 内置 drawer（数据驱动，零代码）

`implementation` 省略时用 `"drawer"` 引用内置绘制器，第三方只提供**参数与默认值**：

| drawer id | 用途 | 关键参数 |
|---|---|---|
| `image-shape` | 图片裁形（圆角矩形 / 圆形 / 贴纸） | `shape`、`radius`、`posX/Y`、`scaleX/Y`、`borderTexture`、`borderWidth`、`spin`、`rotation`、`shadow` |
| `particle-waveform` | 粒子波形（波形线 + 频谱副线 + 喷射粒子） | `amplitude`、`lineGlow`、`particleCount`、`particleGlow`、`gravity` |
| `gaussian-blur` | 高斯模糊（调整层） | `strength`、`radius`、`saturation`、`darken` |

---

## 4. 关键帧（内置 API）

数据：`clip.keyframes[参数键] = [{ t, v }]`，`t` 是 **clip 内相对时长 0..1**（拖动/缩放 clip 时自动跟随）。

| API | 说明 |
|---|---|
| `api.paramAt(params, env.keyframes, key, env.tRel, 默认值)` | **取值入口**：关键帧 → 静态参数 → 默认值 |
| `api.evaluateKeyframes(track, tRel)` | 单轨求值（线性插值、端点夹取） |
| `api.setKeyframe` / `api.removeKeyframeNear` | 编辑（不可变） |

参数 schema 里给 `"keyframe": true`，检查器就会出现 ◆/◇ 按钮，滑块显示**当前播放头时刻的插值结果**。

---

## 5. 音频 API（避免重复造轮子）

逐帧取样（O(1)，`env.audio` 已按帧打包好）：
```js
api.waveValue(env.audio, env.frame, t)          // 波形样本 -1..1（t∈[0,1]）
api.freqValue(env.audio, env.frame, i, n, 1.3)  // 频谱幅度（对数频段，低端增益）
api.levelAt(env.audio, env.frame)               // 电平 0..1
api.onsetAt(env.audio, env.frame)               // 起音强度 0..1（重音/打击处峰值）
api.isBeatFrame(env.audio, env.frame, 2)        // 是否节拍点（拍点脉冲/吸附）
api.birthFrameOf(env.audio, p, env.frame)       // 粒子出生帧反查
env.audio.bpm / .bpmConfidence / .beats
```

通用算法（FFT/频谱/波形/包络/节拍）在 `api.dsp.*`：
```js
const peaks = api.dsp.waveformPeaks(samples, 400)   // {min,max,rms}
const spec  = api.dsp.magnitudeSpectrum(slice, 1024)
const beat  = api.dsp.estimateBeats(env.audio.level, env.fps)
```
→ 完整清单与示例见 [`audio-algorithms.md`](./audio-algorithms.md)

---

## 6. 调整层（作用于其下画面）

```jsonc
"category": "effect", "clipType": "effect", "adjust": true, "adjustKind": "blur"
```
- **导出**：drawer 直接对"当前画布已有的合成结果"做处理（如 `ctx.filter='blur(Npx)'` 叠回）；
- **预览**：Pixi 端按 `adjustKind` 用 GPU 等价实现（`blur` → RenderTexture + BlurFilter）；
  其他 `adjustKind` 目前只在导出生效——**新做调整层时请告知，需要补预览实现**。
- 位置决定影响范围：**轨道越靠上（order 越小）影响越多层**。

---

## 7. 打包 / 分发 / 导入（`.avnpre`）

```jsonc
{
  "format": "avnpre", "version": 1,
  "createdBy": "AudioVizNext", "createdAt": "2026-09-08T…",
  "preset": { …preset.json 的内容（可省略 format/version）… },
  "assets": [ { "key": "border", "name": "border.png", "mime": "image/png", "data": "<base64>" } ]
}
```

导入流程：`文件 → 导入预设…(.avnpre)` → 严格校验（格式/版本/id 合法/drawer 白名单/参数类型/资源 ≤8MB）
→ **含脚本则弹确认框** → 安装到 `<userData>/presets/<id>/` → 立即出现在效果面板（标注「导入的预设」）。

编码/解码参考实现：`src/shared/avnpre.ts`（`encodeAvnpre` / `decodeAvnpre`，无 DOM/Node 依赖）。

### 安全模型（请如实告知你的用户）
- 数据驱动的预设（引用内置 drawer）**没有代码**，随便装；
- 含 `script` 的预设**以渲染进程权限运行**（同 VS Code 扩展信任模型），本程序会在导入时明确警告；
- 这是**信任模型而非真沙箱**——请只分发你愿意让用户信任的脚本。

---

## 8. 从零做一个样式（完整示例：节拍脉冲环）

1) `presets/visualizations/beat-ring/preset.json`
```jsonc
{
  "format": "avnpreset", "version": 1,
  "id": "beat-ring", "name": "节拍脉冲环",
  "category": "visualization", "clipType": "visual", "kind": "visual",
  "durationFrames": 300, "color": "#7a4a9a",
  "desc": "每拍向外脉冲的光环，大小随电平起伏。",
  "params": [
    { "key": "posX", "label": "位置 X", "type": "number", "group": "布局", "min": -0.5, "max": 0.5, "step": 0.005, "default": 0, "percent": true },
    { "key": "posY", "label": "位置 Y", "type": "number", "group": "布局", "min": -0.5, "max": 0.5, "step": 0.005, "default": 0, "percent": true },
    { "key": "baseRadius", "label": "基础半径", "type": "number", "group": "形状", "min": 20, "max": 600, "step": 1, "default": 160, "unit": "px", "keyframe": true },
    { "key": "color", "label": "颜色", "type": "color", "group": "形状", "default": "#a29bfe" },
    { "key": "lineWidth", "label": "线宽", "type": "number", "group": "形状", "min": 1, "max": 30, "step": 1, "default": 6 }
  ],
  "implementation": {
    "type": "script",
    "source": "const tRel = env.tRel || 0\nconst r0 = api.paramAt(params, env.keyframes, 'baseRadius', tRel, 160)\nconst beat = api.isBeatFrame(env.audio, env.frame, 2)\nconst level = api.levelAt(env.audio, env.frame)\nconst cx = env.width / 2 + (params.posX || 0) * env.width\nconst cy = env.height / 2 + (params.posY || 0) * env.height\nctx.save()\nctx.globalAlpha = env.opacity * (beat ? 1 : 0.45)\nctx.strokeStyle = api.hexWithAlpha(params.color || '#a29bfe', 0.9)\nctx.lineWidth = params.lineWidth || 6\nctx.beginPath()\nctx.arc(cx, cy, r0 * (1 + level * 0.35 + (beat ? 0.25 : 0)), 0, Math.PI * 2)\nctx.stroke()\nctx.restore()"
  }
}
```
2) 打包 `.avnpre`（把 `preset` 换成上面的内容）→ 导入 → 拖到时间轴即可。
3) 若想内置进本仓库：把脚本落到 `presets/visualizations/beat-ring/render.js`，
   `implementation` 改为 `{ "type": "builtin", "drawer": "…" }` 并在
   `src/renderer/src/presets/drawers/` 加一个 TS 绘制器登记到 `registry.DRAWERS`。

---

## 9. 调试技巧

- **E2E 预览截图**（最有用）：`test/e2e/spec-preview*.json` 跑完会把预览画布存成
  `<out 同目录>/preview-shot.png`，直接看"预览里到底画了什么"。
  ```powershell
  $env:AVS_E2E_SPEC = (Get-Content -Raw -Encoding UTF8 test\e2e\spec-preview-blur2.json)
  node_modules\.bin\electron.cmd .
  ```
- **导出验证**：spec 里加 `frameChecks`（两个时间点的 SSIM）可自动抓"循环/定格/时间轴错位"；
  `[E2E-verify]` 会比对容器包数与解出帧数，防止码流写坏。详见 [`../test/e2e/README.md`](../test/e2e/README.md)。
- 预览必须处于 **Pixi 模式**（右上角「渲染: Pixi」），DOM 兜底不渲染预设/效果层。
