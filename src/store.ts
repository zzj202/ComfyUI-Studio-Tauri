import { reactive, watch } from 'vue'
import { api } from './api/tauri'
import { ComfyWs } from './api/comfyWs'
import {
  applyValues,
  collectValues,
  parseGraph,
  randomSeed,
} from './core/parseWorkflow'
import { extractSubmitError, normalizeOutputs } from './core/errors'
import { ensureAudio, playChime } from './core/chime'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import type { Asset, FieldSchema, Job, ParamTemplate, WorkflowMeta } from './core/types'
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

let ws: ComfyWs | null = null
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

/** 把一份结果资产的工作流打开：优先输出目录直读，不行就下载到应用数据目录再解析 */
export async function openAssetWorkflow(a: Asset) {
  if (a.kind !== 'image') {
    notify('只有图片里才内嵌工作流', 'warn')
    return
  }
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
    await api.saveOutput(state.settings.baseUrl, a.filename, a.subfolder, a.type, tempPath)
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

// ---------------------------------------------------------------- 初始化

export async function init() {
  try {
    state.settings = await api.getSettings()
  } catch (e) {
    notify(`读取设置失败：${e}`, 'error')
  }
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
  pollProcStatus()
  state.ready = true
}

export async function loadWorkflows() {
  try {
    const r = await api.listWorkflows()
    state.workflows = r.workflows ?? []
  } catch (e) {
    notify(`读取工作流列表失败：${e}`, 'error')
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
    const stats = await api.systemStats(state.settings.baseUrl)
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
    const oi = await api.objectInfo(state.settings.baseUrl)
    state.objectInfo = oi
    buildFields() // 有了节点定义，控件类型和下拉选项会更准
  } catch {
    /* 拉不到就用启发式兜底，不影响使用 */
  }
}

function connectWs() {
  ws?.dispose()
  if (!state.settings.baseUrl) return
  ws = new ComfyWs(state.settings.baseUrl, 'comfyui-studio', {
    onOpen: () => {
      state.queueRemaining = state.queueRemaining // no-op，状态由 status 消息驱动
    },
    onStatus: ({ queueRemaining }) => {
      state.queueRemaining = queueRemaining
    },
    onProgress: ({ promptId, node, value, max }) => {
      const job = state.jobs.find((j) => j.promptId === promptId)
      if (!job) return
      job.status = 'running'
      job.value = value
      job.max = max
      if (node) job.node = node
    },
    onExecuting: ({ promptId, node }) => {
      if (!node) {
        // 该任务整体结束 → 去 /history 取产出
        finishJob(promptId)
      } else {
        const job = state.jobs.find((j) => j.promptId === promptId)
        if (job) {
          job.status = 'running'
          job.node = node
        }
      }
    },
    onError: ({ promptId, message }) => {
      const job = state.jobs.find((j) => j.promptId === promptId)
      if (job) {
        job.status = 'error'
        job.error = message
        job.finishedAt = Date.now()
      }
      notify(`任务出错：${message}`, 'error', 8000)
    },
  })
  ws.connect()
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

async function finishJob(promptId: string) {
  const job = state.jobs.find((j) => j.promptId === promptId)
  if (!job || job.status === 'done' || job.status === 'error') return
  try {
    const res = await api.historyItem(state.settings.baseUrl, promptId)
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

/** 等一个任务真正跑完（WS 驱动状态，这里轮询即可）：返回是否正常完成 */
function waitForJob(promptId: string, timeoutMs = 2 * 60 * 60 * 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = window.setInterval(() => {
      const job = state.jobs.find((j) => j.promptId === promptId)
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
export function submit(batch = 1) {
  ensureAudio() // 用户手势时机预热 AudioContext（完成音效需要）
  if (!state.graph) {
    notify('请先选择一个工作流', 'warn')
    return
  }
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
  void runChain(total, count, multi?.key, imgs, reroll)
}

/** 一条提交链的执行体：busy 由链生命周期管理，计数归零才复位 */
async function runChain(
  total: number,
  count: number,
  multiKey: string | undefined,
  imgs: string[],
  reroll: boolean
) {
  let ok = 0
  const ids: string[] = []
  try {
    // 整批一次性入队：不等前一个跑完，ComfyUI 自己串行执行（队列面板立刻能看到排队）
    for (let i = 0; i < total; i++) {
      const values = collectValues(state.fields.filter((f) => f.kind !== 'multiimage'))
      if (multiKey) values[multiKey] = imgs[Math.floor(i / count)] // 外层图片、内层批次
      const graph = applyValues(state.graph, values)
      // 第 1 个任务沿用表单上的种子（可复现）；其余每个都全量换新种子，整批不重样
      if (i > 0 || reroll) randomizeHiddenSeeds(graph)
      const res = await api.submit(state.settings.baseUrl, graph)
      const err = extractSubmitError(res, graph)
      if (err) {
        notify(err, 'error', 12000)
        break
      }
      ok++
      state.jobs.unshift({
        promptId: res.prompt_id,
        workflow: state.currentWorkflow ?? '',
        status: 'queued',
        value: 0,
        max: 0,
        startedAt: Date.now(),
        outputs: [],
      })
      if (state.jobs.length > 50) state.jobs.length = 50
      ids.push(res.prompt_id)
      // 每提交一个批次任务就把表单种子换新：下一个批次 collectValues 拿到的就是新种子，
      // 表单上也随时显示新鲜种子（与「每批次提交后随机」一致）
      randomizeSeeds()
    }
    let done = 0
    if (ids.length) {
      const results = await Promise.all(ids.map((id) => waitForJob(id)))
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
    await api.interrupt(state.settings.baseUrl)
    notify('已发送中断指令', 'info', 3000)
  } catch (e) {
    notify(`中断失败：${e}`, 'error')
  }
}

export async function refreshQueue() {
  try {
    const q = await api.queue(state.settings.baseUrl)
    state.queueRemaining = (q?.queue_running?.length ?? 0) + (q?.queue_pending?.length ?? 0)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- 结果资产

const ASSETS_KEY = 'comfyui-studio.assets.v1'
const ASSETS_MAX = 500

function assetKey(o: { filename: string; subfolder: string; type: string }) {
  return `${o.type}/${o.subfolder}/${o.filename}`
}

/** 任务完成：把产出提升为独立资产（未读），并与 localStorage 同步 */
function addAssets(job: Job) {
  let added = 0
  for (const o of job.outputs) {
    const key = assetKey(o)
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
    if (Array.isArray(list)) state.assets = list.filter((a: any) => a && a.key && a.filename)
  } catch {
    /* ignore */
  }
}

/** 清空资产：固定的保留 */
export function clearAssets() {
  const kept = state.assets.filter((a) => a.pinned)
  const removed = state.assets.length - kept.length
  state.assets = kept
  persistAssets()
  if (removed) notify(`已清空 ${removed} 个资产（固定的保留）`, 'ok', 3000)
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
  ws?.dispose()
  ws = null
  if (procTimer != null) {
    clearInterval(procTimer)
    procTimer = null
  }
}
