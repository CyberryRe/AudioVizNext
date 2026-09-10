/**
 * gif.ts —— 纯 GIF 解码器（无 DOM / 无 window 依赖，预览与导出共用）。
 *
 * **为什么自己写**：导出帧循环跑在 Worker 里，不能碰 DOM（`<img>` 播不了 GIF）；
 * 而 `createImageBitmap(blob)` 对 GIF **只取第一帧**。要「导出 ≡ 预览」必须两边用
 * 同一套逐帧解码。GIF87a/89a 格式简单（LZW + 帧合成），自研比引三方库更可控，
 * 也不用在 Worker 里处理第三方打包。
 *
 * **输出**：把每帧**预合成**为完整 RGBA 位图（含 disposal 处理），运行时零额外合成——
 * 这一点很重要：GIF 的 disposal method 决定帧与帧如何叠加，若延迟到渲染时算，
 * 预览与导出容易各写一份而漂移。
 *
 * 支持：GIF87a / GIF89a、局部调色板、透明色索引、disposal 0/1/2/3、交错(interlace)。
 * 不支持（罕见，明确跳过而非崩溃）：多帧之外的异常扩展块按字节跳过。
 */

/** 解出的一帧：完整画布尺寸的 RGBA 数据 */
export interface GifFrame {
  /**
   * RGBA 像素（width*height*4），未涉及的像素 alpha=0。
   * 用 `Uint8ClampedArray<ArrayBuffer>` 标注：可直接喂 `ImageData` 构造器
   * （若标成默认的 ArrayBufferLike，TS 会因子类含 SharedArrayBuffer 而拒绝）。
   */
  data: Uint8ClampedArray<ArrayBuffer>
}

export interface DecodedGif {
  width: number
  height: number
  frames: GifFrame[]
}

/** 解码失败/非 GIF → null（调用方回退为静态首帧） */
export function decodeGif(bytes: Uint8Array): DecodedGif | null {
  try {
    return decodeInternal(bytes)
  } catch {
    return null
  }
}

/** 判断字节流是否为 GIF（魔数 GIF87a / GIF89a） */
export function isGifBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && // G
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x38 // 8
  )
}

function decodeInternal(bytes: Uint8Array): DecodedGif | null {
  let p = 0
  const u8 = (): number => bytes[p++]
  const u16 = (): number => {
    const v = bytes[p] | (bytes[p + 1] << 8)
    p += 2
    return v
  }

  // --- Header ---
  if (!isGifBytes(bytes)) return null
  p = 6 // 跳过 "GIF87a"/"GIF89a"

  const width = u16()
  const height = u16()
  if (width < 1 || height < 1) return null

  const packed = u8()
  const hasGlobalTable = (packed & 0x80) !== 0
  // ⚠ 色表大小 = 2^((packed & 0x07) + 1)，**不是** 0x70 那个「颜色分辨率」字段。
  // 早期误用 colorRes(0x70) 当表大小 → 色表越界读取，非 4/8 项的小色表会崩。
  const tableSizeBits = packed & 0x07
  const bgColorIndex = u8()
  p++ // pixel aspect ratio

  // --- 全局调色板 ---
  let globalPalette: Uint8Array | null = null
  if (hasGlobalTable) {
    const size = 1 << (tableSizeBits + 1)
    globalPalette = bytes.subarray(p, p + size * 3)
    p += size * 3
  }

  // 画布缓冲（RGBA）
  const canvas: Uint8ClampedArray<ArrayBuffer> = new Uint8ClampedArray(width * height * 4)
  const frames: GifFrame[] = []

  // GIF 的 disposal 处理机：preceding 帧如何影响下一帧
  let prevDisposal = 0
  let prevRect: { x: number; y: number; w: number; h: number } | null = null
  // 保存 disposal=3「恢复前一帧」所需的快照
  let savedCanvas: Uint8ClampedArray<ArrayBuffer> | null = null

  const loop = true
  while (loop && p < bytes.length) {
    const block = u8()
    if (block === 0x3b) break // Trailer

    if (block === 0x21) {
      // --- 扩展块 ---
      const label = u8()
      if (label === 0xf9) {
        // Graphic Control Extension
        p++ // block size = 4
        const gce = u8()
        const disposal = (gce & 0x1c) >> 2
        const hasTransparent = (gce & 0x01) !== 0
        const delay = u16()
        const transparentIndex = u8()
        p++ // block terminator

        // 先把「上一帧的 disposal」应用到画布（disposal 决定当前帧开始前的清理方式）
        applyDisposal(canvas, width, height, prevDisposal, prevRect, savedCanvas)

        // 读图像描述符
        const imgSep = u8()
        if (imgSep !== 0x2c) {
          // 不是图像分隔符 → 跳过该扩展剩余（容错）
          continue
        }
        const rx = u16()
        const ry = u16()
        const rw = u16()
        const rh = u16()
        const imgPacked = u8()
        const hasLocalTable = (imgPacked & 0x80) !== 0
        const interlaced = (imgPacked & 0x40) !== 0
        const localTableBits = imgPacked & 0x07

        let palette: Uint8Array | null = globalPalette
        if (hasLocalTable) {
          const size = 1 << (localTableBits + 1)
          palette = bytes.subarray(p, p + size * 3)
          p += size * 3
        }
        if (!palette) continue

        // LZW 压缩数据（子块串联）
        const lzwMinCodeSize = u8()
        const dataParts: Uint8Array[] = []
        for (;;) {
          const size = u8()
          if (size === 0) break
          dataParts.push(bytes.subarray(p, p + size))
          p += size
        }
        const lzwData = concat(dataParts)

        // disposal=3 需要「应用本帧之前」的画布快照
        if (disposal === 3) savedCanvas = canvas.slice()

        const indices = lzwDecode(lzwData, lzwMinCodeSize, rw * rh)
        drawFrame(
          canvas,
          width,
          height,
          rx,
          ry,
          rw,
          rh,
          indices,
          palette,
          transparentIndex,
          hasTransparent,
          interlaced
        )

        // 记录本帧（拷贝当前画布）
        frames.push({ data: canvas.slice() })

        prevDisposal = disposal
        prevRect = { x: rx, y: ry, w: rw, h: rh }
        void delay
        continue
      }

      // 其它扩展（注释/应用/纯文本）：跳过所有子块
      for (;;) {
        const size = u8()
        if (size === 0) break
        p += size
      }
      continue
    }

    if (block === 0x2c) {
      // 无 GCE 的图像块（少见）：直接按 disposal=0 处理
      const rx = u16()
      const ry = u16()
      const rw = u16()
      const rh = u16()
      const imgPacked = u8()
      const hasLocalTable = (imgPacked & 0x80) !== 0
      const interlaced = (imgPacked & 0x40) !== 0
      const localTableBits = imgPacked & 0x07
      let palette: Uint8Array | null = globalPalette
      if (hasLocalTable) {
        const size = 1 << (localTableBits + 1)
        palette = bytes.subarray(p, p + size * 3)
        p += size * 3
      }
      if (!palette) return { width, height, frames }
      const lzwMinCodeSize = u8()
      const dataParts: Uint8Array[] = []
      for (;;) {
        const size = u8()
        if (size === 0) break
        dataParts.push(bytes.subarray(p, p + size))
        p += size
      }
      const indices = lzwDecode(concat(dataParts), lzwMinCodeSize, rw * rh)
      applyDisposal(canvas, width, height, prevDisposal, prevRect, null)
      drawFrame(canvas, width, height, rx, ry, rw, rh, indices, palette, bgColorIndex, false, interlaced)
      frames.push({ data: canvas.slice() })
      prevDisposal = 0
      prevRect = { x: rx, y: ry, w: rw, h: rh }
      continue
    }

    // 未知块：保守中断（避免死循环）
    break
  }

  if (frames.length === 0) return null
  return { width, height, frames }
}

/** 应用上一帧的 disposal 到画布 */
function applyDisposal(
  canvas: Uint8ClampedArray<ArrayBuffer>,
  w: number,
  h: number,
  disposal: number,
  rect: { x: number; y: number; w: number; h: number } | null,
  saved: Uint8ClampedArray<ArrayBuffer> | null
): void {
  if (!rect) return
  if (disposal === 0 || disposal === 1) {
    // 0=未指定, 1=保留：什么都不做（图像保留在画布上）
    return
  }
  if (disposal === 2) {
    // 恢复背景色 → 清透明
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      if (y < 0 || y >= h) continue
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (x < 0 || x >= w) continue
        const i = (y * w + x) * 4
        canvas[i] = 0
        canvas[i + 1] = 0
        canvas[i + 2] = 0
        canvas[i + 3] = 0
      }
    }
    return
  }
  if (disposal === 3 && saved) {
    // 恢复前一帧
    canvas.set(saved)
  }
}

/** 把索引图像绘制到画布（处理透明度 + 交错） */
function drawFrame(
  canvas: Uint8ClampedArray<ArrayBuffer>,
  W: number,
  H: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  indices: Uint8Array,
  palette: Uint8Array,
  transparentIndex: number,
  hasTransparent: boolean,
  interlaced: boolean
): void {
  // 交错行序（interlace pass）
  const rowOrder = interlaced ? interlaceRows(rh) : null
  const srcRows = rowOrder ? rowOrder.length : rh
  // 若 LZW 解出的行数少于 rh（交错特殊），按实际处理的源行映射
  void srcRows

  for (let sy = 0; sy < rh; sy++) {
    // 交错：源第 sy 行 → 目标第 rowOrder[sy] 行
    const dy = rowOrder ? rowOrder[sy] : sy
    if (dy < 0 || dy >= rh) continue
    const y = ry + dy
    if (y < 0 || y >= H) continue
    for (let sx = 0; sx < rw; sx++) {
      const x = rx + sx
      if (x < 0 || x >= W) continue
      const idx = indices[sy * rw + sx]
      if (hasTransparent && idx === transparentIndex) continue // 透明像素保留画布原值
      const pi = idx * 3
      const di = (y * W + x) * 4
      canvas[di] = palette[pi]
      canvas[di + 1] = palette[pi + 1]
      canvas[di + 2] = palette[pi + 2]
      canvas[di + 3] = 255
    }
  }
}

/** 交错 GIF 的行顺序：pass1(每8行) pass2(每8行偏移4) pass3(每4行偏移2) pass4(每2行偏移1) */
function interlaceRows(rh: number): number[] {
  const rows: number[] = []
  const passes = [
    { start: 0, step: 8 },
    { start: 4, step: 8 },
    { start: 2, step: 4 },
    { start: 1, step: 2 }
  ]
  for (const ps of passes) {
    for (let y = ps.start; y < rh; y += ps.step) rows.push(y)
  }
  return rows
}

/** LZW 解码（GIF 变体：LSB-first，clear/end code，可变码长） */
function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  const MAX = 4096
  const out = new Uint8Array(pixelCount)
  if (minCodeSize < 2) minCodeSize = 2
  const clearCode = 1 << minCodeSize
  const endCode = clearCode + 1

  // 字典：prefix + suffix 表（避免构建整串，解码时回溯）
  const prefix = new Int32Array(MAX).fill(-1)
  const suffix = new Uint8Array(MAX)
  const pixelStack = new Uint8Array(MAX + 1)

  let avail = clearCode + 2
  let codeSize = minCodeSize + 1
  let codeMask = (1 << codeSize) - 1

  // 位读取器（LSB first）
  let bitBuf = 0
  let bitCount = 0
  let bytePos = 0
  const readCode = (): number => {
    while (bitCount < codeSize) {
      if (bytePos >= data.length) return endCode
      bitBuf |= data[bytePos++] << bitCount
      bitCount += 8
    }
    const code = bitBuf & codeMask
    bitBuf >>= codeSize
    bitCount -= codeSize
    return code
  }

  // 初始化字典：每个码 = 单像素
  const resetDict = (): void => {
    for (let i = 0; i < clearCode; i++) {
      prefix[i] = -1
      suffix[i] = i
    }
    avail = clearCode + 2
    codeSize = minCodeSize + 1
    codeMask = (1 << codeSize) - 1
  }
  resetDict()

  let outPos = 0
  let top = 0
  let prev = -1

  for (;;) {
    const code = readCode()
    if (code === endCode) break
    if (code === clearCode) {
      resetDict()
      prev = -1
      continue
    }
    let inCode = code
    if (code >= avail) {
      // KwKwK 情况
      if (prev < 0) break
      pixelStack[top++] = firstPixel(prev, prefix, suffix)
      inCode = prev
    }
    // 回溯展开
    let c = inCode
    while (c >= 0 && top < pixelStack.length) {
      pixelStack[top++] = suffix[c]
      c = prefix[c]
    }
    if (top === 0) break
    const first = pixelStack[top - 1]
    // 输出（栈是逆序的）
    for (let i = top - 1; i >= 0; i--) {
      if (outPos < pixelCount) out[outPos++] = pixelStack[i]
    }
    top = 0
    // 添加新字典项
    if (prev >= 0 && avail < MAX) {
      prefix[avail] = prev
      suffix[avail] = first
      avail++
      if ((avail & codeMask) === 0 && avail < MAX) {
        codeSize++
        codeMask = (1 << codeSize) - 1
      }
    }
    prev = code
    if (outPos >= pixelCount) break
  }
  return out
}

/** 回溯取某码对应串的首像素 */
function firstPixel(code: number, prefix: Int32Array, suffix: Uint8Array): number {
  let c = code
  while (prefix[c] >= 0) c = prefix[c]
  return suffix[c]
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/**
 * GIF 帧索引：把 clip 的源帧映射到 GIF 第几帧（**忽略 delay，按帧号直读**）。
 *
 * 语义（用户选定）：GIF 每帧占 `gifFps` 个时间轴帧（默认按 GIF 帧数铺满 clip 时长）；
 * 这里用「源帧 / 每 GIF 帧占用的时间轴帧数」取整。`framesPerGifFrame` 由调用方决定
 * （通常 = 时间轴 fps / gif 标称帧率；简化实现默认 1，即一帧换一帧）。
 */
export function gifFrameIndex(sourceFrame: number, frameCount: number, framesPerGifFrame = 1): number {
  if (frameCount <= 0) return 0
  const per = Math.max(1, Math.floor(framesPerGifFrame))
  const idx = Math.floor(sourceFrame / per)
  return ((idx % frameCount) + frameCount) % frameCount
}
