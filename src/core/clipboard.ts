/**
 * 剪贴板粘贴辅助：处理「图片」进剪贴板的三种形态。
 *
 * ① 位图（截图工具 / 聊天窗口「复制图片」）—— paste 事件 items 和
 *    navigator.clipboard.read() 都能看到；
 * ② 资源管理器 Ctrl+C 复制的图片文件 —— 部分平台在 paste 事件的 files 里可见；
 * ③ 同样的文件列表（Windows 上是 CF_HDROP）在 WebView 的 clipboard API 里
 *    彻底不可见 —— 这就是以前「复制图片文件粘贴总报剪贴板里没有图片」的根因，
 *    需要走 Rust `clipboard_file_paths` 兜底。
 */

/** 位图 MIME（ComfyUI LoadImage 认的格式） */
export const BITMAP_MIME_RE = /^image\/(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i

/** 图片文件扩展名（过滤资源管理器复制来的文件路径） */
export const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|tiff?)$/i

/** MIME → 存盘扩展名（jpeg 归一成 jpg） */
export function extFromMime(m: string): string {
  const sub = (m.split('/')[1] || 'png').split(';')[0].toLowerCase()
  return sub === 'jpeg' ? 'jpg' : sub || 'png'
}

/** 文件名 → 存盘扩展名 */
export function extFromName(name: string): string {
  const e = (IMG_EXT_RE.exec(name)?.[1] ?? 'png').toLowerCase()
  return e === 'jpeg' ? 'jpg' : e
}

/** File 的落盘扩展名：优先 MIME，其次按文件名猜 */
export function extFromFile(f: File): string {
  return f.type && BITMAP_MIME_RE.test(f.type) ? extFromMime(f.type) : extFromName(f.name)
}

/** 从 paste 事件里取出全部图片文件（files 优先；截图位图通常在 items 里） */
export function filesFromClipboardData(dt: DataTransfer | null): File[] {
  const out = Array.from(dt?.files ?? []).filter(
    (f) => BITMAP_MIME_RE.test(f.type) || IMG_EXT_RE.test(f.name)
  )
  if (out.length) return out
  for (const it of Array.from(dt?.items ?? [])) {
    if (it.kind === 'file' && BITMAP_MIME_RE.test(it.type)) {
      const f = it.getAsFile()
      if (f) out.push(f)
    }
  }
  return out
}
