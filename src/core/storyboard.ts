import { reactive, ref, watch } from 'vue'
import { api } from '../api/tauri'
import { notify, primaryBase } from '../store'
import { IMG_EXT_RE } from './clipboard'
import type { Asset } from './types'

/**
 * 连续插画板（Storyboard）：按序号摆放一串图片框，从结果区/素材列拖图入框，
 * 供连续翻页 / 自动播放检查动作衔接。
 *
 * 数据模型：多套画板（board）× 帧列表（frame）。
 * 帧只记**本地路径**：
 *  - 从结果区拖入的资产图 → 拖入瞬间转存进 appDataDir/storyboard/（落盘持久，
 *    清空结果资产 / 重启应用都不丢），同时记来源 assetKey（供「载入参数 / 打开工作流」）；
 *  - 从素材列拖入的本地文件 → 直接引用原路径（不复制，文件归用户管）。
 * 画板结构整体存 localStorage（帧图本体在磁盘上，结构只占几十字节）。
 */

export interface SbFrame {
  id: string
  /** 帧图本地路径；空 = 空框 */
  path: string
  /** 来源结果资产的 key（key 形如 `base|type/sub/file`），有则可载入参数/打开工作流 */
  assetKey?: string
  /** 备注行：一般写该镜提示词摘要 */
  caption: string
}

export interface SbBoard {
  id: string
  name: string
  frames: SbFrame[]
}

export const storyboard = reactive({
  boards: [] as SbBoard[],
  activeId: '',
  /** 自动播放间隔（秒） */
  interval: 0.8,
  /** 往返播放：到末尾后倒着放 */
  pingpong: false,
})

const KEY = 'comfyui-studio.storyboard:v1'
/** 单板帧数上限（防误拖几百张把 localStorage 与渲染拖垮） */
export const SB_MAX_FRAMES = 30

/**
 * 外部文件拖拽（资源管理器 → WebView）悬停时的插画板落点，值 = sb:frame:<id> / sb:append。
 * AssetDrop 在 enter/over/leave 时维护，组件用来点亮对应帧格 —— 外部拖拽没有
 * dragGhost 总线，高亮只能走这条旁路。
 */
export const sbExtHover = ref<string | null>(null)

let seq = 0
function uid(): string {
  return `sb${Date.now().toString(36)}${(seq++).toString(36)}`
}

/** 恢复持久化数据（模块加载时执行一次；结构不对就丢弃重来，不抛错） */
function load() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return
    const data = JSON.parse(raw)
    if (!Array.isArray(data?.boards)) return
    const boards: SbBoard[] = []
    for (const b of data.boards) {
      if (typeof b?.id !== 'string' || typeof b?.name !== 'string' || !Array.isArray(b?.frames)) continue
      boards.push({
        id: b.id,
        name: b.name,
        frames: b.frames
          .filter((f: any) => typeof f?.id === 'string')
          .map((f: any) => ({
            id: f.id,
            path: typeof f.path === 'string' ? f.path : '',
            assetKey: typeof f.assetKey === 'string' ? f.assetKey : undefined,
            caption: typeof f.caption === 'string' ? f.caption : '',
          })),
      })
    }
    if (boards.length) {
      storyboard.boards = boards
      storyboard.activeId = boards.some((b) => b.id === data.activeId) ? data.activeId : boards[0].id
    }
    if (typeof data.interval === 'number' && data.interval > 0.05) storyboard.interval = data.interval
    storyboard.pingpong = !!data.pingpong
  } catch {
    /* ignore：坏数据当没有 */
  }
}

load()

function persist() {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        boards: storyboard.boards,
        activeId: storyboard.activeId,
        interval: storyboard.interval,
        pingpong: storyboard.pingpong,
      })
    )
  } catch {
    /* ignore：配额满等场景静默，帧图本体仍在磁盘 */
  }
}

// 任何字段（含嵌套 frames）变化即落盘；数据量极小，无需防抖
watch(storyboard, persist, { deep: true })

export function activeBoard(): SbBoard | null {
  return storyboard.boards.find((b) => b.id === storyboard.activeId) ?? null
}

function emptyFrame(): SbFrame {
  return { id: uid(), path: '', caption: '' }
}

function newBoard(name?: string): SbBoard {
  return {
    id: uid(),
    name: name || `画板 ${storyboard.boards.length + 1}`,
    frames: [emptyFrame(), emptyFrame(), emptyFrame(), emptyFrame()],
  }
}

/** 首次使用兜底：至少一块板且有一块处于激活 */
function ensureBoard(): SbBoard {
  if (!storyboard.boards.length) {
    const b = newBoard()
    storyboard.boards.push(b)
    storyboard.activeId = b.id
  }
  if (!activeBoard()) storyboard.activeId = storyboard.boards[0].id
  return activeBoard()!
}

ensureBoard()

// ---------------------------------------------------------------- 画板操作

export function addBoard(): SbBoard {
  const b = newBoard()
  storyboard.boards.push(b)
  storyboard.activeId = b.id
  return b
}

export function removeBoard(id: string): void {
  const i = storyboard.boards.findIndex((b) => b.id === id)
  if (i < 0) return
  storyboard.boards.splice(i, 1)
  if (storyboard.boards.length) {
    if (storyboard.activeId === id) storyboard.activeId = storyboard.boards[Math.max(0, i - 1)].id
  } else {
    ensureBoard()
  }
}

export function renameBoard(id: string, name: string): void {
  const b = storyboard.boards.find((x) => x.id === id)
  if (b && name.trim()) b.name = name.trim()
}

// ---------------------------------------------------------------- 帧操作

/** 追加一个空框；超上限返回 null（调用方负责提示） */
export function appendFrame(b: SbBoard): SbFrame | null {
  if (b.frames.length >= SB_MAX_FRAMES) return null
  const f = emptyFrame()
  b.frames.push(f)
  return f
}

/** 两帧互换位置（帧内图拖到空框上 = 图像落进那个框，而不是「插到它前面」造成相邻时看起来没反应） */
export function swapFrames(b: SbBoard, aId: string, bId: string): boolean {
  const i = b.frames.findIndex((f) => f.id === aId)
  const j = b.frames.findIndex((f) => f.id === bId)
  if (i < 0 || j < 0 || i === j) return false
  const t = b.frames[i]
  b.frames[i] = b.frames[j]
  b.frames[j] = t
  return true
}

/** 在某帧前插入空框；同样受上限约束 */
export function insertFrameBefore(b: SbBoard, frameId: string): SbFrame | null {
  if (b.frames.length >= SB_MAX_FRAMES) return null
  const i = b.frames.findIndex((f) => f.id === frameId)
  const f = emptyFrame()
  b.frames.splice(i < 0 ? b.frames.length : i, 0, f)
  return f
}

/** 在某帧后插入空框 */
export function insertFrameAfter(b: SbBoard, frameId: string): SbFrame | null {
  if (b.frames.length >= SB_MAX_FRAMES) return null
  const i = b.frames.findIndex((f) => f.id === frameId)
  const f = emptyFrame()
  b.frames.splice(i < 0 ? b.frames.length : i + 1, 0, f)
  return f
}

/** 删除整帧（含框） */
export function removeFrame(b: SbBoard, frameId: string): void {
  const i = b.frames.findIndex((f) => f.id === frameId)
  if (i >= 0) b.frames.splice(i, 1)
}

/** 清空帧内容（保留空框） */
export function clearFrame(b: SbBoard, frameId: string): void {
  const f = b.frames.find((x) => x.id === frameId)
  if (f) {
    f.path = ''
    delete f.assetKey
  }
}

/** 把帧移到指定下标（越界按末尾处理）；返回是否移动 */
export function moveFrame(b: SbBoard, frameId: string, toIndex: number): boolean {
  const from = b.frames.findIndex((f) => f.id === frameId)
  if (from < 0) return false
  const [f] = b.frames.splice(from, 1)
  b.frames.splice(Math.max(0, Math.min(toIndex, b.frames.length)), 0, f)
  return true
}

/** 帧内图拖到另一帧 / 追加位 = 调整顺序（不产生复制） */
export function reorderFrame(b: SbBoard, frameId: string, toIndex: number): boolean {
  const from = b.frames.findIndex((f) => f.id === frameId)
  if (from < 0) return false
  // 删除自身后 toIndex 需要回退一位才是视觉上的落点
  const adj = toIndex > from ? toIndex - 1 : toIndex
  return moveFrame(b, frameId, adj)
}

// ---------------------------------------------------------------- 填帧（落盘）

let sbDirCache = ''
/** 帧图保存目录：appDataDir/storyboard（首次调用时缓存；\\?\ 前缀去掉） */
export async function sbDir(): Promise<string> {
  if (!sbDirCache) {
    sbDirCache =
      (await api.appDataDir())
        .replace(/^\\\\\?\\/, '')
        .replace(/[\\/]+$/, '') + '/storyboard'
  }
  return sbDirCache
}

/**
 * 结果资产拖入帧：转存进 storyboard 目录（save_output 会自动建目录 + 同名避让），
 * 成功后写路径与来源 key。返回是否成功。
 */
export async function fillFrameFromAsset(b: SbBoard, frame: SbFrame, a: Asset): Promise<boolean> {
  if (a.kind !== 'image') {
    notify('连续插画只收图片', 'warn', 3000)
    return false
  }
  try {
    const dir = await sbDir()
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const dest = `${dir}/sb-${stamp}-${a.filename}`
    const r = await api.saveOutput(a.base ?? primaryBase(), a.filename, a.subfolder, a.type, dest)
    frame.path = r.path
    frame.assetKey = a.key
    return true
  } catch (e) {
    notify(`加入插画板失败：${e}`, 'error', 8000)
    return false
  }
}

/** 本地文件拖入帧：直接引用原路径（文件归素材目录管，不复制） */
export function fillFrameFromPath(frame: SbFrame, path: string): void {
  frame.path = path
  delete frame.assetKey
}

/** 清空画板内容并回到 4 个空框（与新建画板一致） */
export function resetBoard(b: SbBoard): void {
  b.frames = [emptyFrame(), emptyFrame(), emptyFrame(), emptyFrame()]
}

/** 批量按顺序把本地图片插入插画板：target 给定时第一张精确放入该帧（后续图顺延插到它后面），
 *  target 为空 = 追加到末尾。返回成功放入的张数。 */
export function insertStoryboardPaths(paths: string[], target?: SbFrame | null): number {
  const b = activeBoard()
  if (!b) return 0
  let n = 0
  let first = true
  // anchor：后续图依次插到上一张后面（而不是都插到 target 后面导致顺序倒置）
  let anchor: SbFrame | null = target ?? null
  for (const p of paths) {
    if (!IMG_EXT_RE.test(p)) continue
    let f: SbFrame | null = null
    if (first && anchor) {
      f = anchor // 第一张直接落进目标帧（空帧填入 / 有图帧替换）
    } else {
      f = anchor ? insertFrameAfter(b, anchor.id) : appendFrame(b)
    }
    if (!f) break // 上限即停
    fillFrameFromPath(f, p)
    if (f !== anchor) anchor = f
    first = false
    n++
  }
  return n
}

// ---------------------------------------------------------------- 导出

/** 把有图的帧按顺序导出成 01.png / 02.png… 到用户选的目录；返回导出张数（抛错则失败） */
export async function exportBoardFrames(b: SbBoard, dir: string): Promise<number> {
  const frames = b.frames.filter((f) => f.path)
  let n = 0
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    const ext = (f.path.match(/\.[a-z0-9]+$/i)?.[0] ?? '.png').toLowerCase()
    const b64 = await api.readLocalFile(f.path)
    await api.saveLocalBytes(dir, `${String(i + 1).padStart(2, '0')}${ext}`, b64)
    n++
  }
  return n
}
