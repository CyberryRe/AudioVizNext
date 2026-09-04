/**
 * webcodecsEncoder.ts —— 渲染层 WebCodecs H.264 硬件编码（移植自旧项目 ExportCodec，简化版）。
 *
 * 目标：把 Canvas 2D 画好的帧用 VideoEncoder（优先 NVENC）编成 H.264 Annex-B 裸流，
 * 只把小块 chunk 交给主进程 ffmpeg `-c:v copy` 复用，避免逐帧 rawvideo IPC + getImageData 回读。
 * 探测失败（无硬件编码器/不支持）返回 null → 调用方回退 rawvideo + ffmpeg 硬编。
 */

const H264_CANDIDATES = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f']

export interface EncoderConfig {
  codec: string
  width: number
  height: number
  bitrate: number
  framerate: number
}

/** 探测一个可用的 H.264 硬件编码配置；失败返回 null。 */
export async function probeH264Config(
  width: number,
  height: number,
  fps: number,
  bitrate: number
): Promise<EncoderConfig | null> {
  for (const codec of H264_CANDIDATES) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate: fps,
      bitrateMode: 'variable',
      avc: { format: 'annexb' },
      latencyMode: 'realtime'
    }
    try {
      const sup = await VideoEncoder.isConfigSupported(config)
      if (sup?.supported) return { codec, width, height, bitrate, framerate: fps }
      console.warn('[WebCodecsEncoder] 不支持', codec, `${width}x${height}`)
    } catch (e) {
      console.warn('[WebCodecsEncoder] 探测异常', codec, (e as Error)?.message)
    }
  }
  return null
}

type ChunkHandler = (chunks: Uint8Array[]) => void

export class WebCodecsExportEncoder {
  private encoder: VideoEncoder | null = null
  private pending: Uint8Array[] = []
  private freePool: Uint8Array[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private fps = 30

  async init(config: EncoderConfig, onChunk: ChunkHandler, onError: (e: DOMException) => void): Promise<void> {
    this.fps = config.framerate
    this.encoder = new VideoEncoder({
      output: (chunk) => this.handleOutput(chunk, onChunk),
      error: (e) => onError(e)
    })
    this.encoder.configure({
      codec: config.codec,
      width: config.width,
      height: config.height,
      bitrate: config.bitrate,
      framerate: config.framerate,
      bitrateMode: 'variable',
      avc: { format: 'annexb' },
      latencyMode: 'realtime'
    })
  }

  private takeBuf(len: number): Uint8Array {
    // 池缓冲必须 ≥ chunk 长度（关键帧可达数百 KB），否则 copyTo 会抛错丢 chunk
    if (this.freePool.length && this.freePool[this.freePool.length - 1].byteLength >= len) {
      return this.freePool.pop()!
    }
    return new Uint8Array(Math.max(512 * 1024, len))
  }

  private handleOutput(chunk: EncodedVideoChunk, onChunk: ChunkHandler): void {
    const raw = this.takeBuf(chunk.byteLength)
    chunk.copyTo(raw)
    const buf = raw.subarray(0, chunk.byteLength)
    this.pending.push(buf)
    if (this.pending.length >= 128) this.flush(onChunk)
    else if (!this.timer) this.timer = setTimeout(() => this.flush(onChunk), 50)
  }

  private flush(onChunk: ChunkHandler): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.pending.length) return
    const batch = this.pending.splice(0)
    onChunk(batch)
    for (const b of batch) {
      if (this.freePool.length < 32) this.freePool.push(b)
    }
  }

  get encodeQueueSize(): number {
    return this.encoder?.encodeQueueSize ?? 0
  }

  /** 把一帧画布编码（timestampUs 微秒，keyFrame 是否关键帧）。 */
  encode(canvas: OffscreenCanvas | HTMLCanvasElement, timestampUs: number, keyFrame: boolean): void {
    if (!this.encoder) return
    const frame = new VideoFrame(canvas, { timestamp: timestampUs, duration: Math.round(1e6 / this.fps) })
    try {
      this.encoder.encode(frame, { keyFrame })
    } finally {
      frame.close()
    }
  }

  /** 等待背压缓解（encodeQueueSize 降到阈值以下）。 */
  async backpressure(maxQueue = 64): Promise<void> {
    while ((this.encoder?.encodeQueueSize ?? 0) > maxQueue) {
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  /** 排空并关闭。 */
  async close(onChunk: ChunkHandler): Promise<void> {
    if (!this.encoder) return
    try {
      await this.encoder.flush()
    } catch { /* 忽略 flush 异常 */ }
    this.flush(onChunk)
    try { this.encoder.close() } catch { /* 忽略 */ }
    this.encoder = null
  }
}
