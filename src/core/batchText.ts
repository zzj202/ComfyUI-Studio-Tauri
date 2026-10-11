/**
 * 批量提示词智能拆分（「✂ 拆行提交」/ Ctrl+E 多行识别共用）。
 *
 * 两种模式（自动识别，无需选择）：
 * 1. 编号块模式——分镜/步骤类文本：每块以编号起始行开头（跨多行），整块 = 一条提示词。
 *    识别的编号形式：`1️⃣ 标题`、`1. / 1、/ 1) / 1） / 1: / 1：`、`【1】`、`[1]`、`#1`。
 *    触发条件：全文 ≥2 个编号起始行且编号严格递增（连续性校验防误伤普通文本）。
 *    块内清洗：丢弃空行与孤立的代码栏标记行（``` / plaintext / text / json），
 *    其余内容原样保留（含标题行与 integrated_multimodal_description 等字段行）。
 * 2. 按行模式（回落）——每行 trim 后非空即一条，与旧版行为一致。
 *
 * 拆出 <2 条视为未命中（调用方回落整段提交，不打扰单行场景）。
 */

/** 单次批量提交上限（与批次数量钳制一致） */
export const BATCH_TEXT_MAX = 50

/** 孤立的代码栏标记行（从 markdown 复制分镜时残留的 ``` / plaintext 等） */
const FENCE_LINE_RE = /^\s*(?:`{3,}|~{3,}|'''|"'''|plaintext|text|json)\s*$/i

/** 行首编号（keycap emoji / 括号编号 / 数字+分隔符 / #编号）；无则 null */
function blockStartNum(line: string): number | null {
  let m = line.match(/^\s*(\d{1,3})(?:\uFE0F)?\u20E3\s*/) // 1️⃣（keycap）
  if (m) return Number(m[1])
  m = line.match(/^\s*[【\[]\s*(\d{1,3})\s*[】\]]/) // 【1】 / [1]
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
          .filter((l) => l.trim() && !FENCE_LINE_RE.test(l))
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
