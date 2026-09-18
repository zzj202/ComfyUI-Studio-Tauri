export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'seed'
  | 'select'
  | 'toggle'
  | 'image'
  | 'multiimage'

export type FieldAction = 'randomize' | 'clear' | 'step'

/** 一个可编辑参数（由工作流节点输入推导而来） */
export interface FieldSchema {
  /** `${nodeId}::${inputName}`，全局唯一 */
  key: string
  nodeId: string
  inputName: string
  classType: string
  /** 分组名，默认取节点标题 */
  group: string
  label: string
  kind: FieldKind
  order: number
  value: any
  options?: string[]
  min?: number
  max?: number
  step?: number
  placeholder?: string
  /** 该输入在 /object_info 里的原始定义，定制编辑器里改控件类型时要用 */
  spec?: any
  /** ---- 以下为定制模板覆盖项（通用模式下为空） ---- */
  /** 行号：相同行号的参数强制排在同一行；空 = 自动流式排布 */
  row?: number | null
  /** 附加功能按钮 */
  actions?: FieldAction[]
  /** 预设值：点击一键填入 */
  presets?: string[]
  /** 节点标题里写的排序号（排序最优先，且相同数字同行） */
  titleNum?: number
  /** 标题带约定标记（数字/功能词/预设/+）→ 通用模式下显示；未标记的默认隐藏 */
  marked?: boolean
  /** 交换对（标题 `交换:A,B`）：按钮把 A 换成 B、B 换成 A */
  swap?: [string, string] | null
}

/** 定制模板里的字段绑定（覆盖自动推导结果） */
export interface FieldBinding {
  key: string
  label: string
  kind: FieldKind
  group: string
  order: number
  visible: boolean
  options?: string[]
  min?: number
  max?: number
  step?: number
  placeholder?: string
  /** 行号：相同行号的参数排同一行；不填 = 自动流式 */
  row?: number | null
  /** 附加功能按钮 */
  actions?: FieldAction[]
  /** 预设值，一键填入 */
  presets?: string[]
  /** 交换对（标题 `交换:A,B`） */
  swap?: [string, string] | null
}

export interface ParamTemplate {
  name: string
  _file?: string
  /** 关联的工作流名 */
  workflow: string
  /** auto = 通用模式（全部字段自动展示）；custom = 定制模式（按 fields 渲染） */
  mode: 'auto' | 'custom'
  description?: string
  fields: FieldBinding[]
  updatedAt?: number
}

export interface WorkflowMeta {
  name: string
  nodeCount: number
  hasMeta: boolean
  broken?: boolean
  size: number
  updatedAt: number
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

/** 一个计算节点（远程 ComfyUI 实例）配置 */
export interface WorkerProfile {
  /** 稳定随机 id（派发/冷却/负载计数的 key，与 base 解耦——同 base 双 profile 不互相污染） */
  id: string
  /** 显示名，如「4090 工作站」「默认节点」 */
  name: string
  /** 服务地址，如 http://192.168.1.10:8188 或 https://反代域名 */
  base: string
  enabled: boolean
  /** 反代鉴权等自定义请求头（预留，本期 UI 不编辑） */
  headers?: Record<string, string>
  /** 权重（预留；least-busy 并列时作次级排序） */
  weight: number
}

export interface Job {
  promptId: string
  workflow: string
  status: JobStatus
  value: number
  max: number
  node?: string
  startedAt: number
  finishedAt?: number
  error?: string
  outputs: OutputItem[]
  /** 提交时的参数快照（key → 字段值），完成时随产出写入资产 */
  params?: Record<string, any>
  /** 派发到的计算节点 id（刷新恢复的旧任务可能没有） */
  workerId?: string
  /** 冗余存产出机器的 base：节点被删/改名后仍能收尾、下载、查历史（WS/对账按它路由） */
  base?: string
  /** 首次发现不在服务器队列的时间（幽灵任务两轮确认用，内部字段） */
  staleSince?: number
  /** 提交时的完整 prompt 图（仅内存留存）：排队任务「改派」到其他节点时带原图重新提交 */
  graph?: any
}

export interface OutputItem {
  nodeId: string
  filename: string
  subfolder: string
  type: string
  kind: 'image' | 'video' | 'audio'
}

/** 结果资产：任务产出提升成的独立列表项（队列记录删了它也还在） */
export interface Asset {
  /** `${base}|${type}/${subfolder}/${filename}`，同一份产出唯一（base 前缀防跨机同名互撞） */
  key: string
  filename: string
  subfolder: string
  type: string
  kind: OutputItem['kind']
  promptId: string
  workflow: string
  createdAt: number
  /** 产出所在机器的 base：预览 <img> 与下载按它回源（旧数据迁移时补主节点 base） */
  base?: string
  /** 未读：新产出还没在放大预览里看过 */
  read: boolean
  /** 固定：排在最前，且「清空资产」不会清掉它 */
  pinned: boolean
  /** 本地重命名的显示名；空 = 用原始文件名 */
  alias?: string
  /** 提交时的参数快照（key → 字段值），灯箱「载入参数」一键回填表单用 */
  params?: Record<string, any>
}
