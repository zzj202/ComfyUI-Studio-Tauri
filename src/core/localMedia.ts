/**
 * 本地媒体文件操作（素材面板 / 本地资产收藏条共用）。
 * 本地路径（asset protocol）的源对 canvas 是跨源的——drawImage 后 toBlob 会抛
 * SecurityError，所以字节必须经 Rust read_local_file 中转拿回，转 blob URL（同源）
 * 后再喂给离屏 img/video 处理。
 */

import { api } from '../api/tauri'

export function b64ToBlobUrl(b64: string, mime: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

/** 扩展名 → MIME（截帧/复制时给 blob 标类型用；解码器按内容嗅探，此处只是标注） */
export function extMime(p: string): string {
  const n = p.split(/[\\/]/).pop() ?? ''
  const i = n.lastIndexOf('.')
  const ext = i >= 0 ? n.slice(i + 1).toLowerCase() : ''
  const table: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
  }
  return table[ext] ?? 'application/octet-stream'
}

/** 画一个 img/video 源到 PNG Blob */
async function toPngBlob(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')?.drawImage(source, 0, 0, w, h)
  return new Promise<Blob>((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片编码失败'))), 'image/png')
  )
}

/** 截取本地视频在 atTime 秒处的帧 → PNG Blob（离屏 video 重演 seek，绕开 canvas 污染） */
export async function captureLocalFrame(path: string, atTime = 0): Promise<Blob> {
  const url = b64ToBlobUrl(await api.readLocalFile(path), extMime(path))
  try {
    const off = document.createElement('video')
    off.muted = true
    off.preload = 'auto'
    off.src = url
    await new Promise<void>((resolve, reject) => {
      off.onloadedmetadata = () => resolve()
      off.onerror = () => reject(new Error('视频加载失败'))
    })
    off.currentTime = Math.min(atTime, off.duration || atTime)
    await new Promise<void>((resolve) => {
      off.onseeked = () => resolve()
      window.setTimeout(resolve, 3000) // seek 事件偶发不触发的兜底
    })
    return await toPngBlob(off, off.videoWidth || 720, off.videoHeight || 1280)
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 把 PNG Blob 写进剪贴板 */
export async function writePngToClipboard(png: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

/** 复制本地图片到剪贴板（统一转 PNG：gif/webp/bmp 都能直接粘贴发送） */
export async function copyLocalImageToClipboard(path: string): Promise<void> {
  const url = b64ToBlobUrl(await api.readLocalFile(path), extMime(path))
  try {
    const img = document.createElement('img')
    img.src = url
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('图片加载失败'))
    })
    const png = await toPngBlob(img, img.naturalWidth, img.naturalHeight)
    await writePngToClipboard(png)
  } finally {
    URL.revokeObjectURL(url)
  }
}
