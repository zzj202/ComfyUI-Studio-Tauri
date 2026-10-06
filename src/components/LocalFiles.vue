<script setup lang="ts">
/**
 * 右侧「📁 素材」面板：浏览用户本地文件夹里的图片/视频（自定义路径，单层浏览）。
 * - 缩略图经 convertFileSrc（assetProtocol scope 已全放行）直接显示；视频悬停播放
 * - 按住卡片拖到左侧参数区图片卡 = 设为参考图（复用应用内拖拽总线）
 * - 右键：发送到图片字段 / 打开所在位置
 * - 只读不写：不提供删除等破坏性操作，本地文件在资源管理器里管
 */
import { computed, ref, watch } from 'vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { api, saveTempBlob } from '../api/tauri'
import { addManualAsset, beginDrag, imageDropTargets, notify, primaryBase, state } from '../store'
import { ui } from '../ui'

interface MediaItem {
  name: string
  path: string
  isDir: boolean
  kind: 'dir' | 'image' | 'video'
  size: number
  mtime: number
}

const DIR_KEY = 'comfyui-studio.localFilesDir:v1'

const dir = ref('')
const items = ref<MediaItem[]>([])
const loading = ref(false)
const error = ref('')
const preview = ref<MediaItem | null>(null)
const broken = ref(new Set<string>())

try {
  dir.value = localStorage.getItem(DIR_KEY) ?? ''
} catch {
  /* ignore */
}

/** 已成功加载的目录：canonicalize 回写 dir 会再触发 watch，靠它防二次加载 */
let lastLoaded = ''

/** 目录变化即自动加载（点目录卡 / 面包屑 / 换目录都走这里，无需手动刷新） */
watch(dir, (v) => {
  try {
    if (v) localStorage.setItem(DIR_KEY, v)
    else localStorage.removeItem(DIR_KEY)
  } catch {
    /* ignore */
  }
  if (v && v !== lastLoaded) void load()
})

/** 打开状态从关到开时：目录已加载过就展示缓存，没加载过（首次）才拉取；
 *  immediate 兜住「恢复时已处于打开态」的启动路径（此时不会再有变化触发 watch） */
watch(
  () => ui.localFilesOpen,
  (open_) => {
    if (open_ && dir.value && !items.value.length) void load()
  },
  { immediate: true }
)

async function load() {
  if (!dir.value) return
  loading.value = true
  error.value = ''
  try {
    const data = await api.listLocalMedia(dir.value)
    lastLoaded = data.dir
    items.value = data.items
    // Rust 侧 canonicalize 后的规范绝对路径（dialog 可能给相对路径），回写保证面包屑/持久化正确；
    // 回写会再触发 watch(dir)，但 dir === lastLoaded 直接跳过，不会二次加载
    dir.value = data.dir
  } catch (e) {
    error.value = String(e)
    items.value = []
  } finally {
    loading.value = false
  }
}

async function pickDir() {
  const picked = await open({ directory: true, multiple: false })
  if (!picked || typeof picked !== 'string') return
  dir.value = picked // watch(dir) 自动加载
}

/** 面包屑分段：盘符 + 各级目录名，点击回跳 */
const crumbs = computed(() => {
  if (!dir.value) return []
  const segs = dir.value.split(/[\\/]/).filter(Boolean)
  const out: { label: string; path: string }[] = []
  let acc = ''
  for (let i = 0; i < segs.length; i++) {
    acc += i === 0 ? segs[i] + '\\' : segs[i] + (i < segs.length - 1 ? '\\' : '')
    out.push({ label: segs[i], path: i === 0 ? segs[i] + '\\' : acc })
  }
  return out
})

function parentDir(): string {
  const i = Math.max(dir.value.lastIndexOf('\\'), dir.value.lastIndexOf('/'))
  return i > 0 ? dir.value.slice(0, i) : ''
}

function goUp() {
  const p = parentDir()
  if (p) dir.value = p
}

/** 进入目录 / 预览文件 */
function activate(it: MediaItem) {
  if (it.isDir) {
    dir.value = it.path
    return
  }
  preview.value = it
}

function fileName(p: string) {
  return p.split(/[\\/]/).pop() ?? p
}

function thumbUrl(it: MediaItem) {
  return convertFileSrc(it.path)
}

// ---- 时间分组（今天/昨天/本周早些时候/本月早些时候/更早），组可折叠 ----

const LF_COLLAPSE_KEY = 'comfyui-studio.localFilesCollapsed:v1'
const collapsed = ref<Set<string>>(new Set())
try {
  const raw = localStorage.getItem(LF_COLLAPSE_KEY)
  if (raw) {
    const list = JSON.parse(raw)
    if (Array.isArray(list)) collapsed.value = new Set(list.filter((x: any) => typeof x === 'string'))
  }
} catch {
  /* ignore */
}

function toggleGroup(label: string) {
  const s = new Set(collapsed.value)
  if (s.has(label)) s.delete(label)
  else s.add(label)
  collapsed.value = s
  try {
    localStorage.setItem(LF_COLLAPSE_KEY, JSON.stringify([...s]))
  } catch {
    /* ignore */
  }
}

/** items 已按 mtime 倒序，分组天然保序；文件夹与文件混排进所属时间组 */
const groups = computed(() => {
  const map = new Map<string, MediaItem[]>()
  const order: string[] = []
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000
  const dow = (now.getDay() + 6) % 7 // 周一=0
  const startOfWeek = startOfToday - dow * 86_400_000
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  for (const it of items.value) {
    const t = it.mtime * 1000
    let label: string
    if (t >= startOfToday) label = '今天'
    else if (t >= startOfYesterday) label = '昨天'
    else if (t >= startOfWeek) label = '本周早些时候'
    else if (t >= startOfMonth) label = '本月早些时候'
    else label = '更早'
    if (!map.has(label)) {
      map.set(label, [])
      order.push(label)
    }
    map.get(label)!.push(it)
  }
  return order.map((label) => ({ label, items: map.get(label)! }))
})

// ---- 预览浮层的复制/截帧：字节经 Rust 拿回（asset 源跨域会污染 canvas）再走 blob URL ----

const pvVideo = ref<HTMLVideoElement | null>(null)

function b64ToBlobUrl(b64: string, mime: string): string {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

function extOf(p: string): string {
  const n = p.split(/[\\/]/).pop() ?? ''
  const i = n.lastIndexOf('.')
  return i >= 0 ? n.slice(i + 1).toLowerCase() : ''
}

/** 截取预览视频当前帧：进剪贴板 + 结果区留底（自动固定），与结果区截帧行为一致 */
async function captureFrame(it: MediaItem) {
  const t = pvVideo.value?.currentTime ?? 0
  notify('正在截取当前帧…', 'info', 2000)
  try {
    const url = b64ToBlobUrl(await api.readLocalFile(it.path), `video/${extOf(it.path) || 'mp4'}`)
    const off = document.createElement('video')
    off.muted = true
    off.preload = 'auto'
    off.src = url
    await new Promise<void>((resolve, reject) => {
      off.onloadedmetadata = () => resolve()
      off.onerror = () => reject(new Error('视频加载失败'))
    })
    off.currentTime = Math.min(t, off.duration || t)
    await new Promise<void>((resolve) => {
      off.onseeked = () => resolve()
      window.setTimeout(resolve, 3000) // seek 事件偶发不触发的兜底
    })
    const c = document.createElement('canvas')
    c.width = off.videoWidth || 720
    c.height = off.videoHeight || 1280
    c.getContext('2d')?.drawImage(off, 0, 0, c.width, c.height)
    URL.revokeObjectURL(url)
    const png = await new Promise<Blob>((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('截帧失败'))), 'image/png')
    )
    let copied = false
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      copied = true
    } catch {
      /* 剪贴板被占用/权限失败：结果区留底兜底 */
    }
    const path = await saveTempBlob(png, 'png')
    const base = primaryBase()
    const res = await api.uploadImage(base, path, undefined, 'studio', true)
    const name = String(res?.name ?? '')
    if (name) {
      addManualAsset({ base, filename: name, subfolder: String(res?.subfolder ?? 'studio'), pinned: true })
    }
    notify(
      copied
        ? '已截取当前帧：剪贴板可直接 Ctrl+V（结果区也留了一份）'
        : '已截取当前帧（剪贴板写入失败，结果区可查看）',
      copied ? 'ok' : 'warn',
      5000
    )
  } catch (e) {
    notify(`截帧失败：${e}`, 'error', 8000)
  }
}

/** 复制本地图片到剪贴板（统一转 PNG，gif/webp 都能贴） */
async function copyImage(it: MediaItem) {
  try {
    const url = b64ToBlobUrl(await api.readLocalFile(it.path), `image/${extOf(it.path) || 'png'}`)
    const img = document.createElement('img')
    img.src = url
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('图片加载失败'))
    })
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    c.getContext('2d')?.drawImage(img, 0, 0)
    URL.revokeObjectURL(url)
    const png = await new Promise<Blob>((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('转码失败'))), 'image/png')
    )
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    notify(`已复制「${it.name}」到剪贴板`, 'ok', 3000)
  } catch (e) {
    notify(`复制失败：${e}`, 'error', 8000)
  }
}

/** 发送到图片字段：走字段注册的上传回调（与粘贴/拖拽同一通道） */
function sendToField(p: string) {
  const f =
    state.fields.find((x) => x.kind === 'image') ??
    state.fields.find((x) => x.kind === 'multiimage')
  if (!f) {
    notify('当前工作流没有图片字段', 'warn', 4000)
    return
  }
  void imageDropTargets.get(f.key)?.(p)
  notify(`已发送「${fileName(p)}」到「${f.label}」`, 'ok', 2500)
}

// ---- 右键菜单 ----
const ctx = ref<{ x: number; y: number; item: MediaItem } | null>(null)

function openCtx(e: MouseEvent, it: MediaItem) {
  e.preventDefault()
  if (it.isDir) return
  ctx.value = {
    x: Math.min(e.clientX, window.innerWidth - 190),
    y: Math.min(e.clientY, window.innerHeight - 100),
    item: it,
  }
}

function ctxRun(fn: (it: MediaItem) => void) {
  if (ctx.value) fn(ctx.value.item)
  ctx.value = null
}

function fmtSize(n: number): string {
  if (!n) return ''
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1048576).toFixed(1)}MB`
}

// 点击其他地方关菜单 / 预览
function onDocClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  if (!t?.closest('.lf-ctx')) ctx.value = null
  if (!t?.closest('.lf-preview') && !t?.closest('.lf-card')) preview.value = null
}
window.addEventListener('click', onDocClick)
</script>

<template>
  <aside v-if="ui.localFilesOpen" class="lf">
    <header class="lf-head">
      <span class="lf-title">📁 素材</span>
      <span class="lf-path mono" :title="dir || '未选择目录'">{{ dir || '未选择目录' }}</span>
      <span class="spacer" />
      <button class="btn sm ghost" title="更换目录" @click="pickDir">📂</button>
      <button
        class="btn sm ghost"
        :disabled="!dir || loading"
        title="刷新（平时进目录/切目录自动加载）"
        @click="load"
      >
        ↻
      </button>
    </header>

    <!-- 面包屑：盘符/目录名点击回跳；.. 返回上级 -->
    <div v-if="dir" class="lf-crumbs">
      <button class="lf-crumb" title="返回上级" @click="goUp">..</button>
      <button v-for="(c, i) in crumbs" :key="c.path" class="lf-crumb" :title="c.path" @click="dir = c.path">
        {{ c.label }}<span v-if="i < crumbs.length - 1" class="lf-sep">›</span>
      </button>
      <span class="spacer" />
      <span class="faint lf-n">{{ items.filter((x) => !x.isDir).length }} 项</span>
    </div>

    <div class="lf-body">
      <div v-if="!dir" class="lf-empty">
        选择一个文件夹开始<br />
        <button class="btn sm" @click="pickDir">📂 选择目录</button>
      </div>
      <div v-else-if="loading" class="lf-empty">读取中…</div>
      <div v-else-if="error" class="lf-empty lf-err">{{ error }}</div>
      <div v-else-if="!items.length" class="lf-empty">这个目录里没有图片 / 视频</div>

      <template v-else>
        <!-- 时间分组：今天/昨天/本周早些时候/本月早些时候/更早，组头点击折叠 -->
        <section v-for="g in groups" :key="g.label" class="lf-group">
          <button class="lf-ghead" :title="collapsed.has(g.label) ? '展开' : '收起'" @click="toggleGroup(g.label)">
            <span class="lf-tri">{{ collapsed.has(g.label) ? '▸' : '▾' }}</span>
            <span>{{ g.label }}</span>
            <span class="lf-gcount">{{ g.items.length }}</span>
            <span class="lf-gline" />
          </button>
          <div v-show="!collapsed.has(g.label)" class="lf-grid">
            <div
              v-for="it in g.items"
              :key="it.path"
              class="lf-card"
              :class="{ dir: it.isDir }"
              :title="it.isDir ? it.name : `${it.name}${fmtSize(it.size) ? ' · ' + fmtSize(it.size) : ''}（按住拖到参数卡）`"
              @click="activate(it)"
              @pointerdown="!it.isDir && beginDrag($event, { path: it.path, label: it.name, thumb: thumbUrl(it) })"
              @contextmenu="openCtx($event, it)"
            >
              <template v-if="it.isDir">
                <span class="lf-dir-icon">📁</span>
                <span class="lf-dir-name">{{ it.name }}</span>
              </template>
              <template v-else>
                <video
                  v-if="it.kind === 'video' && !broken.has(it.path)"
                  :src="thumbUrl(it)"
                  muted
                  loop
                  playsinline
                  preload="metadata"
                  @mouseenter="(e) => (e.currentTarget as HTMLVideoElement)?.play().catch(() => {})"
                  @mouseleave="(e) => { const v = e.currentTarget as HTMLVideoElement; v?.pause(); if (v) v.currentTime = 0 }"
                  @error="broken.add(it.path)"
                />
                <img
                  v-else-if="it.kind === 'image' && !broken.has(it.path)"
                  :src="thumbUrl(it)"
                  :alt="it.name"
                  loading="lazy"
                  @error="broken.add(it.path)"
                />
                <span v-else class="lf-ph">{{ it.kind === 'video' ? '🎬' : '🖼' }}</span>
                <span v-if="it.kind === 'video'" class="lf-kind">▶</span>
              </template>
            </div>
          </div>
        </section>
      </template>
    </div>

    <!-- 右键菜单 -->
    <div
      v-if="ctx"
      class="lf-ctx"
      :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <button class="lf-ctx-item" @click="ctxRun((it) => sendToField(it.path))">
        ⤴ 发送到图片字段
      </button>
      <button class="lf-ctx-item" @click="ctxRun((it) => revealItemInDir(it.path).catch(() => {}))">
        📂 打开所在位置
      </button>
    </div>

    <!-- 点击放大预览（Esc / 点外部关闭）：视频可截帧、图片可复制 -->
    <div v-if="preview" class="lf-preview" @click.self="preview = null" @contextmenu.prevent>
      <div class="lf-pv-body">
        <video v-if="preview.kind === 'video'" ref="pvVideo" :src="thumbUrl(preview)" controls autoplay loop />
        <img v-else :src="thumbUrl(preview)" :alt="preview.name" />
      </div>
      <div class="lf-pv-cap">
        <span class="mono" :title="preview.path">{{ preview.name }}</span>
        <span class="spacer" />
        <button v-if="preview.kind === 'video'" class="btn sm" title="截取当前画面：进剪贴板，结果区留底并自动固定" @click="captureFrame(preview)">
          📷 截帧
        </button>
        <button v-if="preview.kind === 'image'" class="btn sm" title="复制图片（可直接粘贴发送）" @click="copyImage(preview)">
          ⧉ 复制
        </button>
        <button class="btn sm" @click="sendToField(preview.path)">⤴ 发送到图片字段</button>
        <button class="btn sm ghost" @click="preview = null">✕</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.lf {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 268px;
  min-height: 0;
  background: var(--bg-1);
  border-left: 1px solid var(--border-soft);
  overflow: hidden;
}
.lf-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 6px;
  flex: none;
}
.lf-title {
  font-size: 12.5px;
  font-weight: 600;
  flex: none;
}
.lf-path {
  font-size: 10.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.spacer {
  flex: 1;
}
.lf-crumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 0 10px 6px;
  flex: none;
  border-bottom: 1px solid var(--border-soft);
}
.lf-crumb {
  border: none;
  background: none;
  color: var(--text-dim);
  font-size: 11px;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lf-crumb:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.lf-sep {
  color: var(--text-faint);
  margin-left: 2px;
}
.lf-n {
  font-size: 10.5px;
}
.lf-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.lf-empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-faint);
  line-height: 2;
}
.lf-err {
  color: var(--err);
  word-break: break-all;
}
.lf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
  gap: 6px;
  padding: 4px 10px 10px;
}
/* 时间分组头：吸顶（lf-body 滚动时当前组名常驻可见） */
.lf-ghead {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: var(--bg-1);
  color: var(--text-dim);
  font-size: 11.5px;
  font-weight: 600;
  text-align: left;
  padding: 10px 12px 4px;
  cursor: pointer;
  position: sticky;
  top: 0;
  z-index: 1;
}
.lf-ghead:hover {
  color: var(--accent);
}
.lf-tri {
  font-size: 10px;
  width: 12px;
  flex: none;
  color: var(--text-faint);
}
.lf-gcount {
  font-size: 10.5px;
  color: var(--text-faint);
  font-weight: 400;
}
.lf-gline {
  flex: 1;
  height: 1px;
  background: var(--border-soft);
}
.lf-card {
  position: relative;
  aspect-ratio: 1;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-2);
  cursor: grab;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.lf-card:hover {
  border-color: var(--accent);
}
.lf-card.dir {
  cursor: pointer;
  aspect-ratio: auto;
  min-height: 52px;
  padding: 6px 4px;
  gap: 4px;
}
.lf-dir-icon {
  font-size: 20px;
}
.lf-dir-name {
  font-size: 10.5px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}
.lf-card img,
.lf-card video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
}
.lf-card video {
  pointer-events: auto;
}
.lf-ph {
  font-size: 20px;
}
.lf-kind {
  position: absolute;
  right: 3px;
  bottom: 3px;
  padding: 1px 5px;
  border-radius: 999px;
  background: rgba(13, 16, 23, 0.62);
  border: 1px solid rgba(255, 255, 255, 0.22);
  color: #e7ecf5;
  font-size: 9px;
  line-height: 1.3;
  pointer-events: none;
}
/* 右键菜单：fixed 定位，样式与结果区 ctx-menu 一致 */
.lf-ctx {
  position: fixed;
  z-index: 130;
  min-width: 170px;
  padding: 5px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
}
.lf-ctx-item {
  display: flex;
  align-items: center;
  gap: 7px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 12.5px;
  text-align: left;
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}
.lf-ctx-item:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
/* 预览浮层 */
.lf-preview {
  position: fixed;
  inset: 0;
  z-index: 125;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px;
}
.lf-pv-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.lf-pv-body img,
.lf-pv-body video {
  max-width: 100%;
  max-height: 100%;
  border-radius: 8px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
}
.lf-pv-cap {
  flex: none;
  width: 100%;
  max-width: 720px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--panel);
  border: 1px solid var(--border);
  font-size: 12px;
}
.lf-pv-cap .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
