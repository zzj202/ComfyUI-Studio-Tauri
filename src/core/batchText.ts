/**
 * 批量提示词智能拆分（「✂ 拆行提交」/ Ctrl+E 多行识别共用）。
 *
 * 两种模式（自动识别，无需选择）：
 * 1. 编号块模式——分镜/步骤类文本：每块以编号起始行开头（跨多行），整块 = 一条提示词。
 *    识别的编号形式：`1️⃣ 标题`、`1. / 1、/ 1) / 1） / 1: / 1：`、`【1】`、`【第 1 条｜标题】`、
 *    `提示词 1：标题`、`[1]`、`[Shot 1]`、`#1`。
 *    触发条件：全文 ≥2 个编号起始行且编号严格递增（连续性校验防误伤普通文本）。
 *    块内清洗：丢弃空行、孤立的代码栏标记行（``` / plaintext / json）与
 *    纯分隔线行（======== / -------- 等 ≥6 个同一分隔字符）。
 *    其余内容原样保留（含标题行与 integrated_multimodal_description 等字段行）。
 * 2. 字段块模式——结构化提示词组（如视频模型的 integrated_multimodal_description /
 *    overall_soundscape / non_diegetic_music）：每块以同一个行首字段标签开头（跨多行）。
 *    触发条件：全文 ≥2 次出现同一个行首 `字段名:` 标签，选最早出现者为锚点；
 *    锚点行与其后内容（含后续字段行）整块保留。
 * 3. 按行模式（回落）——每行 trim 后非空即一条，与旧版行为一致。
 *
 * 拆出 <2 条视为未命中（调用方回落整段提交，不打扰单行场景）。
 */

/** 单次批量提交上限（与批次数量钳制一致） */
export const BATCH_TEXT_MAX = 50

/** 孤立的代码栏标记行（从 markdown 复制分镜时残留的 ``` / plaintext 等） */
const FENCE_LINE_RE = /^\s*(?:`{3,}|~{3,}|'''|"'''|plaintext|text|json)\s*$/i

/** 纯分隔线行（======== / -------- / ******** 等 ≥6 个同一分隔字符） */
const SEPARATOR_LINE_RE = /^\s*([-=_*~#×]{6,})\s*$/

/** 行首字段标签（如 integrated_multimodal_description: / overall_soundscape:）。
 *  要求标签 ≥3 字符且纯 ASCII 标识符，避免把普通句子冒号误当字段。 */
const FIELD_LABEL_RE = /^\s*([A-Za-z_][A-Za-z0-9_]{2,})\s*:/

/** 行首编号（keycap emoji / 括号编号 / 数字+分隔符 / #编号）；无则 null。
 *  keycap 支持多位连写与特殊字形：1️⃣ / 1️⃣1️⃣（=11） / 🔟（=10，单码点） */
function blockStartNum(line: string): number | null {
  // ① keycap：单个或连写（每个键帽 = 数字+VS16?+U+20E3；🔟 是独立的单码点 emoji）
  let m = line.match(/^\s*((?:\d\uFE0F?\u20E3)+|🔟)\s*/)
  if (m) {
    if (m[1] === '🔟') return 10
    const digits = [...m[1].matchAll(/(\d)\uFE0F?\u20E3/g)].map((x) => x[1]).join('')
    const n = Number(digits)
    if (Number.isFinite(n)) return n
  }
  m = line.match(/^\s*[【\[]\s*(\d{1,3})[^】\]]*[】\]]/) // 【1】 / [1] / 【01｜双人互动】标题（编号后可带任意标题）
  if (m) return Number(m[1])
  m = line.match(/^\s*[【\[]\s*第\s*(\d{1,3})\s*条/) // 【第 01 条｜标题】（视频提示词批量稿常用编号式）
  if (m) return Number(m[1])
  m = line.match(/^\s*提示词\s*(\d{1,3})\s*[：:]/) // 提示词 1：标题（批量稿分隔线式）
  if (m) return Number(m[1])
  m = line.match(/^\s*[【\[]\s*[^\d】\]]{0,10}?(\d{1,3})\s*[】\]]/) // [Shot 1] / 【镜头01】（前缀词+编号）
  if (m) return Number(m[1])
  m = line.match(/^\s*(\d{1,3})\s*[.、)）：:]\s*\S/) // 1. / 1、 / 1) / 1） / 1: / 1：
  if (m) return Number(m[1])
  m = line.match(/^\s*#{1,4}\s*(\d+)\b/) // #1 / ##1
  if (m) return Number(m[1])
  return null
}

export function splitBatchLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map((s) => s.replace(/\s+$/, ''))

  // ---- 编号块模式：≥2 个编号起始行且编号严格递增 → 整块 = 一条 ----
  const starts = lines
    .map((l, i) => ({ i, n: blockStartNum(l) }))
    .filter((x): x is { i: number; n: number } => x.n != null)
  if (starts.length >= 2) {
    const nums = starts.map((s) => s.n)
    const increasing = nums.every((n, i) => i === 0 || n > nums[i - 1])
    if (increasing) {
      const blocks: string[] = []
      starts.forEach((s, k) => {
        const end = k + 1 < starts.length ? starts[k + 1].i : lines.length
        const chunk = lines
          .slice(s.i, end)
          .filter((l) => l.trim() && !FENCE_LINE_RE.test(l) && !SEPARATOR_LINE_RE.test(l))
          .join('\n')
          .trim()
        if (chunk) blocks.push(chunk)
      })
      if (blocks.length >= 2) return blocks.slice(0, BATCH_TEXT_MAX)
    }
  }

  // ---- 字段块模式：同一行首字段标签 ≥2 次 → 每次出现 = 一块起点 ----
  const labelStats = new Map<string, { count: number; firstIdx: number }>()
  lines.forEach((l, i) => {
    const m = l.match(FIELD_LABEL_RE)
    if (!m) return
    const e = labelStats.get(m[1]) ?? { count: 0, firstIdx: i }
    e.count++
    labelStats.set(m[1], e)
  })
  // 锚点取「出现 ≥2 次且首次出现最早」的标签（= 每块的第一个字段）
  let anchorLabel: string | null = null
  for (const [label, e] of labelStats) {
    if (e.count >= 2 && (anchorLabel === null || e.firstIdx < (labelStats.get(anchorLabel)?.firstIdx ?? Infinity)))
      anchorLabel = label
  }
  if (anchorLabel) {
    const starts2 = lines
      .map((l, i) => ({ i, hit: l.match(FIELD_LABEL_RE)?.[1] === anchorLabel }))
      .filter((x) => x.hit)
      .map((x) => x.i)
    if (starts2.length >= 2) {
      const blocks: string[] = []
      starts2.forEach((s, k) => {
        const end = k + 1 < starts2.length ? starts2[k + 1] : lines.length
        const chunk = lines
          .slice(s, end)
          .filter((l) => l.trim() && !FENCE_LINE_RE.test(l) && !SEPARATOR_LINE_RE.test(l))
          .join('\n')
          .trim()
        if (chunk) blocks.push(chunk)
      })
      if (blocks.length >= 2) return blocks.slice(0, BATCH_TEXT_MAX)
    }
  }

  // ---- 回落：按行拆分（现状行为） ----
  return lines.map((s) => s.trim()).filter(Boolean)
}
