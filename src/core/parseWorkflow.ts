import type { FieldKind, FieldSchema } from './types'
import { parseTitle } from './titleSyntax'

/**
 * 把 API 格式的工作流 JSON 解析成可编辑参数列表。
 *
 * 三层识别优先级：
 * 1. 定制模板绑定（buildFields 里覆盖）
 * 2. 节点标题约定（`10 宽度`、`图:参考图`、`~隐藏`、`=预设1|预设2`，见 titleSyntax.ts）
 * 3. 有 /object_info（连着服务器时）→ 用节点定义精确推导控件类型、取值范围、下拉选项
 *    没有 /object_info（离线导入）→ 用「输入名启发式 + 值的 JS 类型」兜底
 * 这样任何通用工作流都能立刻得到一个能用的表单，不依赖服务器在线。
 */

/** 被上游节点连线占用的输入：值是 [nodeId, slot] */
function isWired(v: any): boolean {
  return Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number')
}

/** ComfyUI 的纯前端控件，不参与出图，且不出现在 API 图里，兜底过滤 */
const IGNORED_INPUTS = new Set([
  'control_after_generate',
  'control_before_generate',
  'unique_id',
  'ue_version',
])

const NAME_RANGES: Record<string, { min: number; max: number; step: number }> = {
  steps: { min: 1, max: 150, step: 1 },
  cfg: { min: 0, max: 30, step: 0.5 },
  denoise: { min: 0, max: 1, step: 0.01 },
  width: { min: 64, max: 8192, step: 8 },
  height: { min: 64, max: 8192, step: 8 },
  batch_size: { min: 1, max: 64, step: 1 },
  clip_skip: { min: -24, max: 0, step: 1 },
  frame_rate: { min: 1, max: 60, step: 1 },
  length: { min: 1, max: 4096, step: 1 },
  strength: { min: 0, max: 2, step: 0.01 },
  strength_model: { min: 0, max: 2, step: 0.01 },
  strength_clip: { min: 0, max: 2, step: 0.01 },
  lora_strength: { min: 0, max: 2, step: 0.01 },
  guidance: { min: 0, max: 100, step: 0.5 },
}

// 注意：这里**不能**包含 prefix —— filename_prefix 是自由输入的路径前缀，
// 一旦识别成下拉框，用户就没法自己改输出目录了。
const SELECT_BY_NAME = /(_name|sampler|scheduler|model|vae|lora|control_net|upscale|format|dtype)$/i

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i

export function isApiGraph(g: any): boolean {
  if (!g || typeof g !== 'object' || Array.isArray(g)) return false
  return Object.values(g).some((n: any) => n && typeof n === 'object' && n.class_type)
}

/** 解析入口 */
export function parseGraph(graph: any, objectInfo?: Record<string, any> | null): FieldSchema[] {
  const nodes = Object.entries<any>(graph ?? {}).filter(
    ([, n]) => n && typeof n === 'object' && n.class_type
  )
  if (!nodes.length) return []

  // nodeId → 引用它的输入名集合（用来判断正向/负向提示词）
  const refs = new Map<string, Set<string>>()
  for (const [, node] of nodes) {
    for (const [inputName, raw] of Object.entries<any>(node.inputs ?? {})) {
      if (!isWired(raw)) continue
      const target = String(raw[0])
      if (!refs.has(target)) refs.set(target, new Set())
      refs.get(target)!.add(inputName)
    }
  }

  const fields: FieldSchema[] = []
  nodes.forEach(([nodeId, node], nodeIndex) => {
    const classType = String(node.class_type)
    const def = objectInfo?.[classType]
    const rawTitle = typeof node._meta?.title === 'string' ? node._meta.title : node.title
    // 节点标题约定：`~隐藏` `数字排序/同行` `功能词:控件` `=预设`（见 titleSyntax.ts）
    const info = parseTitle(typeof rawTitle === 'string' ? rawTitle : '')
    if (info.hidden) return // 标题以 ~ 开头：整个节点不进表单
    const refNames = refs.get(nodeId) ?? new Set<string>()
    const group = info.label || (typeof rawTitle === 'string' && rawTitle) || classType

    // 可编辑输入（未被连线占用、不是忽略项、不是复杂结构）
    const editable = Object.entries<any>(node.inputs ?? {}).filter(
      ([inputName, raw]) =>
        !IGNORED_INPUTS.has(inputName) && !isWired(raw) && (raw === null || typeof raw !== 'object')
    )

    for (const [inputName, raw] of editable) {
      const spec =
        def?.input?.required?.[inputName] ?? def?.input?.optional?.[inputName] ?? null

      const field = buildField({
        nodeId,
        inputName,
        classType,
        group,
        raw,
        spec,
        refNames,
        nodeIndex,
      })
      if (!field) continue

      // 标题约定覆盖自动推断（模板绑定之后在 buildFields 里还能再覆盖一层）
      // 显示名只在节点只有一个可编辑输入时生效，多输入节点保留输入名、标题作分组名
      if (info.label && editable.length === 1) field.label = info.label
      if (info.kindHint) field.kind = info.kindHint
      if (info.num != null) {
        field.row = info.num // 相同数字 → 同一行
        field.titleNum = info.num
      }
      if (info.presets) field.presets = info.presets
      if (info.swap) field.swap = info.swap
      // 多图节点的值是服务器文件名列表（把现有单值转成列表初始项）
      if (field.kind === 'multiimage') {
        field.value = field.value == null || field.value === '' ? [] : [String(field.value)]
      }
      // 通用模式只显示带标记的节点（默认不暴露），模板编辑器里可以看到全部
      field.marked = info.exposed

      fields.push(field)
    }
  })

  return sortFields(fields)
}

interface BuildCtx {
  nodeId: string
  inputName: string
  classType: string
  group: string
  raw: any
  spec: any
  refNames: Set<string>
  nodeIndex: number
}

function base(ctx: BuildCtx): FieldSchema {
  return {
    key: `${ctx.nodeId}::${ctx.inputName}`,
    nodeId: ctx.nodeId,
    inputName: ctx.inputName,
    classType: ctx.classType,
    group: ctx.group,
    label: ctx.inputName,
    kind: 'text',
    order: ctx.nodeIndex * 1000,
    value: ctx.raw,
    spec: ctx.spec,
  }
}

function buildField(ctx: BuildCtx): FieldSchema | null {
  const f = base(ctx)
  const name = ctx.inputName

  // ---------- 1) 有 /object_info 定义：精确推导 ----------
  if (ctx.spec) {
    const [type, opts] = Array.isArray(ctx.spec) ? ctx.spec : [null, {}]
    const o = opts ?? {}

    if (Array.isArray(type)) {
      f.kind = 'select'
      f.options = type.map((x) => String(x))
      f.value = ctx.raw == null ? (f.options[0] ?? '') : String(ctx.raw)
      return f
    }
    if (type === 'BOOLEAN') {
      f.kind = 'toggle'
      f.value = !!ctx.raw
      return f
    }
    if (type === 'INT' || type === 'FLOAT') {
      f.kind = name === 'seed' || name === 'noise_seed' ? 'seed' : 'number'
      f.min = typeof o.min === 'number' ? o.min : undefined
      f.max = typeof o.max === 'number' ? o.max : undefined
      f.step = typeof o.step === 'number' ? o.step : type === 'INT' ? 1 : 0.01
      f.value = Number(ctx.raw ?? 0)
      return f
    }
    if (type === 'STRING') {
      if (o.multiline) {
        f.kind = 'textarea'
        f.placeholder = o.placeholder ?? ''
      } else {
        f.kind = 'text'
      }
      f.value = ctx.raw == null ? '' : String(ctx.raw)
      applyPromptLabel(f, ctx)
      return f
    }
    if (type === 'IMAGEUPLOAD') {
      f.kind = 'image'
      f.value = ctx.raw ? String(ctx.raw) : ''
      return f
    }
  }

  // ---------- 2) 无定义：命名启发式 ----------
  if (name === 'seed' || name === 'noise_seed') {
    f.kind = 'seed'
    f.min = 0
    f.max = 0xffffffff
    f.step = 1
    f.value = Number(ctx.raw ?? 0)
    return f
  }
  if (NAME_RANGES[name]) {
    f.kind = 'number'
    Object.assign(f, NAME_RANGES[name])
    f.value = Number(ctx.raw ?? 0)
    return f
  }
  // 未连线的 image 类输入必然是服务器上的图片文件名（LoadImage / LoadImageMask / ref_image 等）
  const rawStr = String(ctx.raw ?? '')
  if (name === 'image' || (name.includes('image') && IMAGE_EXT.test(rawStr))) {
    f.kind = 'image'
    f.value = ctx.raw == null ? '' : rawStr
    return f
  }
  if (SELECT_BY_NAME.test(name) && typeof ctx.raw === 'string') {
    f.kind = 'select'
    f.options = [ctx.raw]
    f.value = ctx.raw
    return f
  }

  // ---------- 3) 按 JS 值类型兜底 ----------
  if (typeof ctx.raw === 'boolean') {
    f.kind = 'toggle'
    return f
  }
  if (typeof ctx.raw === 'number') {
    f.kind = 'number'
    f.value = ctx.raw
    return f
  }
  if (typeof ctx.raw === 'string') {
    if (ctx.raw.length > 90 || ctx.raw.includes('\n')) {
      f.kind = 'textarea'
    } else {
      f.kind = 'text'
    }
    applyPromptLabel(f, ctx)
    return f
  }
  return null
}

/** CLIPTextEncode 之类：根据谁引用了它，判断是正向还是负向提示词 */
function applyPromptLabel(f: FieldSchema, ctx: BuildCtx) {
  if (f.kind !== 'textarea') return
  if (ctx.classType !== 'CLIPTextEncode') {
    if (ctx.refNames.size === 0) f.placeholder = f.placeholder || '提示词'
    return
  }
  if (ctx.refNames.has('negative')) f.label = '负向提示词'
  else if (ctx.refNames.has('positive')) f.label = '正向提示词'
  else f.placeholder = f.placeholder || '提示词'
}

/** 排序：标题写了数字的按数字置顶 → 其余提示词置顶 → seed → 按节点顺序 */
function sortFields(fields: FieldSchema[]): FieldSchema[] {
  const rank = (f: FieldSchema) => {
    if (f.kind === 'textarea') return 0
    if (f.kind === 'seed') return 1
    if (f.kind === 'select') return 2
    if (f.kind === 'number') return 3
    return 4
  }
  return [...fields].sort((a, b) => {
    // 标题约定写了数字的：完全按数字排（显式意图压过「提示词置顶」启发式）
    const na = a.titleNum ?? Number.POSITIVE_INFINITY
    const nb = b.titleNum ?? Number.POSITIVE_INFINITY
    if (na !== nb) return na - nb
    if (na === Number.POSITIVE_INFINITY) {
      const r = rank(a) - rank(b)
      if (r !== 0) return r
    }
    return a.order - b.order
  })
}

/** 按 group 聚合成「分组 → 字段数组」，并保持排序 */
export function groupFields(fields: FieldSchema[]): { group: string; fields: FieldSchema[] }[] {
  const map = new Map<string, FieldSchema[]>()
  for (const f of fields) {
    if (!map.has(f.group)) map.set(f.group, [])
    map.get(f.group)!.push(f)
  }
  return [...map.entries()].map(([group, list]) => ({ group, fields: list }))
}

/**
 * 把表单值写回工作流（深拷贝，不污染原图）。
 * 只覆盖出现在 values 里的字段，其余保持原样。
 */
export function applyValues(graph: any, values: Record<string, any>): any {
  const out = JSON.parse(JSON.stringify(graph ?? {}))
  for (const [key, value] of Object.entries(values)) {
    const idx = key.indexOf('::')
    if (idx < 0) continue
    const nodeId = key.slice(0, idx)
    const inputName = key.slice(idx + 2)
    const node = out?.[nodeId]
    if (!node || !node.inputs) continue
    // 该输入被连线占用时不覆盖（防止把图改坏）
    if (isWired(node.inputs[inputName])) continue
    node.inputs[inputName] = value
  }
  return out
}

export function collectValues(fields: FieldSchema[]): Record<string, any> {
  const values: Record<string, any> = {}
  for (const f of fields) values[f.key] = f.value
  return values
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff)
}

export const KIND_LABELS: Record<FieldKind, string> = {
  text: '单行文本',
  textarea: '多行文本',
  number: '数字',
  seed: '随机种子',
  select: '下拉选择',
  toggle: '开关',
  image: '图片',
  multiimage: '多图上传',
}
