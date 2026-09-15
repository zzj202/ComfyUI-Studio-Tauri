import type { FieldKind } from './types'

/**
 * 节点标题约定 —— 把界面配置直接写进 ComfyUI 的节点标题里，
 * 平台识别后自动生效，免去手动配置模板。
 *
 * **默认所有节点都不暴露**；标题里带任一约定标记（用 | 分隔，位置任意）的节点才显示：
 *
 *   显示名 | 标识 | 标识 | ...
 *
 * 标识（token，不区分大小写）：
 *   ~              彻底隐藏（连模板编辑器里都不出现）
 *   数字            暴露 + 排序号；相同数字的输入排成一行（跨节点也生效）
 *   +              暴露但不编号（排在带数字的后面）
 *   图/图片/上传    暴露 + 图片上传卡
 *   多图/多张       暴露 + 多图上传（多张图各跑一次，图数 × 批次 = 提交数）
 *   种子/随机       暴露 + 随机种子
 *   长文/长文本/多行 暴露 + 多行文本
 *   数字(词)        暴露 + 数字控件（纯数字 token 是排序号，汉字「数字」是控件）
 *   选择/下拉       暴露 + 下拉
 *   开关/切换       暴露 + 开关
 *   文本           暴露 + 单行文本
 *   预设:a,b,c     暴露 + 预设值（点一下一键填入；也支持 =a,b,c）
 *   交换:A,B       暴露 + ⇄ 交换按钮（两个文本框内容互换；只写交换没写功能词时默认按长文）
 *
 * 示例：
 *   提示词|1|长文        → 暴露，排序 1，多行文本
 *   人脸参考|5|图        → 暴露，排序 5，图片上传卡
 *   参考图|多图          → 暴露，多图上传（图数 × 批次 = 提交数）
 *   尺寸|10             → 暴露，排序 10（该节点多个输入并排一行）
 *   步数|20|预设:20,25,30 → 暴露，排序 20，预设值
 *   负面词|3|长文|交换:正,反 → 暴露，多行文本 + ⇄ 交换按钮
 *   批量大小|+           → 暴露，不编号
 *   调试参数|~           → 彻底隐藏
 *   KSampler（无标记）   → 不暴露
 *
 * 兼容旧前缀写法：`10 宽度`（数字+分隔符开头）、`图:人脸参考`（功能词+冒号开头）仍可用。
 * 显示名本身不要包含 |（会被当成标识分隔符）。
 *
 * 优先级：定制模板 > 节点标题约定 > 自动推断。
 */

export interface TitleInfo {
  /** 标题带 ~ 标识 → 彻底隐藏 */
  hidden: boolean
  /** 带任一约定标识（数字/功能词/预设/+）→ 暴露；否则默认不显示 */
  exposed: boolean
  /** 排序号（同时用作同行号），没写数字为 null */
  num: number | null
  /** 功能词强制指定的控件类型 */
  kindHint: FieldKind | null
  /** 去掉标识后的显示名（可能为空，空则沿用原显示逻辑） */
  label: string
  /** 预设值 */
  presets: string[] | null
  /** 交换对（`交换:A,B`）：按钮把 A 换成 B、B 换成 A */
  swap: [string, string] | null
}

const EMPTY: TitleInfo = {
  hidden: false,
  exposed: false,
  num: null,
  kindHint: null,
  label: '',
  presets: null,
  swap: null,
}

/** 功能词别名 → 控件类型（完整 token 精确匹配） */
const KIND_ALIASES: [string, FieldKind][] = [
  // 中文别名，长词在前（供冒号前缀的正则交替使用，防止「图片:x」被拆成「图」+「片:x」）
  ['图片', 'image'],
  ['多图', 'multiimage'],
  ['多张', 'multiimage'],
  ['长文本', 'textarea'],
  ['上传', 'image'],
  ['随机', 'seed'],
  ['下拉', 'select'],
  ['切换', 'toggle'],
  ['选择', 'select'],
  ['开关', 'toggle'],
  ['数字', 'number'],
  ['文本', 'text'],
  ['种子', 'seed'],
  ['多行', 'textarea'],
  ['长文', 'textarea'],
  ['图', 'image'],
  // 英文别名，长词在前
  ['image', 'image'],
  ['img', 'image'],
  ['multiimg', 'multiimage'],
  ['seed', 'seed'],
  ['textarea', 'textarea'],
  ['number', 'number'],
  ['select', 'select'],
  ['toggle', 'toggle'],
  ['text', 'text'],
]
const KIND_MAP = new Map(KIND_ALIASES.map(([a, k]) => [a.toLowerCase(), k] as const))
const KIND_COLON_RE = new RegExp(`^(${KIND_ALIASES.map(([a]) => a).join('|')})[:：](.+)$`, 'i')

const PRESET_SPLIT = /[,，;；、]/
const NUM_PREFIX_RE = /^(\d+)(?:[.、\s_-]+)(.+)$/

export function parseTitle(raw: string | null | undefined): TitleInfo {
  if (!raw) return EMPTY
  const tokens = String(raw)
    .split(/[|｜]/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (!tokens.length) return EMPTY

  let hidden = false
  let plus = false
  let num: number | null = null
  let kindHint: FieldKind | null = null
  let presets: string[] | null = null
  let swap: [string, string] | null = null
  const labelParts: string[] = []

  // token 队列：「10 宽度」这类 数字+分隔符 的 token 会拆成数字 + 余下的子 token 重新入队
  const queue = [...tokens]
  while (queue.length) {
    const t = queue.shift()!.trim()
    if (!t) continue

    // ~ → 彻底隐藏
    if (t.startsWith('~')) {
      hidden = true
      const rest = t.slice(1).trim()
      if (rest) queue.unshift(rest)
      continue
    }

    // + → 暴露但不编号
    if (t === '+') {
      plus = true
      continue
    }

    // 纯数字 → 排序号；预设已开启时（如「预设:20|25|30」被 | 拆开）并入预设
    if (/^\d+$/.test(t)) {
      const n = parseInt(t, 10)
      if (n <= 0) {
        labelParts.push(t)
      } else if (presets) {
        presets.push(String(n))
      } else if (num == null) {
        num = n
      } else {
        labelParts.push(t)
      }
      continue
    }

    // 预设值：预设:a,b,c 或 =a,b,c
    const pm = t.match(/^(?:预设|presets)[:：](.+)$/i) ?? t.match(/^[=＝](.+)$/)
    if (pm) {
      const parts = pm[1]
        .split(PRESET_SPLIT)
        .map((x) => x.trim())
        .filter(Boolean)
      if (parts.length) presets = presets ?? []
      presets?.push(...parts)
      continue
    }

    // 交换对：交换:A,B —— 按钮把 A 换成 B、B 换成 A
    const sm = t.match(/^(?:交换|swap)[:：](.+)$/i)
    if (sm) {
      const parts = sm[1]
        .split(PRESET_SPLIT)
        .map((x) => x.trim())
        .filter(Boolean)
      if (parts.length >= 2) swap = [parts[0], parts[1]]
      continue
    }

    // 数字+分隔符前缀 → 排序号 + 余下部分重新入队（兼容「10 宽度」）
    const nm = t.match(NUM_PREFIX_RE)
    if (nm) {
      const n = parseInt(nm[1], 10)
      if (n > 0) num = n
      queue.unshift(nm[2].trim())
      continue
    }

    // 功能词整 token → 强制控件
    const kw = KIND_MAP.get(t.toLowerCase())
    if (kw) {
      kindHint = kw
      continue
    }

    // 功能词+冒号前缀 → 强制控件 + 余下部分重新入队（兼容「图:人脸参考」）
    const km = t.match(KIND_COLON_RE)
    if (km) {
      kindHint = KIND_MAP.get(km[1].toLowerCase()) ?? null
      queue.unshift(km[2].trim())
      continue
    }

    // 其余 = 显示名
    labelParts.push(t)
  }

  const exposed =
    !hidden && (plus || num != null || kindHint != null || presets != null || swap != null)

  // 交换按钮只在多行文本上渲染：写了交换对但没写功能词时，默认按长文处理
  if (swap && !kindHint) kindHint = 'textarea'

  return {
    hidden,
    exposed,
    num,
    kindHint,
    label: labelParts.join('').trim(),
    presets,
    swap,
  }
}
