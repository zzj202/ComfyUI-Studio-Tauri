<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { api, viewUrl } from '../api/tauri'
import { downloadDir } from '@tauri-apps/api/path'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import type { Asset, Job } from '../core/types'
import {
  applyAssetParams,
  beginDrag,
  clearAssets,
  isDragClick,
  markAllAssetsRead,
  markAssetRead,
  notify,
  openAssetWorkflow,
  refreshQueue,
  removeAsset,
  renameAsset,
  state,
  toggleAssetRead,
  togglePinAsset,
} from '../store'

const STATUS_TEXT: Record<Job['status'], string> = {
  queued: '排队中',
  running: '生成中',
  done: '已完成',
  error: '失败',
  cancelled: '已取消',
}

const activeJobs = computed(() =>
  state.jobs.filter((j) => j.status === 'running' || j.status === 'queued')
)

function pct(job: Job) {
  if (!job.max) return job.status === 'done' ? 100 : 0
  return Math.min(100, Math.round((job.value / job.max) * 100))
}

function dur(job: Job) {
  const end = job.finishedAt ?? Date.now()
  return ((end - job.startedAt) / 1000).toFixed(1) + 's'
}

function removeJob(job: Job) {
  const i = state.jobs.indexOf(job)
  if (i >= 0) state.jobs.splice(i, 1)
}

// ---------------------------------------------------------------- 结果资产

// ---- 筛选：按工作流 / 只看未读 / 只看收藏（资产多了找图快） ----
const filterWf = ref('')
const onlyUnread = ref(false)
const onlyPinned = ref(false)

const wfOptions = computed(() => {
  const set = new Set<string>()
  for (const a of state.assets) if (a.workflow) set.add(a.workflow)
  return [...set].sort()
})

const filterActive = computed(() => !!filterWf.value || onlyUnread.value || onlyPinned.value)

function resetFilters() {
  filterWf.value = ''
  onlyUnread.value = false
  onlyPinned.value = false
}

/** 固定的排最前，其余按产出时间倒序；筛选条件叠加（灯箱翻页也走这份列表） */
const assets = computed(() =>
  [...state.assets]
    .filter(
      (a) =>
        (!filterWf.value || a.workflow === filterWf.value) &&
        (!onlyUnread.value || !a.read) &&
        (!onlyPinned.value || a.pinned)
    )
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.createdAt - a.createdAt)
)

const unreadCount = computed(() => state.assets.filter((a) => !a.read).length)

/**
 * 预览地址缓存（key → { base, url }）。
 * viewUrl 每次调用都带新时间戳参数，若模板直接绑定，组件每次重渲染
 * （进度轮询 / 标已读 / 收藏切换…）src 都会变 → 视频图片全部重新加载 → 闪烁卡顿。
 * 同一资产的 URL 只算一次；换 baseUrl 才重算（资产 key 含文件名，内容不会变）。
 */
const urlCache = new Map<string, { base: string; url: string }>()

function assetUrl(a: Asset) {
  const base = state.settings.baseUrl
  const hit = urlCache.get(a.key)
  if (hit && hit.base === base) return hit.url
  const url = viewUrl(base, a.filename, a.subfolder, a.type)
  urlCache.set(a.key, { base, url })
  return url
}

/** 网格视频默认只停在首帧（多视频同时循环解码会卡整机），悬停才播放 */
function hoverPlay(e: Event) {
  void (e.currentTarget as HTMLVideoElement | null)?.play().catch(() => {})
}
function hoverStop(e: Event) {
  const v = e.currentTarget as HTMLVideoElement | null
  if (!v) return
  v.pause()
  try {
    v.currentTime = 0
  } catch {
    /* 元数据未就绪时忽略 */
  }
}

function displayName(a: Asset) {
  return a.alias || a.filename
}

function fmtTime(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function downloadOne(a: Asset) {
  try {
    const safe = displayName(a).replace(/[\\/:*?"<>|]/g, '_')
    // 别名可能不带扩展名 → 补上原文件扩展名，避免存出无后缀文件
    const ext = (a.filename.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase()
    const file = ext && !safe.toLowerCase().endsWith(ext) ? `${safe}${ext}` : safe
    // 不弹窗：直接存系统「下载」目录（同名覆盖无妨，ComfyUI 文件名本身唯一）
    const dir = String(await downloadDir()).replace(/[\\/]+$/, '')
    const dest = `${dir}/${file}`
    await api.saveOutput(state.settings.baseUrl, a.filename, a.subfolder, a.type, dest)
    notify(`已保存：${dest}`, 'ok', 4000)
  } catch (e) {
    notify(`保存失败：${e}`, 'error', 8000)
  }
}

async function openOutputDir() {
  try {
    if (state.settings.outputDir) await revealItemInDir(state.settings.outputDir)
  } catch (e) {
    notify(`打开失败：${e}`, 'error')
  }
}

// 行内重命名：✎ → 输入框，Enter/失焦确认，Esc 取消
const editingKey = ref<string | null>(null)
const editName = ref('')

function startRename(a: Asset) {
  editingKey.value = a.key
  editName.value = a.alias ?? ''
  nextTick(() => {
    const el = document.getElementById('asset-rename') as HTMLInputElement | null
    el?.focus()
    el?.select()
  })
}

function confirmRename(a: Asset) {
  if (editingKey.value === a.key) renameAsset(a, editName.value)
  editingKey.value = null
}

function cancelRename() {
  editingKey.value = null
}

// ---------------------------------------------------------------- 放大预览 + 左右翻页

const lightbox = ref(-1) // 在排序后列表里的下标；-1 = 关闭
const lbAsset = computed(() => (lightbox.value >= 0 ? assets.value[lightbox.value] : null))

function openLb(a: Asset) {
  if (isDragClick()) return // 拖拽结束在原卡上时浏览器仍会派发 click，别误开预览
  const i = assets.value.indexOf(a)
  if (i < 0) return
  lightbox.value = i
  markAssetRead(a)
}

function closeLb() {
  lightbox.value = -1
  lbEditing.value = false
}

function stepLb(d: number) {
  const n = assets.value.length
  if (!n) return
  lightbox.value = (lightbox.value + d + n) % n
  lbEditing.value = false
  markAssetRead(assets.value[lightbox.value])
}

// ---- 灯箱内重命名（确认后自动固定：起名保存 = 要收藏） ----
const lbEditing = ref(false)
const lbEditName = ref('')

function startLbRename() {
  const a = lbAsset.value
  if (!a) return
  lbEditName.value = a.alias ?? ''
  lbEditing.value = true
  nextTick(() => {
    const el = document.getElementById('lb-rename') as HTMLInputElement | null
    el?.focus()
    el?.select()
  })
}

function confirmLbRename() {
  if (!lbEditing.value) return
  const a = lbAsset.value
  if (a) {
    renameAsset(a, lbEditName.value)
    if (!a.pinned) togglePinAsset(a)
  }
  lbEditing.value = false
}

/** 灯箱里移除当前资产（列表会自动跳到相邻项之前先关掉，行为明确） */
function removeCurrent() {
  const a = lbAsset.value
  if (!a) return
  removeAsset(a)
  closeLb()
}

function onKey(e: KeyboardEvent) {
  if (lightbox.value < 0) return
  if (lbEditing.value) return // 重命名输入中：键盘留给输入框（Esc 由输入框自己处理）
  const k = e.key
  if (k === 'Escape') closeLb()
  else if (k === 'ArrowLeft' || k === 'a' || k === 'A') stepLb(-1)
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') stepLb(1)
}

// ---------------------------------------------------------------- 应用内拖拽 / 右键菜单

/** 按下卡片开始拖拽（逻辑在 store 的拖拽总线里：ghost 跟随 + 松手命中落点） */
function onCardPointerDown(e: PointerEvent, a: Asset) {
  beginDrag(e, { asset: a, label: displayName(a), thumb: assetUrl(a) })
}

const ctxMenu = ref<{ x: number; y: number; asset: Asset } | null>(null)

function openCtx(e: MouseEvent, a: Asset) {
  e.preventDefault()
  // 粗略防溢出（菜单约 168×252）
  ctxMenu.value = {
    x: Math.min(e.clientX, window.innerWidth - 176),
    y: Math.min(e.clientY, window.innerHeight - 262),
    asset: a,
  }
}

function closeCtx() {
  ctxMenu.value = null
}

function onGlobalCtx(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  if (!t?.closest('[data-asset-card]') && !t?.closest('.ctx-menu')) closeCtx()
}

function ctxRun(fn: (a: Asset) => void) {
  if (ctxMenu.value) fn(ctxMenu.value.asset)
  closeCtx()
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('click', closeCtx)
  window.addEventListener('contextmenu', onGlobalCtx)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('click', closeCtx)
  window.removeEventListener('contextmenu', onGlobalCtx)
})
</script>

<template>
  <section class="panel">
    <!-- 队列：紧凑条，高度很短 -->
    <div class="queue">
      <header class="q-head">
        <h2>队列</h2>
        <span v-if="activeJobs.length" class="live-badge">{{ activeJobs.length }} 个进行中</span>
        <span v-else-if="state.queueRemaining" class="faint">待处理 {{ state.queueRemaining }}</span>
        <span class="spacer" />
        <button class="btn ghost sm" @click="refreshQueue">刷新</button>
        <button class="btn ghost sm" :disabled="!state.settings.outputDir" @click="openOutputDir">
          输出目录
        </button>
      </header>
      <div class="q-body">
        <div v-if="!state.jobs.length" class="q-empty">队列空 · 任务进度显示在这里</div>
        <div v-for="job in state.jobs" :key="job.promptId" class="q-row">
          <span class="dot" :class="job.status" />
          <span class="q-wf" :title="job.workflow">{{ job.workflow || '—' }}</span>
          <div v-if="job.status === 'running' || job.status === 'queued'" class="q-bar">
            <div class="q-fill" :style="{ width: pct(job) + '%' }" />
          </div>
          <span v-else class="q-state" :class="{ err: job.status === 'error' }">
            {{ job.error ? '失败' : STATUS_TEXT[job.status] }} · {{ dur(job) }}
          </span>
          <span v-if="job.outputs.length" class="faint q-files">{{ job.outputs.length }} 文件</span>
          <button class="btn ghost sm q-x" title="移除记录" @click="removeJob(job)">✕</button>
        </div>
      </div>
    </div>

    <!-- 结果：资产区 -->
    <div class="results">
      <header class="r-head">
        <h2>结果</h2>
        <span class="faint">
          {{ filterActive ? `${assets.length}/${state.assets.length}` : `${assets.length} 项` }}
        </span>
        <button v-if="unreadCount" class="btn ghost sm" @click="markAllAssetsRead">
          全部标为已读（{{ unreadCount }}）
        </button>
        <span class="spacer" />
        <button class="btn sm" :disabled="!assets.length" title="只清掉已看过的；未读和 📌 固定的保留" @click="clearAssets">
          清空资产
        </button>
      </header>
      <!-- 筛选条：工作流下拉 + 未读/收藏 chip；灯箱翻页跟随筛选结果 -->
      <div class="r-filter">
        <select v-model="filterWf" class="select f-wf" title="只看某个工作流的产出">
          <option value="">全部工作流</option>
          <option v-for="w in wfOptions" :key="w" :value="w">{{ w }}</option>
        </select>
        <button class="chip-f" :class="{ on: onlyUnread }" title="只看未读（新产出）" @click="onlyUnread = !onlyUnread">
          未读
        </button>
        <button class="chip-f" :class="{ on: onlyPinned }" title="只看固定的收藏" @click="onlyPinned = !onlyPinned">
          📌 收藏
        </button>
        <span class="spacer" />
        <button v-if="filterActive" class="btn ghost sm" @click="resetFilters">重置筛选</button>
      </div>
      <div class="r-body">
        <div v-if="!assets.length" class="empty">
          还没有产出。<br />提交生成后，出图会出现在这里，点击可放大预览。
        </div>
        <div v-else class="grid">
          <figure
            v-for="a in assets"
            :key="a.key"
            class="card"
            :class="{ 'unread-card': !a.read }"
            data-asset-card
            @click="openLb(a)"
            @pointerdown="onCardPointerDown($event, a)"
            @contextmenu="openCtx($event, a)"
          >
            <div class="media">
              <video
                v-if="a.kind === 'video'"
                :src="assetUrl(a)"
                muted
                loop
                playsinline
                preload="metadata"
                title="悬停播放"
                @mouseenter="hoverPlay($event)"
                @mouseleave="hoverStop($event)"
              />
              <img v-else :src="assetUrl(a)" :alt="displayName(a)" loading="lazy" />
              <span v-if="!a.read" class="unread-pill">未读</span>
              <span v-if="a.pinned" class="pin-flag" title="已固定">📌</span>
            </div>
            <figcaption>
              <input
                v-if="editingKey === a.key"
                id="asset-rename"
                v-model="editName"
                class="rename-input"
                @click.stop
                @keydown.enter.prevent="confirmRename(a)"
                @keydown.esc.prevent="cancelRename"
                @blur="confirmRename(a)"
              />
              <span v-else class="name" :title="displayName(a)">{{ displayName(a) }}</span>
              <span class="time">{{ fmtTime(a.createdAt) }}</span>
            </figcaption>
            <div class="tools" @click.stop>
              <button
                class="tool"
                :class="{ on: a.pinned }"
                :title="a.pinned ? '取消固定' : '固定（清空时不删除）'"
                @click="togglePinAsset(a)"
              >
                📌
              </button>
              <button class="tool" title="重命名" @click="startRename(a)">✎</button>
              <button class="tool" title="下载到本地" @click="downloadOne(a)">⬇</button>
              <button class="tool danger" title="移除" @click="removeAsset(a)">✕</button>
            </div>
          </figure>
        </div>
      </div>
    </div>

    <!-- 放大预览：左右翻页 / 方向键 / Esc -->
    <div v-if="lbAsset" class="lightbox" @click.self="closeLb">
      <button class="nav prev" title="上一张（← / A）" @click="stepLb(-1)">‹</button>
      <div class="stage" @click.self="closeLb">
        <video
          v-if="lbAsset.kind === 'video'"
          :key="lbAsset.key"
          :src="assetUrl(lbAsset)"
          controls
          autoplay
          loop
          playsinline
        />
        <img v-else :key="lbAsset.key" :src="assetUrl(lbAsset)" :alt="displayName(lbAsset)" />
      </div>
      <button class="nav next" title="下一张（→ / D）" @click="stepLb(1)">›</button>
      <footer class="lb-foot" @click.stop>
        <template v-if="lbEditing">
          <input
            id="lb-rename"
            v-model="lbEditName"
            class="lb-rename"
            placeholder="输入名称，回车确认"
            @keydown.enter.prevent="confirmLbRename"
            @keydown.esc.prevent="lbEditing = false"
            @blur="confirmLbRename"
          />
        </template>
        <template v-else>
          <span v-if="lbAsset.pinned" class="lb-pin">📌</span>
          <span class="lb-name" :title="lbAsset.filename">{{ displayName(lbAsset) }}</span>
        </template>
        <span class="faint">{{ lightbox + 1 }} / {{ assets.length }}</span>
        <span class="spacer" />
        <button v-if="lbAsset.params" class="btn sm" title="把这张图提交时的参数回填到左侧表单" @click="applyAssetParams(lbAsset)">
          ⤴ 载入参数
        </button>
        <button v-if="lbAsset.kind === 'image'" class="btn sm" @click="openAssetWorkflow(lbAsset)">
          打开工作流
        </button>
        <button class="btn sm" @click="startLbRename">✎ 重命名</button>
        <button class="btn sm" @click="downloadOne(lbAsset)">下载</button>
        <button class="btn sm" :class="{ on: lbAsset.pinned }" @click="togglePinAsset(lbAsset)">
          {{ lbAsset.pinned ? '取消固定' : '固定' }}
        </button>
        <button class="btn sm danger" @click="removeCurrent">移除</button>
        <button class="btn sm ghost" @click="closeLb">关闭</button>
      </footer>
    </div>

    <!-- 应用内拖拽的跟随幽灵统一由 App.vue 渲染 -->

    <!-- 右键菜单 -->
    <div
      v-if="ctxMenu"
      class="ctx-menu"
      :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <button class="ctx-item" @click="ctxRun(openLb)">🔍 打开预览</button>
      <button class="ctx-item" @click="ctxRun(applyAssetParams)" title="把提交这张图时的参数回填到表单">⤴ 载入参数</button>
      <button class="ctx-item" @click="ctxRun(openAssetWorkflow)">📂 打开工作流</button>
      <button class="ctx-item" @click="ctxRun(downloadOne)">⬇ 下载到本地</button>
      <button class="ctx-item" @click="ctxRun(startRename)">✎ 重命名</button>
      <button class="ctx-item" @click="ctxRun(togglePinAsset)">
        📌 {{ ctxMenu.asset.pinned ? '取消固定' : '固定' }}
      </button>
      <button class="ctx-item" @click="ctxRun(toggleAssetRead)">
        👁 {{ ctxMenu.asset.read ? '标为未读' : '标为已读' }}
      </button>
      <div class="ctx-sep" />
      <button class="ctx-item danger" @click="ctxRun(removeAsset)">✕ 移除</button>
    </div>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-1);
  min-width: 0;
}

/* ---- 队列：紧凑条 ---- */
.queue {
  flex: none;
  border-bottom: 1px solid var(--border-soft);
  background: var(--panel);
}
.q-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px 6px;
}
.q-head h2 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
}
.live-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  color: var(--cyan);
  border: 1px solid #22d3ee44;
  background: #22d3ee14;
}
.spacer {
  flex: 1;
}
.q-body {
  max-height: 118px;
  overflow-y: auto;
  padding: 0 14px 8px;
}
.q-empty {
  font-size: 11.5px;
  color: var(--text-faint);
  padding: 4px 0 2px;
}
.q-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  padding: 3px 0;
  min-height: 22px;
}
.dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-faint);
}
.dot.running {
  background: var(--cyan);
  box-shadow: 0 0 6px #22d3ee88;
  animation: pulse 1.2s infinite;
}
.dot.queued {
  background: #f59e0b;
}
.dot.done {
  background: var(--ok);
}
.dot.error,
.dot.cancelled {
  background: var(--err);
}
@keyframes pulse {
  50% {
    opacity: 0.4;
  }
}
.q-wf {
  flex: none;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
}
.q-bar {
  flex: 1;
  height: 4px;
  background: var(--bg-3);
  border-radius: 2px;
  overflow: hidden;
}
.q-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--cyan));
  transition: width 0.25s;
}
.q-state {
  flex: 1;
  color: var(--text-faint);
}
.q-state.err {
  color: var(--err);
}
.q-files {
  flex: none;
}
.q-x {
  flex: none;
  padding: 0 6px;
}

/* ---- 结果 ---- */
.results {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.r-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  flex: none;
}
.r-head h2 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
}

/* ---- 结果筛选条 ---- */
.r-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 14px 8px;
  flex: none;
}
.f-wf {
  width: 150px;
  flex: none;
  padding: 3px 24px 3px 8px;
  font-size: 12px;
}
.chip-f {
  font-size: 11.5px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text-dim);
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.14s, color 0.14s, background 0.14s;
}
.chip-f:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.chip-f.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.r-body {
  flex: 1;
  overflow: auto;
  padding: 2px 14px 20px;
}
.empty {
  color: var(--text-faint);
  font-size: 12.5px;
  padding: 32px 0;
  text-align: center;
  line-height: 2;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
  gap: 10px;
}
.card {
  position: relative;
  margin: 0;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
  cursor: zoom-in;
  background: var(--panel);
  transition: border-color 0.14s, transform 0.14s;
}
.card:hover {
  border-color: var(--accent);
  transform: translateY(-1px);
}
.media {
  position: relative;
}
.media img,
.media video {
  width: 100%;
  height: 108px;
  object-fit: cover;
  display: block;
  background: #000;
}
/* 未读：accent 描边 + 光晕，一眼能认出哪些是没看过的新图 */
.card.unread-card {
  border-color: var(--accent);
  box-shadow:
    0 0 0 1px var(--accent-soft),
    0 2px 12px rgba(99, 102, 241, 0.28);
}
.unread-pill {
  position: absolute;
  top: 6px;
  left: 6px;
  background: var(--accent);
  color: #fff;
  font-size: 10px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 999px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}
.pin-flag {
  position: absolute;
  top: 3px;
  right: 4px;
  font-size: 11px;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
}
.card figcaption {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 7px;
  font-size: 10.5px;
  color: var(--text-faint);
}
.card figcaption .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card figcaption .time {
  flex: none;
  font-size: 10px;
  opacity: 0.7;
}
.rename-input {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  padding: 1px 4px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
}
.tools {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  padding: 4px;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.45), transparent);
  opacity: 0;
  transition: opacity 0.14s;
}
.card:hover .tools {
  opacity: 1;
}
.tool {
  border: none;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 11px;
  line-height: 1;
  padding: 4px 6px;
  cursor: pointer;
}
.tool:hover {
  background: rgba(0, 0, 0, 0.75);
}
.tool.on {
  background: var(--accent);
}
.tool.danger:hover {
  background: rgba(220, 38, 38, 0.9);
}

/* ---- 放大预览 ---- */
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(0, 0, 0, 0.88);
  display: flex;
  align-items: center;
  justify-content: center;
}
.stage {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 34px 12px 56px;
  min-width: 0;
}
.stage img,
.stage video {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: 6px;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);
}
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
  width: 44px;
  height: 64px;
  border: none;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  font-size: 30px;
  line-height: 1;
  cursor: pointer;
}
.nav:hover {
  background: rgba(255, 255, 255, 0.2);
}
.nav.prev {
  left: 14px;
}
.nav.next {
  right: 14px;
}
.lb-foot {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: rgba(0, 0, 0, 0.55);
  color: #e5e5e5;
  font-size: 12.5px;
}
.lb-pin {
  font-size: 13px;
}
.lb-name {
  max-width: 46%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lb-rename {
  width: 300px;
  font-size: 12.5px;
  padding: 4px 8px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
}
.btn.on {
  border-color: var(--accent);
  color: var(--accent);
}

/* ---- 右键菜单 ---- */
.ctx-menu {
  position: fixed;
  z-index: 130;
  min-width: 160px;
  padding: 5px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
}
.ctx-item {
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
.ctx-item:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.ctx-item.danger:hover {
  background: #f871711f;
  color: var(--err);
}
.ctx-sep {
  height: 1px;
  background: var(--border-soft);
  margin: 4px 6px;
}
</style>
