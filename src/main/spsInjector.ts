// H.264 SPS VUI timing 注入器（移植自旧项目 AudioViz Studio，逐行等价）。
// 背景：WebCodecs/NVENC 的 SPS 不含 VUI timing_info（timing_info_present_flag=0），
// 而 ffmpeg 的 h264 parser 只在 SPS 带 VUI timing 时才生成 pts → 全部包 NOPTS →
// mp4/mpegts muxer 的 interleave 时间戳推理错误，只写前 ~50 帧就停。
// libx264 流自带 timing_info（time_scale=2×fps），所以正常。
// 修法：对每个 keyframe chunk 里的 SPS NAL 做位级解析，把 timing_info_present_flag
// 置 1 并插入 num_units_in_tick=1 / time_scale=2×fps / fixed_frame_rate_flag=1。

interface Nal { start: number; end: number; scLen: number; header: number }

// 在 annexb 字节流中扫描 NAL
function scanNals(buf: Buffer): Nal[] {
  const nals: Nal[] = []
  let i = 0
  while (i < buf.length - 3) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      nals.push({ start: i + 3, scLen: 3, end: 0, header: 0 })
      i += 3
    } else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
      nals.push({ start: i + 4, scLen: 4, end: 0, header: 0 })
      i += 4
    } else i++
  }
  for (let n = 0; n < nals.length; n++) {
    nals[n].end = n < nals.length - 1 ? nals[n + 1].start - nals[n + 1].scLen : buf.length
    nals[n].header = buf[nals[n].start]
  }
  return nals
}

// 位读取器（MSB first），自动跳过 emulation prevention bytes
class BitReader {
  private bytePos = 0
  private bitPos = 0
  private zeroRun = 0
  totalBits = 0
  private cur: number | null = 0
  constructor(private b: Uint8Array) {}

  private nextByte(): number | null {
    while (true) {
      if (this.bytePos >= this.b.length) return null
      const c = this.b[this.bytePos++]
      if (this.zeroRun >= 2 && c === 0x03) { this.zeroRun = 0; continue } // EPB 跳过
      this.zeroRun = c === 0 ? this.zeroRun + 1 : 0
      return c
    }
  }

  readBit(): number | null {
    if (this.bitPos === 0) {
      this.cur = this.nextByte()
      if (this.cur === null) return null
    }
    const v = (this.cur! >> (7 - this.bitPos)) & 1
    this.bitPos = (this.bitPos + 1) & 7
    this.totalBits++
    return v
  }

  readBits(n: number): number | null {
    let v = 0
    for (let i = 0; i < n; i++) {
      const b = this.readBit()
      if (b === null) return null
      v = (v << 1) | b
    }
    return v
  }

  readUe(): number | null {
    let zeros = 0
    while (true) {
      const b = this.readBit()
      if (b === null) return null
      if (b === 1) break
      zeros++
    }
    if (zeros === 0) return 0
    const suffix = this.readBits(zeros)
    if (suffix === null) return null
    return (1 << zeros) - 1 + suffix
  }

  readSe(): number | null {
    const u = this.readUe()
    if (u === null) return null
    const sign = u & 1
    const abs = (u + 1) >> 1
    return sign ? -abs : abs
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135])

// 解析 SPS 到 VUI timing_info_present_flag；失败返回 null
function parseSpsToTiming(rbsp: Uint8Array): { timing: number; bitOffset: number } | null {
  const r = new BitReader(rbsp)
  const profile = r.readBits(8)
  if (profile === null) return null
  r.readBits(8) // constraint flags + reserved
  r.readBits(8) // level_idc
  if (r.readUe() === null) return null // seq_parameter_set_id
  let chromaFormat = 1
  if (HIGH_PROFILES.has(profile)) {
    const cf = r.readUe() // chroma_format_idc
    if (cf === null) return null
    chromaFormat = cf
    if (chromaFormat === 3 && r.readBits(1) === null) return null
    if (r.readUe() === null) return null
    if (r.readUe() === null) return null
    if (r.readBits(1) === null) return null
    const scaling = r.readBits(1)
    if (scaling === null) return null
    if (scaling === 1) {
      const groups = chromaFormat === 3 ? 12 : 8
      for (let g = 0; g < groups; g++) {
        const present = r.readBits(1)
        if (present === null) return null
        if (present === 1) {
          const size = g < 6 ? 16 : 64
          for (let k = 0; k < size; k++) if (r.readBits(8) === null) return null
        }
      }
    }
  }
  if (r.readUe() === null) return null
  const pocType = r.readUe()
  if (pocType === null) return null
  if (pocType === 0) {
    if (r.readUe() === null) return null
  } else if (pocType === 1) {
    if (r.readBits(1) === null) return null
    if (r.readSe() === null) return null
    if (r.readSe() === null) return null
    const n = r.readUe()
    if (n === null) return null
    for (let i = 0; i < n; i++) if (r.readSe() === null) return null
  } else if (pocType !== 2) return null
  if (r.readUe() === null) return null
  if (r.readBits(1) === null) return null
  if (r.readUe() === null) return null
  if (r.readUe() === null) return null
  const frameMbs = r.readBits(1)
  if (frameMbs === null) return null
  if (frameMbs === 0 && r.readBits(1) === null) return null
  if (r.readBits(1) === null) return null
  const crop = r.readBits(1)
  if (crop === null) return null
  if (crop === 1) {
    for (let i = 0; i < 4; i++) if (r.readUe() === null) return null
  }
  if (r.readBits(1) === null) return null // vui_parameters_present_flag
  const aspect = r.readBits(1)
  if (aspect === null) return null
  if (aspect === 1) {
    const idc = r.readBits(8)
    if (idc === null) return null
    if (idc === 255) { for (let i = 0; i < 4; i++) if (r.readBits(8) === null) return null }
  }
  const overscan = r.readBits(1)
  if (overscan === null) return null
  if (overscan === 1 && r.readBits(1) === null) return null
  const vst = r.readBits(1)
  if (vst === null) return null
  if (vst === 1) {
    if (r.readBits(3) === null) return null
    if (r.readBits(1) === null) return null
    const cd = r.readBits(1)
    if (cd === null) return null
    if (cd === 1) { for (let i = 0; i < 3; i++) if (r.readBits(8) === null) return null }
  }
  const chromaLoc = r.readBits(1)
  if (chromaLoc === null) return null
  if (chromaLoc === 1) {
    if (r.readUe() === null) return null
    if (r.readUe() === null) return null
  }
  const timing = r.readBits(1)
  if (timing === null) return null
  return { timing, bitOffset: r.totalBits - 1 }
}

// 位写入器（MSB first），自动处理 EPB
class BitWriter {
  private out: number[] = []
  private acc = 0
  private bitCount = 0
  private zeroRun = 0

  writeBit(v: number): void {
    this.acc = (this.acc << 1) | (v & 1)
    this.bitCount++
    if (this.bitCount === 8) {
      this.emitByte(this.acc)
      this.acc = 0
      this.bitCount = 0
    }
  }

  private emitByte(b: number): void {
    if (this.zeroRun >= 2 && b <= 0x03) { this.out.push(0x03); this.zeroRun = 0 }
    this.out.push(b)
    this.zeroRun = b === 0 ? this.zeroRun + 1 : 0
  }

  finish(): Buffer {
    while (this.bitCount > 0) this.writeBit(0)
    return Buffer.from(this.out)
  }
}

// 把一个 chunk（可能含多个 NAL）里的所有 SPS 注入 VUI timing；无 SPS/失败时原样返回
export function injectSpsTiming(buf: Buffer, fps: number): Buffer {
  const nals = scanNals(buf)
  if (!nals.length) return buf
  let out = buf
  let changed = false
  for (let n = nals.length - 1; n >= 0; n--) { // 倒序处理，避免偏移失效
    const nal = nals[n]
    if ((nal.header & 0x1f) !== 7) continue
    const rbsp = buf.subarray(nal.start + 1, nal.end)
    const info = parseSpsToTiming(rbsp)
    if (!info) { console.warn('[spsInjector] SPS 解析失败，跳过注入'); continue }
    if (info.timing === 1) continue
    const bits: number[] = []
    const br = new BitReader(rbsp)
    let b: number | null
    while ((b = br.readBit()) !== null) bits.push(b)
    const at = info.bitOffset + 1
    bits[info.bitOffset] = 1 // timing_info_present_flag = 1
    const insert: number[] = []
    for (let i = 31; i >= 0; i--) insert.push((1 >> i) & 1) // num_units_in_tick = 1
    const ts = fps * 2
    for (let i = 31; i >= 0; i--) insert.push((ts >> i) & 1) // time_scale = 2×fps
    insert.push(1) // fixed_frame_rate_flag
    const newBits = bits.slice(0, at).concat(insert, bits.slice(at))
    const w = new BitWriter()
    for (const bit of newBits) w.writeBit(bit)
    const newRbsp = w.finish()
    const scStart = nal.start - nal.scLen
    out = Buffer.concat([out.subarray(0, scStart), out.subarray(scStart, nal.start + 1), newRbsp, out.subarray(nal.end)])
    changed = true
  }
  return changed ? out : buf
}
