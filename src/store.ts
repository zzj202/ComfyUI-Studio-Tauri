import { computed, reactive, ref, watch } from 'vue'
import { api } from './api/tauri'
import { ComfyWs } from './api/comfyWs'
import {
  applyValues,
  collectValues,
  parseGraph,
  randomSeed,
} from './core/parseWorkflow'
import { extractSubmitError, normalizeOutputs } from './core/errors'
import { BATCH_TEXT_MAX, splitBatchLines } from './core/batchText'
import { cooldownWorker, selectWorker } from './core/scheduler'
import { ensureAudio, playChime } from './core/chime'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import type { Asset, FieldSchema, Job, JobStatus, ParamTemplate, WorkflowMeta, WorkerProfile } from './core/types'
import { ui } from './ui'

export const state = reactive({
  ready: false,
  settings: {
    baseUrl: 'http://127.0.0.1:8188',
    comfyDir: '',
    pythonPath: '',
    launchArgs: '',
    outputDir: '',
    autoRefreshQueue: true,
    theme: 'dark',
    /** 计算节点池（旧配置迁移前为空数组，见 migrateWorkers） */
    workers: [] as WorkerProfile[],
  } as Record<string, any>,

  connection: 'unknown' as 'unknown' | 'ok' | 'error',
  connText: '',
  stats: null as any,
  objectInfo: null as Record<string, any> | null,

  workflows: [] as WorkflowMeta[],
  /** 分组列表（workflows/ 下的一级子目录，含空组；组内工作流 name 带「组/」前缀） */
  workflowGroups: [] as string[],
  /** 工作流列表正在读取（面板显示骨架占位） */
  workflowsLoading: false,
  templates: [] as ParamTemplate[],
  currentWorkflow: null as string | null,
  graph: null as any,
  fields: [] as FieldSchema[],
  activeTemplate: null as ParamTemplate | null,

  jobs: [] as Job[],
  queueRemaining: 0,

  /** 结果资产：任务产出平铺成的独立列表（与队列记录解耦） */
  assets: [] as Asset[],

  logs: [] as string[],
  procRunning: false,
  busy: false,

  toasts: [] as { id: number; type: 'ok' | 'error' | 'warn' | 'info'; text: string }[],
})

/** 每个启用节点一条 WS 实时进度连接（key = base；进度/完成/出错按 base 闭包路由） */
const wss = new Map<string, ComfyWs>()
/** 各节点自报的队列余量（WS status 消息），TopBar 显示启用节点之和 */
const perBaseQueue = new Map<string, number>()
let toastSeq = 0

/**
 * 图片控件拖拽注册表：key = field.key，value = 把拖入的本地图片上传为该控件参考图的回调。
 * FieldControl（image 字段）挂载时注册；AssetDrop 通过落点命中的 data-image-key 在这里取回调。
 */
export const imageDropTargets = new Map<string, (path: string) => void>()

/**
 * 应用内「结果资产 → 图片控件」的拖拽注册表（HTML5 拖拽被 dragDropEnabled 吞掉，
 * 所以用自定义 pointer 拖拽 + elementFromPoint 命中后在这里取回调）。
 */
export const assetDropTargets = new Map<string, (asset: Asset) => void>()

// ---------------------------------------------------------------- 应用内拖拽总线
// dragDropEnabled:true 时 WebView2 吞掉 HTML5 拖拽 —— 统一用 pointer 模拟：
// beginDrag 记下拖拽物，移动超过阈值出现 ghost，松手时 elementFromPoint 命中：
//   [data-drop-zone] → dropZones 注册的处理器（工作流面板等）
//   [data-image-key] → imageDropTargets（本地文件上传）/ assetDropTargets（结果资产）

export interface DragItem {
  /** 结果资产（服务器上的产出） */
  asset?: Asset
  /** 本地文件路径 */
  path?: string
  label: string
  thumb?: string
}

export const dragGhost = reactive<{ x: number; y: number; item: DragItem | null }>({
  x: 0,
  y: 0,
  item: null,
})

/** 拖拽落点区注册表：key = data-drop-zone 的值 */
export const dropZones = new Map<string, (item: DragItem) => void>()

let dragItem: DragItem | null = null
let dragStart: { x: number; y: number } | null = null
let dragClickAt = 0 // 拖拽结束的时间戳：用于拦截紧跟着派发的 click

export function beginDrag(e: PointerEvent, item: DragItem) {
  if (e.button !== 0) return
  dragItem = item
  dragStart = { x: e.clientX, y: e.clientY }
  window.addEventListener('pointermove', onDragMove)
  window.addEventListener('pointerup', onDragUp, { once: true })
}

function onDragMove(e: PointerEvent) {
  if (!dragItem || !dragStart) return
  if (!dragGhost.item) {
    if (Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) < 5) return
    dragGhost.item = dragItem
    // 锁住原生文本选择：拖动时 mousemove 会框选沿途文字（参数区一片反蓝）
    document.body.classList.add('drag-active')
  }
  dragGhost.x = e.clientX
  dragGhost.y = e.clientY
}

function onDragUp(e: PointerEvent) {
  window.removeEventListener('pointermove', onDragMove)
  document.body.classList.remove('drag-active')
  const item = dragItem
  const started = dragGhost.item != null
  dragGhost.item = null
  dragItem = null
  dragStart = null
  if (!started || !item) return
  dragClickAt = Date.now()
  setTimeout(() => (dragClickAt = 0), 80) // click 在 pointerup 后同步派发，留窗口拦截

  const el = document.elementFromPoint(e.clientX, e.clientY)
  const zone = el?.closest('[data-drop-zone]')?.getAttribute('data-drop-zone') ?? null
  if (zone) {
    dropZones.get(zone)?.(item)
    return
  }
  const key = el?.closest('[data-image-key]')?.getAttribute('data-image-key') ?? null
  if (key) {
    if (item.path) imageDropTargets.get(key)?.(item.path)
    else if (item.asset) assetDropTargets.get(key)?.(item.asset)
    return
  }
  notify('拖到图片参数卡或工作流面板即可', 'info', 3000)
}

/** 组件的 click 处理器开头调用：刚结束的那次拖拽派发的 click 返回 true，别当点击处理 */
export function isDragClick(): boolean {
  return dragClickAt > 0
}

// 拖拽激活期间禁止原生文本选择（body.drag-active CSS 之外的事件级兜底）
document.addEventListener('selectstart', (e) => {
  if (dragGhost.item) e.preventDefault()
})

/** 把一份结果资产的工作流打开：优先输出目录直读，不行就下载到应用数据目录再解析。
 *  视频和图片走同一条链路——ComfyUI 的视频产物同样内嵌 API 图（Rust 侧二进制扫描能捞到） */
/** 丢弃某工作流的已填参数缓存（内存+落盘），并断开当前表单与它的关联。
 *  用资源打开工作流时用：资源内嵌参数才是真相，防旧缓存覆盖、也防 buildFields
 *  开头的快照把旧值写回（当前正开着同名工作流的场景）。 */
function discardFieldValues(name: string) {
  fieldValueCache.delete(name)
  if (fieldsWorkflow === name) fieldsWorkflow = null
  persistFieldValues()
}

export async function openAssetWorkflow(a: Asset) {
  async function openImported(name: string) {
    // 资源内嵌的参数（提示词/种子/图片引用）就是「这个资源自己的值」：
    // 清掉同名工作流残留的已填参数缓存（内存+落盘），否则 buildFields
    // 会用旧值覆盖资源内嵌参数——表现为「新资源打开，参数还是以前的」
    discardFieldValues(name)
    await loadWorkflows()
    await selectWorkflow(name)
    notify(`已打开工作流「${name}」（参数已还原为该资源内嵌值）`, 'ok', 5000)
  }
  try {
    // 应用数据目录；\\?\ 前缀是 Windows 长路径标记，拼接前去掉
    const dir = String(await api.appDataDir())
      .replace(/^\\\\\?\\/, '')
      .replace(/[\\/]+$/, '')
    // ① 优先直读输出目录映射的本地路径（零下载）
    if (a.type === 'output' && state.settings.outputDir) {
      const mapped = [String(state.settings.outputDir).replace(/[\\/]+$/, ''), a.subfolder, a.filename]
        .filter(Boolean)
        .join('/')
      try {
        const r = await api.importAssetWorkflow(mapped)
        await openImported(r.name)
        return
      } catch {
        // 映射路径可能不存在（输出目录改过/文件被移动）→ 不把坏路径丢给查看器，落到下载重试
      }
    }
    // ② 下载到 assets-tmp 再解析：这里的文件一定真实存在，解析失败进查看器也不会「读取失败」
    const tempPath = `${dir}/assets-tmp/${a.filename}`
    await api.saveOutput(a.base ?? primaryBase(), a.filename, a.subfolder, a.type, tempPath)
    try {
      const r = await api.importAssetWorkflow(tempPath)
      await openImported(r.name)
    } catch {
      // 没解析出可执行工作流 → 打开查看器，里面有预览和原因说明
      ui.assetInspect = tempPath
    }
  } catch (e) {
    notify(`打开资产失败：${e}`, 'error', 8000)
  }
}

export function notify(
  text: string,
  type: 'ok' | 'error' | 'warn' | 'info' = 'info',
  duration = 5000
) {
  const id = ++toastSeq
  state.toasts.push({ id, type, text })
  if (duration > 0) {
    window.setTimeout(() => {
      const i = state.toasts.findIndex((t) => t.id === id)
      if (i >= 0) state.toasts.splice(i, 1)
    }, duration)
  }
}

// ---------------------------------------------------------------- 计算节点

/** 所有启用的节点（base 非空；按配置顺序 = 优先级） */
export function enabledWorkers(): WorkerProfile[] {
  const list: WorkerProfile[] = Array.isArray(state.settings.workers)
    ? state.settings.workers
    : []
  return list.filter((w) => w && w.enabled !== false && w.base)
}

/** 主节点 base：首个启用的 worker → 兜底 workers[0] → 兜底旧 baseUrl（迁移前/兼容场景） */
export function primaryBase(): string {
  const list = enabledWorkers()
  if (list[0]?.base) return list[0].base
  const any = Array.isArray(state.settings.workers) ? state.settings.workers[0] : null
  return any?.base ?? state.settings.baseUrl ?? ''
}

/** 节点显示名：找不到（被删）时退回 host，任务/资产上仍可辨识来源 */
export function workerName(base: string): string {
  const list: WorkerProfile[] = Array.isArray(state.settings.workers)
    ? state.settings.workers
    : []
  const w = list.find((x) => x.base === base)
  if (w?.name) return w.name
  try {
    return new URL(base).host
  } catch {
    return base
  }
}

// ------------------------------------------------ 节点健康检查（30s 轮询 + WS 断连联动）
// key = base。WS onOpen/onClose 提供实时信号，30s 轮询 /system_stats 兜底校正；
// 掉线节点自动退出调度池（全部掉线时仍尝试派发，避免网络抖动把任务憋死）。

export const nodeHealth = ref<Record<string, 'up' | 'down' | 'unknown'>>({})

let healthTimer: number | null = null

function setHealth(base: string, h: 'up' | 'down') {
  if (nodeHealth.value[base] !== h) nodeHealth.value = { ...nodeHealth.value, [base]: h }
}

export function healthOf(base: string): 'up' | 'down' | 'unknown' {
  return nodeHealth.value[base] ?? 'unknown'
}

/** 单节点的硬件快照（节点看板用）：/system_stats 的 GPU 名与显存 */
export interface WorkerStat {
  device?: string
  /** 总显存 / 剩余显存（字节）；非 GPU 或旧版 ComfyUI 可能缺 */
  vramTotal?: number
  vramFree?: number
  ts: number
}

/** key = base。健康轮询顺带填充（零额外请求），30s 一刷 */
export const workerStats = ref<Record<string, WorkerStat>>({})

async function pingAllNodes() {
  const list = enabledWorkers()
  await Promise.all(
    list.map(async (w) => {
      try {
        const s = await api.systemStats(w.base)
        setHealth(w.base, 'up')
        const dev = s?.devices?.[0]
        workerStats.value = {
          ...workerStats.value,
          [w.base]: {
            device: dev?.name,
            vramTotal: dev?.vram_total,
            vramFree: dev?.vram_free,
            ts: Date.now(),
          },
        }
      } catch {
        setHealth(w.base, 'down')
      }
    })
  )
}

/** 立即 ping 一轮（节点看板打开 / 手动刷新用），不影响 30s 周期轮询 */
export async function pingNow() {
  await pingAllNodes()
}

function startHealthLoop() {
  if (healthTimer != null) return
  void pingAllNodes()
  healthTimer = window.setInterval(() => void pingAllNodes(), 30_000)
}

/** 可参与调度的节点：启用且未掉线；全部掉线时回落全部启用（网络抖动不憋死任务） */
export function schedulableWorkers(): WorkerProfile[] {
  const all = enabledWorkers()
  const alive = all.filter((w) => healthOf(w.base) !== 'down')
  return alive.length ? alive : all
}

// ------------------------------------------------ 参考图上传源追踪（多机跨机转存用）
// 图片字段 value 是「上传源机器 input 目录里的相对路径」（如 studio/xxx.png），
// 只在源机器有效；派发到其他节点前要先转存过去（scheduler.ensureOnWorker）。
// imageOrigin 记录每个 value 最初传到了哪台机器，localStorage 持久化保证重启后可溯源。

const IMAGE_ORIGIN_KEY = 'comfyui-studio.imageOrigin:v1'
const IMAGE_ORIGIN_MAX = 1000
const imageOrigin = new Map<string, string>()

function loadImageOrigin() {
  try {
    const raw = localStorage.getItem(IMAGE_ORIGIN_KEY)
    if (!raw) return
    for (const [k, v] of Object.entries<any>(JSON.parse(raw))) {
      if (typeof v === 'string') imageOrigin.set(k, v)
    }
  } catch {
    /* 忽略损坏的历史数据 */
  }
}

/** 记录一个图片 value 的上传源机器（FieldControl 所有写图片 value 的入口都要调） */
export function recordImageOrigin(value: string, base: string) {
  if (!value || !base || imageOrigin.get(value) === base) return
  // 简单封顶：超限删最早的，防无限增长（转存缓存丢了也只是重新转存一次）
  if (imageOrigin.size >= IMAGE_ORIGIN_MAX) {
    const oldest = imageOrigin.keys().next().value
    if (oldest != null) imageOrigin.delete(oldest)
  }
  imageOrigin.set(value, base)
  try {
    localStorage.setItem(IMAGE_ORIGIN_KEY, JSON.stringify(Object.fromEntries(imageOrigin)))
  } catch {
    /* 存储失败不影响主流程 */
  }
}

/** 查一个图片 value 的上传源；没记录时按主节点处理（旧数据/单机零变化） */
export function imageOriginBase(value: string): string {
  return imageOrigin.get(value) ?? primaryBase()
}

// ---------------------------------------------------------------- 初始化

export async function init() {
  try {
    state.settings = await api.getSettings()
  } catch (e) {
    notify(`读取设置失败：${e}`, 'error')
  }
  await migrateWorkers()
  loadImageOrigin()
  restoreAssets()
  loadPersistedFieldValues()
  loadBatchSourceSnap()
  await Promise.all([loadWorkflows(), loadTemplates()])
  // 恢复上次打开的工作流（列表里还存在才恢复；不存在则保持未选择）
  let lastWorkflow: string | null = null
  try {
    lastWorkflow = localStorage.getItem('comfyui-studio.lastWorkflow:v1')
  } catch {
    /* 忽略读取失败 */
  }
  if (lastWorkflow && state.workflows.some((w) => w.name === lastWorkflow)) {
    await selectWorkflow(lastWorkflow)
  }
  await checkConnection()
  connectWs()
  startHealthLoop()
  void restoreQueueFromServer()
  pollProcStatus()
  state.ready = true
}

/** 旧配置迁移：workers 为空时把 baseUrl 包装成第一个节点（单机用户无感知）。
 *  直接走 api.saveSettings 落盘，不走 saveSettings()（避免 init 中途触发 WS/连接检查）。 */
async function migrateWorkers() {
  const list = state.settings.workers
  if (Array.isArray(list) && list.length) return
  const base = state.settings.baseUrl
  if (!base) return
  const workers = [{ id: crypto.randomUUID(), name: '默认节点', base, enabled: true, weight: 1 }]
  state.settings = { ...state.settings, workers }
  try {
    state.settings = await api.saveSettings({ workers })
  } catch (e) {
    notify(`保存节点列表失败：${e}`, 'error')
  }
}

/**
 * 刷新/重启后从各节点 /queue 恢复还没跑完的任务（真相源在服务端，本地不存队列）。
 * 每台节点各查各的队列；恢复成队列条目后，实时进度继续由该节点的 WebSocket 推送驱动，
 * 完成时照常落资产 + 弹通知。工作流名取提交时写进 extra_data 的 workflow_name。
 */
async function restoreQueueFromServer() {
  const targets = enabledWorkers().map((w) => ({ base: w.base, id: w.id }))
  if (!targets.length && state.settings.baseUrl) {
    targets.push({ base: state.settings.baseUrl, id: '' })
  }
  if (!targets.length) return
  let restored = 0
  // 持久化索引（方案 A）：promptId → 提交时刻/workerId/params。/queue 里的用不上
  // params（extra_data 已带），但 startedAt 和 workerId 只有这里有。
  const pendMap = new Map(loadPendingRecs().map((r) => [r.promptId, r]))
  for (const { base, id } of targets) {
    try {
      const q = await api.queue(base)
      const runningRows: any[] = Array.isArray(q?.queue_running) ? q.queue_running : []
      const pendingRows: any[] = Array.isArray(q?.queue_pending) ? q.queue_pending : []
      for (const [rows, status] of [
        [runningRows, 'running'],
        [pendingRows, 'queued'],
      ] as const) {
        for (const row of rows) {
          // 行结构：[number, prompt_id, prompt, extra_data, outputs_to_execute]
          const promptId = row?.[1]
          if (!promptId || typeof promptId !== 'string') continue
          // 同一台机器上 promptId 才是唯一键；跨机同名 promptId 互不冲突
          if (state.jobs.some((j) => j.base === base && j.promptId === promptId)) continue
          const graph = row?.[2]
          const nodeCount = graph && typeof graph === 'object' ? Object.keys(graph).length : 0
          // 提交时随 extra_data 存的参数快照（有的话）：恢复的任务完成后，产出资产照样能「载入参数」
          const extra = row?.[3]
          const rec = pendMap.get(promptId)
          const params =
            extra && typeof extra === 'object' && extra.params && typeof extra.params === 'object'
              ? (extra.params as Record<string, any>)
              : rec?.params
          state.jobs.unshift({
            promptId,
            workflow: String(extra?.workflow_name ?? rec?.workflow ?? '刷新前的任务'),
            status,
            value: 0,
            max: nodeCount,
            // 持久化索引里有真实提交时刻（恢复时刻已经晚于提交很久，直接用会毁掉耗时）
            startedAt: rec?.startedAt ?? Date.now(),
            outputs: [],
            params,
            base,
            workerId: id || rec?.workerId || undefined,
            // 留存服务器队列里的原图：恢复来的任务也能「改派」到别的节点
            graph: graph && typeof graph === 'object' ? graph : undefined,
          })
          restored++
        }
      }
    } catch {
      /* 该节点不可达时跳过，不影响其他节点恢复 */
    }
  }
  if (restored) {
    notify(`已恢复队列里 ${restored} 个未完成任务，进度继续跟踪`, 'info', 6000)
  }
  // ---- history 对账：重启期间已经跑完的任务不在 /queue 里，按持久化索引去
  // /history 补收——产出照常进结果区（含精确执行耗时）。收尾后仍查无此任务
  // （且不在队列）的，标记为已被外部清空。 ----
  let doneRecovered = 0
  let gone = 0
  for (const rec of pendMap.values()) {
    if (state.jobs.some((j) => j.base === rec.base && j.promptId === rec.promptId)) continue
    // 暂停的任务：已从 ComfyUI 队列摘除、history 也无产出条目——直接恢复暂停态，
    // 不进对账（否则会被误判为「已被外部清空」）
    if (rec.status === 'paused') {
      state.jobs.unshift({
        promptId: rec.promptId,
        workflow: rec.workflow,
        status: 'paused',
        value: 0,
        max: 0,
        startedAt: rec.startedAt,
        outputs: [],
        params: rec.params,
        workerId: rec.workerId,
        base: rec.base,
      })
      continue
    }
    const job: Job = {
      promptId: rec.promptId,
      workflow: rec.workflow,
      status: 'queued',
      value: 0,
      max: 0,
      startedAt: rec.startedAt,
      outputs: [],
      params: rec.params,
      workerId: rec.workerId,
      base: rec.base,
    }
    state.jobs.unshift(job)
    try {
      await finishJob(rec.promptId, rec.base)
    } catch {
      /* finishJob 内部已处理 */
    }
    if (job.status === 'done') {
      doneRecovered++
    } else if (job.status === 'queued') {
      // /queue 和 /history 都没有 → 服务端已被清空
      job.status = 'cancelled'
      job.error = '服务端队列中已不存在（可能被外部中断或清空）'
      job.finishedAt = Date.now()
      removePendingRec(rec.promptId, rec.base) // 终态
      gone++
    }
  }
  if (doneRecovered) {
    notify(`上次关机时有 ${doneRecovered} 个任务已跑完，产出已补进结果区`, 'ok', 8000)
  }
  if (gone) {
    notify(`${gone} 个任务在服务端已不存在（可能被外部清空）`, 'warn', 8000)
  }
}

export async function loadWorkflows() {
  state.workflowsLoading = true
  try {
    const r = await api.listWorkflows()
    state.workflows = r.workflows ?? []
    state.workflowGroups = r.groups ?? []
    sortWorkflowsByOrder()
  } catch (e) {
    notify(`读取工作流列表失败：${e}`, 'error')
  } finally {
    state.workflowsLoading = false
  }
}

/** 按用户拖拽定制的顺序排工作流（settings.workflowOrder；没记录的排最后，保持扫描序） */
function sortWorkflowsByOrder() {
  const order = state.settings.workflowOrder
  if (!Array.isArray(order) || !order.length) return
  const idx = new Map(order.map((n, i) => [n, i]))
  state.workflows.sort(
    (a, b) => (idx.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (idx.get(b.name) ?? Number.MAX_SAFE_INTEGER)
  )
}

/** 工作流拖拽排序后落盘（settings.workflowOrder，随设置一起持久化） */
export async function persistWorkflowOrder(names: string[]) {
  state.settings.workflowOrder = names
  try {
    state.settings = await api.saveSettings({ workflowOrder: names })
  } catch (e) {
    notify(`保存排序失败：${e}`, 'error', 6000)
  }
}

// ---- 固定工作流：固定的不可删除（settings.pinnedWorkflows，随设置持久化） ----

export function isWorkflowPinned(name: string): boolean {
  const list = state.settings.pinnedWorkflows
  return Array.isArray(list) && list.includes(name)
}

export async function toggleWorkflowPin(name: string) {
  const list: string[] = Array.isArray(state.settings.pinnedWorkflows)
    ? [...state.settings.pinnedWorkflows]
    : []
  const wasPinned = list.includes(name)
  if (wasPinned) list.splice(list.indexOf(name), 1)
  else list.push(name)
  state.settings.pinnedWorkflows = list
  try {
    state.settings = await api.saveSettings({ pinnedWorkflows: list })
    notify(wasPinned ? `已取消固定「${name}」` : `已固定「${name}」，删除会被拦下`, 'info', 3000)
  } catch (e) {
    notify(`保存固定状态失败：${e}`, 'error', 6000)
  }
}

/**
 * 工作流改名（重命名文件）+ 全链路引用迁移：
 * 列表元数据 / 拖拽排序 / 已填参数值缓存 / 上次打开记录 / 模板绑定。
 * 历史任务与资产的 workflow 字段保持提交时的名字（历史语义，不追改）。
 */
export async function renameWorkflow(oldName: string, newName: string) {
  const name = newName.trim()
  if (!name || name === oldName) return
  if (state.workflows.some((w) => w.name === name)) {
    notify(`已存在同名工作流「${name}」`, 'warn', 5000)
    return
  }
  try {
    await api.renameWorkflow(oldName, name)
  } catch (e) {
    notify(`改名失败：${e}`, 'error', 8000)
    return
  }

  // 1) 列表元数据
  const meta = state.workflows.find((w) => w.name === oldName)
  if (meta) meta.name = name

  // 2) 拖拽排序里的旧名 → 新名
  if (Array.isArray(state.settings.workflowOrder)) {
    const order = state.settings.workflowOrder.map((n: string) => (n === oldName ? name : n))
    await persistWorkflowOrder(order)
  }

  // 3) 已填参数值缓存（fieldValueCache + localStorage 落盘）
  if (fieldValueCache.has(oldName)) {
    fieldValueCache.set(name, fieldValueCache.get(oldName)!)
    fieldValueCache.delete(oldName)
    persistFieldValues()
  }

  // 4) 上次打开的工作流
  try {
    if (localStorage.getItem('comfyui-studio.lastWorkflow:v1') === oldName) {
      localStorage.setItem('comfyui-studio.lastWorkflow:v1', name)
    }
  } catch {
    /* 忽略存储失败 */
  }

  // 5) 模板绑定迁移（落盘，否则模板失联）
  for (const t of state.templates) {
    if (t.workflow === oldName) {
      t.workflow = name
      try {
        await api.saveTemplate(t)
      } catch (e) {
        notify(`模板「${t.name}」的绑定迁移失败：${e}`, 'warn', 8000)
      }
    }
  }
  if (state.activeTemplate?.workflow === oldName) state.activeTemplate.workflow = name

  // 6) 当前打开的正是它：内存里 graph/fields 不用重建，改名字即可
  if (state.currentWorkflow === oldName) state.currentWorkflow = name

  notify(`已改名：「${oldName}」→「${name}」`, 'ok', 4000)
}

/**
 * 把一份结果资产设为某个工作流的参考图（拖资产到工作流卡片）：
 * 切到该模板（已在当前则不重载）→ 应用到第一个图片字段（单图）或多图字段追加。
 * 复用 FieldControl 的取值规则：input 里已有文件直接引用并记上传源；output 先 copyToInput 到主节点。
 */
export async function applyAssetToWorkflow(a: Asset, wfName: string) {
  if (a.kind !== 'image') {
    notify('只有图片能设为参考图', 'warn')
    return
  }
  try {
    if (state.currentWorkflow !== wfName) await selectWorkflow(wfName)
    let field = state.fields.find((f) => f.kind === 'image')
    let multi = false
    if (!field) {
      field = state.fields.find((f) => f.kind === 'multiimage')
      multi = true
    }
    if (!field) {
      notify(`「${wfName}」没有图片字段，无法设参考图`, 'warn', 5000)
      return
    }
    let path: string
    if (a.type === 'input') {
      path = a.subfolder ? `${a.subfolder}/${a.filename}` : a.filename
      recordImageOrigin(path, a.base ?? primaryBase())
    } else {
      const base = primaryBase()
      const res = await api.copyToInput(base, a.filename, a.subfolder, a.type, 'studio')
      const sub = String(res?.subfolder ?? 'studio')
      path = sub ? `${sub}/${res.name}` : String(res.name)
      recordImageOrigin(path, base)
    }
    if (multi) {
      if (!Array.isArray(field.value)) field.value = []
      ;(field.value as string[]).push(path)
    } else {
      field.value = path
    }
    notify(`已设为「${wfName}」的参考图`, 'ok', 3000)
  } catch (e) {
    notify(`引用资产失败：${e}`, 'error', 8000)
  }
}

export async function loadTemplates() {
  try {
    const r = await api.listTemplates()
    state.templates = r.templates ?? []
  } catch (e) {
    state.templates = []
  }
}

let procTimer: number | null = null
function pollProcStatus() {
  if (procTimer != null) return
  procTimer = window.setInterval(async () => {
    try {
      const s = await api.procStatus()
      state.procRunning = !!s.running
    } catch {
      /* ignore */
    }
  }, 2000)
}

// ---------------------------------------------------------------- 连接

export async function checkConnection() {
  state.connection = 'unknown'
  state.connText = '正在检测…'
  try {
    const stats = await api.systemStats(primaryBase())
    state.stats = stats
    state.connection = 'ok'
    const dev = stats?.devices?.[0]?.name ?? ''
    state.connText = dev ? `已连接 · ${dev}` : '已连接'
    loadObjectInfo()
    return true
  } catch (e) {
    state.connection = 'error'
    state.connText = String(e).split('\n')[0]
    return false
  }
}

export async function saveSettings(patch: Record<string, any>) {
  state.settings = { ...state.settings, ...patch }
  try {
    state.settings = await api.saveSettings(patch)
  } catch (e) {
    notify(`保存设置失败：${e}`, 'error')
    return
  }
  connectWs()
  await checkConnection()
}

async function loadObjectInfo() {
  try {
    const oi = await api.objectInfo(primaryBase())
    state.objectInfo = oi
    buildFields() // 有了节点定义，控件类型和下拉选项会更准
  } catch {
    /* 拉不到就用启发式兜底，不影响使用 */
  }
}

// ---- 队列 UI 投影（150ms 合并）：入队几十个任务时服务端会连发几十条 status，
// 每条都重建 queueByBase + 重算 total 会让三个组件跟着狂渲染——合并一次足够跟手 ----
let projTimer: number | null = null

function flushQueueProjection() {
  projTimer = null
  queueByBase.value = Object.fromEntries(perBaseQueue)
  let total = 0
  for (const [b, n] of perBaseQueue) {
    if (wss.has(b)) total += n // 已从节点池删除的不计入
  }
  state.queueRemaining = total
}

function connectWs() {
  for (const w of wss.values()) w.dispose()
  wss.clear()
  perBaseQueue.clear()
  // 每个启用节点一条 WS；兼容兜底：节点池为空时至少连旧地址（理论上 init 已迁移）
  const bases = enabledWorkers().map((w) => w.base)
  if (!bases.length && state.settings.baseUrl) bases.push(state.settings.baseUrl)
  for (const base of new Set(bases)) {
    const conn = new ComfyWs(base, 'comfyui-studio', {
      onOpen: () => {
        setHealth(base, 'up')
        // 重连后（睡眠唤醒/网络抖动）也对一遍账：该机队列空了就把幽灵任务清出去
        void reapStaleJobs(base)
      },
      onClose: () => {
        // WS 断开 ≠ 节点必然挂了（可能只是 WS 抖动）：先标 down 让调度避开，30s 轮询会校正
        setHealth(base, 'down')
      },
      onStatus: ({ queueRemaining }) => {
        perBaseQueue.set(base, queueRemaining)
        // UI 投影走 150ms 合并（数据层 perBaseQueue 立即保真）
        if (projTimer == null) {
          projTimer = window.setTimeout(flushQueueProjection, 150)
        }
        // 该机队列已空 → 应用内还挂在它名下的 queued/running 就是幽灵任务，安排清理
        if (queueRemaining === 0) {
          window.clearTimeout(reapTimer)
          reapTimer = window.setTimeout(() => void reapStaleJobs(base), 1500)
        }
      },
      onProgress: ({ promptId, node, value, max }) => {
        const job = state.jobs.find((j) => j.base === base && j.promptId === promptId)
        if (!job) return
        if (!job.execStartedAt) job.execStartedAt = Date.now() // 首个进度事件 = 实际开始执行
        job.status = 'running'
        job.value = value
        job.max = max
        if (node) job.node = node
      },
      onExecuting: ({ promptId, node }) => {
        if (!node) {
          // 该任务整体结束 → 去它所在节点的 /history 取产出
          finishJob(promptId, base)
        } else {
          const job = state.jobs.find((j) => j.base === base && j.promptId === promptId)
          if (job) {
            if (!job.execStartedAt) job.execStartedAt = Date.now()
            job.status = 'running'
            job.node = node
          }
        }
      },
      onError: ({ promptId, message }) => {
        const job = state.jobs.find((j) => j.base === base && j.promptId === promptId)
        if (job) {
          job.status = 'error'
          job.error = message
          job.finishedAt = Date.now()
        }
        removePendingRec(promptId, base) // 终态
        notify(`任务出错：${message}`, 'error', 8000)
      },
      needsLive: () =>
        // 该机还有排队/运行中的任务 → WS 需要保活（假死 watchdog 用）
        state.jobs.some(
          (j) =>
            (j.base ?? primaryBase()) === base &&
            (j.status === 'queued' || j.status === 'running')
        ),
    })
    wss.set(base, conn)
    conn.connect()
  }
}

// ---- 系统通知：窗口在后台/最小化时出图完成弹原生 toast；前台时不打扰 ----

async function systemNotify(title: string, body: string) {
  try {
    if (document.hasFocus() && !document.hidden) return
    let granted = await isPermissionGranted()
    if (!granted) granted = (await requestPermission()) === 'granted'
    if (granted) sendNotification({ title, body })
  } catch {
    /* 通知失败不影响主流程 */
  }
}

// ---- 幽灵任务清理：服务器重启/清队会把恢复来的任务永远卡在 queued，----
// ---- 堵死「队列已空」判定（完成音效、系统通知全不触发）----

let reapTimer = 0

/**
 * 对照「某一台节点」的服务器队列清理幽灵任务。WS 报告该机 queue_remaining=0 时触发；
 * 两轮确认（首次只记 staleSince，10s 后复查仍在才动手）防止把
 * 「刚从运行队列摘下、正要写历史」的瞬间误判成消失。
 * 各机各查各的队列——A 机清空不会误杀 B 机名下的任务。
 */
async function reapStaleJobs(base: string) {
  const candidates = state.jobs.filter(
    (j) => j.base === base && (j.status === 'queued' || j.status === 'running')
  )
  if (!candidates.length) return
  try {
    const q = await api.queue(base)
    const alive = new Set<string>()
    for (const row of [...(q?.queue_running ?? []), ...(q?.queue_pending ?? [])]) {
      const id = row?.[1]
      if (id) alive.add(String(id))
    }
    const now = Date.now()
    let needSecondRound = false
    let reaped = 0
    for (const j of candidates) {
      if (alive.has(j.promptId)) {
        j.staleSince = undefined
        continue
      }
      if (!j.staleSince) {
        j.staleSince = now // 首次发现不在队列 → 等下一轮确认
        needSecondRound = true
        continue
      }
      if (now - j.staleSince < 10_000) {
        needSecondRound = true
        continue
      }
      // 历史里其实有 → 是刚跑完的，正常收尾（产出落库 + 音效判定）
      try {
        const res = await api.historyItem(base, j.promptId)
        if (res?.[j.promptId]) {
          await finishJob(j.promptId, base)
          continue
        }
      } catch {
        /* 查不到历史就按消失处理 */
      }
      j.status = 'error'
      j.error = '任务已不在服务器队列中（服务器可能重启或清理了队列）'
      j.finishedAt = now
      reaped++
    }
    if (reaped) {
      notify(`${reaped} 个任务在节点上已不存在，已标记为失败`, 'warn', 8000)
    }
    // 没有新的 status 消息来触发下一轮时，自己安排复查
    if (needSecondRound) {
      window.clearTimeout(reapTimer)
      reapTimer = window.setTimeout(() => void reapStaleJobs(base), 12_000)
    }
  } catch {
    /* 节点不可达时跳过，等下一次 status 消息 */
  }
}

async function finishJob(promptId: string, base: string) {
  const job = state.jobs.find((j) => j.base === base && j.promptId === promptId)
  if (!job || job.status === 'done' || job.status === 'error') return
  try {
    const res = await api.historyItem(base, promptId)
    const entry = res?.[promptId]
    if (entry) {
      // history 的 status.messages 里有精确的执行起止时间戳：{"prompt_id", "timestamp"}。
      // timestamp 是毫秒（实测 v0.39：1791743291514）；自适应防旧版秒单位（>1e12 视为毫秒）
      const toMs = (ts: unknown) => {
        const n = Number(ts)
        return n > 1e12 ? n : Math.round(n * 1000)
      }
      const msgs: any[] = entry.status?.messages ?? []
      // history 条目也可能执行出错（如被中断）：标 error 而不是误收成 done
      if (entry.status?.status_str === 'error') {
        job.status = 'error'
        job.error = '执行出错（从历史记录补记）'
        job.finishedAt = Date.now()
        return
      }
      const startMsg = msgs.find((m) => m?.[0] === 'execution_start')
      const succMsg = msgs.find((m) => m?.[0] === 'execution_success')
      if (startMsg?.[1]?.timestamp) {
        job.execStartedAt = toMs(startMsg[1].timestamp)
      }
      if (succMsg?.[1]?.timestamp) {
        job.finishedAt = toMs(succMsg[1].timestamp)
      }
      job.outputs = normalizeOutputs(entry)
      job.status = 'done'
      job.value = job.max || 1
      job.finishedAt = job.finishedAt ?? Date.now()
      // 记录该机单任务耗时（指数滑动平均）：队列完成 ETA 的估算依据——
      // 用「执行起点」而非提交起点，排队时间不污染 ETA
      const durMs = Math.max(1000, (job.finishedAt ?? Date.now()) - (job.execStartedAt ?? job.startedAt))
      const prev = baseAvgMs.get(base)
      baseAvgMs.set(base, prev == null ? durMs : Math.round(prev * 0.7 + durMs * 0.3))
      addAssets(job)
      removePendingRec(job.promptId, base) // 终态：从持久化索引移除（资产已带参数快照）
      notify(`生成完成（${job.outputs.length} 个文件）`, 'ok')
      // 应用内没有排队/进行中的任务了（这一批跑完）且窗口在后台 → 发一条系统通知
      // （批次场景下只在整批结束弹一条，避免 N 连弹）
      if (!state.jobs.some((j) => j.status === 'queued' || j.status === 'running')) {
        void systemNotify(
          'ComfyUI Studio · 任务完成',
          `「${job.workflow || '工作流'}」已完成，新增 ${job.outputs.length} 个文件`
        )
      }
    }
  } catch {
    // 查 history 失败（网络抖动等）不标 error：任务保持原状态，
    // history 轮询几秒后会自动重试，直到拿到结果或超时判废
  }
}

// ---- 队列完成 ETA：按各机历史平均单任务耗时估算；总完成时间 = 最慢那台（并行） ----
// 内存数据，重启后从第一个完成任务开始重新积累；无样本时不显示。
const baseAvgMs = reactive(new Map<string, number>())

export const queueEtaText = computed(() => {
  const active = state.jobs.filter((j) => j.status === 'queued' || j.status === 'running')
  if (!active.length) return ''
  // 无样本的机器用全局平均兜底（否则它名下的任务会被直接忽略导致低估）；
  // 全局也无样本（第一个任务还没跑完）时不显示——没有依据的预估没有意义
  const globalAvg =
    baseAvgMs.size > 0
      ? Math.round([...baseAvgMs.values()].reduce((a, b) => a + b, 0) / baseAvgMs.size)
      : 0
  if (!globalAvg) return ''
  const avgFor = (base: string) => baseAvgMs.get(base) ?? globalAvg
  // 每台机器串行消化自己名下任务：总剩余 = 排队任务全耗时 + 在跑任务的剩余折算，
  // 多机并行时取最慢那台；「约 X 分钟」预估的就是这些队列任务还将耗费的总时间
  let slowest = 0
  for (const base of new Set(active.map((j) => j.base ?? primaryBase()))) {
    let remain = 0
    for (const j of active.filter((x) => (x.base ?? primaryBase()) === base)) {
      if (j.status === 'running' && j.max > 0) {
        remain += avgFor(base) * Math.max(0.05, 1 - j.value / j.max)
      } else {
        remain += avgFor(base)
      }
    }
    slowest = Math.max(slowest, remain)
  }
  if (!slowest) return ''
  const s = Math.round(slowest / 1000)
  return s >= 90 ? `约 ${Math.round(s / 60)} 分钟` : `约 ${s} 秒`
})

/** 单任务剩余预估（队列行内显示）：平均执行时长 × 剩余比例；无样本返回空 */
export function jobRemainText(job: Job): string {
  if (job.status !== 'running' || !job.max) return ''
  const base = job.base ?? primaryBase()
  let avg = baseAvgMs.get(base)
  if (avg == null) {
    if (!baseAvgMs.size) return ''
    avg = Math.round([...baseAvgMs.values()].reduce((a, b) => a + b, 0) / baseAvgMs.size)
  }
  const s = Math.round((avg * Math.max(0.05, 1 - job.value / job.max)) / 1000)
  return s >= 90 ? `剩约 ${Math.round(s / 60)} 分钟` : `剩约 ${s} 秒`
}

// ---- 队列暂停/恢复：ComfyUI 无原生暂停，用「中断+摘除 + 原图重投」模拟 ----
// 暂停 = 运行中 → /interrupt（进度作废），排队 → /queue delete 摘除；任务转 paused
// 保留 graph/params。恢复 = 按原顺序用原图重新提交（种子在 graph 里，结果可复现）。

/** 暂停队列：停掉运行中的、摘除排队的，全部转为 paused 保留记录 */
export async function pauseQueue() {
  const active = state.jobs.filter((j) => j.status === 'running' || j.status === 'queued')
  if (!active.length) {
    notify('没有进行中的任务', 'info', 3000)
    return
  }
  const byBase = new Map<string, { run: Job[]; queued: Job[] }>()
  for (const j of active) {
    const b = j.base ?? primaryBase()
    const e = byBase.get(b) ?? { run: [], queued: [] }
    ;(j.status === 'running' ? e.run : e.queued).push(j)
    byBase.set(b, e)
  }
  const failed: string[] = []
  for (const [base, { run, queued }] of byBase) {
    if (run.length) {
      try {
        await api.interrupt(base)
      } catch {
        failed.push(workerName(base))
      }
    }
    if (queued.length) {
      try {
        await api.queueDelete(
          base,
          queued.map((j) => j.promptId)
        )
      } catch {
        failed.push(workerName(base))
      }
    }
  }
  // 摘除/中断成功的转 paused（graph/params 完整保留）；操作失败的保持原状态
  // （任务实际还在跑/在队列，恢复时不能重投，否则重复出图）
  for (const j of active) {
    const failedNode = failed.includes(workerName(j.base ?? primaryBase()))
    if (!failedNode) j.status = 'paused'
  }
  persistPendingJobs()
  if (failed.length) {
    notify(
      `已暂停（节点 ${failed.join('、')} 操作失败，其任务仍在原状态）`,
      'warn',
      8000
    )
  } else {
    notify(`已暂停 ${active.length} 个任务，点「▶ 恢复」继续执行`, 'ok', 6000)
  }
}

/** 恢复单个 paused 任务（重投逻辑与 resumeQueue 共用）：原地更新任务对象，返回是否成功 */
async function resumeOne(j: Job): Promise<boolean> {
  const base = j.base ?? primaryBase()
  let graph = j.graph
  if (!graph) {
    // 刷新后内存里的执行图丢了：工作流文件还在磁盘上，用参数快照重建
    // （params 的 key 是 nodeId::input，applyValues 直接覆盖节点输入，种子也在里面）
    try {
      const baseGraph = await api.readWorkflow(j.workflow)
      graph = j.params ? applyValues(baseGraph, j.params) : baseGraph
      j.graph = graph
    } catch (e) {
      j.status = 'error'
      j.error = `执行图已丢失且工作流「${j.workflow}」不可读：${e}`
      j.finishedAt = Date.now()
      return false
    }
  }
  try {
    const res = await api.submit(base, graph, j.workflow || undefined, j.params ? JSON.stringify(j.params) : undefined)
    const err = extractSubmitError(res, graph)
    if (err) throw new Error(err)
    // 原地更新（不替换对象）：弹窗/列表的引用保持有效
    Object.assign(j, {
      promptId: String(res.prompt_id), // 重投 = 新 promptId，旧索引记录一并移除
      status: 'queued',
      value: 0,
      max: 0,
      startedAt: Date.now(),
      execStartedAt: undefined,
      finishedAt: undefined,
      error: undefined,
      outputs: [],
    })
    removePendingRec(j.promptId, base)
    return true
  } catch (e) {
    console.warn('[resume] 重投失败', j.promptId, e)
    return false
  }
}

/** 恢复队列：paused 任务按「原执行顺序」（数组倒序）用原图重新提交。
 *  刷新后 graph 丢失的，用工作流文件 + 参数快照重建（种子在 params 里，结果可复现）。 */
export async function resumeQueue() {
  const paused = state.jobs.filter((j) => j.status === 'paused').reverse()
  if (!paused.length) {
    notify('没有已暂停的任务', 'info', 3000)
    return
  }
  const failed: string[] = []
  for (const j of paused) {
    if (!(await resumeOne(j))) failed.push(j.workflow || j.promptId)
  }
  persistPendingJobs()
  if (failed.length) {
    notify(`已恢复部分任务，${failed.length} 个重投失败：${failed.join('、')}`, 'warn', 10000)
  } else {
    notify(`已恢复 ${paused.length} 个任务，继续执行`, 'ok', 5000)
  }
}

/** 弹窗「恢复此任务」：单个 paused 任务重投 */
export async function resumeSingle(job: Job) {
  const ok = await resumeOne(job)
  persistPendingJobs()
  notify(
    ok ? '已恢复该任务，进入执行队列' : '恢复失败（详见任务行错误信息）',
    ok ? 'ok' : 'warn',
    5000
  )
}

// ---------------------------------------------------------------- 工作流

export async function selectWorkflow(name: string) {
  try {
    const graph = await api.readWorkflow(name)
    state.currentWorkflow = name
    state.graph = graph
    // 自动选中绑定到该工作流的模板
    const tpl =
      state.templates.find((t) => t.workflow === name && t.mode === 'custom') ?? null
    state.activeTemplate = tpl
    buildFields()
    // 记住当前工作流：刷新/重启后自动回到这里
    try {
      localStorage.setItem('comfyui-studio.lastWorkflow:v1', name)
    } catch {
      /* 忽略存储失败 */
    }
  } catch (e) {
    notify(String(e), 'error')
  }
}

/**
 * 已填参数值的「按工作流」记忆：
 * fieldsWorkflow 记录当前 state.fields 属于哪个工作流；buildFields 重建前把值快照回去、
 * 重建后恢复目标工作流的值 —— 切走再切回来，填过的东西都还在。
 */
let fieldsWorkflow: string | null = null
const fieldValueCache = new Map<string, Map<string, any>>()

// ---- 已填值持久化：刷新/重启后连上传过的图片引用一起恢复 ----

const FIELD_VALUES_KEY = 'comfyui-studio.fieldValues:v1'

function persistFieldValues() {
  try {
    const out: Record<string, Record<string, any>> = {}
    for (const [wf, m] of fieldValueCache) {
      const o: Record<string, any> = {}
      for (const [k, v] of m) o[k] = v
      out[wf] = o
    }
    localStorage.setItem(FIELD_VALUES_KEY, JSON.stringify(out))
  } catch {
    /* 存储失败不影响主流程 */
  }
}

function loadPersistedFieldValues() {
  try {
    const raw = localStorage.getItem(FIELD_VALUES_KEY)
    if (!raw) return
    for (const [wf, m] of Object.entries<any>(JSON.parse(raw))) {
      fieldValueCache.set(wf, new Map(Object.entries(m)))
    }
  } catch {
    /* 忽略损坏的历史数据 */
  }
}

// ---- 排队任务持久化（防关机丢上下文，方案 A）----
// 已提交到 ComfyUI 的任务，服务端队列就是执行真相源（重启应用后 restoreQueueFromServer
// 能恢复壳与 params）——这里补的是轻量索引：提交时刻、workerId，以及**对账依据**：
// 重启期间已跑完的任务不在 /queue 里，只有凭这份索引查 /history 才能把产出补进结果区。
// 任务完成/取消后随 watch 自动从索引消失（资产已带参数快照，不留冗余）。

const PENDING_KEY = 'comfyui-studio.pendingJobs:v1'

interface PendingRec {
  promptId: string
  base: string
  workflow: string
  workerId?: string
  startedAt: number
  status?: JobStatus // 暂停的任务记为 paused：重启对账时直接恢复暂停态，不进 history 对账
  params?: Record<string, any>
}

/** 磁盘索引的内存缓存：合并式写的基础——写时保留「state.jobs 里没有、但还没被
 *  确认终态」的记录（如节点离线未完成对账的），防止一次全量重写把别人抹掉 */
let pendingCache: PendingRec[] | null = null

/** 队列全局暂停：有 paused 任务即视为暂停中（纯状态推导，刷新/重启后依然生效）——
 *  拦截新提交；全部恢复或移除后自动解除 */
export const queuePaused = computed(() => state.jobs.some((j) => j.status === 'paused'))

function loadPendingRecs(): PendingRec[] {
  if (pendingCache) return pendingCache
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    const list = raw ? JSON.parse(raw) : []
    pendingCache = Array.isArray(list)
      ? list.filter((r: any) => r && typeof r.promptId === 'string' && typeof r.base === 'string')
      : []
  } catch {
    pendingCache = []
  }
  return pendingCache
}

/** 确认一条记录到达终态（完成/失败/取消/丢弃）：从索引里真正移除 */
function removePendingRec(promptId: string, base: string) {
  const recs = loadPendingRecs()
  const next = recs.filter((r) => !(r.promptId === promptId && r.base === base))
  pendingCache = next
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

function persistPendingJobs() {
  try {
    const recs = loadPendingRecs()
    // upsert：state.jobs 里的 queued/running/paused 覆盖同名记录；磁盘上多出的（未对账的
    // 离线节点记录等）保留不动——只有 removePendingRec 才真正删除
    for (const j of state.jobs) {
      if (j.status !== 'queued' && j.status !== 'running' && j.status !== 'paused') continue
      const base = j.base ?? primaryBase()
      const rec: PendingRec = {
        promptId: j.promptId,
        base,
        workflow: j.workflow,
        workerId: j.workerId,
        startedAt: j.startedAt,
        status: j.status,
        params: j.params,
      }
      const i = recs.findIndex((r) => r.promptId === rec.promptId && r.base === base)
      if (i >= 0) recs[i] = rec
      else recs.unshift(rec)
    }
    pendingCache = recs
    localStorage.setItem(PENDING_KEY, JSON.stringify(recs))
  } catch {
    /* 存储失败不影响主流程 */
  }
}

let pendingTimer = 0
watch(
  state.jobs,
  () => {
    window.clearTimeout(pendingTimer)
    pendingTimer = window.setTimeout(persistPendingJobs, 800)
  },
  { deep: true }
)

/** 批量拆行源文本快照（防断电保险丝，方案 B）：整段文本留底，断电后可一键重投 */
const BATCH_SNAP_KEY = 'comfyui-studio.batchSnap:v1'

export const batchSourceSnap = ref<{
  text: string
  fieldKey: string
  fieldLabel: string
  count: number
  at: number
  file: string
} | null>(null)

function saveBatchSourceSnap(text: string, fieldKey: string, fieldLabel: string, count: number) {
  // 每批一个独立文件（带时间戳），互不覆盖——前面批次还没执行的也各有留底
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const name = `批次-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const snap = { text, fieldKey, fieldLabel, count, at: d.getTime(), file: name }
  try {
    localStorage.setItem(BATCH_SNAP_KEY, JSON.stringify(snap))
  } catch {
    /* ignore */
  }
  batchSourceSnap.value = snap
  // 同步镜像一份可读文本到 data/batch-snapshots/：文件管理器里直接能看能拷，
  // 不怕清浏览器缓存。失败静默（localStorage 副本仍是主数据）。
  const header = [
    '# ComfyUI Studio 批量拆行快照',
    `# 字段: ${fieldLabel}`,
    `# 条数: ${count}（每条独立任务）`,
    `# 保存时间: ${d.toLocaleString()}`,
    '# 重新载入: 应用结果区队列上方的「⏳ 重新载入」按钮；',
    '#          或手动把下面两条分隔线之间的内容粘贴到对应字段后「✂ 拆行提交」',
    '# ==================== 快照内容开始 ====================',
    '',
    text,
    '',
    '# ==================== 快照内容结束 ====================',
    '',
  ].join('\n')
  void api.writeBatchSnapshot(name, header).catch(() => {})
}

export function loadBatchSourceSnap() {
  try {
    const raw = localStorage.getItem(BATCH_SNAP_KEY)
    if (raw) {
      const snap = JSON.parse(raw)
      if (snap && typeof snap.text === 'string') batchSourceSnap.value = snap
    }
  } catch {
    /* ignore */
  }
}

export function dismissBatchSourceSnap() {
  const s = batchSourceSnap.value
  try {
    localStorage.removeItem(BATCH_SNAP_KEY)
  } catch {
    /* ignore */
  }
  batchSourceSnap.value = null
  if (s?.file) void api.deleteBatchSnapshot(s.file).catch(() => {}) // 同步删除对应的文本镜像
}

/** 重新载入快照：把留底的整段文本按原字段打开拆行确认弹窗（重投会覆盖快照） */
export function requeueBatchSourceSnap() {
  const s = batchSourceSnap.value
  if (!s) return
  const lines = splitBatchLines(s.text)
  if (lines.length < 2) {
    notify('快照内容拆不出多条，已丢弃', 'warn', 4000)
    dismissBatchSourceSnap()
    return
  }
  batchTextPending.value = { fieldKey: s.fieldKey, fieldLabel: s.fieldLabel, lines, raw: s.text }
}

/** 编辑过程中实时快照（防抖 400ms），刷新/崩溃也不丢已填内容。
 *  必须走 snapshotFieldValues（先收当前表单值进缓存再落盘），不能直接 persistFieldValues——
 *  缓存只在 buildFields 时同步，直接落盘会把「上次构建时的旧值」存回去，
 *  上传图片/修改过的值就会丢（刷新后图片消失的根因）。 */
let persistTimer = 0
watch(
  () => state.fields,
  () => {
    window.clearTimeout(persistTimer)
    persistTimer = window.setTimeout(snapshotFieldValues, 400)
  },
  { deep: true }
)

function snapshotFieldValues() {
  if (!fieldsWorkflow || !state.fields.length) return
  const m = new Map<string, any>()
  for (const f of state.fields) {
    m.set(f.key, Array.isArray(f.value) ? [...f.value] : f.value)
  }
  fieldValueCache.set(fieldsWorkflow, m)
  persistFieldValues()
}

/** 通用/定制两条路都在这里汇合：先自动解析，再按标题约定/模板决定显示与形态 */
export function buildFields() {
  // 重建前：把当前已填的值存回它所属的工作流（切工作流时 fields 还是旧的）
  snapshotFieldValues()

  if (!state.graph) {
    state.fields = []
    fieldsWorkflow = state.currentWorkflow
    return
  }
  const all = parseGraph(state.graph, state.objectInfo)
  const tpl = state.activeTemplate

  if (tpl && tpl.mode === 'custom' && tpl.fields?.length) {
    // 定制模式：按模板绑定渲染（模板可以包含未标记的节点）
    const bindings = new Map(tpl.fields.map((b) => [b.key, b]))
    state.fields = all
      .filter((f) => {
        const b = bindings.get(f.key)
        return !!b && b.visible !== false
      })
      .map((f) => {
        const b = bindings.get(f.key)!
        return {
          ...f,
          label: b.label || f.label,
          kind: b.kind || f.kind,
          group: b.group || f.group,
          order: b.order ?? f.order,
          options: b.options ?? f.options,
          min: b.min ?? f.min,
          max: b.max ?? f.max,
          step: b.step ?? f.step,
          placeholder: b.placeholder ?? f.placeholder,
          // 模板没配的项 → 继承节点标题约定（titleSyntax）推出的值
          row: b.row ?? f.row ?? null,
          actions: b.actions?.length ? b.actions : f.actions,
          presets: b.presets?.length ? b.presets : f.presets,
        }
      })
      .sort((a, b) => a.order - b.order)
  } else {
    // 通用模式：默认不暴露任何节点，只显示标题带约定标记的（数字/功能词/预设/+）
    state.fields = all.filter((f) => f.marked)
  }

  // 重建后：fields 现在属于当前工作流，恢复这个工作流上次填过的值
  fieldsWorkflow = state.currentWorkflow
  const saved = fieldsWorkflow ? fieldValueCache.get(fieldsWorkflow) : undefined
  if (saved) {
    for (const f of state.fields) {
      if (!saved.has(f.key)) continue
      const v = saved.get(f.key)
      f.value = Array.isArray(v) ? [...v] : v
    }
  }
}

export function setActiveTemplate(tpl: ParamTemplate | null) {
  state.activeTemplate = tpl
  buildFields()
}

export function randomizeSeeds() {
  for (const f of state.fields) {
    if (f.kind === 'seed') f.value = randomSeed()
  }
}

// ---------------------------------------------------------------- 运行

/**
 * 图里没暴露成参数的 seed / noise_seed 输入直接在图副本里换掉，
 * 保证批次任务不重样（节点没暴露时 randomizeSeeds 摸不到它们）。
 */
function randomizeHiddenSeeds(graph: any) {
  for (const node of Object.values<any>(graph ?? {})) {
    const inputs = node?.inputs
    if (!inputs || typeof inputs !== 'object') continue
    for (const [name, v] of Object.entries(inputs)) {
      if ((name === 'seed' || name === 'noise_seed') && typeof v === 'number') {
        inputs[name] = randomSeed()
      }
    }
  }
}

/** 等一个任务真正跑完（WS 驱动状态，这里轮询即可）：返回是否正常完成。
 *  promptId 只在单机内唯一，必须连同所在节点 base 一起定位。 */
function waitForJob(promptId: string, base: string, timeoutMs = 2 * 60 * 60 * 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    let missingSince = 0 // 记录消失的起始时刻（改派换绑/清理竞态时短暂找不到）
    const timer = window.setInterval(() => {
      const job = state.jobs.find((j) => j.base === base && j.promptId === promptId)
      if (job && (job.status === 'done' || job.status === 'error' || job.status === 'cancelled')) {
        clearInterval(timer)
        resolve(job.status === 'done')
      } else if (!job) {
        // 记录不在了：宽限 30s（改派瞬间旧记录被替换属正常），仍不出现才按取消收尾
        if (!missingSince) missingSince = Date.now()
        else if (Date.now() - missingSince > 30_000) {
          clearInterval(timer)
          resolve(false)
        }
      } else {
        missingSince = 0 // 找到了（且未结束）：继续等
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer)
          resolve(false)
        }
      }
    }, 400)
  })
}

/** 正在后台跑的提交链数量（每点一次「提交生成」产生一条链） */
let activeChains = 0

/**
 * 提交生成（整批入队，链在后台跑）：total 个任务**一次性全部提交**进 ComfyUI 队列
 * （第 1 个用表单当前值，其余每个都独立换新种子），服务端自己串行跑——
 * 队列面板第一时间就是「一个进行中 + 其余排队」，全部跑完后提示 + 完成音效。
 * 校验通过后本函数立即返回，执行转入后台 → 提交按钮随时可再次点击，连点即再排一条链。
 * - batch = 批次数
 * - 带「多图」节点时：外层循环图片、内层循环批次
 *   （2 张图 × 批次 2 → 图1×2 次 → 图2×2 次，共 4 个任务）
 */
// ---- 提示词历史：最近提交过的文本字段值（去重置顶，全局一份，localStorage 持久化） ----

const PROMPT_HIST_KEY = 'comfyui-studio.promptHistory:v1'
const PROMPT_HIST_MAX = 50

function loadPromptHistory(): string[] {
  try {
    const raw = localStorage.getItem(PROMPT_HIST_KEY)
    const arr = raw ? JSON.parse(raw) : null
    return Array.isArray(arr) ? arr.map(String).filter(Boolean).slice(0, PROMPT_HIST_MAX) : []
  } catch {
    return []
  }
}

export const promptHistory = ref<string[]>(loadPromptHistory())

/** 提交时调用：把当前所有文本字段的值收进历史（去重、最近优先） */
export function recordPromptHistory() {
  let changed = false
  for (const f of state.fields) {
    if ((f.kind === 'text' || f.kind === 'textarea') && typeof f.value === 'string') {
      const t = f.value.trim()
      if (!t) continue
      const i = promptHistory.value.indexOf(t)
      if (i > 0) promptHistory.value.splice(i, 1)
      if (i !== 0) {
        promptHistory.value.unshift(t)
        changed = true
      }
    }
  }
  if (promptHistory.value.length > PROMPT_HIST_MAX) {
    promptHistory.value.length = PROMPT_HIST_MAX
    changed = true
  }
  if (changed) localStorage.setItem(PROMPT_HIST_KEY, JSON.stringify(promptHistory.value))
}

// ---- 批次数量：全局共享（提交按钮 / 一键粘贴提交等入口都用它），localStorage 持久化 ----

const BATCH_KEY = 'comfyui-studio.batch:v1'

export const submitBatch = ref(1)
try {
  const saved = parseInt(localStorage.getItem(BATCH_KEY) ?? '', 10)
  if (saved >= 1 && saved <= 10) submitBatch.value = saved
} catch {
  /* 忽略读取失败 */
}
watch(submitBatch, (v) => {
  try {
    localStorage.setItem(BATCH_KEY, String(v))
  } catch {
    /* 忽略写入失败 */
  }
})

// ---- 节点选择：auto = 调度器自动分配；否则固定派给该节点（ParamPanel 下拉，多节点时显示） ----

const WORKER_KEY = 'comfyui-studio.worker:v1'

export const submitWorkerId = ref('auto')
try {
  const saved = localStorage.getItem(WORKER_KEY)
  if (saved) submitWorkerId.value = saved
} catch {
  /* 忽略读取失败 */
}
watch(submitWorkerId, (v) => {
  try {
    localStorage.setItem(WORKER_KEY, v)
  } catch {
    /* 忽略写入失败 */
  }
})

export function submit(batch = submitBatch.value) {
  ensureAudio() // 用户手势时机预热 AudioContext（完成音效需要）
  if (queuePaused.value) {
    notify('队列已暂停，请先点「▶ 恢复」再提交', 'warn', 4000)
    return
  }
  if (!state.graph) {
    notify('请先选择一个工作流', 'warn')
    return
  }
  if (!selectWorker(schedulableWorkers(), state.jobs, submitWorkerId.value)) {
    notify('没有可用的计算节点（全部禁用或冷却中），请到设置里检查节点列表', 'warn', 6000)
    return
  }
  recordPromptHistory() // 每次成功发起提交时记录本次用过的提示词
  const count = Math.max(1, Math.min(50, Math.floor(batch) || 1))
  const multi = state.fields.find((f) => f.kind === 'multiimage')
  const imgs = multi
    ? Array.isArray(multi.value)
      ? multi.value.map(String)
      : []
    : []

  if (multi && !imgs.length) {
    notify('多图节点还没有上传图片', 'warn')
    return
  }

  const total = multi ? imgs.length * count : count
  // 已有链在跑时又点了提交（排队链）→ 这条链整链重掷种子，避免和前面的链撞车出重复图
  const reroll = activeChains > 0
  activeChains++
  state.busy = true
  // 按下提交这一刻的参数快照：随任务挂到每个产出上，供灯箱「载入参数」一键回填
  const paramsSnapshot = collectParamsSnapshot()
  void runChain(total, count, multi?.key, imgs, reroll, paramsSnapshot)
}

// ---- 批量拆行提交（方案 A）：粘贴多行提示词自动识别，逐条 = 每行一个任务 ----

export type BatchTextMode = 'ask' | 'split' | 'whole'

const BATCH_TEXT_KEY = 'comfyui-studio.batchTextMode:v1'

/** 粘贴多行长文本时的行为：ask=弹窗询问（默认）/ split=自动逐条拆 / whole=整段一条 */
export const batchTextMode = ref<BatchTextMode>('ask')
try {
  const saved = localStorage.getItem(BATCH_TEXT_KEY)
  if (saved === 'ask' || saved === 'split' || saved === 'whole') batchTextMode.value = saved
} catch {
  /* 忽略读取失败 */
}
watch(batchTextMode, (v) => {
  try {
    localStorage.setItem(BATCH_TEXT_KEY, v)
  } catch {
    /* 忽略写入失败 */
  }
})

/** 拆行确认弹窗的挂起状态（pasteSubmitField / 拆行按钮设置，BatchTextDialog 消费） */
export const batchTextPending = ref<{
  fieldKey: string
  fieldLabel: string
  lines: string[]
  raw: string
} | null>(null)

/** 拆行弹窗确认：'split'=逐条提交 / 'whole'=整段提交 / 'cancel'=关闭；remember=记住选择；
 *  count=每条的批次数（弹窗里可调，默认顶栏批次）。 */
export function confirmBatchText(
  action: 'split' | 'whole' | 'cancel',
  remember: boolean,
  count = submitBatch.value
) {
  const p = batchTextPending.value
  if (!p) return
  batchTextPending.value = null
  if (action === 'cancel') return
  if (remember) batchTextMode.value = action // split→以后静默拆条；whole→以后整段
  const f = state.fields.find((x) => x.key === p.fieldKey)
  if (f) f.value = p.raw
  if (action === 'split') {
    submitBatchText(p.lines, p.fieldKey, p.fieldLabel, count)
  } else {
    submit()
    notify(`已粘贴并提交到「${p.fieldLabel}」`, 'ok', 2000)
  }
}

/** 批量拆行提交：每行一条提示词 × 批次数，走 runChain 同一链路（改派/ETA/音效/看板全兼容）。
 *  种子策略与批次一致：第 1 个任务用表单种子，其余全量换新；每条的参数快照各记各的行。 */
function submitBatchText(
  lines: string[],
  fieldKey: string,
  fieldLabel: string,
  count = submitBatch.value
) {
  ensureAudio()
  if (queuePaused.value) {
    notify('队列已暂停，请先点「▶ 恢复」再提交', 'warn', 4000)
    return
  }
  if (!state.graph) {
    notify('请先选择一个工作流', 'warn')
    return
  }
  if (!selectWorker(schedulableWorkers(), state.jobs, submitWorkerId.value)) {
    notify('没有可用的计算节点（全部禁用或冷却中），请到设置里检查节点列表', 'warn', 6000)
    return
  }
  const items = lines.slice(0, BATCH_TEXT_MAX)
  const perLine = Math.max(1, Math.min(10, Math.floor(count) || 1))
  recordPromptHistory()
  // 已有链在跑时又提交（排队链）→ 整链重掷种子防撞车，与普通提交一致
  const reroll = activeChains > 0
  activeChains++
  state.busy = true
  const baseSnapshot = collectParamsSnapshot()
  // 外层行 × 内层批次：与多图展开同构（Math.floor(i / count) 取行）
  void runChain(
    items.length * perLine,
    perLine,
    undefined,
    [],
    reroll,
    undefined,
    (i, values) => {
      const line = items[Math.floor(i / perLine)]
      values[fieldKey] = line
      return { ...(baseSnapshot ?? {}), [fieldKey]: line }
    }
  )
  // 方案 B 保险丝：整段源文本留底——断电后 ComfyUI 队列没了也能一键重投
  // （A 的对账只覆盖「ComfyUI 还活着」的场景）
  saveBatchSourceSnap(lines.join('\n'), fieldKey, fieldLabel, items.length)
  notify(
    perLine > 1
      ? `「${fieldLabel}」已按行拆分：${items.length} 条 × ${perLine} 张 = ${items.length * perLine} 个任务`
      : `「${fieldLabel}」已按行拆分：提交 ${items.length} 个任务（每行一条）`,
    'ok',
    4000
  )
}

/** 「✂ 拆行提交」按钮：把字段当前内容按行/编号分镜块拆分，弹预览确认后批量提交（显式操作，总是弹窗） */
export function openBatchTextDialog(f: FieldSchema) {
  const raw = String(f.value ?? '')
  const lines = splitBatchLines(raw)
  if (lines.length < 2) {
    notify('内容不足两条，无需拆分（按换行或 1️⃣/1./【1】等编号块识别）', 'warn', 4000)
    return
  }
  batchTextPending.value = { fieldKey: f.key, fieldLabel: f.label, lines, raw }
}

/**
 * 一键粘贴提交：读剪贴板文本覆盖填入指定文本字段，按当前批次设置立即提交。
 * 「⚡ 粘贴提交」按钮和全局快捷键 Ctrl+E 共用这一份实现。
 * 多行长文本 + 长文字段 → 批量拆行路径：ask 弹窗确认 / split 静默逐条 / whole 整段（现状）。
 */
export async function pasteSubmitField(f: FieldSchema) {
  try {
    const t = await navigator.clipboard.readText()
    if (!t || !t.trim()) {
      notify('剪贴板里没有文本', 'warn', 3000)
      return
    }
    const raw = t.trim()
    if (f.kind === 'textarea') {
      const lines = splitBatchLines(raw)
      if (lines.length >= 2) {
        if (batchTextMode.value === 'split') {
          f.value = raw
          submitBatchText(lines, f.key, f.label)
          return
        }
        if (batchTextMode.value === 'ask') {
          batchTextPending.value = { fieldKey: f.key, fieldLabel: f.label, lines, raw }
          return
        }
        // whole → 落到下面的整段提交
      }
    }
    f.value = raw
    submit()
    notify(`已粘贴并提交到「${f.label}」`, 'ok', 2000)
  } catch {
    notify('读取剪贴板失败，可手动 Ctrl+V 后再提交', 'warn', 4000)
  }
}

/** 当前表单全部字段值收成普通对象（JSON 可序列化，可塞进资产持久化） */
function collectParamsSnapshot(): Record<string, any> | undefined {
  if (!state.fields.length) return undefined
  const o: Record<string, any> = {}
  for (const f of state.fields) {
    o[f.key] = Array.isArray(f.value) ? [...f.value] : f.value
  }
  return o
}

// ------------------------------------------------ 参考图跨机转存 + 单任务派发

/** 转存去重缓存：key = `${value}|${workerId}`，值 = 进行中/已完成的转存 Promise；失败自动出缓存可重试 */
const transferCache = new Map<string, Promise<string>>()

/**
 * 确保一个图片引用（`sub/name`）在目标节点 input 里存在；不在就从它的上传源机器转存过去。
 * 源机 = 目标机（单机/同机）时零开销短路；同一 (value, worker) 并发派发共用同一个 Promise。
 */
async function ensureOnWorker(value: string, target: { id: string; base: string }): Promise<string> {
  const origin = imageOriginBase(value)
  if (origin === target.base) return value
  const ck = `${value}|${target.id}`
  const hit = transferCache.get(ck)
  if (hit) return hit
  const p = (async () => {
    // value = `sub/name`，从右往左切（嵌套子目录时最后一段是文件名）
    const i = value.lastIndexOf('/')
    const name = i >= 0 ? value.slice(i + 1) : value
    const sub = i >= 0 ? value.slice(0, i) : ''
    const res = await api.transferInput(origin, target.base, name, sub || undefined)
    const nname = String(res?.name ?? name)
    const nsub = String(res?.subfolder ?? sub ?? '')
    const nv = nsub ? `${nsub}/${nname}` : nname
    recordImageOrigin(nv, target.base)
    return nv
  })()
  transferCache.set(ck, p)
  try {
    return await p
  } catch (e) {
    transferCache.delete(ck)
    throw e
  }
}

/**
 * 派发一个任务到节点池：选机（least-busy / 手动指定）→ 参考图按需跨机转存 → 提交。
 * 提交或转存失败 → 该节点冷却 60s 并改派（首选 1 次 + 重派 2 轮）；全败抛出终止本链。
 * 工作流参数校验错（node_errors）也走同一条路——换一台装了对应模型的节点有可能直接成功。
 */
async function dispatchOne(
  values: Record<string, any>,
  preferredId: string,
  workflow: string | null,
  params?: Record<string, any>,
  reseed = false
): Promise<{ promptId: string; base: string; workerId: string; graph: any }> {
  const paramsJson = params ? JSON.stringify(params) : undefined
  let lastErr: unknown = null
  for (let round = 0; round < 3; round++) {
    const target = selectWorker(schedulableWorkers(), state.jobs, round === 0 ? preferredId : undefined)
    if (!target) {
      throw new Error(
        round ? '重派失败：已无可用计算节点（全部禁用或冷却中）' : '没有启用的计算节点'
      )
    }
    try {
      // 图片字段按需转存到目标机（patched 只覆盖 image/multiimage 两类，其余值原样）
      const patched: Record<string, any> = { ...values }
      for (const f of state.fields) {
        if (f.kind === 'image' && typeof values[f.key] === 'string' && values[f.key]) {
          patched[f.key] = await ensureOnWorker(values[f.key], target)
        } else if (f.kind === 'multiimage' && Array.isArray(values[f.key])) {
          const out: string[] = []
          for (const v of values[f.key]) {
            out.push(typeof v === 'string' && v ? await ensureOnWorker(v, target) : v)
          }
          patched[f.key] = out
        }
      }
      const graph = applyValues(state.graph, patched)
      if (reseed) randomizeHiddenSeeds(graph)
      const res = await api.submit(target.base, graph, workflow ?? undefined, paramsJson)
      const err = extractSubmitError(res, graph)
      if (err) throw new Error(err)
      // graph 一并带回：排队任务「改派」要用原图重新提交（store.requeueJob）
      return { promptId: String(res.prompt_id), base: target.base, workerId: target.id, graph }
    } catch (e) {
      lastErr = e
      cooldownWorker(target.id)
      notify(
        `节点「${workerName(target.base)}」派发失败，60 秒内不再派发，任务改派其他节点`,
        'warn',
        6000
      )
    }
  }
  throw lastErr ?? new Error('派发失败')
}

/** 一条提交链的执行体：busy 由链生命周期管理，计数归零才复位。
 *  批次/多图展开后逐任务经 dispatchOne 派发——单任务粒度分摊到节点池，
 *  某台失败冷却 60s 自动改派；其余（种子策略/收尾通知音效/busy 语义）与旧版一致。
 *  perItem（批量拆行提交用）：第 i 条派发前对 values 做最后覆盖（如提示词换成第 i 行），
 *  返回值作为该条独立的参数快照（不返回则沿用外层 params）——每条产出的「载入参数」各回各的行。 */
async function runChain(
  total: number,
  count: number,
  multiKey: string | undefined,
  imgs: string[],
  reroll: boolean,
  params?: Record<string, any>,
  perItem?: (i: number, values: Record<string, any>) => Record<string, any> | undefined
) {
  let ok = 0
  const done_ = [] as { base: string; promptId: string }[]
  const batchId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` // 批次分组标记
  try {
    for (let i = 0; i < total; i++) {
      const values = collectValues(state.fields.filter((f) => f.kind !== 'multiimage'))
      if (multiKey) values[multiKey] = imgs[Math.floor(i / count)] // 外层图片、内层批次
      const itemParams = perItem ? perItem(i, values) : params
      // 第 1 个任务沿用表单上的种子（可复现）；其余每个都全量换新种子，整批不重样
      const reseed = i > 0 || reroll
      const r = await dispatchOne(
        values,
        submitWorkerId.value,
        state.currentWorkflow,
        itemParams,
        reseed
      )
      ok++
      state.jobs.unshift({
        promptId: r.promptId,
        workflow: state.currentWorkflow ?? '',
        status: 'queued',
        value: 0,
        max: 0,
        startedAt: Date.now(),
        outputs: [],
        params: itemParams,
        workerId: r.workerId,
        base: r.base,
        graph: r.graph,
        batchId,
      })
      // 防内存膨胀：只清已结束的旧记录（保底 150 条）；排队/运行中的绝不截——
      // 截了 waitForJob 找不到记录会立刻按「已取消」收尾，onExecuting/onProgress
      // 也找不到宿主，产出不落资产 → 用户看到的就是「任务凭空消失像掉线」
      if (state.jobs.length > 300) {
        const finished = state.jobs.filter((j) => j.status !== 'queued' && j.status !== 'running')
        const excess = finished.length - 150
        if (excess > 0) {
          const victims = new Set(finished.slice(0, excess).map((j) => `${j.base}|${j.promptId}`))
          state.jobs = state.jobs.filter((j) => !victims.has(`${j.base}|${j.promptId}`))
        }
      }
      done_.push({ base: r.base, promptId: r.promptId })
      // 每提交一个批次任务就把表单种子换新：下一个批次 collectValues 拿到的就是新种子，
      // 表单上也随时显示新鲜种子（与「每批次提交后随机」一致）
      randomizeSeeds()
    }
    let done = 0
    if (done_.length) {
      const results = await Promise.all(done_.map(({ base, promptId }) => waitForJob(promptId, base)))
      done = results.filter(Boolean).length
    }
    if (ok > 0) {
      const allDone = done === total
      notify(
        allDone
          ? `已全部完成 ${total} 个任务`
          : `完成 ${done}/${total} 个任务（${ok - done} 个已提交未跑完）`,
        allDone ? 'ok' : 'warn',
        5000
      )
      // 全部完成且应用内队列已清空（没有其他链在跑）→ 完成音效（叮-叮-咚 ×3，约 10 秒）
      if (allDone && !state.jobs.some((j) => j.status === 'queued' || j.status === 'running')) {
        playChime(true)
      }
    }
  } catch (e) {
    notify(`提交失败：${e}`, 'error', 8000)
  } finally {
    activeChains--
    if (activeChains <= 0) {
      activeChains = 0
      state.busy = false
    }
  }
}

export async function interrupt() {
  try {
    // 只中断主节点当前任务（「全部中断」属 P2 范围）
    await api.interrupt(primaryBase())
    notify('已发送中断指令', 'info', 3000)
  } catch (e) {
    notify(`中断失败：${e}`, 'error')
  }
}

/** 每台启用节点的待处理数（refreshQueue 填充），队列头部悬停明细用 */
export const queueByBase = ref<Record<string, number>>({})

/** 历史兜底：WS 断连/丢「executing null」事件时，队列里的任务永远收不到收尾信号，
 *  产出就进不了结果区。每轮队列轮询时对 queued+running 的任务查一次 /history——
 *  有产出（finishJob 幂等，status done 自动跳过）就补入库；执行出错也标 error。
 *  queued 也查：恢复自持久化的任务若 WS 死着，状态永远停在 queued——history 里
 *  一旦出现条目（开跑后写入）就说明它有进展，跑完自然收尾。执行中 history 无条目，
 *  静默跳过无副作用。开销：每 4s 每个活动任务一个 history 请求，可忽略。 */
async function pollFinishJob(j: Job) {
  if (j.status !== 'running' && j.status !== 'queued') return
  const base = j.base ?? primaryBase()
  try {
    const res = await api.historyItem(base, j.promptId)
    const entry = res?.[j.promptId]
    if (!entry) {
      // 跑了超久（与 waitForJob 同为 2h）仍无 history 条目 → 判废，防永久卡 running
      if (j.status === 'running' && Date.now() - (j.execStartedAt ?? j.startedAt) > 2 * 3600_000) {
        j.status = 'error'
        j.error = '任务超过 2 小时无响应（服务端可能已重启清队列）'
        j.finishedAt = Date.now()
        removePendingRec(j.promptId, base) // 终态
      }
      return
    }
    if (entry.status?.status_str === 'error') {
      j.status = 'error'
      j.error = '执行出错（从历史记录补记）'
      j.finishedAt = Date.now()
      removePendingRec(j.promptId, base) // 终态
      return
    }
    await finishJob(j.promptId, base)
  } catch {
    /* 轮询失败静默：下一轮再试 */
  }
}

/** 已提示过「实时通道被拒」的节点（每节点每次会话只提示一次） */
const wsBlockedWarned = new Set<string>()

export async function refreshQueue() {
  const bases = enabledWorkers().map((w) => w.base)
  if (!bases.length && state.settings.baseUrl) bases.push(state.settings.baseUrl)
  if (!bases.length) return
  try {
    const qs = await Promise.all(bases.map((b) => api.queue(b).catch(() => null)))
    const detail: Record<string, number> = {}
    let total = 0
    bases.forEach((b, i) => {
      const q = qs[i]
      if (!q) return // 该节点不可达，跳过不拖累合计
      // HTTP 可达但 WS 一直连不上 → 新版 ComfyUI 的 Origin/Sec-Fetch-Site 校验
      // 把应用的网络通道拒了（WS 403、缩略图 403）。产出有 history 兜底不受影响，
      // 但实时进度/自动入库体验受损 → 指引用户加启动参数，每个节点只提示一次。
      if (healthOf(b) === 'down' && !wsBlockedWarned.has(b)) {
        wsBlockedWarned.add(b)
        notify(
          `节点「${workerName(b)}」可达但实时通道未连上：新版 ComfyUI 需在启动参数加 --enable-cors-header "*" 后重启 ComfyUI（否则缩略图不显示、进度不实时；产出仍有历史兜底）`,
          'warn',
          15000
        )
      }
      const n = (q?.queue_running?.length ?? 0) + (q?.queue_pending?.length ?? 0)
      detail[b] = n
      total += n
    })
    queueByBase.value = detail
    state.queueRemaining = total
  } catch {
    /* ignore */
  }
  // 历史兜底（见 pollFinishJob）：queued+running 都查（恢复的任务可能停在 queued）
  for (const j of state.jobs) {
    if (j.status === 'running' || j.status === 'queued') void pollFinishJob(j)
  }
}

/**
 * 移除一条队列记录：任务还在远端时先远端取消，再删本地记录。
 * 真相源在服务端（刷新后会按 /queue 恢复队列），只删本地的话一刷新记录就回来了。
 * - running → POST /interrupt（中断该节点当前正在跑的任务）
 * - queued  → POST /queue delete（从待队列摘除；若恰好已开跑则删不动，再点一次即可中断）
 * 任务被移除后 waitForJob 会按「任务不存在」正常返回，提交链不会卡死。
 */
export async function discardJob(job: Job) {
  const base = job.base ?? primaryBase()
  if (job.status === 'running') {
    try {
      await api.interrupt(base)
      notify('已中断该节点上的任务', 'info', 4000)
    } catch (e) {
      notify(`中断失败：${e}`, 'error', 8000)
    }
  } else if (job.status === 'queued') {
    try {
      await api.queueDelete(base, [job.promptId])
      notify('已从节点队列移除该任务', 'info', 4000)
    } catch (e) {
      notify(`取消失败：${e}`, 'error', 8000)
    }
  }
  const i = state.jobs.indexOf(job)
  if (i >= 0) state.jobs.splice(i, 1)
  removePendingRec(job.promptId, base) // 用户主动移除 = 索引同步删除
  void refreshQueue()
}

/**
 * 全部中断：对每台有活动任务的节点发 /interrupt（杀运行中），
 * 再按节点把本地已知的排队任务从远端队列批量摘除，最后清掉本地活动记录。
 * 只动应用内追踪的任务——不碰服务器上其他客户端提交的东西。
 * 本地记录移除后 waitForJob 按「任务不存在」正常返回，提交链不会卡死。
 */
export async function interruptAll() {
  const active = state.jobs.filter((j) => j.status === 'running' || j.status === 'queued')
  if (!active.length) {
    notify('没有进行中的任务', 'info', 3000)
    return
  }
  const byBase = new Map<string, { run: Job[]; queued: Job[] }>()
  for (const j of active) {
    const b = j.base ?? primaryBase()
    const e = byBase.get(b) ?? { run: [], queued: [] }
    ;(j.status === 'running' ? e.run : e.queued).push(j)
    byBase.set(b, e)
  }
  let stopped = 0
  let removed = 0
  const failed: string[] = []
  for (const [base, { run, queued }] of byBase) {
    if (run.length) {
      try {
        await api.interrupt(base)
        stopped += run.length
      } catch {
        failed.push(workerName(base))
      }
    }
    if (queued.length) {
      try {
        await api.queueDelete(
          base,
          queued.map((j) => j.promptId)
        )
        removed += queued.length
      } catch {
        failed.push(workerName(base))
      }
    }
  }
  for (const j of active) {
    const i = state.jobs.indexOf(j)
    if (i >= 0) state.jobs.splice(i, 1)
    removePendingRec(j.promptId, j.base ?? primaryBase()) // 全部中断 = 索引同步删除
  }
  void refreshQueue()
  if (failed.length) {
    notify(
      `已中断 ${stopped} 个、移除 ${removed} 个；这些节点操作失败：${failed.join('、')}`,
      'warn',
      8000
    )
  } else {
    notify(`已中断 ${stopped} 个运行中、移除 ${removed} 个排队任务`, 'ok', 5000)
  }
}

/**
 * 排队任务改派（慢节点拥堵时用）：从原节点 /queue 摘除 → 带提交时的原图 + 参数
 * 重新提交到 least-busy 的其他节点 → 换绑本地记录（workflow/params/产出历史全保留）。
 * graph 是提交时内存留存的（恢复来的任务取自服务器队列 extra_data），没 graph 的任务无法改派。
 * 已知边界：改派后的任务不在原提交链的等待列表里，不计入该链的完成音效统计（产出照常落资产）。
 */
export async function requeueJob(job: Job) {
  if (job.status !== 'queued') return
  if (!job.graph) {
    notify('这个任务没有留存提交数据，无法改派（可移除后重新提交）', 'warn', 6000)
    return
  }
  const from = job.base ?? primaryBase()
  const candidates = schedulableWorkers().filter((w) => w.base !== from)
  if (!candidates.length) {
    notify('没有其他可用节点可接手', 'warn', 5000)
    return
  }
  const target = selectWorker(candidates, state.jobs, 'auto')
  if (!target) {
    notify('其他节点都在冷却中，稍后再试', 'warn', 5000)
    return
  }
  try {
    await api.queueDelete(from, [job.promptId])
  } catch (e) {
    notify(`从原节点摘除失败：${e}`, 'error', 8000)
    return
  }
  try {
    const res = await api.submit(
      target.base,
      job.graph,
      job.workflow || undefined,
      job.params ? JSON.stringify(job.params) : undefined
    )
    const err = extractSubmitError(res, job.graph)
    if (err) throw new Error(err)
    const i = state.jobs.indexOf(job)
    if (i >= 0) state.jobs.splice(i, 1)
    state.jobs.unshift({
      ...job,
      promptId: String(res.prompt_id),
      base: target.base,
      workerId: target.id,
      status: 'queued',
      value: 0,
      max: 0,
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined,
      outputs: [],
      staleSince: undefined,
      // 自动改派 = 回自动调度：清除任务级 pin（pin 只由 pinJobToWorker 设置）
      pinnedWorkerId: undefined,
    })
    notify(`已改派到「${workerName(target.base)}」`, 'ok', 4000)
  } catch (e) {
    notify(`改派提交失败：${e}（原任务已从队列摘除，请重新提交）`, 'error', 8000)
  }
  void refreshQueue()
}

/**
 * 任务级指定节点（队列右键「必须在这台跑」，绕过自动调度）：
 * - 'auto'      → 清除指定（任务留在当前节点跑完，不再强制）
 * - 指定当前节点 → 只打 pin 标记，不动队列
 * - 指定其他节点 → 从原节点摘除（防竞态：摘除后核对 /queue，已开跑的让它跑完不改派）
 *   → 重新提交到目标机 → 换绑记录并打 pin。
 * pin 不参与 dispatchOne 自动调度；后续 requeueJob/retryJob 等任何重排都会清 pin 回自动。
 */
export async function pinJobToWorker(job: Job, workerId: string) {
  if (job.status !== 'queued') return
  if (workerId === 'auto') {
    if (job.pinnedWorkerId) {
      job.pinnedWorkerId = undefined
      notify('已恢复自动调度', 'ok', 3000)
    }
    return
  }
  const target = enabledWorkers().find((w) => w.id === workerId)
  if (!target) {
    notify('该节点不存在或已禁用', 'warn', 5000)
    return
  }
  if (job.base === target.base) {
    job.pinnedWorkerId = target.id
    notify(`已固定在「${workerName(target.base)}」`, 'ok', 3000)
    return
  }
  if (!job.graph) {
    notify('这个任务没有留存提交数据，无法指定到其他节点（可移除后重新提交）', 'warn', 6000)
    return
  }
  const from = job.base ?? primaryBase()
  try {
    await api.queueDelete(from, [job.promptId])
  } catch (e) {
    notify(`从原节点摘除失败：${e}`, 'error', 8000)
    return
  }
  // 核对摘除后的服务器现状：任务恰好开跑/完成就不动它（避免重复烧卡）
  try {
    const q = await api.queue(from)
    const rows = [...(q?.queue_pending ?? [])]
    const pendingIds = new Set(rows.map((r: any) => String(r?.[1] ?? '')).filter(Boolean))
    if (!pendingIds.has(job.promptId)) {
      notify('任务已开跑或已完成，未改派（等它跑完即可）', 'info', 5000)
      return
    }
  } catch {
    // 拉不到 /queue 就按「仍在队列」处理，与 promoteJob 的兜底一致
  }
  try {
    const res = await api.submit(
      target.base,
      job.graph,
      job.workflow || undefined,
      job.params ? JSON.stringify(job.params) : undefined
    )
    const err = extractSubmitError(res, job.graph)
    if (err) throw new Error(err)
    const i = state.jobs.indexOf(job)
    if (i >= 0) state.jobs.splice(i, 1)
    state.jobs.unshift({
      ...job,
      promptId: String(res.prompt_id),
      base: target.base,
      workerId: target.id,
      pinnedWorkerId: target.id,
      status: 'queued',
      value: 0,
      max: 0,
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined,
      outputs: [],
      staleSince: undefined,
    })
    notify(`已指定到「${workerName(target.base)}」`, 'ok', 4000)
  } catch (e) {
    notify(`提交失败：${e}（原任务已从队列摘除，请重新提交）`, 'error', 8000)
  }
  void refreshQueue()
}

/**
 * 失败任务一键重试：用任务留存的 graph + 参数原样重新提交（换节点不换种子，跑的就是当时那份）。
 * 与 requeueJob（改派排队任务）共用提交/替换记录的骨架，区别：
 * 面向已结束（error/cancelled）任务、无需从队列摘除旧项、派发范围是全部可用节点。
 */
export async function retryJob(job: Job) {
  if (job.status !== 'error' && job.status !== 'cancelled') return
  if (!job.graph) {
    notify('这个任务没有留存提交数据，无法重试（请重新提交）', 'warn', 6000)
    return
  }
  const target = selectWorker(schedulableWorkers(), state.jobs, 'auto')
  if (!target) {
    notify('没有可用节点（可能都在冷却中），稍后再试', 'warn', 5000)
    return
  }
  try {
    const res = await api.submit(
      target.base,
      job.graph,
      job.workflow || undefined,
      job.params ? JSON.stringify(job.params) : undefined
    )
    const err = extractSubmitError(res, job.graph)
    if (err) throw new Error(err)
    const i = state.jobs.indexOf(job)
    if (i >= 0) state.jobs.splice(i, 1)
    state.jobs.unshift({
      ...job,
      promptId: String(res.prompt_id),
      base: target.base,
      workerId: target.id,
      status: 'queued',
      value: 0,
      max: 0,
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined,
      outputs: [],
      staleSince: undefined,
      // 重试同样回自动调度：清除任务级 pin
      pinnedWorkerId: undefined,
    })
    notify('已重新提交', 'ok', 3000)
  } catch (e) {
    notify(`重试提交失败：${e}`, 'error', 8000)
  }
  void refreshQueue()
}

/**
 * 排队插队：让这个任务成为它所在节点的「下一个执行」。
 * ComfyUI 队列是 FIFO 且不支持优先级——做法：摘除该机全部 pending，
 * 按「目标 → 其余（原执行顺序）」立刻重新提交（提交顺序即队列顺序）。
 * 防重复烧卡：摘除瞬间某个任务可能刚好开跑/完成——先拉服务器 /queue 核对，
 * 只重新提交确认还在 pending 里的；已在 running 的让它继续跑，不动。
 */
export async function promoteJob(job: Job) {
  if (job.status !== 'queued') return
  if (!job.graph) {
    notify('这个任务没有留存提交数据，无法插队', 'warn', 6000)
    return
  }
  const base = job.base ?? primaryBase()
  const queued = state.jobs.filter(
    (j) => (j.base ?? primaryBase()) === base && j.status === 'queued'
  )
  if (queued.length < 2) {
    notify('该节点没有其他排队任务，无需插队', 'info', 4000)
    return
  }
  // 服务器执行顺序 = 提交顺序 = state.jobs 倒序（本地新的在前）；目标提到最前
  const ordered = [...queued].reverse()
  const plan = [job, ...ordered.filter((j) => j !== job)]
  try {
    await api.queueDelete(
      base,
      plan.map((j) => j.promptId)
    )
  } catch (e) {
    notify(`从节点摘除失败：${e}`, 'error', 8000)
    return
  }
  // 核对摘除后的服务器现状
  let pendingIds = new Set<string>()
  let runningIds = new Set<string>()
  try {
    const q = await api.queue(base)
    const ids = (rows: any[]) => new Set(rows.map((r) => String(r?.[1] ?? '')).filter(Boolean))
    pendingIds = ids([...(q?.queue_pending ?? [])])
    runningIds = ids([...(q?.queue_running ?? [])])
  } catch {
    // 拉不到就以「全部重新提交」为准（与旧行为一致）
    pendingIds = new Set(plan.map((j) => j.promptId))
  }
  const failed: string[] = []
  for (const j of plan) {
    if (runningIds.has(j.promptId)) continue // 竞态中已开跑：让它跑完，不重复提交
    if (!pendingIds.has(j.promptId)) continue // 已完成/不存在：跳过
    try {
      const res = await api.submit(
        base,
        j.graph,
        j.workflow || undefined,
        j.params ? JSON.stringify(j.params) : undefined
      )
      const err = extractSubmitError(res, j.graph)
      if (err) throw new Error(err)
      const i = state.jobs.indexOf(j)
      if (i >= 0) {
        state.jobs[i] = {
          ...j,
          promptId: String(res.prompt_id),
          status: 'queued',
          value: 0,
          max: 0,
          startedAt: Date.now(),
          finishedAt: undefined,
          error: undefined,
          outputs: [],
          staleSince: undefined,
        }
      }
    } catch {
      failed.push(j.workflow || j.promptId)
    }
  }
  void refreshQueue()
  if (failed.length) {
    notify(`插队时 ${failed.length} 个任务重新提交失败（可在队列里用 ↻ 重试）`, 'error', 8000)
  } else {
    notify(`已插队：「${job.workflow || '任务'}」将成为该节点下一个执行`, 'ok', 4000)
  }
}

// ---------------------------------------------------------------- 结果资产

const ASSETS_KEY = 'comfyui-studio.assets.v1'
const ASSETS_MAX = 500

/** key 带 base 前缀：不同节点的同名产出（ComfyUI_00001_.png）不会互相覆盖 */
function assetKey(base: string, o: { filename: string; subfolder: string; type: string }) {
  return `${base}|${o.type}/${o.subfolder}/${o.filename}`
}

/** 任务完成：把产出提升为独立资产（未读），并与 localStorage 同步 */
function addAssets(job: Job) {
  const base = job.base ?? primaryBase()
  let added = 0
  for (const o of job.outputs) {
    const key = assetKey(base, o)
    if (state.assets.some((a) => a.key === key)) continue
    state.assets.unshift({
      key,
      filename: o.filename,
      subfolder: o.subfolder,
      type: o.type,
      kind: o.kind,
      promptId: job.promptId,
      workflow: job.workflow,
      createdAt: Date.now(),
      read: false,
      pinned: false,
      params: job.params,
      base,
    })
    added++
  }
  if (state.assets.length > ASSETS_MAX) state.assets.length = ASSETS_MAX
  if (added) persistAssets()
}

function persistAssets() {
  try {
    localStorage.setItem(ASSETS_KEY, JSON.stringify(state.assets))
  } catch {
    /* 超限就放弃持久化，不影响使用 */
  }
}

/**
 * 手动添加一份资产（视频截帧等本机产生、不经过任务队列的图片）：
 * type=input（文件在 ComfyUI input/studio/ 下），workflow 标记来源便于筛选。
 */
export function addManualAsset(o: {
  base: string
  filename: string
  subfolder: string
  /** 截帧等「精心挑过的图」直接固定，不会被清空资产误删 */
  pinned?: boolean
}) {
  const key = assetKey(o.base, { filename: o.filename, subfolder: o.subfolder, type: 'input' })
  if (state.assets.some((a) => a.key === key)) return
  state.assets.unshift({
    key,
    filename: o.filename,
    subfolder: o.subfolder,
    type: 'input',
    kind: 'image',
    promptId: '',
    workflow: '视频截帧',
    createdAt: Date.now(),
    base: o.base,
    read: false,
    pinned: o.pinned ?? false,
  })
  persistAssets()
}

function restoreAssets() {
  try {
    const raw = localStorage.getItem(ASSETS_KEY)
    if (!raw) return
    const list = JSON.parse(raw)
    if (!Array.isArray(list)) return
    // 一次性迁移：旧条目无 base/key 无前缀 → 补主节点 base 并重写 key（撞 key 保留先到的）
    const fb = primaryBase()
    let migrated = false
    const seen = new Set<string>()
    const out: Asset[] = []
    for (const a of list) {
      if (!a || !a.key || !a.filename) continue
      if (!a.base) {
        a.base = fb
        migrated = true
      }
      if (!a.key.includes('|')) {
        const nk = assetKey(a.base, a)
        migrated = true
        if (seen.has(nk)) continue
        a.key = nk
      }
      seen.add(a.key)
      out.push(a)
    }
    state.assets = out
    if (migrated) persistAssets()
  } catch {
    /* ignore */
  }
}

/** 清空资产：固定的保留 */
export function clearAssets() {
  // 未读（还没看过的新产出）和固定的都不清，只清已看过的
  const kept = state.assets.filter((a) => a.pinned || !a.read)
  const removed = state.assets.length - kept.length
  state.assets = kept
  persistAssets()
  if (removed) notify(`已清空 ${removed} 个资产（未读、固定的保留）`, 'ok', 3000)
}

export function togglePinAsset(a: Asset) {
  a.pinned = !a.pinned
  persistAssets()
}

/** 重命名只改本地显示名；空字符串 = 恢复原始文件名 */
export function renameAsset(a: Asset, alias: string) {
  const name = alias.trim()
  if (name) a.alias = name
  else delete a.alias
  persistAssets()
}

/**
 * 把资产保存的参数快照回填到当前表单（key 相同的字段才命中，跨工作流也能命中同名输入）。
 * 命中后立即收进持久化缓存——缓存只在 buildFields 同步，直接改 f.value 不落盘的话
 * 400ms 防抖前刷新就会丢（阶段 18 的教训）。
 */
/** 返回命中的字段数（0 = 当前表单没有同名字段） */
export function applyAssetParams(a: Asset): number {
  if (!a.params) {
    notify('该资产没有参数快照（旧版本产出的）', 'warn')
    return 0
  }
  let n = 0
  for (const f of state.fields) {
    const v = a.params[f.key]
    if (v === undefined) continue
    f.value = Array.isArray(v) ? [...v] : v
    n++
  }
  snapshotFieldValues()
  if (n) {
    notify(`已载入「${a.alias || a.filename}」的参数（命中 ${n} 项）`, 'ok', 4000)
  } else {
    notify('当前表单没有匹配的字段（工作流可能不同）', 'warn', 5000)
  }
  return n
}

/**
 * 重跑这张图（灯箱径向菜单 / 右键菜单）：切到它的来源工作流 → 回填参数快照 →
 * 换新种子 → 提交 1 张。种子重掷保证不出和原图一样的结果。
 */
export async function rerunAsset(a: Asset) {
  if (!a.params) {
    notify('该资产没有参数快照（旧版本产出的），无法重跑', 'warn')
    return
  }
  // 跨工作流先切过去（selectWorkflow 会重建表单字段），同工作流直接回填
  if (a.workflow && a.workflow !== state.currentWorkflow) {
    await selectWorkflow(a.workflow)
  }
  if (state.currentWorkflow !== a.workflow) {
    notify(`切回工作流「${a.workflow}」失败，已取消重跑`, 'error', 6000)
    return
  }
  if (!applyAssetParams(a)) return // 一个字段都没命中 = 参数对不上，别拿当前表单误跑
  randomizeSeeds()
  submit(1)
}

/** 在放大预览里看过 → 已读 */
export function markAssetRead(a: Asset) {
  if (!a.read) {
    a.read = true
    persistAssets()
  }
}

/** 手动切换已读/未读（右键菜单用） */
export function toggleAssetRead(a: Asset) {
  a.read = !a.read
  persistAssets()
}

export function markAllAssetsRead() {
  let dirty = false
  for (const a of state.assets) {
    if (!a.read) {
      a.read = true
      dirty = true
    }
  }
  if (dirty) persistAssets()
}

export function removeAsset(a: Asset) {
  const i = state.assets.indexOf(a)
  if (i >= 0) state.assets.splice(i, 1)
  persistAssets()
}

// ---------------------------------------------------------------- 本地进程

export async function startLocal() {
  const dir = state.settings.comfyDir
  if (!dir) {
    notify('请先在设置里填写 ComfyUI 目录', 'warn')
    return
  }
  try {
    await api.startComfy(dir, state.settings.pythonPath, state.settings.launchArgs)
    notify('正在启动本地 ComfyUI…', 'info', 4000)
    // 启动后等几秒再探测连接
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      const ok = await checkConnection()
      if (ok) {
        notify('本地 ComfyUI 已就绪', 'ok')
        return
      }
    }
    notify('启动指令已发出，但 60 秒内没连上，请查看日志面板', 'warn', 8000)
  } catch (e) {
    notify(`启动失败：${e}`, 'error', 10000)
  }
}

export async function stopLocal() {
  try {
    await api.stopComfy()
    notify('已停止本地 ComfyUI', 'info')
    state.procRunning = false
  } catch (e) {
    notify(`停止失败：${e}`, 'error')
  }
}

let logOffset = 0
export async function fetchLogs(reset = false) {
  if (reset) logOffset = 0
  try {
    const r = await api.procLogs(logOffset)
    if (reset) state.logs = []
    state.logs.push(...(r.lines ?? []))
    if (state.logs.length > 1000) state.logs.splice(0, state.logs.length - 1000)
    logOffset = r.total ?? logOffset
  } catch {
    /* ignore */
  }
}

export function disposeAll() {
  for (const w of wss.values()) w.dispose()
  wss.clear()
  if (procTimer != null) {
    clearInterval(procTimer)
    procTimer = null
  }
  if (healthTimer != null) {
    clearInterval(healthTimer)
    healthTimer = null
  }
}
