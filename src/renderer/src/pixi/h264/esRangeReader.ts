/**
 * esRangeReader.ts —— 渲染层：经 avn-file:// 自定义协议 + HTTP Range，按需读回临时 ES 字节。
 *
 * WebCodecs 预解码(decoder.ts)需要一个注入式 `EsRangeReader` 按半开区间 [start,end)
 * 读回 H.264 Annex-B 裸流字节。主进程 ffmpeg 抽出的 ES 是本地临时文件，渲染层可经
 * `fetch('avn-file://<path>')` + Range 头读回任意区间（该协议处理器已支持 206 分段）。
 *
 * 仅一个函数 avnRangeReader(esUrl)，纯浏览器环境；可在纯 Node 测试里用内存 reader 替代。
 */

/** ES 字节范围读取器（与 decoder.ts 的 EsRangeReader 对齐） */
export interface EsRangeReader {
  /** 读取 [start, end) 字节（半开），返回 Uint8Array */
  read(start: number, end: number): Promise<Uint8Array>
}

/**
 * 构造基于 avn-file:// 的 Range reader。
 * @param esUrl avn-file:// 开头的 ES 文件 URL（绝对路径已 URI 编码在 host 位）
 */
export function avnRangeReader(esUrl: string): EsRangeReader {
  return {
    async read(start: number, end: number): Promise<Uint8Array> {
      const from = Math.max(0, start)
      const to = Math.max(from, end) // 开区间 end，fetch Range 用闭区间 to-1
      if (to <= from) return new Uint8Array(0)
      const res = await fetch(esUrl, {
        headers: { Range: `bytes=${from}-${to - 1}` }
      })
      if (!res.ok && res.status !== 206) {
        throw new Error(`ES range read failed: HTTP ${res.status}`)
      }
      const buf = await res.arrayBuffer()
      return new Uint8Array(buf)
    }
  }
}
