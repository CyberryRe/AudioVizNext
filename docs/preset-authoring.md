# 第三方效果包编码规范（`.avnpre`）

面向第三方开发者：**只交付一个 `.avnpre` 文件即可扩展可视化**，无需修改 AudioVizNext 源码。

---

## 1. 包格式

`.avnpre` = UTF-8 JSON（扩展名 `.avnpre`）。

```jsonc
{
  "format": "avnpre",          // 必填魔数
  "version": 1,                 // 必填，≤ 宿主 AVNPRE_VERSION
  "createdBy": "your-name",     // 可选
  "createdAt": "2026-09-10T…",  // 可选 ISO 时间
  "preset": { /* 见 §2 */ },
  "assets": [                   // 可选，随包图片等，总大小 ≤ 8MB
    { "key": "border", "name": "border.png", "mime": "image/png", "data": "<base64，无 data: 前缀>" }
  ]
}
```

校验实现：`src/shared/avnpre.ts`（`encodeAvnpre` / `decodeAvnpre`）。

---

## 2. `preset` 声明

| 字段 | 必填 | 说明 |
|---|---|---|
| `format` | ✓ | `"avnpreset"` |
| `version` | ✓ | `1` |
| `id` | ✓ | `^[A-Za-z0-9][A-Za-z0-9-_]{0,63}$`，安装目录名 |
| `name` | ✓ | 面板显示名 |
| `category` | ✓ | `visualization` \| `image` \| `effect` |
| `clipType` | ✓ | `visual` \| `image` \| `effect` |
| `kind` | ✓ | `visual` \| `image`（拖拽落轨） |
| `durationFrames` | | 默认 150 |
| `color` / `desc` | | 面板色块 / 说明 |
| `params` | ✓ | 参数 schema 数组（§3） |
| `implementation` | ✓* | 实现（§4）；与顶层 `drawer` 二选一，**脚本包必须写这里** |
| `drawer` | | 内置绘制器 id，可作为脚本失败回退 |
| `adjust` / `adjustKind` | | 调整层；`adjustKind:"blur"` 预览有 GPU 等价实现 |

---

## 3. 参数 schema（`params[]`）

检查器 UI **完全由 schema 生成**，勿假设宿主写死控件。

| 字段 | 适用 type | 说明 |
|---|---|---|
| `key` | 全部 | 存入 `clip.params`，脚本用 `params[key]` / `api.paramAt(..., key, ...)` |
| `label` | 全部 | 显示名 |
| `type` | 全部 | `number` \| `color` \| `bool` \| `select` \| `image` \| `gradient` |
| `group` | 全部 | 检查器分组标题 |
| `default` | 全部 | 缺参时兜底 |
| `min` / `max` / `step` | number | 数值范围 |
| `percent` | number | UI 按 % 显示，**内部仍存 0..1** |
| `unit` | number | 单位后缀（`px` / `°` / `圈/秒`） |
| `keyframe` | number | `true` = 可打关键帧 |
| `link` | number | 关联参数键（如 `scaleY` → `"scaleX"`） |
| `options` | select | `[{ value, label }]` |
| `default` | gradient | `{ type:"linear"\|"radial", angle, stops:[{t,color}] }` |

**编码约定**

- 数值动画一律用 `keyframe: true` + 运行时 `api.paramAt`，不要自己在脚本里做全局时间轴状态。
- 颜色用 `#rrggbb`；需要透明时用 `api.hexWithAlpha(hex, a)`。
- 布尔开关命名用正向语义（`followCircle`、`mirror`），默认值写清楚。

---

## 4. 实现：`implementation`

### 4.1 脚本（第三方主路径）

```jsonc
"implementation": { "type": "script", "language": "js", "source": "…绘制体 JS…" }
```

- **脚本正文即绘制函数体**，作用域固定为：`ctx` `env` `params` `meta` `api`。
- 宿主用 `new Function` 编译（渲染层 CSP 含 `script-src 'self' 'unsafe-eval'`）。
- 导入时弹窗确认；以渲染进程权限运行（同 VS Code 扩展信任模型）。
- 编译/运行失败 → `meta.scriptError`，效果控件红字显示；导入后立刻 warmup。
- 同 `id` 若存在内置 drawer，脚本失败时自动回退（演示包可兼作兜底）。
- 脚本会注入导出 Worker，保证 **导出 ≡ 预览**。

### 4.2 内置 drawer（可选回退 / 官方）

```jsonc
"implementation": { "type": "builtin", "drawer": "spectrum-bars" }
```

| drawer id | 用途 |
|---|---|
| `image-shape` | 图片裁形（圆 / 圆角 / 贴纸，含黑胶/彩胶边框） |
| `particle-waveform` | 粒子波形 |
| `gaussian-blur` | 高斯模糊调整层 |
| `spectrum-bars` | 横置频谱柱 |
| `radial-bars` | 环形频谱柱（可 `followCircle`） |

未知 drawer 会被导入拒绝。

---

## 5. 绘制契约（脚本与内置 drawer 相同）

```ts
type PresetDrawer = (
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  env: PresetRenderEnv,
  params: Record<string, unknown>,
  meta: PresetMeta
) => void
```

### `env` 字段

| 字段 | 说明 |
|---|---|
| `width` / `height` | 输出画布 = 工程 stage |
| `frame` / `fps` / `timeSec` | 时间轴帧 / 帧率 / 秒 |
| `sourceFrame` | clip 内源帧 |
| `tRel` | clip 内相对进度 0..1（关键帧） |
| `opacity` | 层透明度（宿主会乘到精灵上，**drawer 内若再乘请只乘一次**） |
| `energy` | 当前帧电平 0..1 |
| `audio` | 逐帧音频数据（可为 null） |
| `keyframes` | 关键帧轨道 |
| `image` | image 类绑定图 |
| `images` | 参数引用的图片 Map |
| `assets` | 包内资源 URL Map |
| `followCircle` | 同帧圆形图片几何 `{x,y,radius,spinRad,box,layer3d}` 或 null（环形可视化跟随用） |
| `followProject` | **跟随必用**：`(x,y) => {x,y}`，把 stage 坐标投到圆形所贴的那个 3D 面上。圆形没开 3D / 未跟随时为 undefined（退回恒等） |

> **跟随圆形必须逐顶点过 `env.followProject`**：宿主只保证"圆"被正确投影，跟随方（环形柱等）
> 若仍用 `ctx.translate/rotate` 直接画，就会留在画幅平面上 → 看起来"没跟随到同一个面"。
> 直线段在单应性下仍是直线，所以把轮廓的**每个点**投一遍即可（圆角采样点也一样）。

> **贴 3D 面时画布会出血**：层选了 3D 附着面后，宿主给你的画布比画幅更大（覆盖"画幅在该面上的原像"，
> 上限每边 0.5 画幅），并把 `ctx` 平移到画幅原点——你仍按 `env.width/height`（= 画幅）作画，
> 但**画幅之外的笔触不再被裁掉**，会被一起投影到那个面上。所以不要假设"超出画幅一定看不见"。

### 硬性要求

1. **确定性**：同一 `(project, frame)` 必须画出相同结果。禁止 `Math.random()`、依赖 `Date.now()`；随机用 `api.hash(n)`。
2. **只画自己**：不要 clear 整个画布、不要改全局 transform 不恢复；`save()/restore()` 配对。
3. **仅 Canvas2D**：不碰 DOM、WebGL、`window`、网络、文件系统（`api` 白名单之外的全局视为未定义行为）。
4. **不持久化**：不要往 `params` 外写宿主状态；跨帧状态只能由参数/关键帧表达。
5. **性能**：热路径避免每帧 `new` 大数组/大路径；循环上限与 `env.width` 相关时注意 4K。

---

## 6. 脚本 API（`api.*`）

### 关键帧

| 函数 | 说明 |
|---|---|
| `paramAt(params, keyframes, key, tRel, fallback)` | **优先入口**：关键帧 → 静态参数 → 默认值 |
| `evaluateKeyframes(track, tRel)` | 单轨求值 |
| `setKeyframe` / `removeKeyframeNear` | 编辑（一般由 UI 调用） |

### 音频（配合 `env.audio`）

| 函数 | 说明 |
|---|---|
| `waveValue(audio, frame, t)` | 波形 -1..1，`t∈[0,1]` |
| `freqValue(audio, frame, i, n, gamma=1.3)` | 频谱 0..1，**bin 间已线性插值** |
| `levelAt` / `onsetAt` / `isBeatFrame` | 电平 / 起音 / 节拍 |
| `birthFrameOf(audio, p, uptoFrame)` | 粒子出生帧反查 |
| `api.dsp.*` | 通用 DSP，见 [audio-algorithms.md](audio-algorithms.md) |

### 工具

`mixColor(c1,c2,k)`、`hexWithAlpha(hex,a)`、`clamp`、`lerp`、`hash(n)`、`WAVE_SAMPLES`、`FREQ_BINS`

---

## 7. 最小可运行脚本包

```jsonc
{
  "format": "avnpre",
  "version": 1,
  "preset": {
    "format": "avnpreset",
    "version": 1,
    "id": "hello-wave",
    "name": "示例波形",
    "category": "visualization",
    "clipType": "visual",
    "kind": "visual",
    "durationFrames": 300,
    "params": [
      { "key": "amp", "label": "振幅", "type": "number", "group": "线条",
        "min": 0.1, "max": 1, "step": 0.01, "default": 0.4, "percent": true, "keyframe": true },
      { "key": "color", "label": "颜色", "type": "color", "group": "线条", "default": "#3fe0ff" }
    ],
    "implementation": {
      "type": "script",
      "language": "js",
      "source": "const tRel = env.tRel || 0\nconst amp = api.paramAt(params, env.keyframes, 'amp', tRel, 0.4) * env.height * 0.35\nconst col = params.color || '#3fe0ff'\nctx.save()\nctx.globalAlpha = env.opacity\nctx.strokeStyle = col\nctx.lineWidth = 2.5\nctx.beginPath()\nfor (let x = 0; x <= env.width; x += 4) {\n  ctx.lineTo(x, env.height / 2 + api.waveValue(env.audio, env.frame, x / env.width) * amp)\n}\nctx.stroke()\nctx.restore()"
    }
  }
}
```

仓库内完整示例（`node scripts/make-demo-presets.mjs` 生成）：
- `plugins/spectrum-bars.avnpre` —— **脚本实现**示例（包内自带 JS）  
- `plugins/radial-bars.avnpre` —— **引用内置 drawer** 示例（数据包；声明直接取自内置
  `presets/visualizations/radial-bars/preset.json`，实现随 app 编译 → 内置版与分发包不会漂移）

> `radial-bars`（环形频谱柱）本身已是**内置预设**，不需要导入即可在「可视化」分类里用；
> 上面的 `.avnpre` 只用于把同样的声明分发到别的机器/工程。

---

## 8. 安装与目录

导入：`文件 → 导入预设…(.avnpre)`  

```
<userData>/presets/<id>/preset.json
<userData>/presets/<id>/assets/<name>
```

Windows 示例：`%APPDATA%/audioviznext/presets/<id>/`  

同 `id` 再次导入会覆盖。调试前可手动删除该目录再导入干净包。

---

## 9. 调试清单

1. 导入后看弹窗是否提示脚本编译失败。  
2. 选中 clip → 效果控件是否出现红字「脚本错误：…」。  
3. Console 过滤 `[Preset]`。  
4. 预览必须为 **Pixi** 模式（DOM 兜底不画预设层）。  
5. 无音频时柱状图仍应显示 `minHeight` 底柱；全空白优先查 `ctx.restore` / 异常。  
6. 导出与预览不一致时，确认脚本未使用非确定 API。

```powershell
# E2E 预览截图
$env:AVS_E2E_SPEC = (Get-Content -Raw -Encoding UTF8 test\e2e\spec-preview-blur2.json)
node_modules\.bin\electron.cmd .
```

---

## 10. 版本与兼容

| 项 | 约定 |
|---|---|
| 包 `version` | 当前 `1`；宿主拒绝更高版本 |
| `id` | 全局唯一；发布后勿改 id（等于换包） |
| 破坏性改参 | 换新 `id` 或升 major 并在 `desc` 说明迁移 |
| 资源 | 单包解码后 ≤ 8MB；优先内联绘制，少带位图 |
