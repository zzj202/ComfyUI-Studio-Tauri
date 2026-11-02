/**
 * 漫画工坊核心：把一组图片按顺序合并成竖版长图（手机阅读向）。
 *
 * - 状态（comic.items / comic.settings）持久化到 localStorage，重启恢复；
 * - 位图经 Rust readLocalFile 中转成 Blob 再 createImageBitmap（绕开 asset 协议
 *   跨域对 canvas 的污染），保证 toBlob 导出可用；
 * - 旋转 / 裁切 / 细框 / 间距 / 署名条 / 平铺水印全部在合成时用 canvas 完成，
 *   预览与导出走同一个 renderComic（预览只是目标宽度更小），所见即所得；
 * - renderComic 里的边框/间距/字号等参数都按 scale = targetWidth / settings.width
 *   等比缩放，因此预览和成品版式完全一致。
 */
import { reactive, watch } from 'vue'
import { downloadDir } from '@tauri-apps/api/path'
import { api, saveTempBlob } from '../api/tauri'
import type { Asset } from './types'
import { IMG_EXT_RE } from './clipboard'
import { notify, primaryBase, state } from '../store'

/** 裁切框：旋转后坐标系里的归一化 0-1 矩形 */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ComicItem {
  id: string
  path: string
  name: string
  /** 原始像素尺寸（位图首次加载后回填，仅用于显示与比例分析） */
  w: number
  h: number
  /** 顺时针旋转的 90° 步数（0-3） */
  rotate: number
  crop: CropRect | null
  /** 水平 / 垂直镜像 */
  flipH: boolean
  flipV: boolean
  /** 亮度 / 对比度 / 饱和度（%，100 = 原图） */
  adjust: { bright: number; contrast: number; satur: number }
  /** 透明区域填充底色（null = 不填充） */
  fill: string | null
}

export interface ComicSettings {
  /** 输出长图宽度（px），每张图等比缩放对齐 */
  width: number
  /** 图外相框（框画在图外，占位） / 图内描边（框压在图边缘内侧） */
  frameMode: 'outset' | 'inset'
  borderWidth: number
  borderColor: string
  /** 图与图之间的间距（px，0 = 紧贴条漫） */
  gap: number
  /** 长图四周留白（px） */
  outerMargin: number
  bgColor: string
  /** 每张图的圆角（px，0 = 直角） */
  radius: number
  format: 'jpg' | 'png'
  /** jpg 质量 1-100（png 无效） */
  quality: number
  /** 超过 splitLimit px 自动分成多段导出 */
  splitEnabled: boolean
  /** 分段高度上限（px，1500-30000） */
  splitLimit: number
  signEnabled: boolean
  signText: string
  signBg: string
  signColor: string
  wmEnabled: boolean
  wmText: string
  wmColor: string
  /** 水印不透明度 %（5-60） */
  wmOpacity: number
  /** 水印字号占长图宽度的百分比 */
  wmSize: number
}

export const DEFAULT_SETTINGS: ComicSettings = {
  width: 1080,
  frameMode: 'outset',
  borderWidth: 2,
  borderColor: '#111111',
  gap: 0,
  outerMargin: 0,
  bgColor: '#ffffff',
  radius: 0,
  format: 'jpg',
  quality: 92,
  splitEnabled: false,
  splitLimit: 8000,
  signEnabled: false,
  signText: '',
  signBg: '#111111',
  signColor: '#ffffff',
  wmEnabled: false,
  wmText: '',
  wmColor: '#ffffff',
  wmOpacity: 25,
  wmSize: 5,
}

const ITEMS_KEY = 'comfyui-studio.comic.items:v1'
const SET_KEY = 'comfyui-studio.comic.settings:v1'

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    // 数组类存储（如 items）不能走 {...} 展开——会把数组变成普通对象导致 .map 崩溃
    if (Array.isArray(fallback)) return (Array.isArray(parsed) ? parsed : fallback) as T
    return { ...fallback, ...parsed } as T
  } catch {
    return fallback
  }
}

export const comic = reactive<{
  items: ComicItem[]
  settings: ComicSettings
  busy: boolean
  /** 导出/复制的进度（null = 空闲）；导出按钮与进度条都用它 */
  progress: { done: number; total: number; label: string } | null
}>({
  items: loadJson<ComicItem[]>(ITEMS_KEY, []).map((it) => ({ ...it })),
  settings: loadJson(SET_KEY, { ...DEFAULT_SETTINGS }),
  busy: false,
  progress: null,
})

// ---- 持久化（400ms 防抖）----
let persistTimer: number | null = null
watch(
  comic,
  () => {
    if (persistTimer != null) clearTimeout(persistTimer)
    persistTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(ITEMS_KEY, JSON.stringify(comic.items))
        localStorage.setItem(SET_KEY, JSON.stringify(comic.settings))
      } catch {
        /* 存储满等异常忽略 */
      }
    }, 400)
  },
  { deep: true }
)

// ---------------------------------------------------------------- 位图加载

const bmpCache = new Map<string, ImageBitmap>()

/** 读本地图片 → ImageBitmap（Rust 中转 base64，避免 asset 协议污染 canvas） */
export async function loadBitmap(path: string): Promise<ImageBitmap> {
  const hit = bmpCache.get(path)
  if (hit) return hit
  const b64 = await api.readLocalFile(path)
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  const bmp = await createImageBitmap(new Blob([buf]), { imageOrientation: 'from-image' })
  if (bmpCache.size >= 32) {
    const oldest = bmpCache.keys().next().value
    if (oldest != null) bmpCache.delete(oldest)
  }
  bmpCache.set(path, bmp)
  return bmp
}

// ---------------------------------------------------------------- 列表操作

// ---- 撤销 / 重做（只跟踪条目列表的变更：加图/删除/排序/清空/裁切/旋转）----
const undoStack: string[] = []
const redoStack: string[] = []
let currentSnap = JSON.stringify(comic.items)
let suppressHistory = false

/** 撤销/重做栈深度（reactive，给按钮禁用态用） */
export const comicHistory = reactive({ undo: 0, redo: 0 })

/** 变更前调用：把当前状态压进撤销栈 */
export function pushHistory(): void {
  if (suppressHistory) return
  undoStack.push(currentSnap)
  if (undoStack.length > 50) undoStack.shift()
  redoStack.length = 0
  currentSnap = JSON.stringify(comic.items)
  comicHistory.undo = undoStack.length
  comicHistory.redo = 0
}

/** 拖动排序等「组件内连续变更」结束后调用：只同步快照不入栈 */
export function syncHistory(): void {
  currentSnap = JSON.stringify(comic.items)
}

function applySnap(snap: string): void {
  suppressHistory = true
  try {
    const items = JSON.parse(snap) as ComicItem[]
    comic.items.splice(0, comic.items.length, ...items)
  } finally {
    suppressHistory = false
  }
  currentSnap = snap
  comicHistory.undo = undoStack.length
  comicHistory.redo = redoStack.length
}

export function undoComic(): void {
  const prev = undoStack.pop()
  if (!prev) return
  redoStack.push(currentSnap)
  applySnap(prev)
}

export function redoComic(): void {
  const next = redoStack.pop()
  if (!next) return
  undoStack.push(currentSnap)
  applySnap(next)
}

let seq = 0
function newId(): string {
  return `c${Date.now().toString(36)}-${(seq++).toString(36)}`
}

/** 批量加入本地路径（自动过滤非图片、按路径去重），返回实际新增张数 */
export function addComicPaths(paths: string[]): number {
  const imgs = paths.filter((p) => IMG_EXT_RE.test(p))
  const fresh = imgs.filter((p) => !comic.items.some((it) => it.path === p))
  if (!fresh.length) {
    if (imgs.length) notify('所选图片都已在列表里', 'info', 3000)
    return 0
  }
  pushHistory()
  for (const p of fresh) {
    const name = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
    comic.items.push({
      id: newId(),
      path: p,
      name,
      w: 0,
      h: 0,
      rotate: 0,
      crop: null,
      flipH: false,
      flipV: false,
      adjust: { bright: 100, contrast: 100, satur: 100 },
      fill: null,
    })
  }
  if (fresh.length !== imgs.length) notify(`${imgs.length - fresh.length} 张重复已跳过`, 'info', 3000)
  notify(`已加入 ${fresh.length} 张图片`, 'ok', 2500)
  return fresh.length
}

/** 粘贴/拖入的内存图片 File → 落临时文件 → 加入列表 */
export async function addComicFiles(files: File[]): Promise<void> {
  const paths: string[] = []
  for (const f of files) {
    try {
      const ext = (f.name.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase()
      paths.push(await saveTempBlob(f, ext.replace('.', '')))
    } catch (e) {
      notify(`图片落盘失败：${e}`, 'error', 6000)
    }
  }
  if (paths.length) addComicPaths(paths)
}

/** 出图结果资产拖进来：转存到 assets-tmp 再按本地路径加入 */
export async function addComicAsset(a: Asset): Promise<void> {
  if (a.kind !== 'image') {
    notify('漫画工坊只收图片', 'warn', 3000)
    return
  }
  try {
    const dir = String(await api.appDataDir())
      .replace(/^\\\\\?\\/, '')
      .replace(/[\\/]+$/, '')
    const dest = `${dir}/assets-tmp/comic-${Date.now().toString(36)}-${a.filename}`
    const r = await api.saveOutput(a.base ?? primaryBase(), a.filename, a.subfolder, a.type, dest)
    addComicPaths([r.path])
  } catch (e) {
    notify(`加入失败：${e}`, 'error', 8000)
  }
}

export function removeComicItem(id: string): void {
  const i = comic.items.findIndex((it) => it.id === id)
  if (i >= 0) {
    pushHistory()
    comic.items.splice(i, 1)
    prepCache.delete(id)
  }
}

/** 批量删除（整批算一步撤销） */
export function removeComicItems(ids: string[]): number {
  const set = new Set(ids)
  if (!set.size) return 0
  pushHistory()
  let n = 0
  for (let i = comic.items.length - 1; i >= 0; i--) {
    if (set.has(comic.items[i].id)) {
      prepCache.delete(comic.items[i].id)
      comic.items.splice(i, 1)
      n++
    }
  }
  return n
}

export function moveComic(index: number, delta: number): void {
  const to = index + delta
  if (to < 0 || to >= comic.items.length) return
  pushHistory()
  const [it] = comic.items.splice(index, 1)
  comic.items.splice(to, 0, it)
}

export function clearComic(): void {
  if (!comic.items.length) return
  pushHistory()
  comic.items.splice(0)
  prepCache.clear()
}

// ---------------------------------------------------------------- 排序工具

/**
 * 自然序比较：把字符串切成「数字段 / 非数字段」逐段比。
 * 这样 p2 < p10（而不是字典序的 p10 < p2），也兼容「1-2.png」「第3张」等命名。
 * 非数字段用 localeCompare（中文按拼音），保证中文名排序稳定可读。
 */
export function naturalCompare(a: string, b: string): number {
  const ax = a.match(/\d+|\D+/g) ?? [a]
  const bx = b.match(/\d+|\D+/g) ?? [b]
  const n = Math.min(ax.length, bx.length)
  for (let i = 0; i < n; i++) {
    const x = ax[i]
    const y = bx[i]
    const xd = /^\d+$/.test(x)
    const yd = /^\d+$/.test(y)
    if (xd && yd) {
      const d = Number(x) - Number(y)
      if (d) return d
    } else {
      const d = x.localeCompare(y, 'zh-Hans-CN', { sensitivity: 'base' })
      if (d) return d
    }
  }
  return ax.length - bx.length
}

export type SortMode = 'name' | 'time' | 'random'

/** 重排整个列表（name = 文件名自然序 / time = 文件修改时间正序 / random = 随机）。
 *  只动顺序、不动每张图的编辑参数；整次重排算一步撤销。 */
export async function sortComic(mode: SortMode): Promise<void> {
  const items = comic.items
  if (items.length < 2) return

  if (mode === 'random') {
    pushHistory()
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[items[i], items[j]] = [items[j], items[i]]
    }
    notify('已随机打乱顺序（Ctrl+Z 可撤销）', 'ok', 3000)
    return
  }

  if (mode === 'time') {
    let times: number[] = []
    try {
      times = await api.pathMtimes(items.map((it) => it.path))
    } catch (e) {
      notify(`读取修改时间失败：${e}`, 'error', 6000)
      return
    }
    pushHistory()
    const order = items.map((it, i) => ({ it, t: times[i] || 0, i }))
    // 时间相同（或都取不到）时保持原有相对顺序
    order.sort((a, b) => a.t - b.t || a.i - b.i)
    items.splice(0, items.length, ...order.map((o) => o.it))
    notify('已按文件修改时间排序（旧的在前）', 'ok', 3000)
    return
  }

  pushHistory()
  const sorted = [...items].sort((a, b) => naturalCompare(a.name, b.name))
  items.splice(0, items.length, ...sorted)
  notify('已按文件名自然排序（p2 在 p10 前）', 'ok', 3000)
}

/** 反转当前顺序（倒着看/倒着排都用得上），算一步撤销 */
export function reverseComic(): void {
  if (comic.items.length < 2) return
  pushHistory()
  comic.items.reverse()
  notify('已反转顺序', 'ok', 2500)
}

// ---------------------------------------------------------------- 一键铺满

/** 旋转后的可用宽高 */
function rotSizeOf(it: ComicItem): { w: number; h: number } {
  const swap = it.rotate % 4 === 1 || it.rotate % 4 === 3
  return { w: swap ? it.h : it.w, h: swap ? it.w : it.h }
}

const RATIO_LABELS: [string, number][] = [
  ['1:1', 1],
  ['4:5', 0.8],
  ['3:4', 0.75],
  ['2:3', 0.6667],
  ['9:16', 0.5625],
  ['5:4', 1.25],
  ['4:3', 1.3333],
  ['3:2', 1.5],
  ['16:9', 1.7778],
]

function ratioLabel(r: number): string {
  for (const [label, v] of RATIO_LABELS) {
    if (Math.abs(r - v) / v < 0.02) return label
  }
  return r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`
}

/**
 * 一键铺满：按所有图宽高比的中位数做统一比例，每张居中裁切到位。
 * 比例本来就在中位数 ±1% 内的图不裁（保留原画质）。
 */
export async function applyUniformCrop(): Promise<void> {
  if (!comic.items.length) {
    notify('列表还是空的', 'warn', 2500)
    return
  }
  try {
    for (const it of comic.items) {
      if (it.w > 0) continue
      const bmp = await loadBitmap(it.path)
      it.w = bmp.width
      it.h = bmp.height
    }
  } catch (e) {
    notify(`读取图片失败：${e}`, 'error', 7000)
    return
  }
  const ratios = comic.items
    .map((it) => {
      const s = rotSizeOf(it)
      return s.w > 0 && s.h > 0 ? s.w / s.h : 0
    })
    .filter((r) => r > 0)
    .sort((a, b) => a - b)
  if (!ratios.length) return
  const mid = ratios.length % 2
    ? ratios[(ratios.length - 1) / 2]
    : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2
  pushHistory()
  let applied = 0
  for (const it of comic.items) {
    const s = rotSizeOf(it)
    if (!(s.w > 0 && s.h > 0)) continue
    const r = s.w / s.h
    if (Math.abs(r - mid) / mid < 0.01) {
      it.crop = null
      applied++
      continue
    }
    if (r > mid) {
      // 太宽 → 左右居中裁掉
      const cw = s.h * mid
      it.crop = { x: (s.w - cw) / 2 / s.w, y: 0, w: cw / s.w, h: 1 }
    } else {
      // 太高 → 上下居中裁掉
      const ch = s.w / mid
      it.crop = { x: 0, y: (s.h - ch) / 2 / s.h, w: 1, h: ch / s.h }
    }
    applied++
  }
  notify(`已按约 ${ratioLabel(mid)} 统一居中裁切 ${applied} 张`, 'ok', 6000)
}

// ---------------------------------------------------------------- 渲染引擎

/** 旋转/镜像/调色后的整图缓存（key = item.id，签名变了重建） */
const prepCache = new Map<string, { canvas: HTMLCanvasElement; sig: string }>()

const DEFAULT_ADJ = { bright: 100, contrast: 100, satur: 100 }

function adjOf(it: ComicItem): { bright: number; contrast: number; satur: number } {
  return it.adjust ?? DEFAULT_ADJ
}

function prepSig(it: ComicItem): string {
  const a = adjOf(it)
  return `${it.rotate % 4}|${it.flipH ? 1 : 0}${it.flipV ? 1 : 0}|${a.bright},${a.contrast},${a.satur}|${it.fill ?? ''}`
}

function getPrepared(it: ComicItem, bmp: ImageBitmap): HTMLCanvasElement {
  const sig = prepSig(it)
  const hit = prepCache.get(it.id)
  if (hit && hit.sig === sig) return hit.canvas
  const rot = it.rotate % 4
  const swap = rot % 2 === 1
  const w = swap ? bmp.height : bmp.width
  const h = swap ? bmp.width : bmp.height
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const cx = c.getContext('2d')!
  const a = adjOf(it)
  cx.translate(w / 2, h / 2)
  cx.rotate((rot * 90 * Math.PI) / 180)
  cx.scale(it.flipH ? -1 : 1, it.flipV ? -1 : 1)
  // 透明底填充（画在滤镜外，保持纯色）
  if (it.fill) {
    cx.fillStyle = it.fill
    cx.fillRect(-bmp.width / 2, -bmp.height / 2, bmp.width, bmp.height)
  }
  if (a.bright !== 100 || a.contrast !== 100 || a.satur !== 100) {
    cx.filter = `brightness(${a.bright}%) contrast(${a.contrast}%) saturate(${a.satur}%)`
  }
  cx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2)
  prepCache.set(it.id, { canvas: c, sig })
  if (prepCache.size > 40) {
    const oldest = prepCache.keys().next().value
    if (oldest != null) prepCache.delete(oldest)
  }
  return c
}

function drawWatermark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  o: { text: string; color: string; opacity: number; fontSize: number }
) {
  const text = o.text.trim()
  if (!text) return
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.globalAlpha = Math.min(0.9, Math.max(0.03, o.opacity))
  ctx.fillStyle = o.color
  ctx.font = `600 ${Math.max(8, o.fontSize)}px "Segoe UI", system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  const tw = ctx.measureText(text).width
  const diag = Math.hypot(w, h)
  ctx.translate(x + w / 2, y + h / 2)
  ctx.rotate((-25 * Math.PI) / 180)
  const stepX = tw + o.fontSize * 2.2
  const stepY = o.fontSize * 3.4
  let row = 0
  for (let yy = -diag / 2; yy <= diag / 2; yy += stepY, row++) {
    const off = (row % 2) * stepX * 0.5
    for (let xx = -diag / 2 - off; xx <= diag / 2; xx += stepX) {
      ctx.fillText(text, xx - tw / 2, yy)
    }
  }
  ctx.restore()
}

/**
 * 把 items 按当前设置渲染到 canvas（targetWidth 为本次渲染的实际宽度，
 * 预览传小值、导出传 settings.width，版式一致）。
 * 返回渲染尺寸 + 每块的顶部 y / 占高（供分段导出按块切）；某张图读取失败时 notify 并返回 null。
 */
export async function renderComic(
  canvas: HTMLCanvasElement,
  items: ComicItem[],
  o: ComicSettings,
  targetWidth: number,
  /** 进度回调（已读张数 / 总数）：导出大图时给 UI 报「读取图片 3/12」 */
  onStep?: (done: number, total: number) => void
): Promise<{
  width: number
  height: number
  tops: number[]
  advs: number[]
} | null> {
  if (!items.length) return null
  const bmps: ImageBitmap[] = []
  for (const it of items) {
    try {
      const bmp = await loadBitmap(it.path)
      if (it.w === 0) {
        it.w = bmp.width
        it.h = bmp.height
      }
      bmps.push(bmp)
      onStep?.(bmps.length, items.length)
    } catch (e) {
      notify(`读取图片失败：${it.name}（${e}）`, 'error', 7000)
      return null
    }
  }
  const scale = targetWidth / Math.max(1, o.width)
  const margin = o.outerMargin * scale
  const gap = o.gap * scale
  const bw = Math.max(0, o.borderWidth * scale)
  const imgW = targetWidth - margin * 2 - (o.frameMode === 'outset' ? bw * 2 : 0)
  if (imgW <= 8) {
    notify('宽度/边距设置太大，画面装不下了', 'warn', 4000)
    return null
  }
  const outset = o.frameMode === 'outset'

  const fontSize = Math.max(10, Math.round(targetWidth * 0.032))
  const signText = o.signEnabled ? o.signText.trim() : ''
  const signH = signText ? Math.round(fontSize * 2.2) : 0

  // 布局：先算每块高度
  const blocks: { canvas: HTMLCanvasElement; sx: number; sy: number; sw: number; sh: number; h: number }[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const prep = getPrepared(it, bmps[i])
    const cr = it.crop ?? { x: 0, y: 0, w: 1, h: 1 }
    const sx = cr.x * prep.width
    const sy = cr.y * prep.height
    const sw = Math.max(1, cr.w * prep.width)
    const sh = Math.max(1, cr.h * prep.height)
    blocks.push({ canvas: prep, sx, sy, sw, sh, h: Math.max(1, Math.round((imgW * sh) / sw)) })
  }
  const blocksH = blocks.reduce((s, b) => s + b.h + (outset ? bw * 2 : 0), 0)
  const totalH = Math.round(margin * 2 + blocksH + gap * (items.length - 1) + (signH ? gap + signH : 0))

  canvas.width = Math.round(targetWidth)
  canvas.height = totalH
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.fillStyle = o.bgColor
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  let y = margin
  const rad = Math.max(0, o.radius * scale)
  const tops: number[] = []
  const advs: number[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    const adv = b.h + (outset ? bw * 2 : 0)
    tops.push(y)
    advs.push(adv)
    const x = margin + (outset ? bw : 0)
    const iy = y + (outset ? bw : 0)
    if (rad >= 0.5) {
      // 每张图圆角：裁剪后绘制（边框仍为直角矩形描边）
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(x, iy, imgW, b.h, rad)
      ctx.clip()
      ctx.drawImage(b.canvas, b.sx, b.sy, b.sw, b.sh, x, iy, imgW, b.h)
      ctx.restore()
    } else {
      ctx.drawImage(b.canvas, b.sx, b.sy, b.sw, b.sh, x, iy, imgW, b.h)
    }
    if (bw >= 0.5) {
      ctx.strokeStyle = o.borderColor
      ctx.lineWidth = bw
      if (rad >= 0.5) {
        // 圆角描边：外框半径 = 图圆角 + 线宽一半，内描半径 = 图圆角 - 线宽一半
        const r = outset ? rad + bw / 2 : Math.max(0, rad - bw / 2)
        ctx.beginPath()
        ctx.roundRect(
          outset ? x - bw / 2 : x + bw / 2,
          outset ? iy - bw / 2 : iy + bw / 2,
          outset ? imgW + bw : imgW - bw,
          outset ? b.h + bw : b.h - bw,
          r
        )
        ctx.stroke()
      } else if (outset) {
        ctx.strokeRect(x - bw / 2, iy - bw / 2, imgW + bw, b.h + bw)
      } else {
        ctx.strokeRect(x + bw / 2, iy + bw / 2, imgW - bw, b.h - bw)
      }
    }
    if (o.wmEnabled) {
      drawWatermark(ctx, x, iy, imgW, b.h, {
        text: o.wmText,
        color: o.wmColor,
        opacity: o.wmOpacity / 100,
        fontSize: (o.wmSize / 100) * targetWidth,
      })
    }
    y += adv + gap
  }
  if (signH) {
    const sy2 = y - gap
    ctx.fillStyle = o.signBg
    ctx.fillRect(margin, sy2, targetWidth - margin * 2, signH)
    ctx.fillStyle = o.signColor
    ctx.font = `500 ${fontSize}px "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(signText, targetWidth / 2, sy2 + signH / 2 + fontSize * 0.05)
  }
  return { width: canvas.width, height: canvas.height, tops, advs }
}

// ---------------------------------------------------------------- 导出

async function blobToB64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  const chunks: string[] = []
  for (let i = 0; i < buf.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...buf.subarray(i, i + 0x8000)))
  }
  return btoa(chunks.join(''))
}

/** 合成全尺寸长图并保存到下载目录（设置里可改），返回保存路径（失败返回 null）。
 *  开启分段时按块边界切成多张（不会从图中间截断），文件名带序号。 */
export async function exportComic(): Promise<string | null> {
  if (!comic.items.length) {
    notify('先添加图片再导出', 'warn', 2500)
    return null
  }
  if (comic.busy) return null
  comic.busy = true
  try {
    const full = document.createElement('canvas')
    comic.progress = { done: 0, total: comic.items.length, label: '读取图片' }
    const dims = await renderComic(
      full,
      comic.items,
      comic.settings,
      comic.settings.width,
      (done, total) => {
        comic.progress = { done, total, label: '读取图片' }
      }
    )
    if (!dims) return null
    const mime = comic.settings.format === 'png' ? 'image/png' : 'image/jpeg'

    // 计算分段范围 [a,b)（按块边界切，不从图中间截断）
    const segs: { a: number; b: number }[] = []
    if (comic.settings.splitEnabled) {
      const limit = Math.max(1500, comic.settings.splitLimit)
      let a = 0
      for (let i = 0; i < comic.items.length; i++) {
        const end = dims.tops[i] + dims.advs[i]
        if (end - a > limit && i > 0 && dims.tops[i] > a) {
          segs.push({ a, b: dims.tops[i] })
          a = dims.tops[i]
        }
      }
      segs.push({ a, b: dims.height })
    } else {
      segs.push({ a: 0, b: dims.height })
    }

    const configured = String(state.settings.downloadDir ?? '').trim()
    const dir = (configured || String(await downloadDir())).replace(/[\\/]+$/, '')
    // sv-SE 本地化得 "2026-11-02 01:35:22" → "20261102-013522"
    const stamp = new Date()
      .toLocaleString('sv-SE', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
      .replace(/[-:]/g, '')
      .replace(' ', '-')
    const ext = comic.settings.format

    let firstPath = ''
    const paths: string[] = []
    for (let k = 0; k < segs.length; k++) {
      const { a, b } = segs[k]
      comic.progress = { done: k, total: segs.length, label: '编码保存' }
      const c = document.createElement('canvas')
      c.width = dims.width
      c.height = b - a
      c.getContext('2d')!.drawImage(full, 0, a, dims.width, b - a, 0, 0, dims.width, b - a)
      const blob = await new Promise<Blob | null>((res) =>
        c.toBlob(res, mime, comic.settings.quality / 100)
      )
      if (!blob) throw new Error('图片编码失败')
      const name = segs.length > 1 ? `comic-${stamp}-${k + 1}.${ext}` : `comic-${stamp}.${ext}`
      const path = await api.saveLocalBytes(dir, name, await blobToB64(blob))
      if (!firstPath) firstPath = path
      paths.push(path)
    }
    if (segs.length > 1) {
      notify(
        `已分 ${segs.length} 段导出（${dims.width}×${dims.height} → 每段 ≤${Math.max(1500, comic.settings.splitLimit)}px）：${paths.map((p) => p.split(/[\\/]/).pop()).join('、')}`,
        'ok',
        9000
      )
    } else {
      notify(`长图已保存：${firstPath}（${dims.width}×${dims.height}）`, 'ok', 9000)
    }
    return firstPath
  } catch (e) {
    notify(`导出失败：${e}`, 'error', 9000)
    return null
  } finally {
    comic.busy = false
    comic.progress = null
  }
}

/** 按当前设置把每张图单独导出成文件（含宽度/细框/圆角/背景/水印；
 *  署名条和图间距对单图无意义不生效），文件名带序号与原图名。 */
export async function exportSingleImages(): Promise<string | null> {
  if (!comic.items.length) {
    notify('先添加图片再导出', 'warn', 2500)
    return null
  }
  if (comic.busy) return null
  comic.busy = true
  comic.progress = { done: 0, total: comic.items.length, label: '单图导出' }
  try {
    const o = comic.settings
    const bw = Math.max(0, o.borderWidth)
    const outset = o.frameMode === 'outset'
    const imgW = o.width - o.outerMargin * 2 - (outset ? bw * 2 : 0)
    if (imgW <= 8) {
      notify('宽度/边距设置太大，画面装不下了', 'warn', 4000)
      return null
    }
    const mime = o.format === 'png' ? 'image/png' : 'image/jpeg'
    const configured = String(state.settings.downloadDir ?? '').trim()
    const dir = (configured || String(await downloadDir())).replace(/[\\/]+$/, '')
    const stamp = new Date()
      .toLocaleString('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' })
      .replace(/-/g, '')
    const ext = o.format

    let firstPath = ''
    let okCount = 0
    for (let i = 0; i < comic.items.length; i++) {
      const it = comic.items[i]
      comic.progress = { done: i, total: comic.items.length, label: '单图导出' }
      // 让出一帧，进度条才会真的动（不然整轮跑完界面才更新）
      await new Promise((r) => setTimeout(r, 0))
      let prep: HTMLCanvasElement
      try {
        const bmp = await loadBitmap(it.path)
        if (it.w === 0) {
          it.w = bmp.width
          it.h = bmp.height
        }
        prep = getPrepared(it, bmp)
      } catch (e) {
        notify(`跳过读不出的图片：${it.name}（${e}）`, 'warn', 5000)
        continue
      }
      const cr = it.crop ?? { x: 0, y: 0, w: 1, h: 1 }
      const sw = Math.max(1, cr.w * prep.width)
      const sh = Math.max(1, cr.h * prep.height)
      const h = Math.max(1, Math.round((imgW * sh) / sw))
      const rad = Math.max(0, o.radius)

      const c = document.createElement('canvas')
      c.width = o.width
      c.height = h + o.outerMargin * 2 + (outset ? bw * 2 : 0)
      const cx = c.getContext('2d')!
      cx.imageSmoothingEnabled = true
      cx.imageSmoothingQuality = 'high'
      cx.fillStyle = o.bgColor
      cx.fillRect(0, 0, c.width, c.height)

      const x = o.outerMargin + (outset ? bw : 0)
      const iy = o.outerMargin + (outset ? bw : 0)
      if (rad >= 0.5) {
        cx.save()
        cx.beginPath()
        cx.roundRect(x, iy, imgW, h, rad)
        cx.clip()
        cx.drawImage(prep, cr.x * prep.width, cr.y * prep.height, sw, sh, x, iy, imgW, h)
        cx.restore()
      } else {
        cx.drawImage(prep, cr.x * prep.width, cr.y * prep.height, sw, sh, x, iy, imgW, h)
      }
      if (bw >= 0.5) {
        cx.strokeStyle = o.borderColor
        cx.lineWidth = bw
        if (rad >= 0.5) {
          const r = outset ? rad + bw / 2 : Math.max(0, rad - bw / 2)
          cx.beginPath()
          cx.roundRect(
            outset ? x - bw / 2 : x + bw / 2,
            outset ? iy - bw / 2 : iy + bw / 2,
            outset ? imgW + bw : imgW - bw,
            outset ? h + bw : h - bw,
            r
          )
          cx.stroke()
        } else if (outset) {
          cx.strokeRect(x - bw / 2, iy - bw / 2, imgW + bw, h + bw)
        } else {
          cx.strokeRect(x + bw / 2, iy + bw / 2, imgW - bw, h - bw)
        }
      }
      if (o.wmEnabled) {
        drawWatermark(cx, x, iy, imgW, h, {
          text: o.wmText,
          color: o.wmColor,
          opacity: o.wmOpacity / 100,
          fontSize: (o.wmSize / 100) * o.width,
        })
      }

      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, mime, o.quality / 100))
      if (!blob) throw new Error('图片编码失败')
      const base = it.name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || `第${i + 1}张`
      const name = `comic-单图-${stamp}-${String(i + 1).padStart(2, '0')}-${base}.${ext}`
      const path = await api.saveLocalBytes(dir, name, await blobToB64(blob))
      if (!firstPath) firstPath = path
      okCount++
    }
    if (!okCount) {
      notify('没有可导出的图片', 'warn', 3000)
      return null
    }
    notify(`已按当前设置导出 ${okCount} 张单图到：${dir}`, 'ok', 9000)
    return firstPath
  } catch (e) {
    notify(`导出单图失败：${e}`, 'error', 9000)
    return null
  } finally {
    comic.busy = false
    comic.progress = null
  }
}

/** 合成整张长图并复制进系统剪贴板（直接粘到公众号编辑器）。
 *  格式固定用 PNG（无损），不受导出格式设置影响；超大长图会在 Rust 侧被拦下。 */
export async function copyComicToClipboard(): Promise<boolean> {
  if (!comic.items.length) {
    notify('先添加图片再复制', 'warn', 2500)
    return false
  }
  if (comic.busy) return false
  comic.busy = true
  comic.progress = { done: 0, total: comic.items.length, label: '读取图片' }
  try {
    const full = document.createElement('canvas')
    const dims = await renderComic(
      full,
      comic.items,
      comic.settings,
      comic.settings.width,
      (done, total) => {
        comic.progress = { done, total, label: '读取图片' }
      }
    )
    if (!dims) return false
    comic.progress = { done: 1, total: 1, label: '编码 PNG' }
    const blob = await new Promise<Blob | null>((res) => full.toBlob(res, 'image/png'))
    if (!blob) throw new Error('图片编码失败')
    const r = await api.clipboardWriteImage(await blobToB64(blob))
    notify(
      `已复制 ${r.width}×${r.height} 长图到剪贴板，去公众号编辑器 Ctrl+V 粘贴即可`,
      'ok',
      8000
    )
    return true
  } catch (e) {
    notify(`复制到剪贴板失败：${e}`, 'error', 9000)
    return false
  } finally {
    comic.busy = false
    comic.progress = null
  }
}

// ---------------------------------------------------------------- 参数预设

const PRESET_KEY = 'comfyui-studio.comic.presets:v1'

export function loadPresets(): Record<string, ComicSettings> {
  try {
    const raw = localStorage.getItem(PRESET_KEY)
    return raw ? (JSON.parse(raw) as Record<string, ComicSettings>) : {}
  } catch {
    return {}
  }
}

export function savePresets(presets: Record<string, ComicSettings>): void {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets))
  } catch {
    /* ignore */
  }
}
