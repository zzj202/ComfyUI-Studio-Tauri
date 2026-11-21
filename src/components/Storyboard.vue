<script setup lang="ts">
/**
 * 「🎞 连续插画」栏：按序号摆放图片框，供连续插画 / 分镜稿的排版与连贯性检查。
 *
 * - 拖拽入框：结果区资产拖入 = 转存进 appDataDir/storyboard（落盘持久）；素材列本地文件 = 引用原路径；
 *   拖到已有图 = 替换；拖到面板底部追加条 = 追加新帧（空板也能直接拖）。
 * - 帧内图可再拖出：拖到参数区 = 设为参考图；拖到另一帧 / 追加条 = 调整顺序（不复制）。
 * - 点击帧 = 放大预览，A/D 或 ←/→ 只在本板帧序列内翻页；▶ 自动播放（间隔 0.2–3s，支持往返）。
 * - 右键帧：插入/清空/删除/移动/载入参数/打开工作流（有来源资产时）。
 * - 多画板：页签切换，双击页签重命名，新建/删除（磁盘图片保留）。
 * - 每帧备注行（一般写该镜提示词摘要）；整板可按 01/02/03… 编号导出到任意文件夹。
 * 状态与落盘逻辑在 core/storyboard.ts，本组件只做 UI。
 */
import { computed, nextTick, onUnmounted, reactive, ref, watch, watchEffect } from 'vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { appConfirm } from '../core/confirm'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import type { DragItem } from '../store'
import { copyLocalImageToClipboard } from '../core/localMedia'
import {
  applyAssetParams,
  beginDrag,
  dragGhost,
  dropZones,
  isDragClick,
  notify,
  openAssetWorkflow,
  state,
} from '../store'
import { IMG_EXT_RE } from '../core/clipboard'
import {
  SB_MAX_FRAMES,
  activeBoard,
  addBoard,
  appendFrame,
  clearFrame,
  exportBoardFrames,
  fillFrameFromAsset,
  fillFrameFromPath,
  insertFrameAfter,
  insertFrameBefore,
  removeBoard,
  removeFrame,
  reorderFrame,
  renameBoard,
  resetBoard,
  sbExtHover,
  storyboard,
  swapFrames,
  type SbBoard,
  type SbFrame,
} from '../core/storyboard'
import { ui } from '../ui'

const board = computed(() => activeBoard())
/** 有图且未损坏的帧：翻页 / 播放序列 */
const filled = computed(() => board.value?.frames.filter((f) => f.path && !broken.has(f.id)) ?? [])

function fileName(p: string) {
  return p.split(/[\\/]/).pop() ?? p
}
function thumbOf(f: SbFrame) {
  return convertFileSrc(f.path)
}

// ---------------------------------------------------------------- 拖拽落点注册
// 每帧一个 dropZone（sb:frame:<id>）+ 一个追加位（sb:append），取到完整 DragItem
// （能同时拿到 asset / path / sbFrameId 三种来源，比 data-image-key 双注册表更省事）。

const registered = new Set<string>()

function onDrop(zoneKey: string, item: DragItem) {
  const b = board.value
  if (!b) return
  // 帧内图拖到另一帧 / 追加条 = 调整顺序
  if (item.sbFrameId) {
    if (zoneKey === 'sb:append') {
      reorderFrame(b, item.sbFrameId, b.frames.length)
      return
    }
    const ti = b.frames.findIndex((f) => `sb:frame:${f.id}` === zoneKey)
    if (ti < 0) return
    const t = b.frames[ti]
    if (t.id === item.sbFrameId) return
    // 空框 = 换位（图像落进那个框；「插到它前面」在相邻框上等于没动，就是当初的 bug）
    if (!t.path) {
      swapFrames(b, item.sbFrameId, t.id)
      return
    }
    // 有图框 = 按 → 指针落在框的左半 / 右半决定插到它前 / 后（精确落点）
    if (zoneSide(zoneKey, dragGhost.x) === 'after') reorderFrame(b, item.sbFrameId, ti + 1)
    else reorderFrame(b, item.sbFrameId, ti)
    return
  }
  // 外部图入框：追加条 = 追加新帧；否则落到目标帧
  const target =
    zoneKey === 'sb:append'
      ? appendFrame(b)
      : b.frames.find((f) => `sb:frame:${f.id}` === zoneKey)
  if (!target) {
    notify(`最多 ${SB_MAX_FRAMES} 帧，加不下了`, 'warn', 3000)
    return
  }
  if (item.asset) {
    void fillFrameFromAsset(b, target, item.asset).then((ok) => {
      if (ok) broken.delete(target.id)
    })
  } else if (item.path && IMG_EXT_RE.test(item.path)) {
    fillFrameFromPath(target, item.path)
    broken.delete(target.id)
  } else {
    notify('插画板帧只收图片', 'warn', 3000)
  }
}

/** 指针在落点框的左半还是右半（决定「插到它前 / 后」；网格按阅读序 2 列） */
function zoneSide(zoneKey: string, pointerX: number): 'before' | 'after' {
  try {
    const el = document.querySelector(`[data-drop-zone="${zoneKey}"]`)
    if (!el) return 'before'
    const r = el.getBoundingClientRect()
    return pointerX > r.left + r.width / 2 ? 'after' : 'before'
  } catch {
    return 'before'
  }
}

watchEffect(() => {
  const wanted = new Set<string>(['sb:append'])
  if (board.value) for (const f of board.value.frames) wanted.add(`sb:frame:${f.id}`)
  for (const k of [...registered]) {
    if (!wanted.has(k)) {
      dropZones.delete(k)
      registered.delete(k)
    }
  }
  for (const k of wanted) {
    if (!registered.has(k)) {
      const key = k // 闭包捕获
      dropZones.set(key, (item: DragItem) => onDrop(key, item))
      registered.add(k)
    }
  }
})

// 组件随栏收起而卸载：必须把注册过的落点全部摘掉，否则留幽灵落点
onUnmounted(() => {
  for (const k of registered) dropZones.delete(k)
  registered.clear()
  stopPlay()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('click', onDocClick)
})

// ---------------------------------------------------------------- 拖拽悬停高亮 + 追加后自动滚动

const bodyEl = ref<HTMLElement | null>(null)
/** 拖拽经过的落点 key（sb:frame:<id> / sb:append）：命中本面板时高亮，松手即清 */
const hoverZone = ref<string | null>(null)
/** 指针在落点框的左半 / 右半：帧间拖动时显示插入位置线 */
const hoverSide = ref<'before' | 'after'>('before')
/** 正在拖的是不是板内帧（帧间拖动用插入线，外部图用整框点亮） */
const hoverInternal = ref(false)

watch(
  () => [dragGhost.x, dragGhost.y, dragGhost.item] as const,
  ([x, , item]) => {
    if (!item) {
      hoverZone.value = null
      hoverInternal.value = false
      return
    }
    hoverInternal.value = !!item.sbFrameId
    try {
      const el = document.elementFromPoint(dragGhost.x, dragGhost.y)
      const zone = el?.closest('[data-drop-zone]')?.getAttribute('data-drop-zone') ?? null
      if (zone?.startsWith('sb:')) {
        hoverZone.value = zone
        if (item.sbFrameId && zone.startsWith('sb:frame:')) hoverSide.value = zoneSide(zone, x)
      } else {
        hoverZone.value = null
      }
    } catch {
      hoverZone.value = null
    }
  }
)

/** 外部图（结果区/素材列/资源管理器）悬停 = 整框点亮；板内帧拖动 = 插入线 */
function cellHot(zone: string) {
  return (hoverZone.value === zone && !hoverInternal.value) || sbExtHover.value === zone
}

// 帧数增加（拖入/追加/插入）后滚到底，让新帧立即可见
watch(
  () => board.value?.frames.length,
  (n, o) => {
    if (n != null && o != null && n > o) {
      void nextTick(() => bodyEl.value?.scrollTo({ top: bodyEl.value.scrollHeight, behavior: 'smooth' }))
    }
  }
)

// ---------------------------------------------------------------- 帧交互

const broken = reactive(new Set<string>())

function onImgError(f: SbFrame) {
  broken.add(f.id)
}

function addFrame() {
  if (isDragClick()) return // 拖图松手在追加条上的 click 不是「点击加框」
  const b = board.value
  if (!b) return
  if (!appendFrame(b)) notify(`最多 ${SB_MAX_FRAMES} 帧`, 'warn', 3000)
}

function clearAll() {
  const b = board.value
  if (!b) return
  if (!b.frames.some((f) => f.path)) {
    resetBoard(b)
    return
  }
  void appConfirm({
    title: '清空画板',
    message: `清空画板「${b.name}」的全部帧？\n磁盘上的图片保留。`,
    danger: true,
    okLabel: '清空',
  }).then((ok) => {
    if (ok && board.value === b) resetBoard(b) // 清完留 4 个空框（用户约定）
  })
}

function frameTitle(f: SbFrame) {
  return f.caption || fileName(f.path)
}

// 右键菜单
const ctx = ref<{ x: number; y: number; frame: SbFrame } | null>(null)

function openCtx(e: MouseEvent, f: SbFrame) {
  e.preventDefault()
  ctx.value = {
    x: Math.min(e.clientX, window.innerWidth - 190),
    y: Math.min(e.clientY, window.innerHeight - 260),
    frame: f,
  }
}

function ctxRun(fn: (f: SbFrame) => void) {
  const f = ctx.value?.frame
  ctx.value = null
  if (f) fn(f)
}

// 右键菜单各动作（board 从 computed 取，模板里不做断言）
function ctxInsertBefore(f: SbFrame) {
  const b = board.value
  if (b && !insertFrameBefore(b, f.id)) notify(`最多 ${SB_MAX_FRAMES} 帧`, 'warn', 3000)
}
function ctxInsertAfter(f: SbFrame) {
  const b = board.value
  if (b && !insertFrameAfter(b, f.id)) notify(`最多 ${SB_MAX_FRAMES} 帧`, 'warn', 3000)
}
function ctxClear(f: SbFrame) {
  if (isDragClick()) return // 拖拽松手落在 ✕ 上的 click 不是「清空此帧」
  const b = board.value
  if (b) clearFrame(b, f.id)
}
function ctxRemove(f: SbFrame) {
  const b = board.value
  if (b) removeFrame(b, f.id)
}
function ctxToFront(f: SbFrame) {
  const b = board.value
  if (b) reorderFrame(b, f.id, 0)
}
function ctxToEnd(f: SbFrame) {
  const b = board.value
  if (b) reorderFrame(b, f.id, b.frames.length)
}
function ctxApplyParams(f: SbFrame) {
  const a = assetOf(f)
  if (a) applyAssetParams(a)
}
function ctxOpenWorkflow(f: SbFrame) {
  const a = assetOf(f)
  if (a) void openAssetWorkflow(a)
}
function ctxReveal(f: SbFrame) {
  revealItemInDir(f.path).catch((e) => notify(`打开失败：${e}`, 'error', 6000))
}
async function ctxCopyImg(f: SbFrame) {
  try {
    await copyLocalImageToClipboard(f.path)
    notify('已复制图片，可直接粘贴到聊天窗口', 'ok', 3000)
  } catch (e) {
    notify(`复制失败：${e}`, 'error', 6000)
  }
}

/** 来源资产（有 key 且结果区里还存在才能操作） */
function assetOf(f: SbFrame) {
  return f.assetKey ? state.assets.find((a) => a.key === f.assetKey) ?? null : null
}

// ---------------------------------------------------------------- 画板页签

const editingBoardId = ref<string | null>(null)
const boardNameDraft = ref('')

function startRenameBoard(b: SbBoard) {
  editingBoardId.value = b.id
  boardNameDraft.value = b.name
  // ref 在 v-for 里会收集成数组，这里用类名直接定位唯一的重命名输入框
  nextTick(() => document.querySelector<HTMLInputElement>('.sb-board-rename')?.focus())
}

function confirmRenameBoard() {
  const id = editingBoardId.value
  editingBoardId.value = null
  if (id) renameBoard(id, boardNameDraft.value)
}

function deleteBoard(b: SbBoard) {
  void appConfirm({
    title: '删除画板',
    message: `删除画板「${b.name}」？\n帧列表删除，磁盘图片保留。`,
    danger: true,
    okLabel: '删除',
  }).then((ok) => {
    if (ok) removeBoard(b.id)
  })
}

// ---------------------------------------------------------------- 放大预览 + 自动播放

const lightboxId = ref<string | null>(null)
const playing = ref(false)
const dir = ref(1) // 播放方向：1 正放 / -1 倒放（往返模式用）
let playTimer: number | null = null

const lbFrame = computed(() => filled.value.find((f) => f.id === lightboxId.value) ?? null)
const lbIndex = computed(() => filled.value.findIndex((f) => f.id === lightboxId.value))
/** 当前帧在整板里的编号（与格子角标一致，方便对照分镜稿；空框跳过但编号不重排） */
const lbBoardNum = computed(() => {
  const f = lbFrame.value
  const b = board.value
  if (!f || !b) return 0
  const i = b.frames.findIndex((x) => x.id === f.id)
  return i < 0 ? 0 : i + 1
})

function openLb(f: SbFrame) {
  if (isDragClick()) return
  if (!f.path || broken.has(f.id)) return
  lightboxId.value = f.id
}

function closeLb() {
  stopPlay()
  lightboxId.value = null
}

function stepLb(d: number) {
  // 手动翻页 = 接管浏览：正在自动播放就停掉（用户约定）
  if (playing.value) stopPlay()
  const list = filled.value
  if (!list.length) return
  const i = lbIndex.value
  if (i < 0) {
    lightboxId.value = null
    return
  }
  lightboxId.value = list[(i + d + list.length) % list.length].id
}

function stopTimer() {
  if (playTimer != null) {
    window.clearInterval(playTimer)
    playTimer = null
  }
}

function advance() {
  const list = filled.value
  if (!list.length || !lightboxId.value) {
    stopPlay()
    return
  }
  const i = lbIndex.value
  const cur = i < 0 ? 0 : i
  let next = cur + dir.value
  if (next >= list.length || next < 0) {
    if (storyboard.pingpong && list.length > 1) {
      dir.value = -dir.value
      next = cur + dir.value
    } else {
      next = (next + list.length) % list.length
    }
  }
  lightboxId.value = list[next].id
}

function startPlay() {
  const list = filled.value
  if (!list.length) {
    notify('还没有帧图，先从结果区拖几张进来', 'info', 3000)
    return
  }
  if (!lightboxId.value) lightboxId.value = list[0].id
  stopTimer()
  playTimer = window.setInterval(advance, Math.max(200, Math.round(storyboard.interval * 1000)))
  dir.value = 1
  playing.value = true
}

function stopPlay() {
  stopTimer()
  playing.value = false
}

function togglePlay() {
  if (playing.value) stopPlay()
  else startPlay()
}

// 播放中拖动间隔滑杆：重建定时器即刻生效
watch(
  () => storyboard.interval,
  () => {
    if (playing.value) {
      stopTimer()
      playTimer = window.setInterval(advance, Math.max(200, Math.round(storyboard.interval * 1000)))
    }
  }
)

// 预览浮层键盘：A/D、←/→ 翻页；空格播放/暂停；Esc 关闭
function onKey(e: KeyboardEvent) {
  if (!lightboxId.value) return
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
  // 素材列预览开着时让位：两边监听都挂 window，翻页/删除键不能双触发
  if (document.querySelector('.lf-preview')) return
  const k = e.key
  if (k === 'Escape') {
    e.preventDefault()
    closeLb()
  } else if (k === 'a' || k === 'A' || k === 'ArrowLeft') {
    e.preventDefault()
    stepLb(-1)
  } else if (k === 'd' || k === 'D' || k === 'ArrowRight') {
    e.preventDefault()
    stepLb(1)
  } else if (k === ' ') {
    e.preventDefault()
    togglePlay()
  }
}
window.addEventListener('keydown', onKey)

// 点击其他地方关右键菜单
function onDocClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  if (!t?.closest('.sb-ctx')) ctx.value = null
}
window.addEventListener('click', onDocClick)

// ---------------------------------------------------------------- 导出

async function doExport() {
  const b = board.value
  if (!b) return
  if (!b.frames.some((f) => f.path)) {
    notify('没有可导出的帧图', 'warn', 3000)
    return
  }
  const picked = await open({ directory: true, multiple: false })
  if (!picked || typeof picked !== 'string') return
  try {
    const n = await exportBoardFrames(b, picked)
    notify(`已按顺序导出 ${n} 张到 ${picked}`, 'ok', 6000)
    ui.fsChangeTick++
  } catch (e) {
    notify(`导出失败：${e}`, 'error', 8000)
  }
}
</script>

<template>
  <aside v-if="ui.storyboardOpen" class="sb">
    <header class="sb-head">
      <span class="sb-title">🎞 连续插画</span>
      <span class="spacer" />
      <span class="faint">{{ board?.frames.filter((f) => f.path).length ?? 0 }}/{{ board?.frames.length ?? 0 }} 帧</span>
    </header>

    <!-- 画板页签：点击切换 / 双击重命名；激活页签可删 -->
    <div class="sb-boards">
      <template v-for="b in storyboard.boards" :key="b.id">
        <input
          v-if="editingBoardId === b.id"
          v-model="boardNameDraft"
          class="sb-board-rename"
          @click.stop
          @pointerdown.stop
          @keydown.enter.prevent="confirmRenameBoard"
          @keydown.esc.prevent="editingBoardId = null"
          @blur="confirmRenameBoard"
        />
        <template v-else>
          <button
            class="sb-tab"
            :class="{ on: b.id === storyboard.activeId }"
            :title="`${b.name}（双击重命名）`"
            @click="storyboard.activeId = b.id"
            @dblclick="startRenameBoard(b)"
          >
            <span class="sb-tab-name">{{ b.name }}</span>
            <span
              v-if="b.id === storyboard.activeId && storyboard.boards.length > 1"
              class="sb-tab-x"
              title="删除画板"
              @click.stop="deleteBoard(b)"
              @pointerdown.stop
            >✕</span>
          </button>
        </template>
      </template>
      <button class="sb-tab add" title="新建画板" @click="addBoard()">＋</button>
    </div>

    <div ref="bodyEl" class="sb-body">
      <div v-if="!board?.frames.length" class="sb-empty">
        把结果区的图拖到这里就会自动加框<br />
        <button class="btn sm" @click="addFrame">＋ 加框</button>
      </div>
      <div v-else class="sb-grid">
        <div
          v-for="(f, i) in board.frames"
          :key="f.id"
          class="sb-cell"
          :class="{
            empty: !f.path,
            'drop-hot': cellHot(`sb:frame:${f.id}`),
            'drop-before': hoverZone === `sb:frame:${f.id}` && hoverInternal && hoverSide === 'before',
            'drop-after': hoverZone === `sb:frame:${f.id}` && hoverInternal && hoverSide === 'after',
          }"
          :data-drop-zone="`sb:frame:${f.id}`"
          :title="f.path ? `${frameTitle(f)}（按住可拖走 / 拖到别的帧换位置）` : `第 ${i + 1} 帧：从结果区拖图进来`"
          @pointerdown="f.path && beginDrag($event, { path: f.path, label: frameTitle(f), thumb: thumbOf(f), sbFrameId: f.id })"
          @click="openLb(f)"
          @contextmenu="openCtx($event, f)"
        >
          <span class="sb-num">{{ i + 1 }}</span>
          <template v-if="f.path && !broken.has(f.id)">
            <img :src="thumbOf(f)" :alt="frameTitle(f)" loading="lazy" @error="onImgError(f)" />
            <button
              class="sb-x"
              title="清空此帧（保留框）"
              @click.stop="ctxClear(f)"
              @pointerdown.stop
            >✕</button>
            <input
              v-model="f.caption"
              class="sb-cap"
              placeholder="备注…"
              :title="'备注（一般写该镜提示词摘要）'"
              @click.stop
              @pointerdown.stop
            />
          </template>
          <template v-else>
            <span class="sb-ph">{{ f.path && broken.has(f.id) ? '🖼 文件缺失' : '＋' }}</span>
            <span v-if="!f.path" class="sb-ph-hint">拖图到这里</span>
          </template>
        </div>
      </div>
      <!-- 追加条（空板也在）：拖图到这 = 追加一帧；点击 = 加框 -->
      <button
        class="sb-append"
        :class="{ 'drop-hot': hoverZone === 'sb:append' || sbExtHover === 'sb:append' }"
        data-drop-zone="sb:append"
        title="把图拖到这里追加一帧（也可点击加框）"
        @click="addFrame"
      >
        ＋ 加框 / 拖图追加
      </button>
    </div>

    <footer class="sb-dock">
      <div class="sb-row">
        <button class="btn sm" title="追加一个空帧" @click="addFrame">＋框</button>
        <button
          class="btn sm"
          :class="{ active: playing }"
          :title="playing ? '停止自动播放（空格）' : '自动播放：按间隔翻页检查连贯性（空格）'"
          @click="togglePlay"
        >
          {{ playing ? '⏸ 停' : '▶ 播' }}
        </button>
        <button
          class="btn sm"
          :class="{ active: storyboard.pingpong }"
          title="往返播放：到末尾后倒着放回来"
          @click="storyboard.pingpong = !storyboard.pingpong"
        >
          ⇄
        </button>
        <button class="btn sm" title="把有图的帧按顺序导出成 01/02/03… 到选定文件夹" @click="doExport">⬇ 导出</button>
        <button class="btn sm danger" title="清空本画板（磁盘图片保留）" @click="clearAll">清空</button>
      </div>
      <div class="sb-row sb-interval">
        <span class="faint">间隔</span>
        <input
          v-model.number="storyboard.interval"
          type="range"
          min="0.2"
          max="3"
          step="0.1"
          :title="`自动播放间隔 ${storyboard.interval.toFixed(1)} 秒`"
        />
        <span class="mono sb-ival">{{ storyboard.interval.toFixed(1) }}s</span>
      </div>
    </footer>

    <!-- 右键菜单 -->
    <div
      v-if="ctx"
      class="sb-ctx"
      :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <button class="sb-ctx-item" @click="ctxRun(ctxInsertBefore)">⬆ 在此前插入</button>
      <button class="sb-ctx-item" @click="ctxRun(ctxInsertAfter)">⬇ 在此后插入</button>
      <button class="sb-ctx-item" @click="ctxRun(ctxClear)">⃞ 清空此帧</button>
      <button class="sb-ctx-item danger" @click="ctxRun(ctxRemove)">🗑 删除此帧</button>
      <span class="sb-ctx-sep" />
      <button class="sb-ctx-item" @click="ctxRun(ctxToFront)">|◀ 移到最前</button>
      <button class="sb-ctx-item" @click="ctxRun(ctxToEnd)">▶| 移到最后</button>
      <template v-if="assetOf(ctx.frame)">
        <span class="sb-ctx-sep" />
        <button class="sb-ctx-item" @click="ctxRun(ctxApplyParams)">⤴ 载入参数</button>
        <button class="sb-ctx-item" @click="ctxRun(ctxOpenWorkflow)">📂 打开工作流</button>
      </template>
      <template v-if="ctx.frame.path">
        <span class="sb-ctx-sep" />
        <button class="sb-ctx-item" @click="ctxRun(ctxCopyImg)">📋 复制图片</button>
        <button class="sb-ctx-item" @click="ctxRun(ctxReveal)">🗂 打开所在位置</button>
      </template>
    </div>

    <!-- 放大预览：A/D 只在本板帧序列内翻页；空格播放 / Esc 关 -->
    <div v-if="lbFrame" class="sb-lightbox" @click.self="closeLb" @contextmenu.prevent>
      <div class="sb-lb-body">
        <img :key="lbFrame.id" :src="thumbOf(lbFrame)" :alt="frameTitle(lbFrame)" />
        <!-- 大字帧号角标：与格子编号一致，播放时对照分镜稿用 -->
        <span v-if="lbBoardNum" class="sb-lb-num">{{ lbBoardNum }}</span>
        <span v-if="lbFrame.caption" class="sb-lb-sub">{{ lbFrame.caption }}</span>
      </div>
      <div class="sb-lb-cap">
        <button class="btn sm ghost" title="上一帧（← / A）" @click="stepLb(-1)">‹</button>
        <button class="btn sm ghost" title="下一帧（→ / D）" @click="stepLb(1)">›</button>
        <span class="mono faint">{{ lbIndex + 1 }}/{{ filled.length }}</span>
        <button class="btn sm" :class="{ active: playing }" :title="playing ? '暂停（空格）' : '播放（空格）'" @click="togglePlay">
          {{ playing ? '⏸' : '▶' }}
        </button>
        <span class="spacer" />
        <span class="sb-lb-name" :title="lbFrame.path">{{ lbFrame.caption || fileName(lbFrame.path) }}</span>
        <span class="spacer" />
        <button class="btn sm ghost" @click="closeLb">✕</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.sb {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 250px;
  min-height: 0;
  background: var(--bg-1);
  border-left: 1px solid var(--border-soft);
  overflow: hidden;
}
.sb-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px 7px;
  flex: none;
}
.sb-title {
  font-size: 12.5px;
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.faint {
  color: var(--text-faint);
  font-size: 10.5px;
}
.mono {
  font-family: var(--mono, monospace);
}

/* 画板页签 */
.sb-boards {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px 7px;
  flex: none;
  overflow-x: auto;
  border-bottom: 1px solid var(--border-soft);
  scrollbar-width: none;
}
.sb-boards::-webkit-scrollbar {
  display: none;
}
.sb-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  max-width: 110px;
  border: 1px solid var(--border-soft);
  background: transparent;
  color: var(--text-dim);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
  cursor: pointer;
}
.sb-tab:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.sb-tab.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.sb-tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sb-tab-x {
  font-size: 11px;
  line-height: 1;
  padding: 1px 3px;
  border-radius: 4px;
  opacity: 0.7;
  transition: opacity 0.15s, background 0.15s;
}
.sb-tab-x:hover {
  opacity: 1;
  color: var(--err, #e84e4e);
  background: rgba(232, 78, 78, 0.14);
}
.sb-tab.add {
  padding: 3px 7px;
}
.sb-board-rename {
  flex: none;
  width: 96px;
  font-size: 11px;
  padding: 3px 6px;
  border: 1px solid var(--accent);
  border-radius: 999px;
  background: var(--bg-1);
  color: var(--text);
  outline: none;
}

/* 帧网格 */
.sb-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}
.sb-empty {
  padding: 26px 10px;
  text-align: center;
  font-size: 12px;
  color: var(--text-faint);
  line-height: 2.2;
}
.sb-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.sb-cell {
  position: relative;
  aspect-ratio: 1;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg-2, var(--bg-1));
  cursor: grab;
  display: flex;
  flex-direction: column;
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}
.sb-cell.empty {
  border-style: dashed;
  cursor: pointer;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.sb-cell:hover {
  border-color: var(--accent);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3);
}
.sb-cell.empty:hover {
  background: var(--accent-soft);
}
/* 拖拽经过时的落点高亮（拖到谁身上谁亮） */
.sb-cell.drop-hot,
.sb-append.drop-hot {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 2px var(--accent), 0 0 14px color-mix(in srgb, var(--accent) 35%, transparent);
}
/* 帧间拖动的插入位置线：指针在框左半=插到它前，右半=插到它后 */
.sb-cell.drop-before::before,
.sb-cell.drop-after::before {
  content: '';
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 3px;
  border-radius: 2px;
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
  z-index: 3;
}
.sb-cell.drop-before::before {
  left: -4px;
}
.sb-cell.drop-after::before {
  right: -4px;
}
.sb-cell img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  pointer-events: none;
}
.sb-num {
  position: absolute;
  left: 5px;
  top: 5px;
  z-index: 2;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 62%, #000 38%));
  color: #fff;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 18px;
  text-align: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  pointer-events: none;
}
/* 删除按钮：24px 大热区 + 毛玻璃底，悬停放大变红 */
.sb-x {
  position: absolute;
  right: 5px;
  top: 5px;
  z-index: 2;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 8px;
  background: rgba(12, 16, 24, 0.55);
  backdrop-filter: blur(4px);
  color: #f2f5fb;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transform: scale(0.88);
  transition: opacity 0.15s, transform 0.15s, background 0.15s;
}
.sb-cell:hover .sb-x {
  opacity: 1;
  transform: scale(1);
}
.sb-x:hover {
  background: var(--err, #e84e4e);
  transform: scale(1.06);
}
.sb-cap {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  border: none;
  background: linear-gradient(to top, rgba(12, 16, 24, 0.82), rgba(12, 16, 24, 0));
  color: #e7ecf5;
  font-size: 10px;
  line-height: 1.4;
  padding: 14px 6px 4px;
  outline: none;
  opacity: 0;
  transition: opacity 0.15s;
}
.sb-cell:hover .sb-cap,
.sb-cap:focus,
.sb-cap:not(:placeholder-shown) {
  opacity: 1;
}
.sb-cap::placeholder {
  color: rgba(231, 236, 245, 0.45);
}
.sb-ph {
  font-size: 20px;
  color: var(--text-faint);
  transition: color 0.15s, transform 0.15s;
}
.sb-cell.empty:hover .sb-ph {
  color: var(--accent);
  transform: scale(1.15);
}
.sb-ph-hint {
  font-size: 9.5px;
  color: var(--text-faint);
}
/* 追加条 */
.sb-append {
  display: block;
  width: 100%;
  margin-top: 8px;
  padding: 9px 0;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: transparent;
  color: var(--text-faint);
  font-size: 11px;
  letter-spacing: 0.4px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.sb-append:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

/* 底部操作坞 */
.sb-dock {
  flex: none;
  border-top: 1px solid var(--border-soft);
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sb-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
/* 窄栏里按钮收窄防溢出（列宽 250px 装不下常规 btn sm） */
.sb-row .btn {
  flex: none;
  padding-left: 8px;
  padding-right: 8px;
  font-size: 11px;
}
.sb-interval input[type='range'] {
  flex: 1;
  min-width: 0;
}
.sb-ival {
  font-size: 10.5px;
  color: var(--text-dim);
  width: 34px;
  text-align: right;
}

/* 右键菜单 */
.sb-ctx {
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
.sb-ctx-item {
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
.sb-ctx-item:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.sb-ctx-item.danger:hover {
  background: rgba(232, 78, 78, 0.14);
  color: var(--err, #e84e4e);
}
.sb-ctx-sep {
  height: 1px;
  background: var(--border-soft);
  margin: 3px 6px;
}

/* 放大预览 */
.sb-lightbox {
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
.sb-lb-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.sb-lb-body img {
  max-width: 100%;
  max-height: 100%;
  border-radius: 8px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
}
/* 大字帧号角标：播放时对照分镜稿 */
.sb-lb-num {
  position: absolute;
  top: 14px;
  left: 18px;
  font-size: 64px;
  font-weight: 700;
  line-height: 1;
  color: rgba(255, 255, 255, 0.92);
  text-shadow: 0 2px 16px rgba(0, 0, 0, 0.85);
  font-family: var(--mono, monospace);
  pointer-events: none;
}
/* 帧备注字幕（有备注才显示） */
.sb-lb-sub {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 72%;
  padding: 6px 16px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #e7ecf5;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.sb-lb-cap {
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
.sb-lb-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
