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
import { assetDropTargets, imageDropTargets, notify, promptHistory, state, submit } from '../store'
import { randomSeed } from '../core/parseWorkflow'

const props = defineProps<{ field: FieldSchema }>()

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

/** 服务器 input 目录里的图片预览地址（值形如 "xxx.png" 或 "子目录/xxx.png"） */
function inputUrl(v: string): string | null {
  const s = String(v ?? '').trim()
  if (!s || !/\.(png|jpe?g|webp|gif|bmp)$/i.test(s)) return null
  const i = s.indexOf('/')
  const sub = i >= 0 ? s.slice(0, i) : ''
  const name = i >= 0 ? s.slice(i + 1) : s
  try {
    return viewUrl(state.settings.baseUrl, name, sub, 'input')
  } catch {
    return null
  }
}

/** 图片字段预览 */
const imgPreviewUrl = computed(() => (props.field.kind === 'image' ? inputUrl(String(props.field.value ?? '')) : null))

/** 多图字段的值：服务器文件名列表 */
const imgList = computed<string[]>(() => {
  const v = props.field.value
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
    const def = await api.objectInfo(state.settings.baseUrl, 'LoadImage')
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

/** 上传一个本地文件，返回服务器上的相对路径 */
async function uploadOne(path: string): Promise<string | null> {
  uploading.value = true
  try {
    const res = await api.uploadImage(state.settings.baseUrl, path, undefined, 'studio', true)
    const name = String(res?.name ?? '')
    const sub = String(res?.subfolder ?? 'studio')
    imgOptions.value = null
    return name ? (sub ? `${sub}/${name}` : name) : null
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

// 注册成「可接收拖拽」的目标：AssetDrop（外部文件）与 ResultPanel（应用内资产）命中 data-image-key 落点后回调
onMounted(() => {
  const k = props.field.kind
  if (k === 'image') {
    imageDropTargets.set(props.field.key, (p) => uploadPath(p))
    assetDropTargets.set(props.field.key, (a) => applyAsset(a))
  } else if (k === 'multiimage') {
    imageDropTargets.set(props.field.key, (p) => addOne(p))
    assetDropTargets.set(props.field.key, (a) => applyAsset(a))
  }
})
onUnmounted(() => {
  imageDropTargets.delete(props.field.key)
  assetDropTargets.delete(props.field.key)
})

/** 把一份结果资产设为参考图：input 里的直接引用，output/temp 先让服务器转存进 input */
async function applyAsset(a: Asset) {
  if (a.kind !== 'image') {
    notify('只有图片能设为参考图', 'warn')
    return
  }
  try {
    let path: string
    if (a.type === 'input') {
      path = a.subfolder ? `${a.subfolder}/${a.filename}` : a.filename
    } else {
      const res = await api.copyToInput(
        state.settings.baseUrl,
        a.filename,
        a.subfolder,
        a.type,
        'studio'
      )
      const sub = String(res?.subfolder ?? 'studio')
      path = sub ? `${sub}/${res.name}` : String(res.name)
      await loadImageOptions()
    }
    if (props.field.kind === 'image') {
      props.field.value = path
    } else if (props.field.kind === 'multiimage') {
      ensureList().push(path)
    }
    notify('已设为参考图', 'ok', 2000)
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

/** 一键粘贴提交：读剪贴板文本填入本框（覆盖），按面板上的批次设置立即提交 */
async function pasteAndSubmit() {
  try {
    const t = await navigator.clipboard.readText()
    if (!t || !t.trim()) {
      notify('剪贴板里没有文本', 'warn', 3000)
      return
    }
    props.field.value = t.trim()
    submit()
    notify('已粘贴并提交', 'ok', 2000)
  } catch {
    notify('读取剪贴板失败，可手动 Ctrl+V 后再提交', 'warn', 4000)
  }
}

// ---- 常用提示词快捷按钮：所有文本字段共用一份库，localStorage 持久化 ----

const QUICK_KEY = 'comfyui-studio.quickPrompts:v1'

function loadQuick(): string[] {
  try {
    const raw = localStorage.getItem(QUICK_KEY)
    const arr = raw ? JSON.parse(raw) : null
    return Array.isArray(arr) ? arr.map(String).filter(Boolean).slice(0, 60) : []
  } catch {
    return []
  }
}

const quickPrompts = ref<string[]>(loadQuick())
const quickAdding = ref(false)
const quickInput = ref('')

function saveQuick() {
  localStorage.setItem(QUICK_KEY, JSON.stringify(quickPrompts.value))
}

function addQuick() {
  const t = quickInput.value.trim()
  if (!t) {
    quickAdding.value = false
    return
  }
  if (!quickPrompts.value.includes(t)) {
    quickPrompts.value.push(t)
    saveQuick()
  }
  quickInput.value = ''
  quickAdding.value = false
}

function removeQuick(p: string) {
  quickPrompts.value = quickPrompts.value.filter((x) => x !== p)
  saveQuick()
}

/** 点常用短语：追加到当前值（逗号衔接），不覆盖已有内容 */
function applyQuick(p: string) {
  const cur = String(props.field.value ?? '').trim()
  if (!cur) props.field.value = p
  else if (/[,，;；\n]$/.test(cur)) props.field.value = cur + ' ' + p
  else props.field.value = cur + ', ' + p
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
</script>

<template>
  <div class="field">
    <div class="field-label">
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
          title="读取剪贴板文本填入本框（覆盖现有内容），并按当前批次设置立即提交"
          @click="pasteAndSubmit"
        >
          ⚡ 粘贴提交
        </button>
      </div>
      <div class="ta-wrap">
        <textarea
          ref="ta"
          v-model="field.value"
          class="textarea"
          :placeholder="field.placeholder || field.label"
          rows="7"
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
    <div v-else-if="field.kind === 'multiimage'" class="multi-card" :data-image-key="field.key" tabindex="0" @paste="onCardPaste">
      <div class="thumbs">
        <div v-for="(v, i) in imgList" :key="v + i" class="mthumb">
          <img v-if="inputUrl(v)" :src="inputUrl(v) ?? ''" alt="" />
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
        <button class="btn sm ghost" title="清空全部图片" @click="clearImages">⌫ 清空</button>
      </div>
      <div class="multi-tip">提交时按顺序逐张 × 批次数（每张图提交批次数次，每次自动随机种子）；可拖图片文件进来，或点卡片后 Ctrl+V——资源管理器里复制的多张图也能一次全贴上</div>
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

    <!-- 用户自定义常用提示词：点一下追加到输入框（所有文本字段共用一份库，悬停 chip 出 × 删除） -->
    <div v-if="field.kind === 'textarea' || field.kind === 'text'" class="quick-row">
      <button
        v-for="p in quickPrompts"
        :key="p"
        class="chip quick"
        :title="`追加「${p}」到输入框`"
        @click="applyQuick(p)"
      >
        <span class="q-text">{{ p }}</span>
        <span class="q-del" title="从常用列表删除" @click.stop="removeQuick(p)">×</span>
      </button>
      <button
        v-if="!quickAdding"
        class="chip quick-add"
        title="把一段提示词存成常用按钮"
        @click="quickAdding = true"
      >
        ＋ 常用
      </button>
      <span v-else class="quick-editor">
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
  gap: 6px;
  margin-top: 6px;
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
  gap: 6px;
  margin-bottom: 6px;
}
.tbtn {
  font-size: 11px;
  padding: 2px 9px;
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
  width: 76px;
  height: 76px;
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
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb .ph {
  font-size: 22px;
  color: var(--text-faint);
}
.img-side {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
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
  gap: 6px;
}
.thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.mthumb {
  position: relative;
  width: 64px;
  height: 64px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-2);
}
.mthumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
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
  width: 64px;
  height: 64px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  color: var(--text-faint);
  font-size: 22px;
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
  font-size: 11px;
  color: var(--text-faint);
}

/* 预设值 chips */
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
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
