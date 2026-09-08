/**
 * export.ts —— 主进程导出相关能力（**已随 mediabunny 管线迁移而大幅瘦身**）。
 *
 * 现状（2026-09-08 起）：导出（解码+编码+MP4 复用）全部在渲染进程的 Worker 里由 mediabunny 完成，
 * 主进程只负责「按偏移写盘」——见 `main/index.ts` 的 `avs:mbBegin/mbWrite/mbEnd`。
 * 因此本文件只剩两件仍然有用的东西：
 *   1) `verifyVideoIntegrity()`：导出产物自检（容器包数 vs 实际解出帧数），E2E 门禁用；
 *   2) `probeHwEncoder()`：ffmpeg 硬件编码器探测——**已不再参与导出**，仅供首选项页展示本机能力。
 *
 * 已删除（历史）：beginVideoEncoding/writeVideoFrame(s)/finishExport/beginAnnexbMux/writeAnnexbChunk
 * （PNG/NV12 逐帧喂 ffmpeg + annexb 复用）—— 它们曾带来缓冲池别名、SPS 注入、逐帧 IPC 等一堆脆弱点。
 */

import { spawn } from 'child_process'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ffmpegPath } from './mediaCache'

export interface ExportResult {
  ok: boolean
  outPath?: string
  frames?: number
  durationSec?: number
  error?: string
}

/**
 * 探测某个 ffmpeg 编码器在本机能否初始化（**仅信息用途**：首选项页展示）。
 * ⚠ 测试分辨率必须用真实尺寸(如 1920×1080)：NVENC 有最小帧尺寸(~145px)，
 *   拿 64×64 去试会报 "Frame Dimension less than minimum" 而被误判成"驱动不支持"。
 */
export function probeHwEncoder(enc: string): Promise<boolean> {
  return new Promise((resolve) => {
    const ff = ffmpegPath()
    if (!ff) return resolve(false)
    const child = spawn(
      ff,
      ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=30:d=0.1', '-frames:v', '1',
        '-c:v', enc, '-pix_fmt', 'yuv420p', '-f', 'null', '-'],
      { windowsHide: true }
    )
    let err = ''
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', () => resolve(false))
    child.on('close', (code) => {
      if (code !== 0) console.warn(`[Export] 编码器 ${enc} 不可用(exit ${code}): ${err.slice(-300)}`)
      resolve(code === 0)
    })
  })
}

/**
 * 比较导出文件两个时间点的画面（SSIM，1.0 = 完全相同）。
 *
 * 用途：验证"时间轴映射"正确性——循环素材的 t 与 t+源时长 必须≈相同；
 * t 与 t+几秒 必须明显不同（画面在动）。曾漏掉的真 bug：循环时间戳用累计偏移而非取模，
 * 第二圈起画面被钳在最后一帧（"只播一次然后定格"），抽帧肉眼看不出来。
 */
export function compareFrames(filePath: string, t1: number, t2: number): Promise<number | null> {
  return new Promise((resolve) => {
    const ff = ffmpegPath()
    if (!ff || !existsSync(filePath)) return resolve(null)
    // 两趟取帧到临时 PNG，再比对：避免"同一文件两个 -ss 输入"在小数时间点上的取帧差异
    const tmpA = join(tmpdir(), `avnssim_a_${process.pid}_${Date.now()}.png`)
    const tmpB = join(tmpdir(), `avnssim_b_${process.pid}_${Date.now()}.png`)
    const cleanup = (): void => {
      for (const p of [tmpA, tmpB]) { try { if (existsSync(p)) unlinkSync(p) } catch { /* 忽略 */ } }
    }
    const grab = (t: number, out: string): Promise<boolean> =>
      new Promise((res) => {
        const c = spawn(ff, ['-y', '-v', 'error', '-ss', String(t), '-i', filePath, '-frames:v', '1', out], { windowsHide: true })
        let e = ''
        c.stderr.on('data', (d: Buffer) => { e += d.toString() })
        c.on('error', () => res(false))
        c.on('close', (code) => {
          if (code !== 0) console.warn(`[Export] 取帧失败 t=${t}: ${e.slice(-200)}`)
          res(code === 0 && existsSync(out))
        })
      })
    void (async () => {
      try {
        if (!(await grab(t1, tmpA)) || !(await grab(t2, tmpB))) return resolve(null)
        const c = spawn(ff, ['-v', 'info', '-i', tmpA, '-i', tmpB, '-lavfi', 'ssim', '-f', 'null', '-'], { windowsHide: true })
        let out = ''
        c.stderr.on('data', (d: Buffer) => { out += d.toString() })
        c.on('error', () => resolve(null))
        c.on('close', () => {
          const m = /All:\s*([0-9.]+)/.exec(out)
          if (!m) console.warn('[Export] SSIM 解析失败:', out.slice(-300))
          cleanup()
          resolve(m ? Number(m[1]) : null)
        })
      } catch {
        cleanup()
        resolve(null)
      }
    })()
  })
}

/**
 * 导出产物自检：用 ffmpeg 解一遍视频轨，比较「容器包数」与「实际解出帧数」。
 * 两者不等 = 码流被写坏（历史上曾因编码器缓冲池复用导致 600 包只解出 409 帧、
 * 画面大面积色块崩坏）。返回 null 表示 ffmpeg 不可用/输出缺失。
 */
export function verifyVideoIntegrity(filePath: string): Promise<{ packets: number; decoded: number; errors: number } | null> {
  return new Promise((resolve) => {
    const ff = ffmpegPath()
    if (!ff || !existsSync(filePath)) return resolve(null)
    const child = spawn(ff, ['-hide_banner', '-v', 'verbose', '-i', filePath, '-map', '0:v', '-f', 'null', '-'], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (d: Buffer) => { err += d.toString() })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      // 形如：Input stream #0:0 (video): 600 packets read (48 bytes); 409 frames decoded; 0 decode errors;
      const m = /(\d+) packets read[^;]*;\s*(\d+) frames decoded;\s*(\d+) decode errors/.exec(err)
      if (!m) return resolve(null)
      resolve({ packets: Number(m[1]), decoded: Number(m[2]), errors: Number(m[3]) })
    })
  })
}
