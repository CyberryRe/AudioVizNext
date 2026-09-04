/**
 * layout.ts —— 纯布局数学（预览 PixiRenderer 与 离屏导出渲染器共用）。
 *
 * 目标：把"某帧的某个层（媒体/文本）在 stage 画布上应如何摆放/排版"抽成**纯函数**，
 * 输入是 resolveTimeline 产出的 scene 层 + 工程(project) + 实际素材像素尺寸；
 * 输出是与"节目监视器遮罩窗口看到的那一帧"完全一致的几何/样式描述。
 *
 * 预览与导出都调用这里，从根上保证 `导出 = 预览` 的像素一致，杜绝两处各自排版导致漂移。
 *
 * 语义（你的"相机比喻"）：
 *  - 内容(媒体/歌词)只随 `project.design`（冻结设计基准）与素材自身尺寸/用户缩放排布，
 *    不随 stage 比例二次缩放 —— 切分辨率/比例只是"换个输出窗口"对内容做裁切/留边。
 *  - 媒体固定"铺满画框高"（mediaH = stage.height），宽按源宽高比自然得出，仅水平居中。
 */

import type { Project, LyricStyle } from '../model/timeline'
import { parseLrc, lrcIndexAt, lrcGlide, mixColor, designScreenPx } from '../model/timeline'

/** 卡拉OK滚动窗口：当前行前后各 2 行 */
export const KARAOKE_WINDOW = 2

/**
 * 媒体层几何（由源纹理像素尺寸 + 层 transform + stage 计算）。
 * @param srcW srcH 源纹理实际像素（视频/图片）
 * @param sw / sy 用户 transform.scaleX/scaleY（可为空=1）
 */
export function mediaBox(
  srcW: number,
  srcH: number,
  transform: { scaleX?: number; scaleY?: number; x?: number; y?: number } | undefined,
  stage: { width: number; height: number }
): {
  width: number
  height: number
  anchorX: number
  anchorY: number
  x: number
  y: number
} {
  const sx = transform?.scaleX ?? 1
  const sy = transform?.scaleY ?? 1
  // 铺满画框高 → 高不变、宽随源比例；保证高向永无黑边(不裁高)，窄画框=裁左右、宽画框=留边。
  const scaleH = stage.height / (srcH || 1)
  const w = srcW * scaleH * sx
  const h = stage.height * sy
  // 中心 + 画框内偏移(x/y 为画框宽/高的比例，-0.5..0.5) → stage px
  const x = stage.width / 2 + (transform?.x ?? 0) * stage.width
  const y = stage.height / 2 + (transform?.y ?? 0) * stage.height
  return { width: w, height: h, anchorX: 0.5, anchorY: 0.5, x, y }
}

/** 一行歌词/文本的纯渲染数据（供 Pixi/DOM 任一后端套用，保证字号/颜色/透明度/位置一致） */
export interface TextRowDatum {
  i: number
  text: string
  size: number
  color: string
  weight: number
  opacity: number
  /** 辉光强度 0..1 */
  glow: number
  /** 行内 y 偏移（stage px，相对行容器中心） */
  y: number
}

/** 文本层的排版上下文（position/alpha/rotation + 基础字号基准） */
export interface TextBox {
  /** 行容器中心在 stage 上的位置（px） */
  x: number
  y: number
  opacity: number
  /** 旋转（弧度） */
  rotation: number
  /** 设计框内字号换算到 stage 的基准字号（px） */
  baseFontSize: number
  align: 'left' | 'center' | 'right'
  fontFamily?: string
  lineHeight?: number
  wordWrapWidth: number
  /** 辉光总开关/颜色 */
  glowEnabled: boolean
  glowColor: string
  mainColor: string
}

/** 文本层是否真实滚动歌词（决定 karaoke 渲染 vs 普通单行） */
export function resolveTextRows(
  isLyric: boolean,
  content: string,
  sourceFrame: number,
  fps: number,
  lyrics: LyricStyle | undefined,
  project: Project
): { text: TextBox; rows: TextRowDatum[] } {
  const designH = project.design?.height || project.stage.height
  const designW = project.design?.width || project.stage.width
  const designScale = project.stage.height / designH
  const authoredBase = (lyrics?.fontSize ?? 48) * (lyrics?.scale ?? 1)
  // 字号以「冻结的 design.height」为分母归一化到 stage 像素 → 同比例切分辨率不改屏上大小
  const baseFontSize = designScreenPx(authoredBase, designH, project.stage.height)
  const align = lyrics?.align ?? 'center'
  const glowEnabled = lyrics?.glowEnabled ?? true
  const glowColor = lyrics?.glowColor ?? '#00e5ff'
  const mainColor = lyrics?.color ?? '#ffffff'
  const fontFamily = lyrics?.fontFamily
  const lineHeight = lyrics?.lineHeight
  // 换行宽度：设计框宽在 stage 空间的等值 * 0.9（同比例时恰等于 stage.width*0.9）
  const wordWrapWidth = designW * designScale * 0.9

  // 位置：design 画框中心 + 偏移(x/y 为 design 宽/高比例)，再整体按 designScale 落 stage 画布中心
  const x = project.stage.width / 2 + (lyrics?.x ?? 0) * designW * designScale
  const y = project.stage.height / 2 + (lyrics?.y ?? 0) * designH * designScale
  const rotation = ((lyrics?.rotateZ ?? 0) * Math.PI) / 180

  let rows: TextRowDatum[] = []

  if (isLyric) {
    const lines = parseLrc(content)
    const sec = sourceFrame / fps
    const pos = lrcGlide(lines, sec)
    const cur = lrcIndexAt(lines, sec)
    if (lines.length > 0 && cur >= 0) {
      const glide = Math.max(0, Math.min(1, pos - cur))
      const highlightScale = 1.2
      const dimColor = 'rgba(255,255,255,0.45)'
      const spacing = baseFontSize * 1.6
      const start = Math.max(0, cur - KARAOKE_WINDOW)
      const end = Math.min(lines.length - 1, cur + KARAOKE_WINDOW)
      for (let i = start; i <= end; i++) {
        const line = lines[i]
        const t = Math.max(0, 1 - Math.abs(i - pos))
        const isCurrent = i === cur
        const isIncoming = i === cur + 1 && glide > 0
        const hl = isCurrent ? 1 - glide : isIncoming ? glide : 0
        const size = baseFontSize * (0.62 + t * 0.38) * (1 + hl * (highlightScale - 1))
        const y = (i - pos) * spacing
        const color = isCurrent
          ? mixColor(mainColor, dimColor, glide)
          : isIncoming
            ? mixColor(dimColor, mainColor, glide)
            : dimColor
        const weight = t > 0.5 ? 700 : 400
        const opacity = isCurrent ? 1 - 0.75 * glide : isIncoming ? 0.25 + 0.75 * glide : 0.25 + t * 0.25
        const glow = isCurrent || isIncoming ? hl : 0
        rows.push({ i, text: line.text || ' ', size, color, weight, opacity, glow, y })
      }
    }
  } else {
    // 普通文本 clip：单行
    rows.push({
      i: 0,
      text: content || ' ',
      size: baseFontSize,
      color: mainColor,
      weight: 700,
      opacity: 1,
      glow: 1,
      y: 0
    })
  }

  return {
    text: {
      x,
      y,
      opacity: 1, // 层整体透明度由调用方(层 opacity)乘到容器上
      rotation,
      baseFontSize,
      align,
      fontFamily,
      lineHeight,
      wordWrapWidth,
      glowEnabled,
      glowColor,
      mainColor
    },
    rows
  }
}

/** 辉光半径（对齐 DOM 两圈大辉光的折中） */
export function glowRadius(size: number): number {
  return Math.max(4, size * 0.45)
}
