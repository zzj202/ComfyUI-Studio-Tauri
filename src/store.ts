import { reactive, ref, watch } from 'vue'
import { api } from './api/tauri'
import { ComfyWs } from './api/comfyWs'
import {
  applyValues,
  collectValues,
  parseGraph,
  randomSeed,
} from './core/parseWorkflow'
import { extractSubmitError, normalizeOutputs } from './core/errors'
import { cooldownWorker, selectWorker } from './core/scheduler'
import { ensureAudio, playChime } from './core/chime'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import type { Asset, FieldSchema, Job, ParamTemplate, WorkflowMeta, WorkerProfile } from './core/types'
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
  }
  dragGhost.x = e.clientX
  dragGhost.y = e.clientY
}

function onDragUp(e: PointerEvent) {
  window.removeEventListener('pointermove', onDragMove)
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

/** 把一份结果资产的工作流打开：优先输出目录直读，不行就下载到应用数据目录再解析。
 *  视频和图片走同一条链路——ComfyUI 的视频产物同样内嵌 API 图（Rust 侧二进制扫描能捞到） */
export async function openAssetWorkflow(a: Asset) {
  async function openImported(name: string) {
    await loadWorkflows()
    await selectWorkflow(name)
    notify(`已打开工作流「${name}」`, 'ok', 5000)
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

async function pingAllNodes() {
  const list = enabledWorkers()
  await Promise.all(
    list.map(async (w) => {
      try {
        await api.systemStats(w.base)
        setHealth(w.base, 'up')
      } catch {
        setHealth(w.base, 'down')
      }
    })
  )
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
          const params =
            extra && typeof extra === 'object' && extra.params && typeof extra.params === 'object'
              ? (extra.params as Record<string, any>)
              : undefined
          state.jobs.unshift({
            promptId,
            workflow: String(extra?.workflow_name ?? '刷新前的任务'),
            status,
            value: 0,
            max: nodeCount,
            startedAt: Date.now(),
            outputs: [],
            params,
            base,
            workerId: id || undefined,
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
}

export async function loadWorkflows() {
  try {
    const r = await api.listWorkflows()
    state.workflows = r.workflows ?? []
    sortWorkflowsByOrder()
  } catch (e) {
    notify(`读取工作流列表失败：${e}`, 'error')
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
        // 实时维护每节点明细（队列头悬停 tooltip 用）
        queueByBase.value = { ...queueByBase.value, [base]: queueRemaining }
        let total = 0
        for (const [b, n] of perBaseQueue) {
          if (wss.has(b)) total += n // 已从节点池删除的不计入
        }
        state.queueRemaining = total
        // 该机队列已空 → 应用内还挂在它名下的 queued/running 就是幽灵任务，安排清理
        if (queueRemaining === 0) {
          window.clearTimeout(reapTimer)
          reapTimer = window.setTimeout(() => void reapStaleJobs(base), 1500)
        }
      },
      onProgress: ({ promptId, node, value, max }) => {
        const job = state.jobs.find((j) => j.base === base && j.promptId === promptId)
        if (!job) return
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
        notify(`任务出错：${message}`, 'error', 8000)
      },
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
      job.outputs = normalizeOutputs(entry)
      job.status = 'done'
      job.value = job.max || 1
      job.finishedAt = Date.now()
      addAssets(job)
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
  } catch (e) {
    job.status = 'error'
    job.error = String(e)
  }
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
    const timer = window.setInterval(() => {
      const job = state.jobs.find((j) => j.base === base && j.promptId === promptId)
      if (!job || job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
        clearInterval(timer)
        resolve(job?.status === 'done')
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        resolve(false)
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

/**
 * 一键粘贴提交：读剪贴板文本覆盖填入指定文本字段，按当前批次设置立即提交。
 * 「⚡ 粘贴提交」按钮和全局快捷键 Ctrl+E 共用这一份实现。
 */
export async function pasteSubmitField(f: FieldSchema) {
  try {
    const t = await navigator.clipboard.readText()
    if (!t || !t.trim()) {
      notify('剪贴板里没有文本', 'warn', 3000)
      return
    }
    f.value = t.trim()
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
 *  某台失败冷却 60s 自动改派；其余（种子策略/收尾通知音效/busy 语义）与旧版一致。 */
async function runChain(
  total: number,
  count: number,
  multiKey: string | undefined,
  imgs: string[],
  reroll: boolean,
  params?: Record<string, any>
) {
  let ok = 0
  const done_ = [] as { base: string; promptId: string }[]
  try {
    for (let i = 0; i < total; i++) {
      const values = collectValues(state.fields.filter((f) => f.kind !== 'multiimage'))
      if (multiKey) values[multiKey] = imgs[Math.floor(i / count)] // 外层图片、内层批次
      // 第 1 个任务沿用表单上的种子（可复现）；其余每个都全量换新种子，整批不重样
      const reseed = i > 0 || reroll
      const r = await dispatchOne(
        values,
        submitWorkerId.value,
        state.currentWorkflow,
        params,
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
        params,
        workerId: r.workerId,
        base: r.base,
        graph: r.graph,
      })
      if (state.jobs.length > 50) state.jobs.length = 50
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
      const n = (q?.queue_running?.length ?? 0) + (q?.queue_pending?.length ?? 0)
      detail[b] = n
      total += n
    })
    queueByBase.value = detail
    state.queueRemaining = total
  } catch {
    /* ignore */
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
    })
    notify(`已改派到「${workerName(target.base)}」`, 'ok', 4000)
  } catch (e) {
    notify(`改派提交失败：${e}（原任务已从队列摘除，请重新提交）`, 'error', 8000)
  }
  void refreshQueue()
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
