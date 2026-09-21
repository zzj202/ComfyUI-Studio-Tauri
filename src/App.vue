<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import TopBar from './components/TopBar.vue'
import WorkflowPanel from './components/WorkflowPanel.vue'
import ParamPanel from './components/ParamPanel.vue'
import ResultPanel from './components/ResultPanel.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import TemplateEditor from './components/TemplateEditor.vue'
import LogPanel from './components/LogPanel.vue'
import Toasts from './components/Toasts.vue'
import AssetDrop from './components/AssetDrop.vue'
import LocalAssets from './components/LocalAssets.vue'
import { disposeAll, dragGhost, imageDropTargets, init, notify, refreshQueue, state } from './store'
import { api, saveTempBlob } from './api/tauri'
import type { FieldSchema } from './core/types'
import { IMG_EXT_RE, extFromFile, filesFromClipboardData } from './core/clipboard'
import { ui } from './ui'

let queueTimer: number | null = null

// ---- 全局 Ctrl+V：把剪贴板里的图片粘到第一个图片字段 ----
// 卡片聚焦时 FieldControl 自己处理（onCardPaste 并 stopPropagation）；
// 这里兜住「焦点在别处」的场景，并补上 WebView 看不到的文件列表（Rust 读）。

/** 粘贴目标：优先第一个单图字段，其次第一个多图字段 */
function pickPasteTarget(): FieldSchema | null {
  return (
    state.fields.find((f) => f.kind === 'image') ??
    state.fields.find((f) => f.kind === 'multiimage') ??
    null
  )
}

/** 内存里的图片 File → 落临时文件 → 走字段注册的上传回调 */
async function pasteFilesToTarget(files: File[]) {
  const target = pickPasteTarget()
  if (!target) {
    notify('当前工作流没有图片字段，粘贴的图片放不下', 'warn', 4000)
    return
  }
  const list = target.kind === 'image' ? files.slice(0, 1) : files
  const cb = imageDropTargets.get(target.key)
  for (const f of list) {
    const path = await saveTempBlob(f, extFromFile(f))
    await cb?.(path)
  }
  if (files.length > 1) {
    notify(
      target.kind === 'image'
        ? `共 ${files.length} 张，单图字段只用了第 1 张`
        : `已粘贴 ${files.length} 张图片到「${target.label}」`,
      'ok',
      3000
    )
  }
}

/** 资源管理器复制的图片文件（WebView 看不见的 CF_HDROP）→ Rust 读路径 → 直接走回调 */
async function pastePathsToTarget(): Promise<boolean> {
  const imgs = (await api.clipboardFilePaths()).filter((p) => IMG_EXT_RE.test(p))
  if (!imgs.length) return false
  const target = pickPasteTarget()
  if (!target) {
    notify('剪贴板里有图片文件，但当前工作流没有图片字段', 'warn', 4000)
    return true
  }
  const cb = imageDropTargets.get(target.key)
  if (target.kind === 'image') {
    await cb?.(imgs[0])
    if (imgs.length > 1) notify(`剪贴板里有 ${imgs.length} 张图，单图字段只用了第 1 张`, 'warn', 4000)
  } else {
    for (const p of imgs) await cb?.(p)
    if (imgs.length > 1) notify(`已粘贴 ${imgs.length} 张图片到「${target.label}」`, 'ok', 2500)
  }
  return true
}

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  )
}

async function onDocPaste(e: ClipboardEvent) {
  if (isEditableTarget(e.target)) return // 文本输入框 / 下拉里的正常粘贴不受影响
  const files = filesFromClipboardData(e.clipboardData)
  if (files.length) {
    e.preventDefault()
    e.stopPropagation()
    await pasteFilesToTarget(files)
    return
  }
  // 位图与 files 都看不到时（如资源管理器复制的图片文件），让 Rust 读剪贴板兜底
  try {
    if (await pastePathsToTarget()) {
      e.preventDefault()
      e.stopPropagation()
    }
  } catch {
    /* Rust 兜底失败就放行默认行为 */
  }
}

/** 按钮触感：全局点击涟漪（事件委托到 .btn/.tbtn，动画结束自动移除）
 *  灯箱翻页（.nav）刻意排除——全屏看图时不要涟漪 */
function onBtnPointerDown(e: PointerEvent) {
  const host = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.btn, .tbtn')
  if (!host || (host as HTMLButtonElement).disabled) return
  const rect = host.getBoundingClientRect()
  const d = Math.max(rect.width, rect.height) * 2
  const s = document.createElement('span')
  s.className = 'ripple'
  s.style.width = s.style.height = `${d}px`
  s.style.left = `${e.clientX - rect.left - d / 2}px`
  s.style.top = `${e.clientY - rect.top - d / 2}px`
  host.appendChild(s)
  s.addEventListener('animationend', () => s.remove())
  window.setTimeout(() => s.remove(), 700) // reduced-motion 下 animationend 不来，兜底清理
}

onMounted(async () => {
  document.addEventListener('paste', onDocPaste)
  document.addEventListener('pointerdown', onBtnPointerDown)
  await init()
  queueTimer = window.setInterval(() => {
    if (state.settings.autoRefreshQueue !== false && state.connection === 'ok') refreshQueue()
  }, 4000)
})

onUnmounted(() => {
  document.removeEventListener('paste', onDocPaste)
  document.removeEventListener('pointerdown', onBtnPointerDown)
  if (queueTimer != null) clearInterval(queueTimer)
  disposeAll()
})
</script>

<template>
  <div class="app">
    <TopBar />

    <div class="body">
      <aside class="col left">
        <div class="left-main"><WorkflowPanel /></div>
        <LocalAssets />
      </aside>
      <main class="col center"><ParamPanel /></main>
      <aside class="col right"><ResultPanel /></aside>
    </div>

    <!-- 应用内拖拽的跟随幽灵（ResultPanel / LocalAssets 共用） -->
    <div
      v-if="dragGhost.item"
      class="drag-ghost"
      :style="{ left: dragGhost.x + 14 + 'px', top: dragGhost.y + 12 + 'px' }"
    >
      <img v-if="dragGhost.item.thumb" :src="dragGhost.item.thumb" alt="" />
      <span v-else class="g-emoji">🎬</span>
      <span class="g-label">{{ dragGhost.item.label }}</span>
    </div>

    <AssetDrop />
    <LogPanel v-if="ui.logsOpen" />
    <SettingsDialog v-if="ui.settingsOpen" />
    <TemplateEditor v-if="ui.templateOpen && state.currentWorkflow" />
    <Toasts />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.body {
  flex: 1;
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr) 340px;
  min-height: 0;
}
.col {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.left {
  border-right: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
}
.left-main {
  flex: 1;
  min-height: 0;
}
.drag-ghost {
  position: fixed;
  z-index: 120;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px 5px 6px;
  border-radius: 999px;
  background: var(--panel);
  border: 1px solid var(--accent);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.45);
  pointer-events: none;
  font-size: 11.5px;
  color: var(--text);
  max-width: 220px;
}
.drag-ghost img {
  width: 30px;
  height: 30px;
  object-fit: cover;
  border-radius: 6px;
  display: block;
}
.drag-ghost .g-emoji {
  font-size: 18px;
}
.drag-ghost .g-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.right {
  border-left: 1px solid var(--border-soft);
}
.center {
  min-width: 0;
}
</style>
