/**
 * 批量提示词智能拆分（「✂ 拆行提交」/ Ctrl+E 多行识别共用）。
 *
 * 两种模式（自动识别，无需选择）：
 * 1. 编号块模式——分镜/步骤类文本：每块以编号起始行开头（跨多行），整块 = 一条提示词。
 *    识别的编号形式：`1️⃣ 标题`、`1. / 1、/ 1) / 1） / 1: / 1： / 01｜标题`、`01【分类】标题`、`【1】`、
 *    `【图1｜下班进门 · 有字版】标题`（前缀词+数字+竖线，四格漫画格子批量稿）、`【1】`、
 *    `【第 1 条｜标题】`/`【新第 61 条｜标题（短语）】`（「新」前缀可选）、`提示词 1：标题`（含 `提示词 1-1：` 子编号）、`【提示词 1-1】标题`、`[1]`、`[Shot 1]`、`#1`、
 *    `【玩球 · 动作一】标题正文`（前缀词+中文数字，一~九十九，前缀可含 ref-0 这类
 *    阿拉伯数字片段、最长 20 字符）、`标题：xxx`（无数字独立标题行，按出现顺序赋号），以及无数字的
 *    `【纯中文标题】`（整行仅标题、≥4 字符，按出现顺序赋号）。
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

/** 单次批量提交上限（与批次数量钳制一致）；2026-11-02 从 50 提到 100——
 *  多系列批量稿（推小车/睡衣/抱抱连贴）动辄上百条，50 截一半 */
export const BATCH_TEXT_MAX = 100

/** 孤立的代码栏标记行（从 markdown 复制分镜时残留的 ``` / plaintext 等） */
const FENCE_LINE_RE = /^\s*(?:`{3,}|~{3,}|'''|"'''|plaintext|text|json)\s*$/i

/** 纯分隔线行（======== / -------- / ******** 等 ≥6 个同一分隔字符） */
const SEPARATOR_LINE_RE = /^\s*([-=_*~#×]{6,})\s*$/

/** 行首字段标签（如 integrated_multimodal_description: / overall_soundscape:）。
 *  要求标签 ≥3 字符且纯 ASCII 标识符，避免把普通句子冒号误当字段。 */
const FIELD_LABEL_RE = /^\s*([A-Za-z_][A-Za-z0-9_]{2,})\s*:/

/** 行首编号判定结果：n = 编号值；strong = 强模式（行首有【】包裹/「第 N 条」/「提示词 N」/
 *  keycap/[Shot]/#/「数字｜」等强特征，多系列编号各自从 03 重置也不做递增校验）。
 *  弱模式（裸数字 1. / 1、/ 1) / 1：等）仍需严格递增防误伤普通文本。 */
export interface BlockStart {
  n: number
  strong: boolean
}

/** 中文数字 → 阿拉伯数字（一~九十九；批量稿的动作编号常用中文数字） */
function cnNum(s: string): number {
  const d: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (s === '十') return 10
  const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/)
  if (m) return (m[1] ? d[m[1]] : 1) * 10 + (m[2] ? d[m[2]] : 0)
  return d[s] ?? 0
}

/** 行首编号（keycap emoji / 括号编号 / 数字+分隔符 / #编号）；无则 null。
 *  keycap 支持多位连写与特殊字形：1️⃣ / 1️⃣1️⃣（=11） / 🔟（=10，单码点） */
function blockStartNum(line: string): BlockStart | null {
  // ① keycap：单个或连写（每个键帽 = 数字+VS16?+U+20E3；🔟 是独立的单码点 emoji）
  let m = line.match(/^\s*((?:\d\uFE0F?\u20E3)+|🔟)\s*/)
  if (m) {
    if (m[1] === '🔟') return { n: 10, strong: true }
    const digits = [...m[1].matchAll(/(\d)\uFE0F?\u20E3/g)].map((x) => x[1]).join('')
    const n = Number(digits)
    if (Number.isFinite(n)) return { n, strong: true }
  }
  m = line.match(/^\s*[【\[]\s*(\d{1,3})[^】\]]*[】\]]/) // 【1】 / [1] / 【01｜双人互动】标题（编号后可带任意标题）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*[【\[]\s*([^\d】\]]{1,10})\s*(\d{1,3})\s*[｜|]/) // 【图1｜下班进门 · 有字版】标题（前缀词+数字+竖线，四格漫画格子批量稿）
  if (m) return { n: Number(m[2]), strong: true }
  m = line.match(/^\s*[【\[]\s*新?\s*第\s*(\d{1,3})\s*条/) // 【第 01 条｜标题】/【新第 61 条｜标题】（视频提示词批量稿常用编号式，「新」前缀可选）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*提示词\s*(\d{1,3})(?:-\d{1,3})?\s*[：:]/) // 提示词 1：标题 / 提示词 1-1：标题（批量稿分隔线式，支持子编号）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*[【\[]\s*提示词\s*(\d{1,3})(?:-\d{1,3})?\s*[】\]]/) // 【提示词 1-1】标题（【】包裹的提示词编号，视频字段块批量稿常用）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*[【\[]\s*[^\d】\]]{0,10}?(\d{1,3})\s*[】\]]/) // [Shot 1] / 【镜头01】（前缀词+编号）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*[【\[]\s*[^】\]]{0,20}?([一二三四五六七八九十]{1,3})\s*[】\]]/) // 【玩球 · 动作一】标题（前缀词+中文数字；{0,20} 容纳「床 · ref-0 · 动作」这类带 ref 编号的较长前缀）
  if (m) {
    const n = cnNum(m[1])
    if (n) return { n, strong: true }
  }
  m = line.match(/^\s*(\d{1,3})\s*[【\[][^】\]]*[】\]]/) // 01【双人互动】标题（行首编号+【分类】包裹，表情包批量稿常用）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*[-=_*]{3,}\s*(\d{1,3})\s*[｜|]\s*\S/) // ========== 01 | 标题 ==========（分隔线行内包裹编号式，英文批量稿常用）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*(\d{1,3})\s*([.、)）：:｜])\s*\S/) // 1. / 1、 / 1) / 1） / 1: / 1： / 01｜标题（数字+全角竖线编号式）
  if (m) return { n: Number(m[1]), strong: m[2] === '｜' } // ｜ 竖线特征强可免递增校验；裸数字仍需递增
  m = line.match(/^\s*#{1,4}\s*(\d+)\b/) // #1 / ##1
  if (m) return { n: Number(m[1]), strong: true }
  return null
}

export function splitBatchLines(text: string): string[] {
  const lines = text.split(/\r?\n/).map((s) => s.replace(/\s+$/, ''))

  // ---- 编号块模式：≥2 个编号起始行 → 整块 = 一条 ----
  // 【纯标题】行（括号内无数字、正文 ≥4 字符）：无编号但意图明确的块起点，
  // 按出现顺序赋号 1..n。≥4 字符是防聊天记录导出的【图片】【表情】
  // 这类 2-3 字短词被误当块起点；含数字的【01｜标题】/【第 1 条】走 blockStartNum。
  // 递增校验只对「弱模式」（裸数字+分隔符）生效——强模式（【】包裹/第 N 条/提示词 N/
  // 01｜…）行首特征强，多系列编号各自从 03 重置也允许（如推小车/睡衣/抱抱连贴）。
  let titleSeq = 0
  const starts = lines
    .map((l, i) => {
      const s = blockStartNum(l)
      if (s) return { i, n: s.n, strong: s.strong }
      const m = l.match(/^\s*【([^】\d]{4,})】\s*$/)
      if (m) return { i, n: ++titleSeq, strong: true }
      // 标题：双人举小旗挥舞（批量稿的独立标题行，无数字编号，按出现顺序赋号；
      // 中文标签不会撞 FIELD_LABEL_RE 的 ASCII 字段块锚点，两类模式互不干扰）
      const t = l.match(/^\s*标题\s*[：:]\s*(\S.*)$/)
      if (t) return { i, n: ++titleSeq, strong: true }
      return { i, n: null, strong: false }
    })
    .filter((x): x is { i: number; n: number; strong: boolean } => x.n != null)
  if (starts.length >= 2) {
    const nums = starts.map((s) => s.n)
    const allStrong = starts.every((s) => s.strong)
    const increasing = nums.every((n, i) => i === 0 || n > nums[i - 1])
    if (allStrong || increasing) {
      // 块首行若为「分隔线+编号+标题+分隔线」包裹式，剥掉首尾分隔线段
      // （========== 01 | 标题 ========== → 01 | 标题），提交的提示词不带 ==== 前后缀
      const stripWrappedSep = (l: string) =>
        l.replace(/^\s*[-=_*]{3,}\s*/, '').replace(/\s*[-=_*]{3,}\s*$/, '')
      const blocks: string[] = []
      starts.forEach((s, k) => {
        const end = k + 1 < starts.length ? starts[k + 1].i : lines.length
        const chunk = lines
          .slice(s.i, end)
          .filter((l) => l.trim() && !FENCE_LINE_RE.test(l) && !SEPARATOR_LINE_RE.test(l))
          .join('\n')
          .trim()
        if (chunk) {
          const nl = chunk.indexOf('\n')
          const head = stripWrappedSep(nl >= 0 ? chunk.slice(0, nl) : chunk)
          blocks.push(nl >= 0 ? head + chunk.slice(nl) : head)
        }
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

/** Windows 文件名非法字符（\\ / : * ? " < > |）→ 全角/近似替代；去掉结尾的点和空格 */
function sanitizeFileName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]/g, (ch) => {
      switch (ch) {
        case '\\':
          return '＼'
        case '/':
          return '／'
        case ':':
          return '：'
        case '*':
          return '＊'
        case '?':
          return '？'
        case '"':
          return '＂'
        case '<':
          return '《'
        case '>':
          return '》'
        default:
          return '｜'
      }
    })
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
}

/** 从一条提示词里提取批量稿标题，作为重命名建议。
 *  识别 splitBatchLines 同款的块首标题语法（整行匹配，行内 anywhere 也兜底）：
 *  - 【第 31 条｜携手拜年：《春节拜年词表》】 → 「31 携手拜年：《春节拜年词表》」
 *  - 【01｜双人互动】 / 01｜标题            → 「01 双人互动」
 *  - 提示词 3：标题                          → 「3 标题」
 *  - 【纯标题至少四字】（无数字整行包裹）    → 「纯标题」
 *  返回已清洗的文件名建议（编号前缀 + 标题）；识别不出返回 null。 */
export function extractPromptTitle(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    // 标题：双人举小旗挥舞（批量稿独立标题行，无数字编号，建议 = 标题文本本身）
    let m = line.match(/^标题\s*[：:]\s*(\S.*)$/)
    if (m) return sanitizeFileName(m[1])
    m = line.match(/^[【\[]\s*新?\s*第\s*(\d{1,3})\s*条\s*[｜|：:]\s*(.+?)[】\]]\s*$/)
    if (m) {
      // 标题末尾带（短语）简称的（如【新第61条｜小白递纸巾…（递纸巾擦泪）】）优先用短语：
      // 长句是场景描述，短语才是作者起的名字，做文件名更干净
      const tag = m[2].match(/^(.*)\s*[（(]([^（）()]{2,20})[）)]\s*$/)
      return sanitizeFileName(tag ? `${m[1]} ${tag[2]}` : `${m[1]} ${m[2]}`)
    }
    m = line.match(/^[【\[]\s*(\d{1,3})\s*[｜|]\s*(.+?)[】\]]\s*$/) // 【01｜标题】
    if (m) return sanitizeFileName(`${m[1]} ${m[2]}`)
    m = line.match(/^[【\[]\s*([^\d】\]]{1,10})\s*(\d{1,3})\s*[｜|]\s*(.+?)[】\]]\s*$/) // 【图1｜下班进门 · 有字版】标题（前缀词+数字+竖线）
    if (m) return sanitizeFileName(`${m[1]}${m[2]} ${m[3]}`)
    m = line.match(/^提示词\s*(\d{1,3}(?:-\d{1,3})?)\s*[：:]\s*(.+)$/) // 提示词 3：标题 / 提示词 1-1：标题
    if (m) return sanitizeFileName(`${m[1]} ${m[2]}`)
    // 【提示词 1-1】照镜整理仪容：建议 = 编号 标题（编号保留 1-1 子编号形式）；标题超长截到 60 字
    m = line.match(/^[【\[]\s*提示词\s*(\d{1,3}(?:-\d{1,3})?)\s*[】\]]\s*(.*)$/)
    if (m) {
      const tail = m[2].trim()
      if (!tail) return sanitizeFileName(m[1])
      return sanitizeFileName(`${m[1]} ${tail.length <= 60 ? tail : tail.slice(0, 60)}`)
    }
    m = line.match(/^[【\[]\s*新?\s*第\s*(\d{1,3})\s*条\s*[｜|：:]\s*(.+)$/) // 行中间出现也算（粘贴稿常有前缀文字）
    if (m) return sanitizeFileName(`${m[1]} ${m[2]}`)
    m = line.match(/^[【\[]([^】\d]{4,})[】\]]\s*$/) // 【纯标题】（≥4 字防【图片】【表情】）
    if (m) return sanitizeFileName(m[1])
    m = line.match(/^(\d{1,3})\s*[｜|]\s*(.+)$/) // 01｜标题（无包裹）
    if (m) return sanitizeFileName(`${m[1]} ${m[2]}`)
    // 01【双人互动】击掌！说定了（行首编号+【分类】+标题）：建议 = 编号 分类 标题；
    // 标题超长（正文粘成一行）时只取分类，避免建议名被正文撑爆
    m = line.match(/^(\d{1,3})\s*[【\[]\s*([^】\]]{1,30})\s*[】\]]\s*(.*)$/)
    if (m) {
      const tail = m[3].trim()
      return sanitizeFileName(tail && tail.length <= 60 ? `${m[1]} ${m[2]} ${tail}` : `${m[1]} ${m[2]}`)
    }
    m = line.match(/^[【\[]([^】\]]{0,30}?[一二三四五六七八九十]{1,3})[】\]]\s*(.*)$/) // 【床 · ref-0 · 动作一】跳上床趴下（【前缀词+中文数字】+标题正文）
    if (m) {
      const tail = m[2].trim()
      // 建议名 = 前缀+中文数字 标题（保留主题/ref 标识与动作序号）；正文超长只取前缀
      return sanitizeFileName(tail && tail.length <= 60 ? `${m[1]} ${tail}` : m[1])
    }
    // 行内 anywhere 兜底：【第 N 条｜标题】/【新第 N 条｜标题（短语）】嵌在长行里（粘贴稿常有前缀文字）
    m = line.match(/[【\[]\s*新?\s*第\s*(\d{1,3})\s*条\s*[｜|：:]\s*([^】\]]{2,60})[】\]]/)
    if (m) {
      const tag = m[2].match(/^(.*)\s*[（(]([^（）()]{2,20})[）)]\s*$/)
      return sanitizeFileName(tag ? `${m[1]} ${tag[2]}` : `${m[1]} ${m[2]}`)
    }
    // 行内 anywhere 兜底：【提示词 1-1】标题 嵌在长行里（标题取到第一个空白为止，
    // 防止把粘在后面的 integrated_multimodal_description 等正文吞进名字）
    m = line.match(/[【\[]\s*提示词\s*(\d{1,3}(?:-\d{1,3})?)\s*[】\]]\s*([^【】]{2,40})/)
    if (m) return sanitizeFileName(`${m[1]} ${m[2].trim().split(/\s+/)[0].slice(0, 60)}`)
    // ========== 01 | ref-0 | 坐下晃腿摇尾巴 ==========（分隔线行内包裹编号式）：
    // 建议 = 编号 + 竖线末段标题（ref-0 这类参考图标记是技术位，不进文件名）
    m = line.match(/^[-=_*]{3,}\s*(\d{1,3})\s*[｜|]\s*(.+?)\s*[-=_*]{3,}\s*$/)
    if (m) {
      const title = m[2].split(/\s*[｜|]\s*/).pop() ?? m[2]
      return sanitizeFileName(`${m[1]} ${title}`)
    }
  }
  return null
}
