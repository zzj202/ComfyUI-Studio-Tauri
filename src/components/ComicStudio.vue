<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ask, open } from '@tauri-apps/plugin-dialog'
import { convertFileSrc } from '@tauri-apps/api/core'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { assetDropTargets, imageDropTargets, notify } from '../store'
import { api } from '../api/tauri'
import { IMG_EXT_RE } from '../core/clipboard'
import {
  addComicAsset,
  addComicPaths,
  applyUniformCrop,
  clearComic,
  comic,
  comicHistory,
  exportComic,
  exportSingleImages,
  loadBitmap,
  loadPresets,
  moveComic,
  pushHistory,
  redoComic,
  removeComicItem,
  removeComicItems,
  renderComic,
  savePresets,
  syncHistory,
  undoComic,
  DEFAULT_SETTINGS,
  type ComicItem,
  type ComicSettings,
} from '../core/comic'
import { cycleTheme, isDarkNow, themeMode } from '../core/theme'
import { ui } from '../ui'
import ColorPick from './ColorPick.vue'

/**
 * 漫画工坊：图片按顺序合并成竖版长图（手机阅读向）。
 * 三栏：左 = 手机预览，中 = 图片列表（拖动排序 / 裁切旋转编辑），右 = 预设与合成参数。
 * 加图入口：文件选择 / 拖文件进窗口 / Ctrl+V / 从「收藏・本地素材・出图结果」拖入。
 * 撤销/重做：Ctrl+Z / Ctrl+Y（跟踪加图、删除、排序、清空、裁切、旋转）。
 */

// ---------------------------------------------------------------- 加图入口

async function pickImages() {
  const picked = await open({
    multiple: true,
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif'] }],
  })
  if (!picked) return
  addComicPaths(Array.isArray(picked) ? picked : [picked])
}

async function doClear() {
  if (!comic.items.length) return
  const yes = await ask(`清空全部 ${comic.items.length} 张图片？（可 Ctrl+Z 撤销）`, {
    title: '漫画工坊',
    kind: 'warning',
    okLabel: '清空',
    cancelLabel: '先不了',
  })
  if (yes) clearComic()
}

// 应用内拖拽落点（收藏 / 本地素材 / 出图结果拖进来）：与 AssetDrop 的命中机制共用 key
const DROP_KEY = 'comic-drop'
onMounted(() => {
  imageDropTargets.set(DROP_KEY, (p) => addComicPaths([p]))
  assetDropTargets.set(DROP_KEY, (a) => void addComicAsset(a))
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  imageDropTargets.delete(DROP_KEY)
  assetDropTargets.delete(DROP_KEY)
  window.removeEventListener('keydown', onKeydown)
})

// ---------------------------------------------------------------- 撤销 / 重做

function onKeydown(e: KeyboardEvent) {
  if (ui.view !== 'comic') return
  const el = document.activeElement as HTMLElement | null
  const inInput =
    !!el &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' ||
      el.isContentEditable)
  const k = e.key.toLowerCase()
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    if (inInput) return // 输入框里放行（Ctrl+A 全选文本等）
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault()
      undoComic()
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault()
      redoComic()
    } else if (k === 'a') {
      e.preventDefault() // Ctrl+A 全选
      comic.items.forEach((it) => sel.add(it.id))
    }
    return
  }
  if (inInput) return
  if (k === 'delete' || k === 'backspace') {
    if (sel.size) {
      e.preventDefault()
      batchDelete()
    }
  } else if (k === 'escape') {
    if (editing.value !== null) closeEditor()
    else if (sel.size) {
      sel.clear()
      anchorIdx = -1
    }
  } else if (k === 'arrowup' || k === 'arrowdown') {
    if (sel.size !== 1) return
    e.preventDefault()
    const id = [...sel][0]
    const i = comic.items.findIndex((it) => it.id === id)
    const d = k === 'arrowup' ? -1 : 1
    if (i >= 0 && i + d >= 0 && i + d < comic.items.length) {
      moveComic(i, d)
      anchorIdx = i + d
    }
  }
}

// ---------------------------------------------------------------- 列表排序（pointer 拖动 + 边缘自动滚动）

const listEl = ref<HTMLElement | null>(null)
const dragIdx = ref<number | null>(null)
let dragStartY = 0
let dragRowStep = 68
let dragActive = false
let dragLastY = 0
let dragLastX = 0
let scrollRaf = 0
/** 刚结束一次拖动（抑制随后的 click 误选中） */
let justDragged = false

/** 按指针坐标计算目标位置并实时换位（行视图按行高算，网格按指针下的单元格算） */
function updateDragTarget() {
  const list = listEl.value
  if (!list || dragIdx.value === null) return
  let target: number
  if (gridView.value) {
    const el = document.elementFromPoint(dragLastX, dragLastY)?.closest('[data-cidx]') as
      | HTMLElement
      | null
    if (!el) return
    target = Number(el.dataset.cidx)
  } else {
    const rect = list.getBoundingClientRect()
    target = Math.floor((dragLastY - rect.top - 10) / dragRowStep)
  }
  target = Math.max(0, Math.min(comic.items.length - 1, target))
  const from = dragIdx.value
  if (target !== from) {
    const [it] = comic.items.splice(from, 1)
    comic.items.splice(target, 0, it)
    dragIdx.value = target
  }
}

/** 拖动期间 rAF 循环：指针靠近列表上下边缘时自动滚动并重算落点 */
function dragTick() {
  const list = listEl.value
  if (list && dragActive) {
    const rect = list.getBoundingClientRect()
    const edge = 48
    if (dragLastY < rect.top + edge) {
      list.scrollTop -= (rect.top + edge - dragLastY) * 0.25
    } else if (dragLastY > rect.bottom - edge) {
      list.scrollTop += (dragLastY - (rect.bottom - edge)) * 0.25
    }
    updateDragTarget()
  }
  scrollRaf = requestAnimationFrame(dragTick)
}

function onRowDragDown(e: PointerEvent, i: number) {
  if (e.button !== 0) return
  e.preventDefault() // 阻止原生文本选择 / 图片拖拽
  justDragged = false
  dragIdx.value = i
  dragStartY = e.clientY
  dragLastY = e.clientY
  dragLastX = e.clientX
  dragActive = false
  const list = listEl.value
  if (list && !gridView.value) {
    const rows = list.querySelectorAll<HTMLElement>('.c-row')
    dragRowStep =
      rows.length > 1 ? rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top : 68
  }
  window.addEventListener('pointermove', onRowDragMove)
  window.addEventListener('pointerup', onRowDragUp, { once: true })
  cancelAnimationFrame(scrollRaf)
  scrollRaf = requestAnimationFrame(dragTick)
}

function onRowDragMove(e: PointerEvent) {
  dragLastY = e.clientY
  dragLastX = e.clientX
  if (dragIdx.value === null) return
  if (!dragActive) {
    if (Math.abs(e.clientY - dragStartY) < 5) return
    dragActive = true
    document.body.classList.add('drag-active')
    pushHistory() // 整段拖动算一步撤销
  }
  updateDragTarget()
}

function onRowDragUp() {
  window.removeEventListener('pointermove', onRowDragMove)
  document.body.classList.remove('drag-active')
  dragIdx.value = null
  justDragged = dragActive
  dragActive = false
  cancelAnimationFrame(scrollRaf)
  syncHistory()
}

// ---------------------------------------------------------------- 多选 / 批量操作

/** 选中集合（存 item.id）；Ctrl 点选切换、Shift 范围选、普通点选单张 */
const sel = reactive(new Set<string>())
let anchorIdx = -1

function rowClick(i: number, e: MouseEvent) {
  if (justDragged) {
    justDragged = false
    return
  }
  const id = comic.items[i]?.id
  if (!id) return
  if (e.ctrlKey || e.metaKey) {
    if (sel.has(id)) sel.delete(id)
    else sel.add(id)
    anchorIdx = i
  } else if (e.shiftKey && anchorIdx >= 0) {
    sel.clear()
    for (let k = Math.min(anchorIdx, i); k <= Math.max(anchorIdx, i); k++) {
      sel.add(comic.items[k].id)
    }
  } else {
    sel.clear()
    sel.add(id)
    anchorIdx = i
  }
}

function clearSelIfGone() {
  for (const id of [...sel]) {
    if (!comic.items.some((it) => it.id === id)) sel.delete(id)
  }
}
watch(() => comic.items.map((it) => it.id).join('|'), clearSelIfGone)

/** 批量裁切用的比例（裁切框取旋转后坐标系里的居中矩形） */
const BATCH_RATIOS = [
  { label: '1:1', ratio: 1 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '2:3', ratio: 2 / 3 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '16:9', ratio: 16 / 9 },
]

function batchRotate() {
  if (!sel.size) return
  pushHistory()
  for (const it of comic.items) {
    if (sel.has(it.id)) it.rotate = (it.rotate + 1) % 4
  }
  notify(`已旋转 ${sel.size} 张`, 'ok', 2200)
}

function batchCrop(ratio: number) {
  if (!sel.size) return
  pushHistory()
  let n = 0
  for (const it of comic.items) {
    if (!sel.has(it.id)) continue
    const w = Math.min(1, ratio)
    const h = w / ratio
    it.crop = { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
    n++
  }
  notify(`已对 ${n} 张应用居中裁切`, 'ok', 2200)
}

function batchDelete() {
  const n = removeComicItems([...sel])
  sel.clear()
  if (n) notify(`已删除 ${n} 张（Ctrl+Z 可撤销）`, 'ok', 3000)
}

// ---------------------------------------------------------------- 网格视图 / 状态角标

const GRID_KEY = 'comfyui-studio.comic.gridView:v1'
const gridView = ref(((): boolean => {
  try {
    return localStorage.getItem(GRID_KEY) === '1'
  } catch {
    return false
  }
})())

function toggleGrid() {
  gridView.value = !gridView.value
  try {
    localStorage.setItem(GRID_KEY, gridView.value ? '1' : '0')
  } catch {
    /* ignore */
  }
}

/** 缩略图角标：已裁切 / 已旋转 / 与前面某张同尺寸（疑似重复） */
function badgesOf(it: ComicItem, i: number): { t: string; k: string }[] {
  const out: { t: string; k: string }[] = []
  if (it.crop) out.push({ t: '裁', k: 'crop' })
  if (it.rotate % 4) out.push({ t: `⟳${it.rotate * 90}°`, k: 'rot' })
  if (it.w > 0 && comic.items.slice(0, i).some((o) => o.w === it.w && o.h === it.h)) {
    out.push({ t: '重', k: 'dup' })
  }
  return out
}

// ---------------------------------------------------------------- 列宽拖拽调整

const COL_P_KEY = 'comfyui-studio.comic.colPreview:v1'
const COL_R_KEY = 'comfyui-studio.comic.colParams:v1'

function loadCol(key: string, dflt: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v >= 240 && v <= 640 ? v : dflt
  } catch {
    return dflt
  }
}

const previewW = ref(loadCol(COL_P_KEY, 302))
const paramsW = ref(loadCol(COL_R_KEY, 330))

const pageStyle = computed(() => ({
  gridTemplateColumns: `minmax(0, 1fr) ${previewW.value}px ${paramsW.value}px`,
}))

/** 拖动列间分隔线调整预览/参数列宽（松手持久化） */
function startColResize(which: 'preview' | 'params', e: PointerEvent) {
  if (e.button !== 0) return
  e.preventDefault()
  const startX = e.clientX
  const startW = which === 'preview' ? previewW.value : paramsW.value
  document.body.classList.add('col-resizing')
  const onMove = (ev: PointerEvent) => {
    // 两根都是「列左缘」分隔线：右移 → 该列变窄（光标跟手）
    const w = Math.max(240, Math.min(640, startW - (ev.clientX - startX)))
    if (which === 'preview') previewW.value = w
    else paramsW.value = w
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    document.body.classList.remove('col-resizing')
    try {
      localStorage.setItem(
        which === 'preview' ? COL_P_KEY : COL_R_KEY,
        String(which === 'preview' ? previewW.value : paramsW.value)
      )
    } catch {
      /* ignore */
    }
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp, { once: true })
}

// ---------------------------------------------------------------- 参数卡折叠

const FOLD_KEY = 'comfyui-studio.comic.folded:v1'
const folded = reactive<Record<string, boolean>>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') as Record<string, boolean>
    } catch {
      return {}
    }
  })()
)

function toggleFold(k: string) {
  folded[k] = !folded[k]
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(folded))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 预览增强（缩放 / 回顶 / 文案）

const phScrollEl = ref<HTMLElement | null>(null)
function previewTop() {
  phScrollEl.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

const ZOOM_KEY = 'comfyui-studio.comic.previewZoom:v1'
const previewZoom = ref<number>(
  (() => {
    try {
      const v = Number(localStorage.getItem(ZOOM_KEY))
      return v === 0.75 || v === 0.6 ? v : 1
    } catch {
      return 1
    }
  })()
)

function setZoom(z: number) {
  previewZoom.value = z
  try {
    localStorage.setItem(ZOOM_KEY, String(z))
  } catch {
    /* ignore */
  }
}

const PH_KEY = 'comfyui-studio.comic.phText:v1'
const phText = reactive<{ title: string; author: string }>(
  (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(PH_KEY) ?? 'null')
      if (raw && typeof raw.title === 'string') {
        // 清洗旧版 bug 存进去的「· 今天」后缀（可能累积了多次）
        const author = String(raw.author ?? '小金毛')
          .replace(/(\s*·\s*今天\s*)+$/g, '')
          .trim()
        return { title: raw.title, author: author || '小金毛' }
      }
    } catch {
      /* ignore */
    }
    return { title: '我的漫画', author: '小金毛' }
  })()
)

function savePhText() {
  try {
    localStorage.setItem(PH_KEY, JSON.stringify(phText))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 空状态快捷导入

async function pasteIn() {
  try {
    const imgs = (await api.clipboardFilePaths()).filter((p) => IMG_EXT_RE.test(p))
    if (imgs.length) addComicPaths(imgs)
    else notify('剪贴板里没有图片文件', 'info', 2500)
  } catch {
    notify('读取剪贴板失败', 'warn', 2500)
  }
}

// ---------------------------------------------------------------- 手机预览独立主题

type PTheme = 'auto' | 'light' | 'dark'
const PKEY = 'comfyui-studio.comic.previewTheme:v1'
const previewTheme = ref<PTheme>(((): PTheme => {
  try {
    const v = localStorage.getItem(PKEY)
    return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto'
  } catch {
    return 'auto'
  }
})())

const PTheme_UI: Record<PTheme, { icon: string; label: string }> = {
  auto: { icon: '🖥', label: '跟随页面' },
  light: { icon: '☀️', label: '亮色' },
  dark: { icon: '🌙', label: '深色' },
}

/** 本页（漫画工坊）主题按钮的文案 */
const THEME_UI: Record<string, { icon: string; label: string }> = {
  auto: { icon: '🌗', label: '跟随系统' },
  light: { icon: '☀️', label: '亮色' },
  dark: { icon: '🌙', label: '深色' },
}

/** 手机预览的配色：三态都显式给类（dark/light 各有硬编码变量，auto 跟随页面当前明暗） */
const phoneCls = computed(() =>
  previewTheme.value === 'light'
    ? 'pt-light'
    : previewTheme.value === 'dark'
      ? 'pt-dark'
      : isDarkNow()
        ? 'pt-dark'
        : 'pt-light'
)

function cyclePreviewTheme() {
  const next: PTheme =
    previewTheme.value === 'auto' ? 'light' : previewTheme.value === 'light' ? 'dark' : 'auto'
  previewTheme.value = next
  try {
    localStorage.setItem(PKEY, next)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 手机预览

/** 预览状态栏时钟（仿手机顶部） */
const clockText = ref('')
let clockTimer: number | null = null
function tickClock() {
  const d = new Date()
  clockText.value = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
tickClock()

const previewEl = ref<HTMLCanvasElement | null>(null)
const outDims = ref<{ w: number; h: number } | null>(null)
const PREVIEW_W = 640
let renderToken = 0
let renderTimer: number | null = null

function schedulePreview() {
  if (renderTimer != null) clearTimeout(renderTimer)
  renderTimer = window.setTimeout(() => void renderPreview(), 140)
}

async function renderPreview() {
  const c = previewEl.value
  if (!c) return
  const token = ++renderToken
  if (!comic.items.length) {
    c.width = 300
    c.height = 400
    outDims.value = null
    estSize.value = null
    return
  }
  const dims = await renderInner(c)
  if (token !== renderToken) return // 已有更新的渲染排队，丢弃这次
  outDims.value = dims
    ? { w: comic.settings.width, h: Math.round(dims.height * (comic.settings.width / dims.width)) }
    : null
  void estimateSize()
}

/** 导出体积预估：预览图编码体积 × (目标宽/预览宽)² 面积比，粗估够用 */
const estSize = ref<number | null>(null)
async function estimateSize() {
  const c = previewEl.value
  if (!c || !comic.items.length) {
    estSize.value = null
    return
  }
  try {
    const mime = comic.settings.format === 'png' ? 'image/png' : 'image/jpeg'
    const blob = await new Promise<Blob | null>((res) =>
      c.toBlob(res, mime, comic.settings.quality / 100)
    )
    if (!blob) return
    estSize.value = blob.size * (comic.settings.width / PREVIEW_W) ** 2
  } catch {
    /* 编码失败不影响主流程 */
  }
}

function fmtSize(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`
}

/** renderComic 的失败低频提醒版（预览里不想每次滑参都弹错） */
let lastErrAt = 0
async function renderInner(c: HTMLCanvasElement) {
  const r = await renderComic(c, comic.items, comic.settings, PREVIEW_W)
  if (!r && comic.items.length && Date.now() - lastErrAt > 8000) {
    lastErrAt = Date.now()
    notify('预览失败：有图片读不出来，详见刚才的提示', 'warn', 4000)
  }
  return r
}

watch(comic, schedulePreview, { deep: true })
watch(
  () => ui.view,
  (v) => {
    if (v === 'comic') schedulePreview()
  }
)
onMounted(() => {
  clockTimer = window.setInterval(tickClock, 20000)
})
onUnmounted(() => {
  if (clockTimer != null) clearInterval(clockTimer)
})
onMounted(schedulePreview)

// ---------------------------------------------------------------- 参数预设

const presets = ref<Record<string, ComicSettings>>(loadPresets())
const presetSel = ref('')
const savingPreset = ref(false)
const presetName = ref('')
const presetNames = computed(() => Object.keys(presets.value))

function applyPreset(name: string) {
  const p = presets.value[name]
  if (!p) return
  presetSel.value = name
  Object.assign(comic.settings, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), p)
  notify(`已应用预设「${name}」`, 'ok', 2200)
}

function savePreset() {
  const name = presetName.value.trim()
  if (!name) return
  presets.value = { ...presets.value, [name]: JSON.parse(JSON.stringify(comic.settings)) }
  savePresets(presets.value)
  presetSel.value = name
  presetName.value = ''
  savingPreset.value = false
  notify(`预设「${name}」已保存`, 'ok', 3000)
}

function delPreset(name: string) {
  const rest = { ...presets.value }
  delete rest[name]
  presets.value = rest
  savePresets(rest)
  if (presetSel.value === name) presetSel.value = ''
  notify(`预设「${name}」已删除`, 'ok', 2500)
}

// ---------------------------------------------------------------- 裁切编辑器

interface CropPreset {
  label: string
  ratio: number | null // w/h；null = 自由
  full?: boolean
}
const CROP_PRESETS: CropPreset[] = [
  { label: '自由', ratio: null },
  { label: '原图', ratio: null, full: true },
  { label: '1:1', ratio: 1 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '2:3', ratio: 2 / 3 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '16:9', ratio: 16 / 9 },
]

const editing = ref<number | null>(null)
const editRotate = ref(0)
const editFlipH = ref(false)
const editFlipV = ref(false)
const editAdj = reactive({ bright: 100, contrast: 100, satur: 100 })
const editFillOn = ref(false)
const editFill = ref('#ffffff')
const rect = reactive({ x: 0, y: 0, w: 1, h: 1 })
const ratioLock = ref<number | null>(null)
const stageEl = ref<HTMLElement | null>(null)
const stageCanvas = ref<HTMLCanvasElement | null>(null)
const stageW = ref(400)
const stageH = ref(300)
let editBmp: ImageBitmap | null = null

const editItem = computed<ComicItem | null>(() =>
  editing.value != null ? (comic.items[editing.value] ?? null) : null
)
const rectStyle = computed(() => ({
  left: `${rect.x * 100}%`,
  top: `${rect.y * 100}%`,
  width: `${rect.w * 100}%`,
  height: `${rect.h * 100}%`,
}))

function setRectFromItem(it: ComicItem) {
  const c = it.crop
  rect.x = c?.x ?? 0
  rect.y = c?.y ?? 0
  rect.w = c?.w ?? 1
  rect.h = c?.h ?? 1
}

async function openEditor(i: number) {
  const it = comic.items[i]
  if (!it) return
  editing.value = i
  editRotate.value = it.rotate % 4
  editFlipH.value = it.flipH === true
  editFlipV.value = it.flipV === true
  const a = it.adjust ?? { bright: 100, contrast: 100, satur: 100 }
  editAdj.bright = a.bright
  editAdj.contrast = a.contrast
  editAdj.satur = a.satur
  editFillOn.value = !!it.fill
  editFill.value = it.fill || '#ffffff'
  ratioLock.value = null
  setRectFromItem(it)
  await drawStage()
}

function closeEditor() {
  editing.value = null
}

async function drawStage() {
  const it = editItem.value
  if (!it || editing.value === null) return
  try {
    editBmp = await loadBitmap(it.path)
  } catch (e) {
    notify(`读取图片失败：${e}`, 'error', 7000)
    editing.value = null
    return
  }
  const swap = editRotate.value % 2 === 1
  const rotW = swap ? editBmp.height : editBmp.width
  const rotH = swap ? editBmp.width : editBmp.height
  const fit = Math.min(560 / rotW, 420 / rotH, 1.5)
  stageW.value = Math.max(80, Math.round(rotW * fit))
  stageH.value = Math.max(80, Math.round(rotH * fit))
  await nextTick()
  const c = stageCanvas.value
  if (!c) return
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  c.width = Math.round(stageW.value * dpr)
  c.height = Math.round(stageH.value * dpr)
  const cx = c.getContext('2d')!
  cx.setTransform(dpr, 0, 0, dpr, 0, 0)
  cx.imageSmoothingQuality = 'high'
  cx.clearRect(0, 0, stageW.value, stageH.value)
  cx.save()
  cx.translate(stageW.value / 2, stageH.value / 2)
  cx.rotate((editRotate.value * 90 * Math.PI) / 180)
  cx.scale(editFlipH.value ? -1 : 1, editFlipV.value ? -1 : 1)
  if (editFillOn.value && editFill.value) {
    cx.fillStyle = editFill.value
    cx.fillRect(-editBmp.width / 2, -editBmp.height / 2, editBmp.width, editBmp.height)
  }
  if (editAdj.bright !== 100 || editAdj.contrast !== 100 || editAdj.satur !== 100) {
    cx.filter = `brightness(${editAdj.bright}%) contrast(${editAdj.contrast}%) saturate(${editAdj.satur}%)`
  }
  const s = Math.min(stageW.value / rotW, stageH.value / rotH)
  cx.scale(s, s)
  cx.drawImage(editBmp, -editBmp.width / 2, -editBmp.height / 2)
  cx.restore()
}

watch(editRotate, () => {
  rect.x = 0
  rect.y = 0
  rect.w = 1
  rect.h = 1
  ratioLock.value = null
  void drawStage()
})

// 镜像 / 调色 / 填充变化 → 编辑台实时重绘（不影响裁切框）
watch(
  [editFlipH, editFlipV, editFillOn, editFill, () => `${editAdj.bright},${editAdj.contrast},${editAdj.satur}`],
  () => {
    if (editing.value !== null) void drawStage()
  }
)

function applyCropPreset(p: CropPreset) {
  if (p.full) {
    rect.x = 0
    rect.y = 0
    rect.w = 1
    rect.h = 1
    ratioLock.value = null
    return
  }
  ratioLock.value = p.ratio
  if (p.ratio) {
    const w = Math.min(1, p.ratio)
    const h = w / p.ratio
    rect.x = (1 - w) / 2
    rect.y = (1 - h) / 2
    rect.w = w
    rect.h = h
  }
}

function doRotate() {
  editRotate.value = (editRotate.value + 1) % 4
}

function doFlipH() {
  editFlipH.value = !editFlipH.value
}

function doFlipV() {
  editFlipV.value = !editFlipV.value
}

function resetEdit() {
  editRotate.value = 0
  editFlipH.value = false
  editFlipV.value = false
  editAdj.bright = 100
  editAdj.contrast = 100
  editAdj.satur = 100
  editFillOn.value = false
  editFill.value = '#ffffff'
  rect.x = 0
  rect.y = 0
  rect.w = 1
  rect.h = 1
  ratioLock.value = null
}

function applyEditor() {
  const it = editItem.value
  if (!it || editing.value === null) return
  pushHistory()
  it.rotate = editRotate.value % 4
  it.flipH = editFlipH.value
  it.flipV = editFlipV.value
  it.adjust = { ...editAdj }
  it.fill = editFillOn.value ? editFill.value : null
  const full = rect.x <= 0.001 && rect.y <= 0.001 && rect.w >= 0.999 && rect.h >= 0.999
  it.crop = full ? null : { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
  editing.value = null
}

// ---- 裁切框指针交互（整体移动 + 四角缩放，可锁比例） ----

type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se'
function startEdit(mode: DragMode, e: PointerEvent) {
  e.preventDefault()
  e.stopPropagation()
  const stageRect = stageEl.value?.getBoundingClientRect()
  if (!stageRect) return
  const startX = e.clientX
  const startY = e.clientY
  const s = { ...rect }
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

  const onMove = (ev: PointerEvent) => {
    const dx = (ev.clientX - startX) / stageRect.width
    const dy = (ev.clientY - startY) / stageRect.height
    if (mode === 'move') {
      rect.x = clamp(s.x + dx, 0, 1 - s.w)
      rect.y = clamp(s.y + dy, 0, 1 - s.h)
      return
    }
    const east = mode === 'ne' || mode === 'se'
    const south = mode === 'se' || mode === 'sw'
    const x1 = east ? s.x : s.x + s.w // 固定锚点
    const y1 = south ? s.y : s.y + s.h
    let w = east ? clamp(s.x + s.w + dx, 0, 1) - x1 : x1 - clamp(s.x + dx, 0, 1)
    w = Math.max(0.01, w)
    let h = Math.max(0.01, south ? clamp(s.y + s.h + dy, 0, 1) - y1 : y1 - clamp(s.y + dy, 0, 1))
    if (ratioLock.value) {
      const r = ratioLock.value
      h = w / r
      const maxH = south ? 1 - y1 : y1
      const maxW = east ? 1 - x1 : x1
      if (h > maxH) {
        h = maxH
        w = h * r
      }
      if (w > maxW) {
        w = maxW
        h = w / r
      }
      if (h < 0.01) {
        h = 0.01
        w = h * r
      }
    }
    const x2 = east ? x1 + w : x1 - w
    const y2 = south ? y1 + h : y1 - h
    rect.x = Math.min(x1, x2)
    rect.y = Math.min(y1, y2)
    rect.w = Math.abs(x2 - x1)
    rect.h = Math.abs(y2 - y1)
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    document.body.classList.remove('drag-active')
  }
  document.body.classList.add('drag-active')
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp, { once: true })
}

// ---------------------------------------------------------------- 导出

const lastExport = ref('')

async function doExport() {
  const path = await exportComic()
  if (path) lastExport.value = path
}

async function doExportSingles() {
  const path = await exportSingleImages()
  if (path) lastExport.value = path
}

async function openExportDir() {
  if (!lastExport.value) return
  try {
    await revealItemInDir(lastExport.value)
  } catch (e) {
    notify(`打开失败：${e}`, 'error', 6000)
  }
}

// ---------------------------------------------------------------- 其他

function thumbOf(it: ComicItem): string {
  return convertFileSrc(it.path)
}

function dimsText(it: ComicItem): string {
  if (!it.w) return '读取中…'
  return `${it.w}×${it.h}`
}

function doUniform() {
  void applyUniformCrop()
}
</script>

<template>
  <div class="comic-page" :style="pageStyle">
    <!-- 左列：图片列表 -->
    <div class="comic-mid">
      <div class="comic-toolbar">
        <button class="btn sm" @click="pickImages">＋ 添加图片</button>
        <button
          class="btn sm"
          title="分析所有图的宽高，按最常见比例统一居中裁切，画面更整齐"
          @click="doUniform"
        >
          🎯 一键铺满
        </button>
        <button class="btn sm" :disabled="!comic.items.length" @click="doClear">清空</button>
        <button
          class="btn sm"
          :disabled="!comicHistory.undo"
          title="撤销上一步（Ctrl+Z）"
          @click="undoComic()"
        >
          ↶ 撤销
        </button>
        <button
          class="btn sm"
          :disabled="!comicHistory.redo"
          title="重做（Ctrl+Y）"
          @click="redoComic()"
        >
          ↷ 重做
        </button>
        <button
          class="btn sm"
          :title="gridView ? '切换为行视图' : '切换为网格视图'"
          @click="toggleGrid"
        >
          {{ gridView ? '📃 行视图' : '▦ 网格视图' }}
        </button>
        <span class="flex1" />
        <button
          class="btn sm"
          :title="`本页主题：${THEME_UI[themeMode].label}（点击切换 跟随系统/深色/亮色）`"
          @click="cycleTheme"
        >
          {{ THEME_UI[themeMode].icon }}
        </button>
        <span class="hint">拖图进窗口 · Ctrl+V 粘贴 · 拖动排序 · Ctrl/Shift 多选</span>
      </div>

      <!-- 批量操作条 -->
      <div v-if="sel.size" class="batch-bar">
        <span class="bb-count">已选 {{ sel.size }} 张</span>
        <button class="btn sm" title="所选各顺时针转 90°" @click="batchRotate">⟳ 批量旋转</button>
        <span class="bb-lbl">批量裁切</span>
        <button
          v-for="p in BATCH_RATIOS"
          :key="p.label"
          class="chip"
          :title="`所选统一居中裁切为 ${p.label}`"
          @click="batchCrop(p.ratio)"
        >
          {{ p.label }}
        </button>
        <span class="flex1" />
        <button class="btn sm danger" @click="batchDelete">🗑 删除所选</button>
        <button class="btn sm" @click="sel.clear(); anchorIdx = -1">取消选择</button>
      </div>

      <div
        ref="listEl"
        class="comic-list"
        :class="{ grid: gridView }"
        :data-image-key="DROP_KEY"
      >
        <div
          v-for="(it, i) in comic.items"
          :key="it.id"
          class="c-row"
          :class="{ lifting: dragIdx === i, selected: sel.has(it.id), grid: gridView }"
          :data-cidx="i"
          :title="gridView ? '点选（Ctrl 多选 / Shift 范围）· 双击编辑 · 拖动换位' : ''"
          @click="rowClick(i, $event)"
          @dblclick="openEditor(i)"
        >
          <!-- 行视图 -->
          <template v-if="!gridView">
            <span
              class="c-handle"
              title="拖动排序"
              @click.stop
              @pointerdown.stop="onRowDragDown($event, i)"
              >⋮⋮</span
            >
            <span class="c-idx">{{ i + 1 }}</span>
            <div class="c-thumbwrap">
              <img class="c-thumb" :src="thumbOf(it)" :alt="it.name" draggable="false" />
              <span v-for="b in badgesOf(it, i)" :key="b.t" class="c-badge" :class="b.k">{{
                b.t
              }}</span>
            </div>
            <div class="c-meta">
              <div class="c-name">{{ it.name }}</div>
              <div class="c-dim">
                <span>{{ dimsText(it) }}</span>
              <em v-if="it.rotate % 4">⟳{{ it.rotate * 90 }}°</em>
              <em v-if="it.flipH || it.flipV">镜像</em>
              <em v-if="it.crop">已裁切</em>
              </div>
            </div>
            <div class="c-ops">
              <button class="btn sm" title="裁切 / 旋转" @click.stop="openEditor(i)">✎</button>
              <button class="btn sm" title="上移" :disabled="i === 0" @click.stop="moveComic(i, -1)">
                ↑
              </button>
              <button
                class="btn sm"
                title="下移"
                :disabled="i === comic.items.length - 1"
                @click.stop="moveComic(i, 1)"
              >
                ↓
              </button>
              <button class="btn sm danger" title="移除" @click.stop="removeComicItem(it.id)">
                ✕
              </button>
            </div>
          </template>
          <!-- 网格视图 -->
          <template v-else>
            <div class="c-gwrap" @pointerdown.stop="onRowDragDown($event, i)">
              <img class="c-gthumb" :src="thumbOf(it)" :alt="it.name" draggable="false" />
              <span class="c-gidx">{{ i + 1 }}</span>
              <span v-for="b in badgesOf(it, i)" :key="b.t" class="c-badge" :class="b.k">{{
                b.t
              }}</span>
              <div class="c-gops">
                <button class="btn sm" title="裁切 / 旋转" @click.stop="openEditor(i)">✎</button>
                <button class="btn sm danger" title="移除" @click.stop="removeComicItem(it.id)">
                  ✕
                </button>
              </div>
            </div>
            <div class="c-gname" :title="it.name">{{ it.name }}</div>
          </template>
        </div>
        <div v-if="!comic.items.length" class="c-empty">
          还没有图片<br />
          <span>点「＋ 添加图片」选择文件，或把图片拖进窗口 / Ctrl+V 粘贴</span>
          <div class="c-empty-ops">
            <button class="btn sm" @click="pickImages">＋ 选择文件</button>
            <button class="btn sm" title="读取剪贴板里的图片文件" @click="pasteIn">
              📥 导入剪贴板图片
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 中列：手机预览（仿公众号文章页样式，独立配色） -->
    <div class="comic-preview-col">
      <div class="col-split" title="拖动调整列宽" @pointerdown="startColResize('preview', $event)" />
      <div class="phone" :class="phoneCls" :style="{ zoom: previewZoom }">
        <div class="ph-status">
          <span>{{ clockText }}</span>
          <span class="ph-status-r">5G&nbsp;▮▮▮</span>
        </div>
        <div class="ph-nav">
          <span class="ph-back">‹</span>
          <span class="ph-more">⋯</span>
        </div>
        <div ref="phScrollEl" class="ph-scroll">
          <div class="ph-head">
            <div
              class="ph-title"
              contenteditable="true"
              spellcheck="false"
              title="点击编辑标题"
              @blur="phText.title = ($event.target as HTMLElement).textContent?.trim() || phText.title; savePhText()"
              @keydown.enter.prevent="($event.target as HTMLElement).blur()"
            >
              {{ phText.title }}
            </div>
            <div class="ph-meta">
              <span class="ph-tag">原创</span>
              <span
                contenteditable="true"
                spellcheck="false"
                title="点击编辑作者名"
                class="ph-author"
                @blur="phText.author = ($event.target as HTMLElement).textContent?.trim() || phText.author; savePhText()"
                @keydown.enter.prevent="($event.target as HTMLElement).blur()"
              >
                {{ phText.author }}
              </span>
              <span>· 今天</span>
            </div>
          </div>
          <canvas v-if="comic.items.length" ref="previewEl" class="ph-canvas" />
          <div v-if="!comic.items.length" class="ph-empty">加入图片后<br />这里就是手机上的效果</div>
        </div>
        <div class="ph-footer">
          <span class="ph-avatar">🐶</span>
          <span class="ph-name">{{ phText.author }}</span>
          <span class="ph-stats">♡ 44&emsp;💬 3</span>
        </div>
      </div>
      <div class="phone-cap">
        <span class="pc-title">手机预览</span>
        <span v-if="outDims" class="pc-dims">{{ outDims.w }}×{{ outDims.h }}</span>
        <span class="flex1" />
        <button
          class="pt-toggle ic"
          :title="`预览配色：${PTheme_UI[previewTheme].label}（点击切换）`"
          @click="cyclePreviewTheme"
        >
          {{ PTheme_UI[previewTheme].icon }}
        </button>
        <span class="pt-toggle-group">
          <button
            v-for="z in [1, 0.75, 0.6]"
            :key="z"
            class="pt-toggle"
            :class="{ on: previewZoom === z }"
            :title="`预览缩放 ${z * 100}%`"
            @click="setZoom(z)"
          >
            {{ z * 100 }}%
          </button>
        </span>
        <button class="pt-toggle ic" title="回到长图顶部" @click="previewTop">↑</button>
      </div>
    </div>

    <!-- 右列：预设 + 合成参数 -->
    <div class="comic-right">
      <div class="col-split" title="拖动调整列宽" @pointerdown="startColResize('params', $event)" />
      <div class="p-card">
        <h4 class="foldable" @click="toggleFold('preset')">
          参数预设<span class="caret">{{ folded.preset ? '▸' : '▾' }}</span>
        </h4>
        <div v-show="!folded.preset" class="preset-chips">
          <span v-if="!presetNames.length" class="pchint">调好参数后点「＋ 存当前」保存成预设</span>
          <span
            v-for="n in presetNames"
            :key="n"
            class="pchip"
            :class="{ on: presetSel === n }"
            :title="`点击应用预设「${n}」`"
            @click="applyPreset(n)"
          >
            {{ n }}
            <i class="pchip-x" title="删除此预设" @click.stop="delPreset(n)">✕</i>
          </span>
          <span v-if="!savingPreset" class="pchip add" title="把当前所有参数存为预设" @click="savingPreset = true">
            ＋ 存当前
          </span>
          <span v-else class="psave">
            <input
              v-model="presetName"
              type="text"
              placeholder="预设名，回车保存"
              @keyup.enter="savePreset"
              @keyup.esc="savingPreset = false"
            />
            <button class="btn sm" :disabled="!presetName.trim()" @click="savePreset">存</button>
            <button class="btn sm" title="取消" @click="savingPreset = false">✕</button>
          </span>
        </div>
      </div>

      <div class="p-card">
        <h4 class="foldable" @click="toggleFold('canvas')">
          画布<span class="caret">{{ folded.canvas ? '▸' : '▾' }}</span>
        </h4>
        <div v-show="!folded.canvas" class="p-body">
        <div class="p-row">
          <span class="lbl">目标宽度</span>
          <span class="p-inline">
            <button
              v-for="w in [720, 1080, 1440]"
              :key="w"
              class="chip"
              :class="{ on: comic.settings.width === w }"
              @click="comic.settings.width = w"
            >
              {{ w }}
            </button>
            <input
              v-model.number="comic.settings.width"
              type="number"
              min="200"
              max="4000"
              class="w-input"
            />
            <span class="val">px</span>
          </span>
        </div>
        <div class="p-row">
          <span class="lbl">图间距</span>
          <input v-model.number="comic.settings.gap" type="range" min="0" max="60" />
          <span class="val">{{ comic.settings.gap }}px</span>
        </div>
        <div class="p-row">
          <span class="lbl">四周留白</span>
          <input v-model.number="comic.settings.outerMargin" type="range" min="0" max="80" />
          <span class="val">{{ comic.settings.outerMargin }}px</span>
        </div>
        <div class="p-row">
          <span class="lbl">背景色</span>
          <ColorPick v-model="comic.settings.bgColor" />
        </div>
        <div class="p-row">
          <span class="lbl">图片圆角</span>
          <input v-model.number="comic.settings.radius" type="range" min="0" max="48" />
          <span class="val">{{ comic.settings.radius }}px</span>
        </div>
        </div>
      </div>

      <div class="p-card">
        <h4 class="foldable" @click="toggleFold('frame')">
          图片细框<span class="caret">{{ folded.frame ? '▸' : '▾' }}</span>
        </h4>
        <div v-show="!folded.frame" class="p-body">
        <div class="p-row">
          <span class="lbl">框样式</span>
          <span class="seg">
            <button
              :class="{ on: comic.settings.frameMode === 'outset' }"
              title="框画在图片外围，占位（白边相框感）"
              @click="comic.settings.frameMode = 'outset'"
            >
              图外相框
            </button>
            <button
              :class="{ on: comic.settings.frameMode === 'inset' }"
              title="框压在图片边缘内侧，不占位"
              @click="comic.settings.frameMode = 'inset'"
            >
              图内描边
            </button>
          </span>
        </div>
        <div class="p-row">
          <span class="lbl">框宽</span>
          <input v-model.number="comic.settings.borderWidth" type="range" min="0" max="10" step="0.5" />
          <span class="val">{{ comic.settings.borderWidth }}px</span>
        </div>
        <div class="p-row">
          <span class="lbl">框色</span>
          <ColorPick v-model="comic.settings.borderColor" />
        </div>
        </div>
      </div>

      <div class="p-card">
        <h4 class="foldable" @click="toggleFold('output')">
          输出<span class="caret">{{ folded.output ? '▸' : '▾' }}</span>
        </h4>
        <div v-show="!folded.output" class="p-body">
        <div class="p-row">
          <span class="lbl">格式</span>
          <span class="seg">
            <button
              :class="{ on: comic.settings.format === 'jpg' }"
              title="体积小，适合发文章"
              @click="comic.settings.format = 'jpg'"
            >
              JPG
            </button>
            <button
              :class="{ on: comic.settings.format === 'png' }"
              title="无损，体积大"
              @click="comic.settings.format = 'png'"
            >
              PNG
            </button>
          </span>
        </div>
        <div class="p-row" v-if="comic.settings.format === 'jpg'">
          <span class="lbl">质量</span>
          <input v-model.number="comic.settings.quality" type="range" min="50" max="100" />
          <span class="val">{{ comic.settings.quality }}</span>
        </div>
        <div class="p-row">
          <span class="lbl">分段导出</span>
          <label class="p-check">
            <input v-model="comic.settings.splitEnabled" type="checkbox" />
            <span>超长图自动分段</span>
          </label>
        </div>
        <div class="p-row" v-if="comic.settings.splitEnabled">
          <span class="lbl">每段上限</span>
          <input v-model.number="comic.settings.splitLimit" type="number" min="1500" max="30000" step="500" />
          <span class="val">px（按图分，不切图）</span>
        </div>
        <div class="p-row">
          <span class="lbl">署名条</span>
          <label class="p-check">
            <input v-model="comic.settings.signEnabled" type="checkbox" />
            <span>长图底部加一条</span>
          </label>
        </div>
        <template v-if="comic.settings.signEnabled">
          <div class="p-row">
            <span class="lbl">署名文字</span>
            <input v-model="comic.settings.signText" type="text" placeholder="例：小金毛出品" />
          </div>
          <div class="p-row">
            <span class="lbl">条底色</span>
            <ColorPick v-model="comic.settings.signBg" />
          </div>
          <div class="p-row">
            <span class="lbl">文字色</span>
            <ColorPick v-model="comic.settings.signColor" />
          </div>
        </template>
        <div class="p-row">
          <span class="lbl">水印</span>
          <label class="p-check">
            <input v-model="comic.settings.wmEnabled" type="checkbox" />
            <span>图上平铺半透明文字</span>
          </label>
        </div>
        <template v-if="comic.settings.wmEnabled">
          <div class="p-row">
            <span class="lbl">水印文字</span>
            <input v-model="comic.settings.wmText" type="text" placeholder="例：@小金毛" />
          </div>
          <div class="p-row">
            <span class="lbl">颜色</span>
            <ColorPick v-model="comic.settings.wmColor" />
          </div>
          <div class="p-row">
            <span class="lbl">不透明度</span>
            <input v-model.number="comic.settings.wmOpacity" type="range" min="5" max="60" />
            <span class="val">{{ comic.settings.wmOpacity }}%</span>
          </div>
          <div class="p-row">
            <span class="lbl">字号</span>
            <input v-model.number="comic.settings.wmSize" type="range" min="2" max="12" step="0.5" />
            <span class="val">宽度的 {{ comic.settings.wmSize }}%</span>
          </div>
        </template>
        </div>
      </div>

      <button
        class="btn primary export"
        :disabled="!comic.items.length || comic.busy"
        @click="doExport"
      >
        {{ comic.busy ? '正在合成…' : estSize ? `合并并导出长图（约 ${fmtSize(estSize)}）` : '合并并导出长图' }}
      </button>
      <button
        class="btn export"
        :disabled="!comic.items.length || comic.busy"
        title="每张图按当前设置（宽度/细框/圆角/背景/水印）单独导出成文件"
        @click="doExportSingles"
      >
        🖼 {{ comic.items.length }} 张单图分别导出
      </button>
      <button
        v-if="lastExport"
        class="btn export"
        title="在资源管理器中定位到导出的长图"
        @click="openExportDir"
      >
        📂 打开所在文件夹
      </button>
    </div>

    <!-- 裁切 / 旋转编辑器 -->
    <div v-if="editing !== null" class="crop-mask" @click.self="closeEditor">
      <div class="crop-modal">
        <div class="crop-head">
          <h3>编辑 · {{ editItem?.name }}</h3>
          <button class="btn ghost sm" @click="closeEditor">✕</button>
        </div>
        <div
          ref="stageEl"
          class="crop-stage"
          :style="{ width: stageW + 'px', height: stageH + 'px' }"
        >
          <canvas ref="stageCanvas" />
          <div class="crop-rect" :style="rectStyle" @pointerdown="startEdit('move', $event)">
            <span class="crop-dot nw" @pointerdown="startEdit('nw', $event)" />
            <span class="crop-dot ne" @pointerdown="startEdit('ne', $event)" />
            <span class="crop-dot sw" @pointerdown="startEdit('sw', $event)" />
            <span class="crop-dot se" @pointerdown="startEdit('se', $event)" />
          </div>
        </div>
        <div class="crop-tools">
          <span class="lbl">比例</span>
          <button
            v-for="p in CROP_PRESETS"
            :key="p.label"
            class="chip"
            :class="{ on: p.ratio !== null && ratioLock === p.ratio }"
            @click="applyCropPreset(p)"
          >
            {{ p.label }}
          </button>
          <span class="flex1" />
          <button class="btn sm" title="顺时针转 90°（裁切框会重置）" @click="doRotate">⟳ 旋转</button>
          <button class="btn sm" @click="resetEdit">还原</button>
        </div>
        <div class="crop-tools">
          <button
            class="btn sm"
            :class="{ 'chip-on': editFlipH }"
            title="水平镜像"
            @click="doFlipH"
          >
            ⇋ 水平
          </button>
          <button
            class="btn sm"
            :class="{ 'chip-on': editFlipV }"
            title="垂直镜像"
            @click="doFlipV"
          >
            ⥯ 垂直
          </button>
          <span class="lbl adj-lbl">亮度</span>
          <input v-model.number="editAdj.bright" type="range" min="40" max="180" class="adj" />
          <span class="lbl adj-lbl">对比</span>
          <input v-model.number="editAdj.contrast" type="range" min="40" max="180" class="adj" />
          <span class="lbl adj-lbl">饱和</span>
          <input v-model.number="editAdj.satur" type="range" min="0" max="200" class="adj" />
          <label class="p-check" title="给透明图垫个底色">
            <input v-model="editFillOn" type="checkbox" />
            <span>填充底色</span>
          </label>
          <ColorPick v-if="editFillOn" v-model="editFill" />
        </div>
        <div class="crop-foot">
          <span class="tip">拖动边角或整体调整裁切框；选比例后拖角会锁定比例</span>
          <button class="btn" @click="closeEditor">取消</button>
          <button class="btn primary" @click="applyEditor">应用</button>
        </div>
      </div>
    </div>
  </div>
</template>
