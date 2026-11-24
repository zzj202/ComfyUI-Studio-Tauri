<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type { Asset, FieldAction, FieldSchema } from '../core/types'
import { api, saveTempBlob, viewUrl } from '../api/tauri'
import {
  BITMAP_MIME_RE,
  IMG_EXT_RE,
  extFromFile,
  extFromMime,
  filesFromClipboardData,
} from '../core/clipboard'
import { open } from '@tauri-apps/plugin-dialog'
import { appConfirm } from '../core/confirm'
import {
  assetDropTargets,
  fieldDirty,
  imageDropTargets,
  imageOriginBase,
  notify,
  openBatchTextDialog,
  openPairedDialog,
  pasteSubmitField,
  primaryBase,
  promptHistory,
  recordImageOrigin,
  state,
} from '../store'
import { randomSeed, VIDEO_EXT, AUDIO_EXT } from '../core/parseWorkflow'
import { stableKeys, useDragSort } from '../core/dragSort'

const props = defineProps<{ field: FieldSchema }>()

/** 与上次提交时的值不同 → 标题旁亮一个点（seed 字段每次提交自动换新，不参与对比） */
const dirty = computed(() => fieldDirty(props.field))

const uploading = ref(false)
const imgOptions = ref<string[] | null>(null)
const ta = ref<HTMLTextAreaElement | null>(null)

const ACTION_ICON: Record<FieldAction, string> = {
  randomize: '🎲',
  clear: '⌫',
  step: '±',
}
const ACTION_TITLE: Record<FieldAction, string> = {
  randomize: '随机值',
  clear: '清空 / 重置',
  step: '步进 +',
}

/** 下拉框：保证当前值一定在选项里，避免因为服务器选项变化把已选值悄悄改掉 */
const selectOptions = computed(() => {
  const opts = props.field.options ?? []
  const v = props.field.value
  if (v == null || v === '') return opts
  return opts.includes(String(v)) ? opts : [String(v), ...opts]
})

const hasRange = computed(
  () =>
    (props.field.kind === 'number' || props.field.kind === 'seed') &&
    props.field.min != null &&
    props.field.max != null &&
    props.field.max - props.field.min <= 4096
)

/** 服务器 input 目录里的图片预览地址（值形如 "xxx.png" 或 "子目录/xxx.png"）。
 *  多节点：回源到该 value 的上传源机器（无记录视为主节点） */
function inputUrl(v: string): string | null {
  const s = String(v ?? '').trim()
  if (!s || !/\.(png|jpe?g|webp|gif|bmp)$/i.test(s)) return null
  const i = s.indexOf('/')
  const sub = i >= 0 ? s.slice(0, i) : ''
  const name = i >= 0 ? s.slice(i + 1) : s
  try {
    return viewUrl(imageOriginBase(s), name, sub, 'input')
  } catch {
    return null
  }
}

/** 图片字段预览 */
const imgPreviewUrl = computed(() => (props.field.kind === 'image' ? inputUrl(String(props.field.value ?? '')) : null))

/** 视频字段预览地址（值形如 "xxx.mp4" 或 "子目录/xxx.mp4"；回源逻辑与图片一致） */
const vidPreviewUrl = computed(() => {
  if (props.field.kind !== 'video') return null
  const s = String(props.field.value ?? '').trim()
  if (!s || !VIDEO_EXT.test(s)) return null
  const i = s.indexOf('/')
  const sub = i >= 0 ? s.slice(0, i) : ''
  const name = i >= 0 ? s.slice(i + 1) : s
  try {
    return viewUrl(imageOriginBase(s), name, sub, 'input')
  } catch {
    return null
  }
})

/** 音频字段预览地址（值形如 "xxx.mp3" 或 "子目录/xxx.mp3"；回源逻辑与图片一致） */
const audPreviewUrl = computed(() => {
  if (props.field.kind !== 'audio') return null
  const s = String(props.field.value ?? '').trim()
  if (!s || !AUDIO_EXT.test(s)) return null
  const i = s.indexOf('/')
  const sub = i >= 0 ? s.slice(0, i) : ''
  const name = i >= 0 ? s.slice(i + 1) : s
  try {
    return viewUrl(imageOriginBase(s), name, sub, 'input')
  } catch {
    return null
  }
})

/** 多图字段的值：服务器文件名列表 */
const imgList = computed<string[]>(() => {  const v = props.field.value
  return Array.isArray(v) ? v.map(String) : v ? [String(v)] : []
})

function ensureList(): string[] {
  if (!Array.isArray(props.field.value)) {
    props.field.value = props.field.value ? [String(props.field.value)] : []
  }
  return props.field.value as string[]
}

async function loadImageOptions() {
  if (imgOptions.value) return
  try {
    const def = await api.objectInfo(primaryBase(), 'LoadImage')
    const list = def?.LoadImage?.input?.required?.image?.[0]
    imgOptions.value = Array.isArray(list) ? list.map(String) : []
  } catch {
    imgOptions.value = []
  }
}

async function refreshImages() {
  imgOptions.value = null
  await loadImageOptions()
}

/** 上传一个本地文件，返回服务器上的相对路径。
 *  上传统一进主节点（派发到其他节点时由调度器按需转存），并记录上传源 */
async function uploadOne(path: string): Promise<string | null> {
  uploading.value = true
  try {
    const base = primaryBase()
    const res = await api.uploadImage(base, path, undefined, 'studio', true)
    const name = String(res?.name ?? '')
    const sub = String(res?.subfolder ?? 'studio')
    const value = name ? (sub ? `${sub}/${name}` : name) : null
    if (value) recordImageOrigin(value, base)
    imgOptions.value = null
    return value
  } catch (e) {
    notify(`上传失败：${e}`, 'error', 8000)
    return null
  } finally {
    uploading.value = false
  }
}

/** 单图字段：上传并替换当前值 */
async function uploadPath(path: string) {
  const name = await uploadOne(path)
  if (name) {
    await loadImageOptions()
    props.field.value = name
    notify('已上传参考图', 'ok', 2500)
  }
}

async function pickAndUpload() {
  const picked = await open({
    multiple: false,
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  })
  if (!picked || Array.isArray(picked)) return
  await uploadPath(picked)
}

// ---- 视频字段（VHS_LoadVideo / LoadVideo 等）：上传卡 + 服务器视频列表 ----

const vidOptions = ref<string[] | null>(
  (props.field.options ?? []).length ? props.field.options!.map(String) : null
)

/** 拉服务器上该节点 video 输入的文件列表（VHS 的 combo 定义在 object_info 里） */
async function loadVideoOptions() {
  if (vidOptions.value) return
  try {
    const def = await api.objectInfo(primaryBase(), props.field.classType)
    const nodeDef = def?.[props.field.classType]
    const list =
      nodeDef?.input?.required?.[props.field.inputName]?.[0] ??
      nodeDef?.input?.optional?.[props.field.inputName]?.[0]
    vidOptions.value = Array.isArray(list) ? list.map(String) : []
  } catch {
    vidOptions.value = []
  }
}

async function refreshVideos() {
  vidOptions.value = null
  await loadVideoOptions()
}

/** 上传本地视频并替换当前值（与图片同链路：主节点 input/studio，跨机派发时按需转存） */
async function uploadVideoPath(path: string) {
  uploading.value = true
  try {
    const base = primaryBase()
    const res = await api.uploadImage(base, path, undefined, 'studio', true)
    const name = String(res?.name ?? '')
    const sub = String(res?.subfolder ?? 'studio')
    const value = name ? (sub ? `${sub}/${name}` : name) : null
    if (value) {
      recordImageOrigin(value, base)
      await loadVideoOptions()
      props.field.value = value
      notify('已上传视频', 'ok', 2500)
    }
  } catch (e) {
    notify(`上传失败：${e}`, 'error', 8000)
  } finally {
    uploading.value = false
  }
}

async function pickAndUploadVideo() {
  const picked = await open({
    multiple: false,
    filters: [{ name: '视频', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'flv'] }],
  })
  if (!picked || Array.isArray(picked)) return
  await uploadVideoPath(picked)
}

function clearVideo() {
  props.field.value = ''
  notify('已清空视频', 'ok', 1500)
}

// ---- 音频字段（LoadAudio / LoadAudioUpload 等）：上传卡 + 服务器音频列表 ----

const audOptions = ref<string[] | null>(
  (props.field.options ?? []).length ? props.field.options!.map(String) : null
)

/** 拉服务器上该节点 audio 输入的文件列表（LoadAudio 的 combo 定义在 object_info 里） */
async function loadAudioOptions() {
  if (audOptions.value) return
  try {
    const def = await api.objectInfo(primaryBase(), props.field.classType)
    const nodeDef = def?.[props.field.classType]
    const list =
      nodeDef?.input?.required?.[props.field.inputName]?.[0] ??
      nodeDef?.input?.optional?.[props.field.inputName]?.[0]
    audOptions.value = Array.isArray(list) ? list.map(String) : []
  } catch {
    audOptions.value = []
  }
}

async function refreshAudios() {
  audOptions.value = null
  await loadAudioOptions()
}

/** 上传本地音频并替换当前值（与图片/视频同链路：主节点 input/studio，跨机派发时按需转存） */
async function uploadAudioPath(path: string) {
  uploading.value = true
  try {
    const base = primaryBase()
    const res = await api.uploadImage(base, path, undefined, 'studio', true)
    const name = String(res?.name ?? '')
    const sub = String(res?.subfolder ?? 'studio')
    const value = name ? (sub ? `${sub}/${name}` : name) : null
    if (value) {
      recordImageOrigin(value, base)
      await loadAudioOptions()
      props.field.value = value
      notify('已上传音频', 'ok', 2500)
    }
  } catch (e) {
    notify(`上传失败：${e}`, 'error', 8000)
  } finally {
    uploading.value = false
  }
}

async function pickAndUploadAudio() {
  const picked = await open({
    multiple: false,
    filters: [{ name: '音频', extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus'] }],
  })
  if (!picked || Array.isArray(picked)) return
  await uploadAudioPath(picked)
}

function clearAudio() {
  props.field.value = ''
  notify('已清空音频', 'ok', 1500)
}

// ---- 多图节点：追加式上传 ----

async function addOne(path: string, quiet = false) {
  const name = await uploadOne(path)
  if (name) {
    ensureList().push(name)
    if (!quiet) notify('已添加图片', 'ok', 2000)
  }
}

async function pickMulti() {
  const picked = await open({
    multiple: true,
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  })
  if (!picked) return
  const paths = Array.isArray(picked) ? picked : [picked]
  for (const p of paths) await addOne(p)
}

// ---- 剪贴板粘贴图片（两条来源）----
// ① 位图：截图 / 聊天窗口「复制图片」→ navigator.clipboard.read() 能看到；
// ② 文件列表：资源管理器 Ctrl+C 的图片文件是 CF_HDROP，WebView 的 clipboard API
//    看不到（以前总报「剪贴板里没有图片」就是它）→ Rust 读文件路径兜底。

/** 内存图片 Blob → 落临时文件 → 上传（单图替换 / 多图追加） */
async function uploadBlob(blob: Blob, ext: string) {
  const path = await saveTempBlob(blob, ext)
  if (props.field.kind === 'image') await uploadPath(path)
  else await addOne(path)
}

/** 资源管理器复制的图片文件（可能多张）：Rust 读剪贴板文件路径 → 逐张上传。读到图返回 true */
async function pasteFromClipboardFiles(): Promise<boolean> {
  try {
    const imgs = (await api.clipboardFilePaths()).filter((p) => IMG_EXT_RE.test(p))
    if (!imgs.length) return false
    if (props.field.kind === 'image') {
      await uploadPath(imgs[0])
      if (imgs.length > 1) notify(`剪贴板里有 ${imgs.length} 张图，单图字段只用了第 1 张`, 'warn', 4000)
    } else {
      for (const p of imgs) await addOne(p, true)
      notify(imgs.length > 1 ? `已粘贴 ${imgs.length} 张图片` : '已添加图片', 'ok', 2000)
    }
    return true
  } catch {
    return false
  }
}

/** 📋 粘贴按钮：位图优先，文件列表兜底，都没有才提示 */
async function pasteImage() {
  try {
    const items = await navigator.clipboard.read()
    for (const it of items) {
      const imgType = it.types.find((t) => BITMAP_MIME_RE.test(t))
      if (!imgType) continue
      const blob = await it.getType(imgType)
      await uploadBlob(blob, extFromMime(imgType))
      return
    }
  } catch {
    /* 位图读不到很常见（比如复制的是文件），走文件列表兜底 */
  }
  if (await pasteFromClipboardFiles()) return
  notify('剪贴板里没有图片', 'warn', 3000)
}

/** 图片卡片聚焦时直接 Ctrl+V：浏览器 paste 事件自带复制的文件 / 截图位图 */
function onCardPaste(e: ClipboardEvent) {
  const files = filesFromClipboardData(e.clipboardData)
  if (!files.length) return // 没图：不拦，交给全局路由或默认行为
  e.preventDefault()
  e.stopPropagation()
  void (async () => {
    const list = props.field.kind === 'image' ? files.slice(0, 1) : files
    for (const f of list) await uploadBlob(f, extFromFile(f))
    if (files.length > list.length) notify(`共 ${files.length} 张，单图字段只用了第 1 张`, 'warn', 4000)
    else if (list.length > 1) notify(`已粘贴 ${list.length} 张图片`, 'ok', 2000)
  })()
}

/** ⌫ 清空：单图清掉参考图，多图清掉整个列表 */
function clearImages() {
  if (props.field.kind === 'image') props.field.value = ''
  else if (props.field.kind === 'multiimage') props.field.value = []
  notify('已清空图片', 'ok', 1500)
}

function removeAt(i: number) {
  ensureList().splice(i, 1)
}

// ---- 多图缩略卡拖拽排序（插入线模式）：按住拖动 → 目标插入位亮竖线 → 松手挪过去 ----

const thumbsWrap = ref<HTMLElement | null>(null)
const dsKeys = computed(() => stableKeys(imgList.value))
const { onDown: dsDown, dragging: dsDragging, insertAt: dsInsertAt } = useDragSort(
  () => thumbsWrap.value,
  () => imgList.value,
  (arr) => {
    ensureList()
    props.field.value = arr
  }
)

// 注册成「可接收拖拽」的目标：AssetDrop（外部文件）与 ResultPanel（应用内资产）命中 data-image-key 落点后回调。
// 回调收路径数组（资源管理器一次拖 N 张很常见）：单图取第一张，多图全收，视频筛视频扩展名。
onMounted(() => {
  const k = props.field.kind
  if (k === 'image') {
    imageDropTargets.set(props.field.key, (paths) => {
      const imgs = paths.filter((p) => IMG_EXT_RE.test(p))
      if (!imgs.length) return
      void uploadPath(imgs[0])
      if (imgs.length > 1) notify(`共拖入 ${imgs.length} 张图，单图字段只用了第 1 张`, 'warn', 4000)
    })
    assetDropTargets.set(props.field.key, (a) => applyAsset(a))
  } else if (k === 'multiimage') {
    imageDropTargets.set(props.field.key, (paths) => {
      const imgs = paths.filter((p) => IMG_EXT_RE.test(p))
      if (!imgs.length) return
      void (async () => {
        for (const p of imgs) await addOne(p, true)
        notify(imgs.length > 1 ? `已添加 ${imgs.length} 张图片` : '已添加图片', 'ok', 2000)
      })()
    })
    assetDropTargets.set(props.field.key, (a) => applyAsset(a))
  } else if (k === 'video') {
    imageDropTargets.set(props.field.key, (paths) => {
      const vids = paths.filter((p) => VIDEO_EXT.test(p))
      if (vids.length) void uploadVideoPath(vids[0])
    })
    assetDropTargets.set(props.field.key, (a) => applyAsset(a))
  } else if (k === 'audio') {
    imageDropTargets.set(props.field.key, (paths) => {
      const auds = paths.filter((p) => AUDIO_EXT.test(p))
      if (auds.length) void uploadAudioPath(auds[0])
    })
    assetDropTargets.set(props.field.key, (a) => applyAsset(a))
  }
})
onUnmounted(() => {
  imageDropTargets.delete(props.field.key)
  assetDropTargets.delete(props.field.key)
})

/** 把一份结果资产设为参考素材：input 里的直接引用，output/temp 先让服务器转存进 input。
 *  图片字段收图片资产，视频字段收视频资产，音频字段收音频资产。 */
async function applyAsset(a: Asset) {
  const wantKind = props.field.kind === 'video' ? 'video' : props.field.kind === 'audio' ? 'audio' : 'image'
  if (a.kind !== wantKind) {
    notify(
      wantKind === 'video'
        ? '只有视频能设为参考视频'
        : wantKind === 'audio'
          ? '只有音频能设为参考音频'
          : '只有图片能设为参考图',
      'warn'
    )
    return
  }
  try {
    let path: string
    if (a.type === 'input') {
      path = a.subfolder ? `${a.subfolder}/${a.filename}` : a.filename
      // 引用的是某台机器 input 里已有的文件 → 上传源就是产出它的那台
      recordImageOrigin(path, a.base ?? primaryBase())
    } else {
      const base = primaryBase()
      const res = await api.copyToInput(base, a.filename, a.subfolder, a.type, 'studio')
      const sub = String(res?.subfolder ?? 'studio')
      path = sub ? `${sub}/${res.name}` : String(res.name)
      recordImageOrigin(path, base)
      if (props.field.kind === 'video') await loadVideoOptions()
      else if (props.field.kind === 'audio') await loadAudioOptions()
      else await loadImageOptions()
    }
    if (props.field.kind === 'video' || props.field.kind === 'audio' || props.field.kind === 'image') {
      props.field.value = path
    } else if (props.field.kind === 'multiimage') {
      ensureList().push(path)
    }
    notify(
      wantKind === 'video' ? '已设为参考视频' : wantKind === 'audio' ? '已设为参考音频' : '已设为参考图',
      'ok',
      2000
    )
  } catch (e) {
    notify(`引用资产失败：${e}`, 'error', 8000)
  }
}

/** 模板配置的功能按钮 */
function doAction(a: FieldAction) {
  const f = props.field
  if (a === 'randomize') {
    if (f.kind === 'number' && f.min != null && f.max != null) {
      f.value = Math.floor(f.min + Math.random() * (f.max - f.min))
    } else {
      f.value = randomSeed()
    }
  } else if (a === 'clear') {
    f.value = f.kind === 'number' || f.kind === 'seed' ? (f.min ?? 0) : ''
  } else if (a === 'step') {
    if (f.kind === 'number' || f.kind === 'seed') {
      const step = f.step ?? 1
      const n = Number(f.value) || 0
      const lo = f.min ?? -Infinity
      const hi = f.max ?? Infinity
      f.value = Math.min(hi, Math.max(lo, n + step))
    }
  }
}

function applyPreset(p: string) {
  const f = props.field
  f.value = f.kind === 'number' || f.kind === 'seed' ? Number(p) || 0 : p
}

// ---- 文本节点的工具条：复制 / 粘贴 / 清空 / 交换 ----

async function copyText() {
  try {
    await navigator.clipboard.writeText(String(props.field.value ?? ''))
    notify('已复制到剪贴板', 'ok', 2000)
  } catch {
    notify('复制失败，请手动选中文本后 Ctrl+C', 'warn', 4000)
  }
}

async function pasteText() {
  try {
    const t = await navigator.clipboard.readText()
    if (!t) return
    const el = ta.value
    const cur = String(props.field.value ?? '')
    if (el && el.selectionStart != null) {
      const s = el.selectionStart
      const e = el.selectionEnd ?? s
      props.field.value = cur.slice(0, s) + t + cur.slice(e)
      const el2 = el
      nextTick(() => {
        el2.focus()
        el2.setSelectionRange(s + t.length, s + t.length)
      })
    } else {
      props.field.value = cur + t
    }
    notify('已粘贴', 'ok', 1500)
  } catch {
    notify('读取剪贴板失败，可直接在输入框里 Ctrl+V', 'warn', 4000)
  }
}

function clearText() {
  props.field.value = ''
}

// 「⚡ 粘贴提交」的实现已提到 store（pasteSubmitField）：按钮和全局快捷键 Ctrl+E 共用

// ---- 常用提示词库（v2：分组 + 搜索；旧版平铺数组自动迁移，不丢数据） ----

interface QuickEntry {
  t: string // 短语文本
  g: string // 分组名（空 = 未分组）
}
const QUICK_KEY_V2 = 'comfyui-studio.quickPrompts:v2'
const QUICK_KEY_V1 = 'comfyui-studio.quickPrompts:v1'

function loadQuick(): QuickEntry[] {
  try {
    const raw2 = localStorage.getItem(QUICK_KEY_V2)
    if (raw2) {
      const arr = JSON.parse(raw2)
      if (Array.isArray(arr))
        return arr
          .filter((e: any) => e && typeof e.t === 'string' && e.t)
          .map((e: any) => ({ t: String(e.t), g: String(e.g ?? '') }))
          .slice(0, 120)
    }
    // v1 平铺（string[]）迁移
    const raw = localStorage.getItem(QUICK_KEY_V1)
    const arr = raw ? JSON.parse(raw) : null
    return Array.isArray(arr)
      ? arr
          .map(String)
          .filter(Boolean)
          .slice(0, 60)
          .map((t: string) => ({ t, g: '' }))
      : []
  } catch {
    return []
  }
}

const quickEntries = ref<QuickEntry[]>(loadQuick())

function saveQuick() {
  try {
    localStorage.setItem(QUICK_KEY_V2, JSON.stringify(quickEntries.value))
  } catch {
    /* ignore */
  }
}

/** 已有的分组名（≥2 个才显示分组过滤 chips） */
const quickGroups = computed(() => {
  const set = new Set<string>()
  for (const e of quickEntries.value) if (e.g) set.add(e.g)
  return [...set]
})

const quickSearch = ref('')
const quickGroupSel = ref('')
const quickAdding = ref(false)
const quickInput = ref('')
const quickGroupInput = ref('')

/** 搜索 + 分组过滤后的可见短语（无过滤条件时全量，保持旧观感） */
const visibleQuick = computed(() => {
  const q = quickSearch.value.trim().toLowerCase()
  return quickEntries.value
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => {
      if (quickGroupSel.value && e.g !== quickGroupSel.value) return false
      if (q && !e.t.toLowerCase().includes(q) && !e.g.toLowerCase().includes(q)) return false
      return true
    })
})

function addQuick() {
  const t = quickInput.value.trim()
  if (!t) {
    quickAdding.value = false
    return
  }
  const g = quickGroupInput.value.trim()
  const dup = quickEntries.value.findIndex((e) => e.t === t && e.g === g)
  if (dup < 0) {
    quickEntries.value.unshift({ t, g })
    if (quickEntries.value.length > 120) quickEntries.value.length = 120
    saveQuick()
  }
  quickInput.value = ''
  quickGroupInput.value = ''
  quickAdding.value = false
}

function removeQuickAt(i: number) {
  quickEntries.value.splice(i, 1)
  saveQuick()
}

/** 点常用短语：追加到当前值（逗号衔接），不覆盖已有内容 */
function applyQuick(p: string) {
  const cur = String(props.field.value ?? '').trim()
  if (!cur) props.field.value = p
  else if (/[,，;；\n]$/.test(cur)) props.field.value = cur + ' ' + p
  else props.field.value = cur + ', ' + p
}

// ---- 文本模板库：批量稿等常用整段文本存成模板，一键回填（textarea 字段） ----

interface TextTemplate {
  name: string
  content: string
}
const TPL_KEY = 'comfyui-studio.textTemplates:v1'

function loadTextTemplates(): TextTemplate[] {
  try {
    const arr = JSON.parse(localStorage.getItem(TPL_KEY) ?? '[]')
    return Array.isArray(arr)
      ? arr
          .filter((x: any) => x && typeof x.name === 'string' && typeof x.content === 'string')
          .slice(0, 40)
      : []
  } catch {
    return []
  }
}

const textTemplates = ref<TextTemplate[]>(loadTextTemplates())

function saveTplStore() {
  try {
    localStorage.setItem(TPL_KEY, JSON.stringify(textTemplates.value))
  } catch {
    /* ignore */
  }
}

const tplAdding = ref(false)
const tplName = ref('')

function startTplAdd() {
  if (!String(props.field.value ?? '').trim()) {
    notify('输入框是空的，先粘贴内容再存模板', 'warn', 3000)
    return
  }
  tplName.value = ''
  tplAdding.value = true
}

function saveTemplate() {
  const name = tplName.value.trim()
  const content = String(props.field.value ?? '')
  if (!name || !content.trim()) {
    tplAdding.value = false
    return
  }
  const dup = textTemplates.value.findIndex((t) => t.name === name)
  if (dup >= 0) textTemplates.value.splice(dup, 1)
  textTemplates.value.unshift({ name, content })
  if (textTemplates.value.length > 40) textTemplates.value.length = 40
  saveTplStore()
  tplAdding.value = false
  notify(`已存模板「${name}」`, 'ok', 2000)
}

/** 点模板：整框替换（框里有内容先确认，防止手滑覆盖） */
async function applyTemplate(tp: TextTemplate) {
  const cur = String(props.field.value ?? '')
  if (cur.trim() && cur !== tp.content) {
    const yes = await appConfirm({
      title: `替换为模板「${tp.name}」？`,
      message: `「${props.field.label}」当前内容将被覆盖（${cur.length} 字 → 模板 ${tp.content.length} 字）。`,
      danger: true,
      okLabel: '替换',
    })
    if (!yes) return
  }
  props.field.value = tp.content
  notify(`已填入模板「${tp.name}」`, 'ok', 2000)
}

function removeTemplate(i: number) {
  textTemplates.value.splice(i, 1)
  saveTplStore()
}

// ---- 提示词历史：输入框光标在最开头时按 ↑ 弹出最近提交过的提示词，选中即填入 ----

const histOpen = ref(false)
const histSel = ref(-1)

/** 光标在文本最开头（含空输入）时 ↑ 才弹历史，平时 ↑ 移动光标不受影响 */
function histCanOpen(el: HTMLTextAreaElement | HTMLInputElement): boolean {
  const s = el.selectionStart ?? 0
  const e = el.selectionEnd ?? s
  return s === 0 && e === 0
}

function onTextKeydown(e: KeyboardEvent) {
  const el = e.target as HTMLTextAreaElement
  if (e.key === 'ArrowUp') {
    if (histOpen.value || histCanOpen(el)) {
      e.preventDefault()
      if (!promptHistory.value.length) return
      histOpen.value = true
      histSel.value = -1
    }
  } else if (histOpen.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      histSel.value = Math.min(histSel.value + 1, promptHistory.value.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      histSel.value = Math.max(histSel.value - 1, 0)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (histSel.value >= 0) applyHistory(promptHistory.value[histSel.value])
      else histOpen.value = false
    } else if (e.key === 'Escape') {
      histOpen.value = false
    }
  }
}

function applyHistory(t: string) {
  props.field.value = t
  histOpen.value = false
  histSel.value = -1
  nextTick(() => {
    const el = ta.value
    if (el) {
      el.focus()
      const end = String(props.field.value ?? '').length
      el.setSelectionRange(end, end)
    }
  })
}

/** 交换对：A→B、B→A（单趟正则同时替换，避免互相污染） */
function swapText() {
  const [a, b] = props.field.swap ?? []
  if (!a || !b) return
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${esc(a)}|${esc(b)}`, 'g')
  props.field.value = String(props.field.value ?? '').replace(re, (m) => (m === a ? b : a))
  notify(`已交换：${a} ⇄ ${b}`, 'ok', 2000)
}

if (props.field.kind === 'image') loadImageOptions()
if (props.field.kind === 'video') loadVideoOptions()
if (props.field.kind === 'audio') loadAudioOptions()
</script>

<template>
  <div class="field">
    <div class="field-label">
      <span v-if="dirty" class="dirty-dot" title="与上次提交时的值不同（提交后会熄灭）" />
      <span class="name">{{ field.label }}</span>
      <span class="code">{{ field.nodeId }}.{{ field.inputName }}</span>
      <span v-if="field.actions?.length" class="acts">
        <button
          v-for="a in field.actions"
          :key="a"
          class="mini"
          :title="ACTION_TITLE[a]"
          @click="doAction(a)"
        >
          {{ ACTION_ICON[a] }}
        </button>
      </span>
    </div>

    <!-- 多行文本：自带 复制/粘贴/清空 工具条，标题带「交换:A,B」时多一个交换按钮 -->
    <template v-if="field.kind === 'textarea'">
      <div class="ta-tools">
        <button class="tbtn" title="复制到剪贴板" @click="copyText">⧉ 复制</button>
        <button class="tbtn" title="粘贴到光标处" @click="pasteText">📋 粘贴</button>
        <button class="tbtn" title="清空" @click="clearText">⌫ 清空</button>
        <button
          v-if="field.swap"
          class="tbtn swap"
          :title="`把「${field.swap[0]}」换成「${field.swap[1]}」，同时把「${field.swap[1]}」换成「${field.swap[0]}」`"
          @click="swapText"
        >
          ⇄ 交换
        </button>
        <button
          class="tbtn go"
          title="读取剪贴板文本填入本框（覆盖现有内容），并按当前批次设置立即提交（Ctrl+E）；多行内容会询问是否逐条拆分"
          @click="pasteSubmitField(field)"
        >
          ⚡ 粘贴提交
        </button>
        <button
          class="tbtn"
          title="把框内内容按行拆分：每行一条提示词，各提交一个任务"
          @click="openBatchTextDialog(field)"
        >
          ✂ 拆行提交
        </button>
      </div>
      <div class="ta-wrap">
        <textarea
          ref="ta"
          v-model="field.value"
          class="textarea"
          :data-field-key="field.key"
          :placeholder="field.placeholder || field.label"
          rows="5"
          @keydown="onTextKeydown"
          @input="histOpen = false"
        />
        <!-- 提示词历史下拉：↑ 唤出，选中即覆盖填入 -->
        <div v-if="histOpen && promptHistory.length" class="prompt-hist" @mousedown.prevent>
          <button
            v-for="(h, i) in promptHistory"
            :key="i"
            class="ph-item"
            :class="{ sel: i === histSel }"
            :title="`填入这条历史（${i + 1}/${promptHistory.length}）`"
            @click="applyHistory(h)"
          >
            <span class="ph-text">{{ h }}</span>
          </button>
          <div class="ph-hint">↑↓ 选择 · Enter 填入 · Esc 关闭</div>
        </div>
      </div>
    </template>

    <!-- 随机种子 -->
    <div v-else-if="field.kind === 'seed'" class="seed-row">
      <input v-model.number="field.value" type="number" class="input" />
      <button class="btn sm" title="随机" @click="field.value = randomSeed()">🎲</button>
    </div>

    <!-- 数字 -->
    <div v-else-if="field.kind === 'number'" class="num-row">
      <input
        v-model.number="field.value"
        type="number"
        class="input"
        :min="field.min"
        :max="field.max"
        :step="field.step ?? 1"
      />
      <input
        v-if="hasRange"
        v-model.number="field.value"
        type="range"
        class="input"
        :min="field.min"
        :max="field.max"
        :step="field.step ?? 1"
      />
    </div>

    <!-- 下拉 -->
    <select v-else-if="field.kind === 'select' && selectOptions.length" v-model="field.value" class="select">
      <option v-for="o in selectOptions" :key="o" :value="o">{{ o }}</option>
    </select>

    <!-- 开关 -->
    <label v-else-if="field.kind === 'toggle'" class="toggle-row">
      <input v-model="field.value" type="checkbox" />
      <span>{{ field.value ? '开启' : '关闭' }}</span>
    </label>

    <!-- 单图：缩略图卡片 + 服务器文件选择；缩略卡也是拖拽上传 / Ctrl+V 粘贴的落点 -->
    <div
      v-else-if="field.kind === 'image'"
      class="img-card"
      :data-image-key="field.key"
      :data-drop-label="`设为参考图「${field.label}」`"
      tabindex="0"
      title="可把图片文件直接拖到卡片上；点卡片后按 Ctrl+V 也能粘贴"
      @paste="onCardPaste"
    >
      <button
        class="thumb"
        :title="uploading ? '上传中…' : '点击上传，或直接把图片拖到这张卡片上'"
        @click="pickAndUpload"
      >
        <img v-if="imgPreviewUrl" :src="imgPreviewUrl" alt="" />
        <span v-else class="ph">{{ uploading ? '…' : '＋' }}</span>
      </button>
      <div class="img-side">
        <select
          v-if="(imgOptions ?? []).length"
          v-model="field.value"
          class="select"
          @focus="loadImageOptions"
        >
          <option v-for="o in imgOptions ?? []" :key="o" :value="o">{{ o }}</option>
        </select>
        <input
          v-else
          v-model="field.value"
          class="input"
          placeholder="服务器上的图片，如 studio/a.png"
          @focus="loadImageOptions"
        />
        <div class="img-btns">
          <button class="btn sm" :disabled="uploading" @click="pickAndUpload">
            {{ uploading ? '上传中…' : '上传' }}
          </button>
          <button
            class="btn sm"
            :disabled="uploading"
            title="粘贴剪贴板里的图片（截图、复制的图片文件都行，支持多张；也可在卡片上直接 Ctrl+V）"
            @click="pasteImage"
          >
            📋 粘贴
          </button>
          <button class="btn sm ghost" title="清空已选的参考图" @click="clearImages">⌫ 清空</button>
          <button class="btn sm ghost" title="重新拉取服务器图片列表" @click="refreshImages">⟳</button>
        </div>
      </div>
    </div>

    <!-- 多图：一排缩略卡 + 追加上传；提交时按顺序逐张 × 批次数；支持一次粘贴多张 -->
    <div
      v-else-if="field.kind === 'multiimage'"
      class="multi-card"
      :data-image-key="field.key"
      :data-drop-label="`追加到「${field.label}」图片列表`"
      tabindex="0"
      @paste="onCardPaste"
    >
      <div ref="thumbsWrap" class="thumbs" :class="{ sorting: dsDragging >= 0 }">
        <div
          v-for="(v, i) in imgList"
          :key="dsKeys[i]"
          class="mthumb"
          :class="{
            dragging: dsDragging === i,
            'ds-line-l': dsInsertAt === i,
            'ds-line-r': dsInsertAt === i + 1,
          }"
          :title="`${v}（按住拖动可调顺序）`"
          data-ds
          @pointerdown="dsDown($event, i)"
        >
          <img v-if="inputUrl(v)" :src="inputUrl(v) ?? ''" alt="" draggable="false" />
          <span v-else class="mname" :title="v">{{ v }}</span>
          <button class="mx" title="移除" @click="removeAt(i)">✕</button>
        </div>
        <button
          class="madd"
          :disabled="uploading"
          title="点击上传多张图片，或直接把图片拖到这排卡片上"
          @click="pickMulti"
        >
          <span v-if="uploading">…</span>
          <span v-else>＋</span>
        </button>
      </div>
      <div class="img-btns">
        <button
          class="btn sm"
          :disabled="uploading"
          title="粘贴剪贴板里的图片，有几张贴几张（截图、复制的图片文件都行；也可在卡片上直接 Ctrl+V）"
          @click="pasteImage"
        >
          📋 粘贴图片
        </button>
        <button
          v-if="imgList.length"
          class="btn sm"
          title="图文配对：多张图 × 多条提示词均分配对批量提交（每条提示词只跑一次）"
          @click="openPairedDialog(field)"
        >
          🔗 配对提交
        </button>
        <button class="btn sm ghost" title="清空全部图片" @click="clearImages">⌫ 清空</button>
      </div>
      <div class="multi-tip">提交时逐张 × 批次数（自动随机种子）· 按住缩略图拖动调顺序 · 可拖入图片文件，或点卡片后 Ctrl+V（可一次贴多张）</div>
    </div>

    <!-- 视频：内联预览缩略卡 + 服务器视频选择；卡片也是拖拽上传的落点 -->
    <div
      v-else-if="field.kind === 'video'"
      class="img-card"
      :data-image-key="field.key"
      :data-drop-label="`设为参考视频「${field.label}」`"
      tabindex="0"
      title="可把视频文件直接拖到卡片上"
    >
      <button
        class="thumb"
        :title="uploading ? '上传中…' : '点击上传视频，或直接把视频文件拖到这张卡片上'"
        @click="pickAndUploadVideo"
      >
        <video v-if="vidPreviewUrl" :src="vidPreviewUrl" muted preload="metadata" />
        <span v-else class="ph">{{ uploading ? '…' : '🎬' }}</span>
      </button>
      <div class="img-side">
        <select
          v-if="(vidOptions ?? []).length"
          v-model="field.value"
          class="select"
          @focus="loadVideoOptions"
        >
          <option v-for="o in vidOptions ?? []" :key="o" :value="o">{{ o }}</option>
        </select>
        <input
          v-else
          v-model="field.value"
          class="input"
          placeholder="服务器上的视频，如 studio/a.mp4"
          @focus="loadVideoOptions"
        />
        <div class="img-btns">
          <button class="btn sm" :disabled="uploading" @click="pickAndUploadVideo">
            {{ uploading ? '上传中…' : '上传视频' }}
          </button>
          <button class="btn sm ghost" title="清空已选视频" @click="clearVideo">⌫ 清空</button>
          <button class="btn sm ghost" title="重新拉取服务器视频列表" @click="refreshVideos">⟳</button>
        </div>
      </div>
    </div>

    <!-- 音频：♪ 缩略卡（点击上传）+ 试听条 + 服务器音频选择；卡片也是拖拽上传的落点 -->
    <div
      v-else-if="field.kind === 'audio'"
      class="img-card"
      :data-image-key="field.key"
      :data-drop-label="`设为参考音频「${field.label}」`"
      tabindex="0"
      title="可把音频文件直接拖到卡片上"
    >
      <button
        class="thumb"
        :title="uploading ? '上传中…' : '点击上传音频，或直接把音频文件拖到这张卡片上'"
        @click="pickAndUploadAudio"
      >
        <span v-if="!audPreviewUrl || uploading" class="ph">{{ uploading ? '…' : '♪' }}</span>
        <span v-else class="ph aud-playing">♪</span>
      </button>
      <div class="img-side">
        <audio
          v-if="audPreviewUrl"
          :src="audPreviewUrl"
          class="aud-prev"
          controls
          preload="metadata"
        />
        <select
          v-if="(audOptions ?? []).length"
          v-model="field.value"
          class="select"
          @focus="loadAudioOptions"
        >
          <option v-for="o in audOptions ?? []" :key="o" :value="o">{{ o }}</option>
        </select>
        <input
          v-else
          v-model="field.value"
          class="input"
          placeholder="服务器上的音频，如 studio/a.mp3"
          @focus="loadAudioOptions"
        />
        <div class="img-btns">
          <button class="btn sm" :disabled="uploading" @click="pickAndUploadAudio">
            {{ uploading ? '上传中…' : '上传音频' }}
          </button>
          <button class="btn sm ghost" title="清空已选音频" @click="clearAudio">⌫ 清空</button>
          <button class="btn sm ghost" title="重新拉取服务器音频列表" @click="refreshAudios">⟳</button>
        </div>
      </div>
    </div>

    <!-- 兜底：单行文本 -->
    <div v-else class="ta-wrap">
      <input
        v-model="field.value"
        class="input"
        :placeholder="field.placeholder || ''"
        @keydown="onTextKeydown"
        @input="histOpen = false"
      />
      <div v-if="histOpen && promptHistory.length" class="prompt-hist" @mousedown.prevent>
        <button
          v-for="(h, i) in promptHistory"
          :key="i"
          class="ph-item"
          :class="{ sel: i === histSel }"
          :title="`填入这条历史（${i + 1}/${promptHistory.length}）`"
          @click="applyHistory(h)"
        >
          <span class="ph-text">{{ h }}</span>
        </button>
        <div class="ph-hint">↑↓ 选择 · Enter 填入 · Esc 关闭</div>
      </div>
    </div>

    <!-- 用户自定义常用提示词库（v2）：分组过滤 + 搜索（短语多时才出现），点一下追加到输入框 -->
    <div v-if="field.kind === 'textarea' || field.kind === 'text'" class="quick-row">
      <input
        v-if="quickEntries.length > 6"
        v-model="quickSearch"
        class="input q-search"
        placeholder="搜短语…"
      />
      <button
        v-for="g in quickGroups"
        :key="g"
        class="chip q-group"
        :class="{ on: quickGroupSel === g }"
        :title="`只看分组「${g}」`"
        @click="quickGroupSel = quickGroupSel === g ? '' : g"
      >
        {{ g }}
      </button>
      <button
        v-for="(x, i) in visibleQuick"
        :key="i"
        class="chip quick"
        :title="`${x.e.g ? `分组「${x.e.g}」· ` : ''}追加「${x.e.t}」到输入框`"
        @click="applyQuick(x.e.t)"
      >
        <span v-if="x.e.g && !quickGroupSel" class="q-gtag">{{ x.e.g }}</span>
        <span class="q-text">{{ x.e.t }}</span>
        <span class="q-del" title="从常用列表删除" @click.stop="removeQuickAt(x.i)">×</span>
      </button>
      <button
        v-if="!quickAdding"
        class="chip quick-add"
        title="把一段提示词存成常用按钮（可填分组）"
        @click="quickAdding = true"
      >
        ＋ 常用
      </button>
      <span v-else class="quick-editor">
        <input
          v-model="quickGroupInput"
          class="input q-g-input"
          placeholder="分组(可空)"
          :list="`quick-groups-${field.key}`"
        />
        <datalist :id="`quick-groups-${field.key}`">
          <option v-for="g in quickGroups" :key="g" :value="g" />
        </datalist>
        <input
          v-model="quickInput"
          class="input"
          placeholder="输入常用提示词，回车保存"
          @keydown.enter.prevent="addQuick"
          @keydown.esc="quickAdding = false"
        />
        <button class="btn sm" @click="addQuick">保存</button>
        <button class="btn sm ghost" @click="quickAdding = false">取消</button>
      </span>
    </div>

    <!-- 整段文本模板库（textarea 字段）：批量稿等常用格式存成模板，一键回填 -->
    <div v-if="field.kind === 'textarea'" class="tpl-row">
      <span class="tpl-lbl" title="常用整段文本模板（批量稿/固定格式），点击整框替换">📄 模板</span>
      <span
        v-for="(tp, i) in textTemplates"
        :key="i"
        class="chip tpl"
        :title="`整框替换为「${tp.name}」（${tp.content.length} 字；框里有内容会先确认）`"
        @click="applyTemplate(tp)"
      >
        <span class="t-name">{{ tp.name }}</span>
        <span class="t-del" title="删除模板" @click.stop="removeTemplate(i)">×</span>
      </span>
      <button
        v-if="!tplAdding"
        class="chip tpl-add"
        title="把当前输入框的内容存成模板"
        @click="startTplAdd"
      >
        💾 存当前
      </button>
      <span v-else class="quick-editor">
        <input
          v-model="tplName"
          class="input"
          placeholder="模板名，回车保存"
          @keydown.enter.prevent="saveTemplate"
          @keydown.esc="tplAdding = false"
        />
        <button class="btn sm" @click="saveTemplate">保存</button>
        <button class="btn sm ghost" @click="tplAdding = false">取消</button>
      </span>
    </div>

    <!-- 模板配置的预设值：点一下就填入 -->
    <div v-if="field.presets?.length" class="presets">
      <button v-for="p in field.presets" :key="p" class="chip" @click="applyPreset(p)">
        {{ p }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.seed-row,
.num-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.num-row .input[type='number'] {
  width: 96px;
  flex: none;
}
.num-row .input[type='range'] {
  flex: 1;
}
.seed-row .input {
  flex: 1;
}
.toggle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--text-dim);
}

/* 提示词历史下拉（相对输入框定位的浮层） */
.ta-wrap {
  position: relative;
}
.prompt-hist {
  position: absolute;
  left: 0;
  right: 0;
  top: 100%;
  margin-top: 4px;
  z-index: 60;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  padding: 4px;
}
.ph-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  border: 0;
  border-radius: 4px;
  background: none;
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
  line-height: 1.5;
}
.ph-item:hover,
.ph-item.sel {
  background: var(--bg-3, var(--bg-1));
}
.ph-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ph-hint {
  padding: 4px 8px 2px;
  font-size: 10.5px;
  color: var(--text-faint);
  border-top: 1px solid var(--border);
  margin-top: 2px;
}

/* 常用提示词快捷按钮 */
.quick-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}
.chip.quick {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 240px;
}
.quick .q-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.quick .q-del {
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1;
  padding: 0 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.quick:hover .q-del {
  opacity: 1;
}
.quick .q-del:hover {
  color: var(--err);
}
.chip.quick-add {
  color: var(--text-faint);
}
/* 常用库搜索框 + 分组过滤 chips */
.q-search {
  width: 110px;
  flex: none;
  font-size: 11.5px;
  padding: 2px 8px;
}
.chip.q-group {
  color: var(--accent);
  border-color: var(--accent);
  opacity: 0.65;
}
.chip.q-group.on {
  opacity: 1;
  background: var(--accent-soft, transparent);
}
.quick .q-gtag {
  flex: none;
  max-width: 64px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 0 5px;
  line-height: 1.4;
}
.quick-editor .q-g-input {
  width: 96px;
}
/* 整段文本模板行 */
.tpl-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.tpl-lbl {
  font-size: 11px;
  color: var(--text-faint);
  flex: none;
}
.chip.tpl {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
}
.chip.tpl .t-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip.tpl .t-del {
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1;
  padding: 0 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.chip.tpl:hover .t-del {
  opacity: 1;
}
.chip.tpl .t-del:hover {
  color: var(--err);
}
.chip.tpl-add {
  color: var(--text-faint);
}
.quick-editor {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.quick-editor .input {
  width: 220px;
}

/* 文本工具条 */
.ta-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}
.tbtn {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text-dim);
  cursor: pointer;
}
.tbtn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.tbtn.swap {
  border-color: var(--accent);
  color: var(--accent);
}
.tbtn.go {
  margin-left: auto; /* 单独顶到工具条最右侧 */
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

/* 功能按钮（模板配置的 actions） */
.acts {
  margin-left: auto;
  display: inline-flex;
  gap: 2px;
}
.mini {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 6px;
  color: var(--text-dim);
}
.mini:hover {
  background: var(--bg-3);
  color: var(--text);
}

/* 单图缩略卡 */
.img-card {
  display: flex;
  gap: 10px;
  align-items: stretch;
}
.thumb {
  flex: none;
  width: 60px;
  height: 60px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  cursor: pointer;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.thumb:hover {
  border-color: var(--accent);
}
.thumb img,
.thumb video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb .ph {
  font-size: 18px;
  color: var(--text-faint);
}
/* 音频卡：缩略位 ♪ 主题色强调 + 侧栏试听条（原生 audio 控件压到紧凑高度） */
.thumb .ph.aud-playing {
  color: var(--accent);
}
.aud-prev {
  width: 100%;
  height: 34px;
  min-width: 0;
}
.img-side {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
/* 下拉/输入框统一撑满右侧列，长文件名不再把控件撑溢出 */
.img-side > .select,
.img-side > .input {
  width: 100%;
  min-width: 0;
}
.img-btns {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
}

/* 多图节点 */
.multi-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.mthumb {
  position: relative;
  width: 52px;
  height: 52px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: visible;
  background: var(--bg-2);
  cursor: grab;
  user-select: none;
}
/* 拖动中的原条目：变暗 + 虚线框（列表本体不动，松手才挪） */
.mthumb.dragging {
  opacity: 0.35;
  border-style: dashed;
  cursor: grabbing;
}
/* 插入位置指示线（dragSort 插入线模式）：亮在目标间隙的左右边缘 */
.mthumb.ds-line-l::before,
.mthumb.ds-line-r::after {
  content: '';
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 4px;
  border-radius: 2px;
  background: var(--accent);
  z-index: 3;
  box-shadow: 0 0 6px var(--accent);
}
.mthumb.ds-line-l::before {
  left: -6px;
}
.mthumb.ds-line-r::after {
  right: -6px;
}
/* 拖动中给插入线让位的空隙感：整排轻微淡化 */
.thumbs.sorting .mthumb:not(.dragging) {
  opacity: 0.85;
}
.mthumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  /* overflow 改 visible（给插入线露头）后圆角裁切改由图片自己承担 */
  border-radius: calc(var(--radius-sm) - 1px);
  /* 禁原生图片拖拽：不然按住一动就被 WebView 原生拖放接管，排序失效 */
  -webkit-user-drag: none;
}
.mname {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 10px;
  color: var(--text-faint);
  padding: 4px;
  overflow: hidden;
  word-break: break-all;
  text-align: center;
  border-radius: calc(var(--radius-sm) - 1px);
}
.mx {
  position: absolute;
  top: 0;
  right: 0;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 0 0 0 6px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.mx:hover {
  background: rgba(220, 38, 38, 0.85);
}
.madd {
  width: 52px;
  height: 52px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  color: var(--text-faint);
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.madd:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.multi-tip {
  font-size: 10.5px;
  color: var(--text-faint);
  line-height: 1.45;
}

/* 预设值 chips */
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.chip {
  font-size: 11.5px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text-dim);
  cursor: pointer;
}
.chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>
