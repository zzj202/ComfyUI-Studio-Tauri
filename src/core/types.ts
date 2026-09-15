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
  /** `${type}/${subfolder}/${filename}`，同一份产出唯一 */
  key: string
  filename: string
  subfolder: string
  type: string
  kind: OutputItem['kind']
  promptId: string
  workflow: string
  createdAt: number
  /** 未读：新产出还没在放大预览里看过 */
  read: boolean
  /** 固定：排在最前，且「清空资产」不会清掉它 */
  pinned: boolean
  /** 本地重命名的显示名；空 = 用原始文件名 */
  alias?: string
}
