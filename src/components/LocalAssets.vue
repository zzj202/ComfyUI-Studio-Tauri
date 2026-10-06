<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { api } from '../api/tauri'
import { captureLocalFrame, copyLocalImageToClipboard, writePngToClipboard } from '../core/localMedia'
import { beginDrag, imageDropTargets, notify, state } from '../store'
import { ui } from '../ui'

/**
 * 左下角「收藏」条：精选图片/视频，**添加时复制进应用自己的素材库目录**
 * （appData/favorites/，集中存放，不引用散落各处的原始路径，也不经过服务器）。
 * 按住拖到右侧参数区的图片卡上当参考图（拖的是素材库里的副本，原图随便删）；
 * 点击卡片 = 预览浮层（视频 ⏮⏸⏭📷 截帧 / 图片 ⧉ 复制，快捷键 Q/E/空格/R、Ctrl+C）；
 * 右键 = 发送到图片字段 / 复制图片 / 打开所在位置 / 移除。
 */

const KEY = 'comfyui-studio.favorites.v1'
const paths = ref<string[]>([])
const broken = ref(new Set<string>()) // 加载失败（文件被删/移动）的缩略图
const preview = ref<string | null>(null)
const pvVideo = ref<HTMLVideoElement | null>(null)
const pvPlaying = ref(false)

const VIDEO_RE = /\.(mp4|webm|mov|mkv|avi)$/i

function kindOf(p: string): 'image' | 'video' {
  return VIDEO_RE.test(p) ? 'video' : 'image'
}

onMounted(() => {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const list = JSON.parse(raw)
      if (Array.isArray(list)) paths.value = list.filter((p: any) => typeof p === 'string')
    }
  } catch {
    /* ignore */
  }
})

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(paths.value))
  } catch {
    /* ignore */
  }
}

function fileName(p: string) {
  return p.split(/[\\/]/).pop() ?? p
}

function thumbUrl(p: string) {
  return convertFileSrc(p)
}

/** 添加收藏：选本地文件 → 复制进应用素材库 favorites/ → 记录库内路径（集中存放） */
async function addFiles() {
  const picked = await open({
    multiple: true,
    filters: [
      {
        name: '图片/视频',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'webm', 'mov', 'mkv', 'avi'],
      },
    ],
  })
  if (!picked) return
  const files = Array.isArray(picked) ? picked : [picked]
  let added = 0
  notify(`正在复制 ${files.length} 个文件进素材库…`, 'info', 2000)
  for (const f of files) {
    try {
      const dest = await api.copyToFavorites(f)
      if (!paths.value.includes(dest)) {
        paths.value.push(dest)
        broken.value.delete(dest)
        added++
      }
    } catch (e) {
      notify(`「${fileName(f)}」收藏失败：${e}`, 'error', 6000)
    }
  }
  if (added) {
    persist()
    notify(`已收藏 ${added} 个文件（存入系统素材库）`, 'ok', 3000)
  }
}

function removeOne(p: string) {
  const i = paths.value.indexOf(p)
  if (i >= 0) paths.value.splice(i, 1)
  persist()
  if (preview.value === p) preview.value = null
}

function clearAll() {
  paths.value = []
  preview.value = null
  persist()
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

// ---- 预览浮层（快捷键同素材面板：Q/E/空格/R，Ctrl+C 复制图片） ----

function stepPv(d: number) {
  const v = pvVideo.value
  if (!v) return
  v.pause()
  v.currentTime = Math.min(v.duration || 0, Math.max(0, v.currentTime + d / 30))
}

function togglePv() {
  const v = pvVideo.value
  if (!v) return
  if (v.paused) void v.play().catch(() => {})
  else v.pause()
}

async function captureFrame(p: string) {
  const t = pvVideo.value?.currentTime ?? 0
  notify('正在截取当前帧…', 'info', 2000)
  try {
    const png = await captureLocalFrame(p, t)
    await writePngToClipboard(png)
    notify('已截取当前帧：剪贴板可直接 Ctrl+V', 'ok', 4000)
  } catch (e) {
    notify(`截帧失败：${e}`, 'error', 8000)
  }
}

async function copyImage(p: string) {
  try {
    await copyLocalImageToClipboard(p)
    notify(`已复制「${fileName(p)}」到剪贴板`, 'ok', 3000)
  } catch (e) {
    notify(`复制失败：${e}`, 'error', 8000)
  }
}

function onPvKey(e: KeyboardEvent) {
  if (!preview.value) return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  const k = e.key
  if ((e.ctrlKey || e.metaKey) && (k === 'c' || k === 'C')) {
    e.preventDefault()
    if (kindOf(preview.value) === 'image') void copyImage(preview.value)
    return
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (kindOf(preview.value) !== 'video') return
  if (k === 'q' || k === 'Q') stepPv(-1)
  else if (k === 'e' || k === 'E') stepPv(1)
  else if (k === ' ') {
    e.preventDefault()
    togglePv()
  } else if (k === 'r' || k === 'R') void captureFrame(preview.value)
}
window.addEventListener('keydown', onPvKey)

// ---- 右键菜单 ----
const ctx = ref<{ x: number; y: number; path: string } | null>(null)

function openCtx(e: MouseEvent, p: string) {
  e.preventDefault()
  ctx.value = {
    x: Math.min(e.clientX, window.innerWidth - 190),
    y: Math.min(e.clientY, window.innerHeight - 160),
    path: p,
  }
}

function ctxRun(fn: (p: string) => void) {
  if (ctx.value) fn(ctx.value.path)
  ctx.value = null
}

// 点击其他地方关菜单 / 预览
function onDocClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  if (!t?.closest('.fav-ctx')) ctx.value = null
  if (!t?.closest('.fav-preview') && !t?.closest('.thumb')) preview.value = null
}
window.addEventListener('click', onDocClick)
</script>

<template>
  <section v-if="ui.localAssetsOpen" class="local">
    <header class="head">
      <h2>收藏</h2>
      <span class="faint">{{ paths.length }}</span>
      <span class="spacer" />
      <button class="btn sm" title="选择本地文件复制进系统素材库（集中存放）" @click="addFiles">
        ＋ 添加
      </button>
      <button class="btn sm ghost" :disabled="!paths.length" @click="clearAll">清空</button>
    </header>
    <div class="strip">
      <div v-if="!paths.length" class="empty">常用图片/视频存这里（复制进系统素材库集中存放），<br />按住拖到右侧参数卡当参考图</div>
      <div
        v-for="p in paths"
        :key="p"
        class="thumb"
        :title="`${fileName(p)}（按住拖到参数卡 · 点击预览 · 右键更多）`"
        @pointerdown="beginDrag($event, { path: p, label: fileName(p), thumb: thumbUrl(p) })"
        @click="preview = p"
        @contextmenu="openCtx($event, p)"
      >
        <video
          v-if="kindOf(p) === 'video' && !broken.has(p)"
          :src="thumbUrl(p)"
          muted
          loop
          playsinline
          preload="metadata"
          @mouseenter="(e) => (e.currentTarget as HTMLVideoElement)?.play().catch(() => {})"
          @mouseleave="(e) => { const v = e.currentTarget as HTMLVideoElement; v?.pause(); if (v) v.currentTime = 0 }"
          @error="broken.add(p)"
        />
        <img
          v-else-if="kindOf(p) === 'image' && !broken.has(p)"
          :src="thumbUrl(p)"
          :alt="fileName(p)"
          loading="lazy"
          @error="broken.add(p)"
        />
        <span v-else class="ph">🖼</span>
        <span v-if="kindOf(p) === 'video'" class="kind">▶</span>
        <button class="x" title="移除收藏" @click.stop="removeOne(p)">✕</button>
      </div>
    </div>

    <!-- 右键菜单 -->
    <div
      v-if="ctx"
      class="fav-ctx"
      :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <button class="fav-ctx-item" @click="ctxRun((p) => sendToField(p))">⤴ 发送到图片字段</button>
      <button v-if="ctx.path && kindOf(ctx.path) === 'image'" class="fav-ctx-item" @click="ctxRun((p) => copyImage(p))">
        ⧉ 复制图片
      </button>
      <button class="fav-ctx-item" @click="ctxRun((p) => revealItemInDir(p).catch(() => {}))">
        📂 打开所在位置
      </button>
      <div class="fav-sep" />
      <button class="fav-ctx-item danger" @click="ctxRun((p) => removeOne(p))">✕ 移除收藏</button>
    </div>

    <!-- 预览浮层（快捷键同素材面板：Q/E/空格/R，Ctrl+C 复制图片） -->
    <div v-if="preview" class="fav-preview" @click.self="preview = null" @contextmenu.prevent>
      <div class="fav-pv-body">
        <video
          v-if="kindOf(preview) === 'video'"
          ref="pvVideo"
          :src="thumbUrl(preview)"
          controls
          autoplay
          loop
          @play="pvPlaying = true"
          @pause="pvPlaying = false"
        />
        <img v-else :src="thumbUrl(preview)" :alt="fileName(preview)" />
      </div>
      <div class="fav-pv-cap">
        <template v-if="kindOf(preview) === 'video'">
          <button class="btn sm ghost" title="上一帧（Q）" @click="stepPv(-1)">⏮</button>
          <button class="btn sm ghost" :title="pvPlaying ? '暂停（空格）' : '播放（空格）'" @click="togglePv">
            {{ pvPlaying ? '⏸' : '▶' }}
          </button>
          <button class="btn sm ghost" title="下一帧（E）" @click="stepPv(1)">⏭</button>
          <button class="btn sm" title="截取当前画面（R）：只进剪贴板" @click="captureFrame(preview)">
            📷 截帧
          </button>
        </template>
        <button v-if="kindOf(preview) === 'image'" class="btn sm" title="复制图片（Ctrl+C）" @click="copyImage(preview)">
          ⧉ 复制
        </button>
        <span class="fav-pv-name" :title="preview">{{ fileName(preview) }}</span>
        <span class="spacer" />
        <button class="btn sm ghost" @click="preview = null">✕</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.local {
  flex: none;
  border-top: 1px solid var(--border-soft);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  max-height: 216px;
  min-height: 0;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 6px;
  flex: none;
}
.head h2 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.strip {
  overflow-y: auto;
  padding: 0 12px 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
  gap: 6px;
  align-content: start;
}
.empty {
  grid-column: 1 / -1;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.7;
  padding: 4px 0 2px;
}
.thumb {
  position: relative;
  aspect-ratio: 1;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-2);
  cursor: grab;
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
  pointer-events: none;
}
.thumb .ph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 18px;
}
.kind {
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
.x {
  position: absolute;
  top: 0;
  right: 0;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 0 0 0 6px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.thumb:hover .x {
  display: flex;
}
.x:hover {
  background: rgba(220, 38, 38, 0.9);
}
/* 右键菜单（样式与结果区 ctx-menu 一致） */
.fav-ctx {
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
.fav-ctx-item {
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
.fav-ctx-item:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.fav-ctx-item.danger:hover {
  background: #f871711f;
  color: var(--err);
}
.fav-sep {
  height: 1px;
  background: var(--border-soft);
  margin: 4px 6px;
}
/* 预览浮层 */
.fav-preview {
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
.fav-pv-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.fav-pv-body img,
.fav-pv-body video {
  max-width: 100%;
  max-height: 100%;
  border-radius: 8px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
}
.fav-pv-cap {
  flex: none;
  width: 100%;
  max-width: 720px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--panel);
  border: 1px solid var(--border);
  font-size: 12px;
}
.fav-pv-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
