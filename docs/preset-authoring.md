# 第三方样式制作指南

一个样式 = `presets/<分类>/<id>/preset.json`（声明）+ 一个绘制器（内置 drawer 或随包脚本）。
检查器 UI 由 `params` schema 自动生成，无需改本仓库代码。

## 目录与分类

```
presets/visualizations/<id>/preset.json   可视化（无素材）
presets/images/<id>/preset.json           图片样式（需绑定图片素材）
presets/effects/<id>/preset.json          效果（调整层，作用于其下画面）
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `category` | `visualization` / `image` / `effect` | 效果面板分类 |
| `clipType` | `visual` / `image` / `effect` | 生成的 clip 类型 |
| `kind` | `visual` / `image` | 拖拽落轨类型 |

## preset.json

| 字段 | 必填 | 说明 |
|---|---|---|
| `format` | ✓ | 固定 `"avnpreset"` |
| `version` | ✓ | `1` |
| `id` | ✓ | `[A-Za-z0-9-_]`，也是 `.avnpre` 安装目录名 |
| `name` | ✓ | 面板显示名 |
| `category` / `clipType` / `kind` | ✓ | 见上表 |
| `drawer` | ✓\* | 内置绘制器 id（\*与 `implementation` 二选一） |
| `implementation` | ✓\* | `{ type:'builtin', drawer }` 或 `{ type:'script', source }` |
| `durationFrames` | | 拖到时间轴的默认时长，默认 150 |
| `color` / `desc` | | 面板色块 / 说明 |
| `adjust` / `adjustKind` | | 调整层标记；`adjustKind:'blur'` 时预览端有 GPU 等价实现 |
| `params` | ✓ | 参数 schema，见下 |
| `assets` | | 随包资源 `[{ key, path, mime }]` |

## 参数 schema

| 字段 | 适用 | 说明 |
|---|---|---|
| `key` / `label` | 全部 | 参数键（存入 `clip.params`）/ 显示名 |
| `type` | 全部 | `number` \| `color` \| `bool` \| `select` \| `image` |
| `group` | 全部 | 分组标题 |
| `default` | 全部 | 默认值（drawer 缺参数时兜底） |
| `min` / `max` / `step` | number | 取值范围 |
| `percent` | number | 以 % 显示（内部仍存 0..1） |
| `unit` | number | 单位后缀（px / ° / 圈/秒） |
| `keyframe` | number | `true` = 支持关键帧（检查器出现 ◆/◇） |
| `link` | number | 关联到另一参数键（如缩放 Y 跟随 X） |
| `options` | select | `[{ value, label }]` |
| `default` | image | 素材 src（引用素材库图片） |

```jsonc
"params": [
  { "key": "radius", "label": "模糊半径", "type": "number", "group": "模糊",
    "min": 0, "max": 160, "step": 1, "default": 24, "unit": "px", "keyframe": true },
  { "key": "color", "label": "主色", "type": "color", "group": "粒子", "default": "#3fe0ff" }
]
```

## 绘制器契约

```ts
type PresetDrawer = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
                    env: PresetRenderEnv,
                    params: Record<string, unknown>,
                    meta: PresetMeta) => void
```

`env`：

| 字段 | 说明 |
|---|---|
| `width` / `height` | 输出画布尺寸（= 工程 stage） |
| `frame` / `fps` / `timeSec` | 时间轴帧 / 帧率 / 秒 |
| `sourceFrame` | clip 内源帧 |
| `tRel` | clip 内相对进度 0..1（关键帧求值用） |
| `opacity` | 层透明度（由调用方乘，drawer 不要再乘） |
| `energy` | 当前帧电平 0..1 |
| `audio` | 逐帧音频数据（见下） |
| `keyframes` | 关键帧轨道 |
| `image` | image 类预设绑定的图片（`CanvasImageSource`） |
| `images` | 参数引用的图片（key = 参数值 src） |
| `assets` | 预设自带资源 URL（key = asset.key） |

要求：只画自己的内容；**确定性**（用 `api.hash(n)` 不用 `Math.random()`）；只用 Canvas2D API。

### 脚本实现（`.avnpre` 携带）

脚本正文即绘制体，作用域内为 `ctx / env / params / meta / api`：

```js
const tRel = env.tRel || 0
const radius = api.paramAt(params, env.keyframes, 'radius', tRel, 40)
ctx.save()
ctx.globalAlpha = env.opacity
ctx.strokeStyle = api.hexWithAlpha(params.color || '#3fe0ff', 0.9)
ctx.lineWidth = 3
ctx.beginPath()
for (let x = 0; x <= env.width; x += 4) {
  ctx.lineTo(x, env.height / 2 + api.waveValue(env.audio, env.frame, x / env.width) * radius)
}
ctx.stroke()
ctx.restore()
```

### 内置 drawer（数据驱动，无代码）

| drawer id | 用途 | 主要参数 |
|---|---|---|
| `image-shape` | 图片裁形 | `shape`(`rounded-rect`/`circle`/`sticker`)、`radius`、`posX/posY`、`scaleX/scaleY`、`borderTexture`、`borderWidth`、`spin`、`rotation`、`shadow` |
| `particle-waveform` | 粒子波形 | `amplitude`、`lineGlow`、`particleCount`、`particleGlow`、`gravity` |
| `gaussian-blur` | 高斯模糊（调整层） | `strength`、`radius`、`saturation`、`darken` |

## API（脚本内 `api.*`）

### 关键帧
| 函数 | 说明 |
|---|---|
| `paramAt(params, keyframes, key, tRel, 默认值)` | 取值入口：关键帧 → 静态参数 → 默认值 |
| `evaluateKeyframes(track, tRel)` | 单轨求值（线性插值，端点夹取） |
| `setKeyframe(track, t, v)` / `removeKeyframeNear(track, t)` | 编辑（返回新数组） |

### 音频（`env.audio` 为逐帧数据）
| 函数 | 说明 |
|---|---|
| `waveValue(audio, frame, t)` | 波形样本 -1..1（`t∈[0,1]`） |
| `freqValue(audio, frame, i, n, gamma=1.3)` | 频谱幅度 0..1（对数频段） |
| `levelAt(audio, frame)` | 电平 0..1 |
| `onsetAt(audio, frame)` | 起音强度 0..1 |
| `isBeatFrame(audio, frame, tol=1)` | 是否节拍点 |
| `birthFrameOf(audio, p, uptoFrame)` | 粒子出生帧反查 |
| `audio.bpm` / `.bpmConfidence` / `.beats` | 节拍估计 |
| `api.dsp.*` | 通用算法库（FFT / 波形峰值 / 包络 / 节拍…），见 [audio-algorithms.md](audio-algorithms.md) |

### 工具
`mixColor(c1, c2, k)`、`hexWithAlpha(hex, a)`、`clamp(v, lo, hi)`、`lerp(a, b, t)`、`hash(n)`、`WAVE_SAMPLES`、`FREQ_BINS`

## `.avnpre`

```jsonc
{
  "format": "avnpre", "version": 1,
  "preset": { /* preset.json 内容 */ },
  "assets": [ { "key": "border", "name": "border.png", "mime": "image/png", "data": "<base64>" } ]
}
```

导入：`文件 → 导入预设…(.avnpre)` → 校验（格式 / id / drawer 白名单 / 参数类型 / 资源 ≤8MB）→
含 `script` 时弹确认框 → 安装到 `<userData>/presets/<id>/` → 出现在效果面板。
编码/解码实现：`src/shared/avnpre.ts`（`encodeAvnpre` / `decodeAvnpre`）。

> `script` 以渲染进程权限运行（同 VS Code 扩展信任模型），导入时会警告。
> 只引用内置 drawer 的预设不含代码。

## 最小示例

`presets/visualizations/beat-ring/preset.json`：

```jsonc
{
  "format": "avnpreset", "version": 1,
  "id": "beat-ring", "name": "节拍脉冲环",
  "category": "visualization", "clipType": "visual", "kind": "visual",
  "durationFrames": 300, "color": "#7a4a9a",
  "params": [
    { "key": "posX", "label": "位置 X", "type": "number", "group": "布局", "min": -0.5, "max": 0.5, "step": 0.005, "default": 0, "percent": true },
    { "key": "posY", "label": "位置 Y", "type": "number", "group": "布局", "min": -0.5, "max": 0.5, "step": 0.005, "default": 0, "percent": true },
    { "key": "baseRadius", "label": "基础半径", "type": "number", "group": "形状", "min": 20, "max": 600, "step": 1, "default": 160, "unit": "px", "keyframe": true },
    { "key": "color", "label": "颜色", "type": "color", "group": "形状", "default": "#a29bfe" }
  ],
  "implementation": {
    "type": "script",
    "source": "const r0 = api.paramAt(params, env.keyframes, 'baseRadius', env.tRel || 0, 160)\nconst beat = api.isBeatFrame(env.audio, env.frame, 2)\nconst level = api.levelAt(env.audio, env.frame)\nconst cx = env.width / 2 + (params.posX || 0) * env.width\nconst cy = env.height / 2 + (params.posY || 0) * env.height\nctx.save()\nctx.globalAlpha = env.opacity * (beat ? 1 : 0.45)\nctx.strokeStyle = api.hexWithAlpha(params.color || '#a29bfe', 0.9)\nctx.lineWidth = 6\nctx.beginPath()\nctx.arc(cx, cy, r0 * (1 + level * 0.35 + (beat ? 0.25 : 0)), 0, Math.PI * 2)\nctx.stroke()\nctx.restore()"
  }
}
```

## 调试

```powershell
# 预览截图（渲染完成后存到 out 同目录的 preview-shot.png）
$env:AVS_E2E_SPEC = (Get-Content -Raw -Encoding UTF8 test\e2e\spec-preview-blur2.json)
node_modules\.bin\electron.cmd .
```

- 预览需处于 **Pixi 模式**（右上角「渲染: Pixi」），DOM 兜底不渲染预设/效果层。
- 调整层位置决定影响范围：轨道越靠上（`order` 越小）影响越多层。
