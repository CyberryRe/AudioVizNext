/**
 * gifDetect.ts —— 判断「素材/clip 指向的是不是 GIF」，供效果控件决定是否显示「GIF 速度」滑杆。
 *
 * 只在**无 DOM 依赖**的前提下做「看名字」的轻量判断；真正的字节嗅探（isGifBytes）在解码路径里做。
 * 之所以不在这里读字节：效果控件是纯 UI，不该拉取网络/磁盘；且 GIF 可能来自远程 URL / blob，
 * 名字判断已能覆盖绝大多数情况（本地拖入的 .gif 文件 + 演示素材 URL）。
 */

/**
 * 名字/URL 是否像 GIF（含 `?`/`#` 查询串与编码路径）。
 * ⚠ 与 PixiRenderer.looksLikeImage 的写法保持一致：avn-file:// 先 decodeURIComponent 再测。
 */
export function looksLikeGifName(src: string | undefined | null): boolean {
  if (!src) return false
  if (src.startsWith('data:image/gif')) return true
  let low = src.toLowerCase()
  if (low.startsWith('avn-file://')) {
    try {
      low = decodeURIComponent(src.slice('avn-file://'.length)).toLowerCase()
    } catch {
      /* 保留原串 */
    }
  }
  return /\.gif(\?|#|$)/.test(low)
}
