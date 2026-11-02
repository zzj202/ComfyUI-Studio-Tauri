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
  copyComicToClipboard,
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
  reverseComic,
  savePresets,
  sortComic,
  syncHistory,
  undoComic,
  DEFAULT_SETTINGS,
  type ComicItem,
  type ComicSettings,
  type SortMode,
} from '../core/comic'
import { cycleTheme, isDarkNow, themeMode } from '../core/theme'
import { ui } from '../ui'
import ColorPick from './ColorPick.vue'
import NumBox from './NumBox.vue'

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
  window.addEventListener('pointerdown', onDocPointerDown, true)
  mqNarrow = window.matchMedia('(max-width: 1200px)')
  mqTiny = window.matchMedia('(max-width: 900px)')
  mqNarrow.addEventListener('change', syncLayout)
  mqTiny.addEventListener('change', syncLayout)
  syncLayout()
})
onUnmounted(() => {
  imageDropTargets.delete(DROP_KEY)
  assetDropTargets.delete(DROP_KEY)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pointerdown', onDocPointerDown, true)
  mqNarrow?.removeEventListener('change', syncLayout)
  mqTiny?.removeEventListener('change', syncLayout)
})

// ---------------------------------------------------------------- 窄屏布局
// <1200px 收起预览列（按需浮层打开）；<900px 参数列变右侧抽屉。
// 纯 CSS 做不到「列宽仍可拖」+「抽屉按需打开」，所以断点状态放 JS，样式用媒体查询兜底。

// 初始值直接同步取一次，避免首帧先按三列渲染再塌陷（会闪一下）
const narrow = ref(window.matchMedia('(max-width: 1200px)').matches)
const tiny = ref(window.matchMedia('(max-width: 900px)').matches)
const drawerOpen = ref(false)
const previewOpen = ref(false)
const sortOpen = ref(false)
const moreOpen = ref(false)
const helpOpen = ref(false)
let mqNarrow: MediaQueryList | null = null
let mqTiny: MediaQueryList | null = null

function syncLayout() {
  narrow.value = mqNarrow?.matches ?? false
  tiny.value = mqTiny?.matches ?? false
  if (!tiny.value) drawerOpen.value = false
  if (!narrow.value) previewOpen.value = false
}

/** 点空白处收起下拉菜单 */
function onDocPointerDown(e: PointerEvent) {
  const el = e.target as HTMLElement | null
  if (!el?.closest('.menu-wrap')) {
    sortOpen.value = false
    moreOpen.value = false
  }
}

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
  // 编辑台打开时按键归编辑台：←/→ 应用并切图、Esc 关闭；
  // 不能再落到列表快捷键上（否则 Delete / ↑↓ 会误删、误移后面的图）
  if (editing.value !== null) {
    if (inInput) return
    if (k === 'escape') {
      e.preventDefault()
      closeEditor()
    } else if (k === 'arrowleft' || k === 'arrowright') {
      e.preventDefault()
      switchEdit(k === 'arrowleft' ? -1 : 1)
    }
    return
  }
  // 大图查看器
  if (viewing.value !== null) {
    if (k === 'escape') {
      e.preventDefault()
      viewing.value = null
    } else if (k === 'arrowleft' || k === 'arrowright') {
      e.preventDefault()
      viewerStep(k === 'arrowleft' ? -1 : 1)
    }
    return
  }
  if (inInput) return
  if (k === '?') {
    e.preventDefault()
    helpOpen.value = true
    return
  }
  if (k === ' ' || k === 'spacebar') {
    if (sel.size === 1) {
      e.preventDefault()
      const id = [...sel][0]
      const i = comic.items.findIndex((it) => it.id === id)
      if (i >= 0) viewing.value = i
    }
    return
  }
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
/** 行视图的落点横线（相对 .comic-list 的 y）/ 网格视图高亮的目标格 */
const dropLine = ref<number | null>(null)
const dropTargetIdx = ref<number | null>(null)

/** 按指针在目标行里的上/下半区，决定横线画在它上面还是下面 */
function updateDropLine(target: number) {
  dropTargetIdx.value = target
  const list = listEl.value
  if (!list || gridView.value) {
    dropLine.value = null
    return
  }
  const row = list.querySelector<HTMLElement>(`[data-cidx="${target}"]`)
  if (!row) return
  const rr = row.getBoundingClientRect()
  const lr = list.getBoundingClientRect()
  const after = dragLastY > rr.top + rr.height / 2
  dropLine.value = rr.top - lr.top + list.scrollTop + (after ? rr.height : 0)
}

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
  updateDropLine(target)
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
  dropLine.value = null
  dropTargetIdx.value = null
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

// ---------------------------------------------------------------- 大图查看（空格 / 缩略图）

const viewing = ref<number | null>(null)

function openViewer(i: number) {
  viewing.value = i
}

function viewerStep(d: number) {
  if (viewing.value === null) return
  const n = viewing.value + d
  if (n >= 0 && n < comic.items.length) viewing.value = n
}

/** 从查看器直接进编辑台（看完想改的常见路径） */
function viewerEdit() {
  if (viewing.value === null) return
  const i = viewing.value
  viewing.value = null
  void openEditor(i)
}

// ---------------------------------------------------------------- 排序 / 复制 / 快捷键

/** 排序下拉：选完立刻收起 */
function doSort(mode: SortMode) {
  sortOpen.value = false
  void sortComic(mode)
}

function doReverse() {
  sortOpen.value = false
  reverseComic()
}

async function doCopy() {
  await copyComicToClipboard()
}

/** 导出进度百分比（没有进度时 0） */
const progressPct = computed(() => {
  const p = comic.progress
  if (!p || !p.total) return 0
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)))
})

const SHORTCUTS: [string, string][] = [
  ['Ctrl + Z', '撤销'],
  ['Ctrl + Y / Ctrl + Shift + Z', '重做'],
  ['Ctrl + A', '全选列表'],
  ['Delete / Backspace', '删除所选'],
  ['↑ / ↓', '所选单张上移 / 下移'],
  ['← / →', '编辑台：应用并切上一张 / 下一张'],
  ['空格', '查看所选大图'],
  ['Esc', '关闭编辑台 / 查看器 / 取消选择'],
  ['?', '打开这个面板'],
  ['Ctrl + V', '粘贴图片加入列表'],
  ['拖文件进窗口', '直接加入列表'],
]

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
  // 列宽交给 CSS 变量：媒体查询里窄屏要能覆盖掉（内联 grid-template-columns 会压过媒体查询）
  '--pw': `${previewW.value}px`,
  '--rw': `${paramsW.value}px`,
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

/** 一键展开 / 折叠全部参数卡（窗口小的时候很省事） */
function foldAll(v: boolean) {
  for (const k of ['preset', 'canvas', 'frame', 'output']) folded[k] = v
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
/** 预览里每张图顶部的 y（canvas 像素）与占高：给右侧导航条定位用 */
const previewTops = ref<number[]>([])
const previewHeights = ref<number[]>([])
const curIdx = ref(0)
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
    previewTops.value = []
    previewHeights.value = []
    return
  }
  const dims = await renderInner(c)
  if (token !== renderToken) return // 已有更新的渲染排队，丢弃这次
  outDims.value = dims
    ? { w: comic.settings.width, h: Math.round(dims.height * (comic.settings.width / dims.width)) }
    : null
  previewTops.value = dims?.tops ?? []
  previewHeights.value = dims?.advs ?? []
  void estimateSize()
}

// ---- 长图导航条：滚到第几张、点一段跳过去 ----

/** 每段按占高分配高度（最少 6px，不然细条点不中） */
const railSegs = computed(() => previewHeights.value.map((h) => Math.max(6, Math.round(h))))

function scrollToBlock(i: number) {
  const c = previewEl.value
  const el = phScrollEl.value
  const top = previewTops.value[i]
  if (!c || !el || top == null) return
  const scale = (c.clientWidth || 1) / (c.width || 1)
  const canvasTop = c.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
  el.scrollTo({ top: Math.max(0, canvasTop + top * scale - 4), behavior: 'smooth' })
  curIdx.value = i
}

/** 滚动时更新「当前第几张」（按 canvas 顶边换算） */
function onPhScroll() {
  const c = previewEl.value
  const el = phScrollEl.value
  const tops = previewTops.value
  if (!c || !el || !tops.length) return
  const scale = (c.clientWidth || 1) / (c.width || 1)
  const canvasTop = c.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
  const y = el.scrollTop - canvasTop
  let idx = 0
  for (let i = 0; i < tops.length; i++) {
    if (y >= tops[i] * scale - 2) idx = i
  }
  curIdx.value = idx
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

/** 编辑台里的值跟条目本身是否不同（决定切图/应用时要不要压一步撤销） */
function editDirty(): boolean {
  const it = editItem.value
  if (!it) return false
  const a = it.adjust ?? { bright: 100, contrast: 100, satur: 100 }
  const fullR = rect.x <= 0.001 && rect.y <= 0.001 && rect.w >= 0.999 && rect.h >= 0.999
  let cropSame: boolean
  if (!it.crop) {
    cropSame = fullR
  } else if (fullR) {
    cropSame = false
  } else {
    const c = it.crop
    cropSame =
      Math.abs(c.x - rect.x) < 1e-4 &&
      Math.abs(c.y - rect.y) < 1e-4 &&
      Math.abs(c.w - rect.w) < 1e-4 &&
      Math.abs(c.h - rect.h) < 1e-4
  }
  return (
    it.rotate % 4 !== editRotate.value % 4 ||
    it.flipH !== editFlipH.value ||
    it.flipV !== editFlipV.value ||
    a.bright !== editAdj.bright ||
    a.contrast !== editAdj.contrast ||
    a.satur !== editAdj.satur ||
    (it.fill ?? null) !== (editFillOn.value ? editFill.value : null) ||
    !cropSame
  )
}

function applyEditor() {
  const it = editItem.value
  if (!it || editing.value === null) return
  // 没动过就不压撤销栈：连着看 20 张不会把历史挤满
  if (editDirty()) pushHistory()
  it.rotate = editRotate.value % 4
  it.flipH = editFlipH.value
  it.flipV = editFlipV.value
  it.adjust = { ...editAdj }
  it.fill = editFillOn.value ? editFill.value : null
  const full = rect.x <= 0.001 && rect.y <= 0.001 && rect.w >= 0.999 && rect.h >= 0.999
  it.crop = full ? null : { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
  editing.value = null
}

/** ← / →：当前这张先应用（没改动就跳过），紧接着打开相邻那张——连续修图不用关窗再双击 */
function switchEdit(d: number) {
  if (editing.value === null) return
  const next = editing.value + d
  if (next < 0 || next >= comic.items.length) return
  applyEditor()
  void openEditor(next)
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
        <div class="tb-group">
          <button class="btn sm" @click="pickImages">＋ 添加图片</button>
          <button
            class="btn sm"
            title="分析所有图的宽高，按最常见比例统一居中裁切，画面更整齐"
            @click="doUniform"
          >
            🎯 一键铺满
          </button>
        </div>
        <span class="tb-sep" />
        <div class="tb-group">
          <button
            class="btn sm"
            :disabled="!comicHistory.undo"
            title="撤销上一步（Ctrl+Z）"
            @click="undoComic()"
          >
            ↶
          </button>
          <button
            class="btn sm"
            :disabled="!comicHistory.redo"
            title="重做（Ctrl+Y）"
            @click="redoComic()"
          >
            ↷
          </button>
        </div>
        <span class="tb-sep" />
        <div class="tb-group">
          <button
            class="btn sm"
            :title="gridView ? '切换为行视图' : '切换为网格视图'"
            @click="toggleGrid"
          >
            {{ gridView ? '📃 列表' : '▦ 网格' }}
          </button>
          <div class="menu-wrap">
            <button class="btn sm" title="排序 / 打乱顺序" @click.stop="sortOpen = !sortOpen">
              ⇅ 排序 ▾
            </button>
            <div v-if="sortOpen" class="tb-menu" @click.stop>
              <button @click="doSort('name')">按文件名（p2 在 p10 前）</button>
              <button @click="doSort('time')">按文件修改时间</button>
              <button @click="doSort('random')">随机打乱</button>
              <button @click="doReverse">反转当前顺序</button>
            </div>
          </div>
        </div>
        <span class="flex1" />
        <div class="tb-group">
          <button v-if="narrow" class="btn sm" title="打开手机预览" @click="previewOpen = true">
            📱 预览
          </button>
          <button v-if="tiny" class="btn sm" title="打开参数面板" @click="drawerOpen = true">
            ⚙ 参数
          </button>
          <button
            class="btn sm"
            :title="`本页主题：${THEME_UI[themeMode].label}（点击切换 跟随系统/深色/亮色）`"
            @click="cycleTheme"
          >
            {{ THEME_UI[themeMode].icon }}
          </button>
          <div class="menu-wrap">
            <button class="btn sm" title="更多" @click.stop="moreOpen = !moreOpen">⋯</button>
            <div v-if="moreOpen" class="tb-menu right" @click.stop>
              <button @click="moreOpen = false; helpOpen = true">⌨ 快捷键 / 帮助</button>
              <button @click="moreOpen = false; foldAll(false)">展开全部参数卡</button>
              <button @click="moreOpen = false; foldAll(true)">折叠全部参数卡</button>
              <button
                class="danger"
                :disabled="!comic.items.length"
                @click="moreOpen = false; doClear()"
              >
                清空列表
              </button>
            </div>
          </div>
        </div>
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
        :class="{ grid: gridView, dragging: dragIdx !== null }"
        :data-image-key="DROP_KEY"
      >
        <div
          v-for="(it, i) in comic.items"
          :key="it.id"
          class="c-row"
          :class="{
            lifting: dragIdx === i,
            selected: sel.has(it.id),
            grid: gridView,
            'drop-target': gridView && dropTargetIdx === i,
          }"
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
              <button class="btn sm" title="查看大图（空格）" @click.stop="openViewer(i)">👁</button>
              <button class="btn sm" title="裁切 / 旋转（双击）" @click.stop="openEditor(i)">✎</button>
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
                <button class="btn sm" title="查看大图（空格）" @click.stop="openViewer(i)">👁</button>
                <button class="btn sm" title="裁切 / 旋转（双击）" @click.stop="openEditor(i)">✎</button>
                <button class="btn sm danger" title="移除" @click.stop="removeComicItem(it.id)">
                  ✕
                </button>
              </div>
            </div>
            <div class="c-gname" :title="it.name">{{ it.name }}</div>
          </template>
        </div>
        <!-- 拖动排序的落点横线：松手前就知道会插到哪两行之间 -->
        <div v-if="dropLine !== null" class="c-dropline" :style="{ top: dropLine + 'px' }" />
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
    <div class="comic-preview-col" :class="{ float: previewOpen }">
      <div class="col-split" title="拖动调整列宽" @pointerdown="startColResize('preview', $event)" />
      <div class="ph-wrap">
      <div class="phone" :class="phoneCls" :style="{ zoom: previewZoom }">
        <div class="ph-status">
          <span>{{ clockText }}</span>
          <span class="ph-status-r">5G&nbsp;▮▮▮</span>
        </div>
        <div class="ph-nav">
          <span class="ph-back">‹</span>
          <span class="ph-more">⋯</span>
        </div>
        <div ref="phScrollEl" class="ph-scroll" @scroll.passive="onPhScroll">
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
        <!-- 长图导航条：每段高度按图占高分配，点一下跳到那张 -->
        <div
          v-if="comic.items.length > 1 && previewTops.length"
          class="ph-rail"
          title="长图导航：点一段跳到对应图片"
        >
          <button
            v-for="(h, i) in railSegs"
            :key="i"
            class="ph-tick"
            :class="{ on: curIdx === i }"
            :style="{ flexGrow: h }"
            :title="`第 ${i + 1} 张`"
            @click="scrollToBlock(i)"
          />
        </div>
      </div>
      <div class="phone-cap">
        <span class="pc-title">手机预览</span>
        <span v-if="outDims" class="pc-dims">{{ outDims.w }}×{{ outDims.h }}</span>
        <span v-if="comic.items.length > 1" class="pc-idx">{{ curIdx + 1 }}/{{ comic.items.length }}</span>
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
        <button v-if="previewOpen" class="pt-toggle ic" title="关闭预览" @click="previewOpen = false">
          ✕
        </button>
      </div>
    </div>

    <!-- 右列：预设 + 合成参数（<900px 时变右侧抽屉） -->
    <div v-if="tiny && drawerOpen" class="drawer-mask" @click="drawerOpen = false" />
    <div class="comic-right" :class="{ open: drawerOpen }">
      <div class="drawer-head">
        <span>合成参数</span>
        <button class="btn ghost sm" title="收起" @click="drawerOpen = false">✕</button>
      </div>
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
          <NumBox v-model="comic.settings.gap" :min="0" :max="60" unit="px" :dflt="0" />
        </div>
        <div class="p-row">
          <span class="lbl">四周留白</span>
          <input v-model.number="comic.settings.outerMargin" type="range" min="0" max="80" />
          <NumBox v-model="comic.settings.outerMargin" :min="0" :max="80" unit="px" :dflt="0" />
        </div>
        <div class="p-row">
          <span class="lbl">背景色</span>
          <ColorPick v-model="comic.settings.bgColor" />
        </div>
        <div class="p-row">
          <span class="lbl">图片圆角</span>
          <input v-model.number="comic.settings.radius" type="range" min="0" max="48" />
          <NumBox v-model="comic.settings.radius" :min="0" :max="48" unit="px" :dflt="0" />
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
          <NumBox
            v-model="comic.settings.borderWidth"
            :min="0"
            :max="10"
            :step="0.5"
            unit="px"
            :dflt="2"
          />
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
          <NumBox v-model="comic.settings.quality" :min="50" :max="100" :dflt="92" />
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
            <NumBox v-model="comic.settings.wmOpacity" :min="5" :max="60" unit="%" :dflt="25" />
          </div>
          <div class="p-row">
            <span class="lbl">字号</span>
            <input v-model.number="comic.settings.wmSize" type="range" min="2" max="12" step="0.5" />
            <NumBox
              v-model="comic.settings.wmSize"
              :min="2"
              :max="12"
              :step="0.5"
              unit="%"
              :dflt="5"
            />
          </div>
        </template>
        </div>
      </div>

      <!-- 导出区吸底：参数卡再多也不用往下翻找按钮 -->
      <div class="export-dock">
        <div v-if="comic.progress" class="prog">
          <div class="prog-bar"><i :style="{ width: progressPct + '%' }" /></div>
          <span class="prog-txt">
            {{ comic.progress.label }} {{ comic.progress.done }}/{{ comic.progress.total }}
          </span>
        </div>
        <button
          class="btn primary export"
          :disabled="!comic.items.length || comic.busy"
          @click="doExport"
        >
          {{
            comic.busy
              ? comic.progress
                ? `正在合成 ${comic.progress.done}/${comic.progress.total}…`
                : '正在合成…'
              : estSize
                ? `合并并导出长图（约 ${fmtSize(estSize)}）`
                : '合并并导出长图'
          }}
        </button>
        <div class="export-row">
          <button
            class="btn export"
            :disabled="!comic.items.length || comic.busy"
            title="把整张长图复制到剪贴板，直接粘进公众号编辑器（PNG 无损，不受导出格式影响）"
            @click="doCopy"
          >
            📋 复制长图
          </button>
          <button
            class="btn export"
            :disabled="!comic.items.length || comic.busy"
            title="每张图按当前设置（宽度/细框/圆角/背景/水印）单独导出成文件"
            @click="doExportSingles"
          >
            🖼 单图 ×{{ comic.items.length }}
          </button>
        </div>
        <button
          v-if="lastExport"
          class="btn export"
          title="在资源管理器中定位到导出的长图"
          @click="openExportDir"
        >
          📂 打开所在文件夹
        </button>
      </div>
    </div>

    <!-- 裁切 / 旋转编辑器 -->
    <div v-if="editing !== null" class="crop-mask" @click.self="closeEditor">
      <div class="crop-modal">
        <div class="crop-head">
          <h3>编辑 · {{ editItem?.name }}</h3>
          <span class="crop-nav">
            <button
              class="btn ghost sm"
              :disabled="editing === 0"
              title="上一张（←），当前改动会先应用"
              @click="switchEdit(-1)"
            >
              ‹
            </button>
            <span class="crop-count">{{ (editing ?? 0) + 1 }} / {{ comic.items.length }}</span>
            <button
              class="btn ghost sm"
              :disabled="editing === comic.items.length - 1"
              title="下一张（→），当前改动会先应用"
              @click="switchEdit(1)"
            >
              ›
            </button>
            <button class="btn ghost sm" title="关闭（Esc）" @click="closeEditor">✕</button>
          </span>
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
          <span class="tip">拖动边角或整体调整裁切框；选比例后拖角会锁定比例 · ←/→ 应用并切换上一张/下一张</span>
          <button class="btn" @click="closeEditor">取消</button>
          <button class="btn primary" @click="applyEditor">应用</button>
        </div>
      </div>
    </div>

    <!-- 大图查看器（空格 / 列表里的 👁） -->
    <div v-if="viewing !== null && comic.items[viewing]" class="viewer-mask" @click.self="viewing = null">
      <img class="viewer-img" :src="thumbOf(comic.items[viewing])" :alt="comic.items[viewing].name" />
      <div class="viewer-bar">
        <button
          class="btn sm"
          :disabled="viewing === 0"
          title="上一张（←）"
          @click="viewerStep(-1)"
        >
          ‹
        </button>
        <span class="viewer-count">{{ viewing + 1 }} / {{ comic.items.length }}</span>
        <button
          class="btn sm"
          :disabled="viewing === comic.items.length - 1"
          title="下一张（→）"
          @click="viewerStep(1)"
        >
          ›
        </button>
        <button class="btn sm" title="去裁切 / 调色" @click="viewerEdit">✎ 编辑</button>
        <button class="btn sm" title="关闭（Esc）" @click="viewing = null">✕</button>
      </div>
    </div>

    <!-- 快捷键面板（? 或工具栏 ⋯） -->
    <div v-if="helpOpen" class="crop-mask" @click.self="helpOpen = false">
      <div class="crop-modal help-modal">
        <div class="crop-head">
          <h3>键盘快捷键</h3>
          <button class="btn ghost sm" @click="helpOpen = false">✕</button>
        </div>
        <div class="help-grid">
          <template v-for="[key, desc] in SHORTCUTS" :key="key">
            <kbd>{{ key }}</kbd>
            <span>{{ desc }}</span>
          </template>
        </div>
        <div class="crop-foot">
          <span class="tip">数值框里 ↑/↓ 微调一格，按住 Shift 一次走 10 格</span>
          <button class="btn primary" @click="helpOpen = false">知道了</button>
        </div>
      </div>
    </div>
  </div>
</template>
