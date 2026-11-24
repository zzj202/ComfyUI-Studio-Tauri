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
import { openCtxMenu } from '../core/ctxMenu'
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
  framePreview,
  frameRev,
  insertFrameAfter,
  insertFrameBefore,
  removeBoard,
  removeFrame,
  reorderFrame,
  renameBoard,
  resetBoard,
  rerolling,
  rerunFrame,
  sbExtHover,
  startFrameWatch,
  stopFrameWatch,
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
  // 粘贴即时预览优先（内存 blob URL 就是最新内容，且不能追加 query 参数）
  const pv = framePreview(f.id)
  if (pv) return pv
  // 磁盘路径 + mtime 版本号破缓存：文件被外部改过即强制重载
  const base = convertFileSrc(f.path)
  const rev = frameRev.value[f.id]
  return rev ? `${base}?v=${rev}` : base
}

// 帧图 mtime 巡检：外部修改源文件后自动重载缩略图（灯箱同步生效）
startFrameWatch()

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
    const prev = target.path // 有图帧 = 替换：旧图先存进历史再换，防丢
    void fillFrameFromAsset(b, target, item.asset).then((ok) => {
      if (!ok) return
      broken.delete(target.id)
      if (prev) {
        pushFrameHistory(target, prev)
        notify(`已替换第 ${frameNo(target)} 帧（旧图在灯箱「历史」里可找回）`, 'ok', 3000)
      }
    })
  } else if (item.path && IMG_EXT_RE.test(item.path)) {
    const prev = target.path
    if (prev && prev !== item.path) pushFrameHistory(target, prev)
    fillFrameFromPath(target, item.path)
    broken.delete(target.id)
    if (prev) notify(`已替换第 ${frameNo(target)} 帧（旧图在灯箱「历史」里可找回）`, 'ok', 3000)
  } else {
    notify('插画板帧只收图片', 'warn', 3000)
  }
}

/** 替换前的旧图进帧历史（灯箱历史条可回看/换回），上限 5 份防膨胀——与「再来一次」同规则 */
function pushFrameHistory(f: SbFrame, prev: string) {
  const h = f.history ?? (f.history = [])
  h.push(prev)
  if (h.length > 5) h.splice(0, h.length - 5)
}

/** 帧序号（提示文案用） */
function frameNo(f: SbFrame): number {
  return board.value ? board.value.frames.indexOf(f) + 1 : 0
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
  stopFrameWatch()
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

// 文件被外部修改（mtime 变化）bump 版本重载时，顺带清掉旧的「文件缺失」标记
watch(frameRev, (rec) => {
  for (const id of Object.keys(rec)) broken.delete(id)
})

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
  // 用户约定：不弹确认直接清（磁盘图片本就保留，可重导入）
  resetBoard(b) // 清完留 4 个空框（用户约定）
}

function frameTitle(f: SbFrame) {
  return f.caption || fileName(f.path)
}

// 右键菜单（两段式定位，见 core/ctxMenu.ts：菜单项随帧状态增减，固定估值会被截断）
const ctx = ref<{ x: number; y: number; frame: SbFrame; placed: boolean } | null>(null)
const ctxEl = ref<HTMLElement | null>(null)

function openCtx(e: MouseEvent, f: SbFrame) {
  openCtxMenu(e, ctx, ctxEl, { frame: f })
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
/** 帧能否「再来一次」：有来源资产且带参数快照 */
function canReroll(f: SbFrame): boolean {
  return !!assetOf(f)?.params
}
function ctxReroll(f: SbFrame) {
  const b = board.value
  if (b) void rerunFrame(b, f)
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

/** 来源资产：优先结果区活资产（别名/未读等最新），结果区里没了（清空/超限淘汰/刷新丢）
 *  就用填帧时存下的快照——载入参数/再来一次/打开工作流/提示词不依赖结果区列表 */
function assetOf(f: SbFrame) {
  if (f.assetKey) {
    const a = state.assets.find((a) => a.key === f.assetKey)
    if (a) {
      // 惰性回填：老帧还没快照就趁资产还在时补一份（以后清空/刷新也不怕）
      if (!f.src) f.src = { ...a, params: a.params ? { ...a.params } : undefined }
      return a
    }
  }
  return f.src ?? null
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
/** 灯箱正在看的图：null = 当前帧图；历史版本 = 替换前原图的磁盘路径 */
const lbView = ref<string | null>(null)
const lbSrc = computed(() => (lbView.value ? convertFileSrc(lbView.value) : lbFrame.value ? thumbOf(lbFrame.value) : ''))
/** 看历史时舞台上的角标文案（"当前"不显示，历史显示第几版） */
const lbViewTag = computed(() => {
  if (!lbView.value || !lbFrame.value?.history) return ''
  const i = lbFrame.value.history.indexOf(lbView.value)
  return i >= 0 ? `替换前版本 ${i + 1}` : ''
})
// 切帧（翻页/重开灯箱）回到当前图，避免历史视图串帧
watch(
  () => lbFrame.value?.id,
  () => {
    lbView.value = null
  }
)

// ---- 灯箱提示词面板（对齐结果区灯箱）：展示来源资产参数快照里的文本项，点击复制 ----
const lbPromptsOpen = ref(false)
const lbPromptEntries = computed(() => {
  const p = lbFrame.value ? assetOf(lbFrame.value)?.params : undefined
  if (!p) return []
  // key 形如 nodeId::inputName：当前表单有同名字段就用它的可读标签，没有就取 inputName
  const labels = new Map(state.fields.map((f) => [f.key, f.label] as const))
  const out: { key: string; label: string; text: string }[] = []
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== 'string' || !v.trim()) continue
    if (IMG_EXT_RE.test(v.trim())) continue // 图片引用不算提示词
    out.push({ key: k, label: labels.get(k) ?? (k.split('::').pop() ?? k), text: v })
  }
  return out
})

async function copyLbPrompt(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    notify('已复制提示词', 'ok', 2000)
  } catch {
    notify('复制失败（剪贴板被其他程序占用？）', 'warn')
  }
}

/** 回看历史时「✓ 使用此版本」：该历史图与本帧当前图互换位置（当前图进入历史，可随时换回） */
function useHistory() {
  const f = lbFrame.value
  if (!f || !lbView.value || !f.history) return
  const i = f.history.indexOf(lbView.value)
  if (i < 0) return
  const cur = f.path
  f.path = f.history[i]
  f.history[i] = cur
  lbView.value = null // 已成为当前图，回到「当前」视图
  notify('已换用此历史版本（原图保留在历史里，可随时换回）', 'ok', 4000)
}
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
  f.fresh = false // 点开看过：清掉重跑替换标记（同结果区已读）
  lightboxId.value = f.id
  lbPromptsOpen.value = true // 打开灯箱默认展开提示词面板（无提示词条目时浮层自身隐藏）
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

/** 跳到指定序号的帧（灯箱底栏 ⏮/⏭ 用） */
function jumpLb(i: number) {
  if (playing.value) stopPlay()
  const list = filled.value
  if (!list.length) return
  const idx = Math.max(0, Math.min(list.length - 1, i))
  lightboxId.value = list[idx].id
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
  } else if ((e.ctrlKey || e.metaKey) && (k === 'c' || k === 'C')) {
    // Ctrl+C：复制当前帧图到剪贴板（对齐结果区灯箱）
    e.preventDefault()
    if (lightboxId.value) void ctxCopyImg(lbFrame.value!)
  } else if (k === 'a' || k === 'A' || k === 'ArrowLeft') {
    e.preventDefault()
    stepLb(-1)
  } else if (k === 'd' || k === 'D' || k === 'ArrowRight') {
    e.preventDefault()
    stepLb(1)
  } else if (k === 'w' || k === 'W') {
    e.preventDefault()
    jumpLb(0) // 跳到第一帧
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
      <button
        class="sb-cols"
        :title="storyboard.cols === 2 ? '当前双列展示，点击切换为单列大图' : '当前单列展示，点击切换为双列'"
        @click="storyboard.cols = storyboard.cols === 2 ? 1 : 2"
      >
        {{ storyboard.cols === 2 ? '▦' : '▤' }}
      </button>
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
      <div v-else class="sb-grid" :class="{ one: storyboard.cols === 1 }">
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
          <span
            v-if="f.fresh && f.path && !broken.has(f.id)"
            class="sb-fresh"
            title="此帧刚被「再来一次」替换，点开看过即消失"
          >
            新
          </span>
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
          <!-- 重跑中浮层：换种子重新生成的等待期 -->
          <div v-if="rerolling.has(f.id)" class="sb-reroll" title="正在按此帧参数换种子重新生成…">
            <span class="sb-reroll-spin" />
            <span>生成中</span>
          </div>
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
      ref="ctxEl"
      class="sb-ctx"
      :style="{
        left: ctx.x + 'px',
        top: ctx.y + 'px',
        visibility: ctx.placed ? 'visible' : 'hidden',
      }"
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
        <button
          v-if="canReroll(ctx.frame)"
          class="sb-ctx-item"
          title="按此帧参数换新种子重新生成，完成后自动替换此帧"
          @click="ctxRun(ctxReroll)"
        >
          🎲 再来一次
        </button>
        <button class="sb-ctx-item" @click="ctxRun(ctxOpenWorkflow)">📂 打开工作流</button>
      </template>
      <template v-if="ctx.frame.path">
        <span class="sb-ctx-sep" />
        <button class="sb-ctx-item" @click="ctxRun(ctxCopyImg)">📋 复制图片</button>
        <button class="sb-ctx-item" @click="ctxRun(ctxReveal)">🗂 打开所在位置</button>
      </template>
    </div>

    <!-- 放大预览：布局对齐结果区灯箱——两侧大翻页钮 + 底部信息条；A/D、←/→ 翻页，空格播放，Esc 关 -->
    <div v-if="lbFrame" class="sb-lightbox" @click.self="closeLb" @contextmenu.prevent>
      <button class="sb-lb-nav prev" title="上一帧（← / A）" @click="stepLb(-1)">‹</button>
      <div class="sb-lb-body">
        <img :key="lbView ?? lbFrame.id" :src="lbSrc" :alt="frameTitle(lbFrame)" />
        <!-- 大字帧号角标：与格子编号一致，播放时对照分镜稿用 -->
        <span v-if="lbBoardNum" class="sb-lb-num">{{ lbBoardNum }}</span>
        <span
          v-if="lbFrame.fresh && !lbView"
          class="sb-fresh sb-lb-fresh"
          title="此帧刚被「再来一次」替换，看过即消失"
        >
          新
        </span>
        <span v-if="lbViewTag" class="sb-lb-hist-tag">{{ lbViewTag }}</span>
        <span v-if="lbFrame.caption && !lbView" class="sb-lb-sub">{{ lbFrame.caption }}</span>
        <!-- 提示词浮层：主区域的 flex 兄弟节点，天然紧贴图片右缘（gap 14px），点击条目复制 -->
        <!-- contextmenu.stop：放行 WebView 原生菜单——选中文本右键「复制」是基本操作，
             不能被灯箱根节点的 contextmenu.prevent（防图片原生菜单）误伤 -->
        <div
          v-if="lbPromptsOpen && lbPromptEntries.length"
          class="sb-lb-prompts"
          @click.stop
          @contextmenu.stop
        >
          <div
            v-for="e in lbPromptEntries"
            :key="e.key"
            class="sb-lb-prompt"
            :title="`点击复制整条；也可以选中部分文字后右键复制`"
            @click="copyLbPrompt(e.text)"
          >
            <span class="sb-lp-label">{{ e.label }}</span>
            <span class="sb-lp-text">{{ e.text }}</span>
          </div>
        </div>
      </div>
      <button class="sb-lb-nav next" title="下一帧（→ / D）" @click="stepLb(1)">›</button>
      <!-- 重跑历史版本条：替换前的原图点一下即可回看；最后一格 = 当前图 -->
      <div v-if="lbFrame.history?.length" class="sb-lb-hist" @click.stop>
        <span class="sb-lb-hist-label">历史</span>
        <button
          v-for="(p, hi) in lbFrame.history"
          :key="p"
          class="sb-hist-thumb"
          :class="{ on: lbView === p }"
          :title="`替换前版本 ${hi + 1}（点击查看）`"
          @click="lbView = p"
        >
          <img :src="convertFileSrc(p)" :alt="`替换前版本 ${hi + 1}`" loading="lazy" />
        </button>
        <button class="sb-hist-thumb now" :class="{ on: !lbView }" title="当前图（点击返回）" @click="lbView = null">
          <img :src="thumbOf(lbFrame)" alt="当前" />
        </button>
        <!-- 正在回看历史时出现：把这一版换成此帧的当前图（被换下的自动进历史，可随时换回） -->
        <button v-if="lbView" class="btn sm sb-hist-use" @click="useHistory">✓ 使用此版本</button>
      </div>
      <div class="sb-lb-cap">
        <button class="btn sm ghost" title="跳到第一帧" @click="jumpLb(0)">⏮</button>
        <span class="mono faint">{{ lbIndex + 1 }}/{{ filled.length }}</span>
        <button class="btn sm ghost" title="跳到最后一帧" @click="jumpLb(filled.length - 1)">⏭</button>
        <button class="btn sm" :class="{ active: playing }" :title="playing ? '暂停（空格）' : '播放（空格）'" @click="togglePlay">
          {{ playing ? '⏸' : '▶' }}
        </button>
        <span class="spacer" />
        <span class="sb-lb-name" :title="lbFrame.path">{{ lbFrame.caption || fileName(lbFrame.path) }}</span>
        <span class="spacer" />
        <button
          v-if="lbPromptEntries.length"
          class="btn sm"
          :class="{ active: lbPromptsOpen }"
          title="查看这张图提交时的提示词（点击条目复制）"
          @click="lbPromptsOpen = !lbPromptsOpen"
        >
          📝 提示词
        </button>
        <button class="btn sm" title="复制当前图到剪贴板，可直接粘贴给聊天窗口（Ctrl+C 也行）" @click="ctxCopyImg(lbFrame)">
          📋
        </button>
        <button class="btn sm" title="在资源管理器中定位当前图文件" @click="ctxReveal(lbFrame)">🗂</button>
        <button
          v-if="canReroll(lbFrame)"
          class="btn sm"
          :title="rerolling.has(lbFrame.id) ? '正在重跑此帧…' : '按此帧参数换新种子重新生成，完成后自动替换此帧'"
          @click="ctxReroll(lbFrame)"
        >
          {{ rerolling.has(lbFrame.id) ? '⏳ 重跑中' : '🎲 再来一次' }}
        </button>
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
/* 列数切换按钮（单列/双列） */
.sb-cols {
  flex: none;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  background: transparent;
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
}
.sb-cols:hover {
  color: var(--accent);
  border-color: var(--accent);
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
/* 单列展示：一行一帧大图，横图比例更贴合视频帧 */
.sb-grid.one {
  grid-template-columns: 1fr;
}
.sb-grid.one .sb-cell {
  aspect-ratio: 16 / 9;
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
/* 「新」标记：帧刚被重跑替换，点开看过即消失（同结果区未读语义） */
.sb-fresh {
  position: absolute;
  left: 5px;
  top: 28px;
  z-index: 3;
  padding: 1px 6px;
  border-radius: 999px;
  background: linear-gradient(135deg, #34c77b, #1fa864);
  color: #fff;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.5px;
  box-shadow: 0 2px 8px rgba(31, 168, 100, 0.5);
  pointer-events: none;
  animation: sb-fresh-in 0.25s ease;
}
@keyframes sb-fresh-in {
  from {
    transform: scale(0.4);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}
/* 重跑中浮层：半透明遮罩 + 旋转圈，盖在帧图上 */
.sb-reroll {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: color-mix(in srgb, var(--bg-1, #14161d) 55%, transparent);
  backdrop-filter: blur(2px);
  color: #fff;
  font-size: 11px;
  pointer-events: none;
}
.sb-reroll-spin {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: var(--accent, #7c9cff);
  border-radius: 50%;
  animation: sb-spin 0.8s linear infinite;
}
@keyframes sb-spin {
  to {
    transform: rotate(360deg);
  }
}
/* 灯箱里的「新」标记放大一号 */
.sb-lb-fresh {
  position: absolute;
  left: 16px;
  top: 16px;
  font-size: 12px;
  padding: 3px 10px;
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
/* 两侧大翻页钮（对齐结果区灯箱 .nav 的样式） */
.sb-lb-nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 3;
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
.sb-lb-nav:hover {
  background: rgba(255, 255, 255, 0.2);
}
.sb-lb-nav.prev {
  left: 14px;
}
.sb-lb-nav.next {
  right: 14px;
}
/* 重跑历史版本条：替换前的原图缩略图（旧→新），点击回看 */
.sb-lb-hist {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 80%;
  padding: 6px 8px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(6px);
}
.sb-lb-hist-label {
  flex: none;
  font-size: 11px;
  color: rgba(231, 236, 245, 0.75);
  padding: 0 2px;
}
.sb-hist-thumb {
  flex: none;
  width: 52px;
  height: 36px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 6px;
  overflow: hidden;
  cursor: pointer;
  opacity: 0.65;
  background: transparent;
  transition:
    opacity 0.12s,
    border-color 0.12s,
    transform 0.12s;
}
.sb-hist-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.sb-hist-thumb:hover {
  opacity: 1;
  transform: translateY(-3px); /* 可点切换的暗示：悬停浮起 */
}
.sb-hist-thumb.on {
  border-color: var(--accent);
  opacity: 1;
}
.sb-hist-thumb.now {
  border-style: dashed;
}
/* 「✓ 使用此版本」：回看历史时出现在历史条末尾 */
.sb-hist-use {
  margin-left: 4px;
  background: var(--accent);
  color: #fff;
  border: none;
}
/* 舞台上「替换前版本 N」角标（回看历史时显示） */
.sb-lb-hist-tag {
  position: absolute;
  top: 14px;
  right: 18px;
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #e7ecf5;
  font-size: 12px;
  pointer-events: none;
}
.sb-lb-body {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px; /* 提示词浮层与图片的贴合间隙 */
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
/* 提示词浮层：主区域 flex 兄弟节点，紧贴图片右缘（gap 14px），条目点击复制 */
.sb-lb-prompts {
  position: relative;
  flex: none;
  align-self: center;
  width: min(336px, 28vw);
  max-height: 100%;
  overflow-y: auto;
  padding: 10px;
  border-radius: 14px;
  background: color-mix(in srgb, var(--panel, rgb(16, 20, 28)) 82%, transparent);
  backdrop-filter: blur(14px) saturate(1.15);
  -webkit-backdrop-filter: blur(14px) saturate(1.15);
  border: 1px solid var(--border);
  box-shadow:
    0 20px 56px rgba(0, 0, 0, 0.55),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
  display: flex;
  flex-direction: column;
  gap: 6px;
  animation: sb-prompts-in 0.18s ease-out;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
@keyframes sb-prompts-in {
  from {
    opacity: 0;
    transform: translateX(14px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.sb-lb-prompt {
  position: relative;
  display: flex;
  flex-direction: column; /* 窄版式：标签在上、正文整行铺开 */
  gap: 4px;
  padding: 8px 10px;
  border-radius: 10px;
  cursor: pointer;
  font-size: 12px;
  line-height: 1.6;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid transparent;
  transition:
    background 0.12s,
    border-color 0.12s;
}
.sb-lb-prompt:hover {
  background: var(--accent-soft, rgba(255, 255, 255, 0.08));
  border-color: var(--accent);
}
/* 悬停时右上角浮现「复制」角标 */
.sb-lb-prompt::after {
  content: '📋 复制';
  position: absolute;
  right: 8px;
  top: 7px;
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  opacity: 0;
  transform: translateY(-3px);
  transition:
    opacity 0.12s,
    transform 0.12s;
  pointer-events: none;
}
.sb-lb-prompt:hover::after {
  opacity: 1;
  transform: none;
}
.sb-lp-label {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--accent-soft, rgba(255, 255, 255, 0.1));
  color: var(--accent, #9db8ff);
  font-size: 10.5px;
  white-space: nowrap;
  align-self: flex-start;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sb-lp-text {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  color: var(--text-1, #e7ecf5);
  /* 允许选中部分文字（右键原生菜单复制用）；面板整体默认可选中，这里显式声明防全局规则误伤 */
  user-select: text;
}
</style>
