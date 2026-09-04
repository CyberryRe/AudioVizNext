/**
 * esUtils.ts —— 纯函数：H.264 Annex-B 裸流(Elementary Stream)的解析与索引 + WebCodecs 配置推导。
 *
 * 背景（WebCodecs 预解码 / ffmpeg 拆裸流喂解码器，参考 elah/VideoDecoderManager）：
 *  Chromium `VideoDecoder`(WebCodecs) 直接吃 **H.264 Annex-B 字节流**(含 00 00 01 start code
 *  的 ES)，配合一个 codec 串(avc1.xxxxxx)与可选 description(avcC)。我们用主进程 ffmpeg 把
 *  mp4/mov 等容器的视频轨 `-c:v copy -bsf:v h264_mp4toannexb -f h264` 抽成一根 .h264 裸流，
 *  本模块负责在**纯字节**层把这段 ES 索引成"访问单元"表(每帧的字节区间/是否关键帧/时间戳)，
 *  以便：按时间定位需喂给解码器的包、seek 到关键帧、推导 description 与 codec 串。
 *
 * 全部为纯函数、零 DOM/零 Electron 依赖 → 可在纯 Node 单元测试锁定契约
 * （test/esUtils.test.mjs），GUI 只负责把字节交给 VideoDecoder。
 */

/** 一个 H.264 NAL 单元的元数据（不含字节，仅位置信息，避免大拷贝） */
export interface NalRef {
  /** NAL 首字节所在文件偏移（含 start code） */
  offset: number
  /** start code 长度（3 或 4 字节） */
  scLen: number
  /** NAL 载荷首字节(header)偏移 = offset + scLen */
  headerOffset: number
  /** NAL 头字节(即 forbidden_zero_bit/nri/nal_unit_type 所在字节) */
  header: number
  /** NAL 单元类型（header & 0x1f） */
  type: number
  /** 该 NAL 长度（含 start code），到下一 start code 或文件尾 */
  length: number
}

/** 一个访问单元 = 一组 NAL（一个视频帧）。索引时按首个 VCL NAL 归类。 */
export interface AccessUnit {
  /** 该 AU 的起始 NAL 索引（一般为 AUD/分隔符） */
  startNal: number
  /** 该 AU 的起始字节偏移（指向第一个 start code） */
  startOffset: number
  /** 该 AU 的结束字节偏移（半开区间，指向下一 AU 的 startOffset 或文件尾） */
  endOffset: number
  /** 是否关键帧（含一个 IDR 切片 NAL，type 5） */
  isKey: boolean
  /** 是否含 SPS(type7)/PPS(type8)——一般仅在关键帧所在 AU 出现 */
  hasParams: boolean
  /** 该 AU 内首个 VCL 切片的 NAL type（1=非 IDR P/B 切片，5=IDR） */
  vclType: number
}

/** 逐字节扫描全部 NAL 单元（start code 同时兼容 4 字节 00 00 00 01 与 3 字节 00 00 01） */
export function findNals(data: Uint8Array, start = 0, end = data.length): NalRef[] {
  const out: NalRef[] = []
  let i = start
  while (i < end - 3) {
    if (data[i] !== 0 || data[i + 1] !== 0) { i++; continue }
    let scLen = 0
    if (data[i + 2] === 1) scLen = 3
    else if (data[i + 2] === 0 && data[i + 3] === 1) scLen = 4
    else { i++; continue }
    const headerOffset = i + scLen
    if (headerOffset >= end) break
    const header = data[headerOffset]
    out.push({
      offset: i,
      scLen,
      headerOffset,
      header,
      type: header & 0x1f,
      length: 0 // 下方批量补
    })
    i = headerOffset + 1 // 跳到 header 之后，避免重复匹配同一 start code 的子串
  }
  // 补全每个 NAL 的长度（到下一 start code 或文件尾）
  for (let n = 0; n < out.length; n++) {
    out[n].length = (n + 1 < out.length ? out[n + 1].offset : end) - out[n].offset
  }
  return out
}

/** H.264 NAL 单元类型（部分，我们关心的） */
export const NAL = {
  NON_IDR: 1, // 非 IDR 切片
  IDR: 5,     // 关键帧切片
  SPS: 7,
  PPS: 8,
  AUD: 9,     // access unit delimiter
  SEI: 6,
  END_SEQ: 10,
  END_STREAM: 11
} as const

/** VCL 切片类型：type 1..5 为切片（其中 5 是 IDR）；其余为参数/增强数据 */
export function isVclSlice(type: number): boolean {
  return type >= 1 && type <= 5
}

/**
 * 把 NAL 列表按访问单元(AU，即一个视频帧)分组。
 *
 * 分组规则（对齐真实 demuxer 语义）：
 *  - 一个 AU 由若干 NAL 组成，其中**最多一个/一组 VCL 切片**承载该帧像素；
 *    SPS/PPS/SEI/AUD 是非 VCL，出现在 AU 头部（解码器用其完成该帧）。
 *  - 新 AU 的边界 = "当前 AU 已含 VCL，又遇到一个 VCL 切片"（说明进入下一帧）。
 *    因此 **SPS/PPS/SEI/AUD 永不单独开新 AU**，而是并入"尚未含 VCL 的待定 AU"
 *    —— 这样流开头的 `[SPS PPS SEI IDR]` 会合并成**一个**关键帧 AU(AU.isKey=true)，
 *    而不是被 SPS/PPS 各自切开导致 AU#0 丢失关键帧标记（此前的 bug）。
 *
 * 无 AUD 的流（ffmpeg 默认抽出的 libx264 不带 aud=1）与带 AUD 的流都能正确分组；
 * 关键是"首个 AU 含 SPS/PPS + IDR"必须归为关键帧。
 *
 * 返回每个 AU 的 {startNal, startOffset, endOffset, isKey, hasParams, vclType}，
 * AU 个数 == 视频帧数。endOffset 是半开区间（不含下一 AU 的 start code）。
 */
export function indexAccessUnits(nals: NalRef[], totalLen = 0): AccessUnit[] {
  const aus: AccessUnit[] = []
  if (nals.length === 0) return aus

  let cur: { startNal: number; startOffset: number; isKey: boolean; hasParams: boolean; vclType: number; hasVcl: boolean } | null = null

  const flush = (nextNalStart: number): void => {
    if (!cur) return
    aus.push({
      startNal: cur.startNal,
      startOffset: cur.startOffset,
      endOffset: nextNalStart,
      isKey: cur.isKey,
      hasParams: cur.hasParams,
      vclType: cur.vclType
    })
  }

  for (let n = 0; n < nals.length; n++) {
    const nal = nals[n]
    const t = nal.type
    const isVcl = isVclSlice(t)

    // 当前 AU 已含 VCL 且又遇 VCL → 本 AU 结束，新开一帧
    if (cur && cur.hasVcl && isVcl) {
      flush(nal.offset)
      cur = null
    }

    if (!cur) {
      cur = {
        startNal: n,
        startOffset: nal.offset,
        isKey: t === NAL.IDR,
        hasParams: t === NAL.SPS || t === NAL.PPS,
        vclType: isVcl ? t : 0,
        hasVcl: isVcl
      }
    } else {
      if (t === NAL.IDR) cur.isKey = true
      if (t === NAL.SPS || t === NAL.PPS) cur.hasParams = true
      if (isVcl && !cur.vclType) cur.vclType = t
      if (isVcl) cur.hasVcl = true
    }
  }
  if (cur) {
    const last = nals[nals.length - 1]
    const end = totalLen > 0 ? Math.min(totalLen, last.offset + last.length) : last.offset + last.length
    flush(end)
  }
  return aus
}

/**
 * 从 NAL 列表取出首个 SPS(type7) 与 PPS(type8) 的**载荷字节**（不含 NAL header 0x67/0x68）。
 * 返回 { spsBody, ppsBody }，缺失者为 null。
 */
export function extractParamSets(nals: NalRef[], data: Uint8Array): { spsBody: Uint8Array | null; ppsBody: Uint8Array | null } {
  let spsBody: Uint8Array | null = null
  let ppsBody: Uint8Array | null = null
  for (const nal of nals) {
    if (spsBody && ppsBody) break
    if (nal.type === NAL.SPS && !spsBody) spsBody = data.slice(nal.headerOffset + 1, nal.offset + nal.length)
    else if (nal.type === NAL.PPS && !ppsBody) ppsBody = data.slice(nal.headerOffset + 1, nal.offset + nal.length)
  }
  return { spsBody, ppsBody }
}

/**
 * 由 SPS 载荷推导 H.264 profile_idc/constraint/level → 生成 WebCodecs codec 串。
 * SPS 布局（去除 NAL header 后）：profile_idc[1] constraint_flags[1] level_idc[1] ...
 * 例：profile_idc=0x64(High), constraint=0x00, level=0x32(L5.0) → 'avc1.640032'
 */
export function codecStringFromSps(spsBody: Uint8Array | null): string | null {
  if (!spsBody || spsBody.length < 4) return null
  const profile = spsBody[0]
  const constraints = spsBody[1]
  const level = spsBody[2]
  const hex = (n: number): string => n.toString(16).padStart(2, '0')
  return `avc1.${hex(profile)}${hex(constraints)}${hex(level)}`
}

/**
 * 用首个 SPS/PPS 组装 WebCodecs 需要的 `description`（avcC box，不含 lengthSize 描述完整版）。
 * Chromium 对 H.264(avc1) 的 VideoDecoderConfig.description 期望是 avcC（AVCDecoderConfigurationRecord）。
 * 这里构造最小可用记录：configurationVersion=1 + profile/compat/level + 0xfc|0 保留位 + numOfSPS(1) +
 * SPS长度(2B BE) + SPS + numOfPPS(1) + PPS长度(2B BE) + PPS。
 * 注意：lengthSizeMinusOne=3（4 字节 NAL 长度），但我们喂的是 Annex-B（start code），Chromium 会按
 * description 的类型决定；avc1 + 显式 description 时 Chromium 解码器接受 Annex-B 输入并在内部处理。
 * 若无 SPS（某些流在首帧后才有）返回 null → 调用方应退化为"不带 description"配置或等待带 SPS 的包。
 */
export function buildAvcCDescription(spsBody: Uint8Array | null, ppsBody: Uint8Array | null): Uint8Array | null {
  if (!spsBody || !ppsBody) return null
  const sps = spsBody
  const pps = ppsBody
  // 布局写满后的总长：6(头0..5) + 2(sps长度) + sps + 1(numPPS) + 2(pps长度) + pps
  const out = new Uint8Array(6 + 2 + sps.length + 1 + 2 + pps.length)
  let o = 0
  out[o++] = 1 // configurationVersion
  out[o++] = sps[0] ?? 66 // profile_idc
  out[o++] = sps[1] ?? 0 // constraint_set flags
  out[o++] = sps[2] ?? 30 // level_idc
  out[o++] = 0xff // reserved(6bit)+lengthSizeMinusOne(2bit=3) → 0xff 表示 4 字节长度
  out[o++] = 0xe1 // reserved(3bit)+numOfSPS(5bit=1) → 0xe1
  out[o++] = (sps.length >> 8) & 0xff
  out[o++] = sps.length & 0xff
  out.set(sps, o); o += sps.length
  out[o++] = 1 // numOfPPS
  out[o++] = (pps.length >> 8) & 0xff
  out[o++] = pps.length & 0xff
  out.set(pps, o); o += pps.length
  return out
}

/**
 * 从 ES 中定位离 timeFrame 最近的关键帧 AU 索引（<= 目标，即"该帧所在的关键帧锚点"）。
 * 用于 seek：Annex-B 流中解码某帧必须从它依赖的最近 IDR 开始喂。
 * @param aua AU 列表
 * @param auIndexByTime 可按需传 null 则由内部顺序推断（本函数按 AU 顺序线性找）
 * @param targetFrame AU 顺序帧号（0-based）
 */
export function keyframeIndexAtOrBefore(aus: AccessUnit[], targetFrame: number): number {
  let anchor = 0
  for (let i = 0; i < aus.length; i++) {
    if (aus[i].isKey) anchor = i
    if (i >= targetFrame) break
  }
  return Math.min(anchor, Math.max(0, aus.length - 1))
}

/**
 * 把一个 AU 区间切割成「从该区间起始的关键帧锚点」到「区间结束」——即我们要喂给解码器的包范围
 * 的字节切片描述（offset 区间列表）。供渲染层按需 fetch 一段 ES 字节。
 */
export function auSliceOffsets(aus: AccessUnit[], fromAu: number, toAuInclusive: number, totalLen: number): { start: number; end: number } {
  const a = aus[fromAu]
  const b = aus[toAuInclusive]
  if (!a) return { start: 0, end: 0 }
  const end = b ? b.endOffset : totalLen
  return { start: a.startOffset, end }
}
