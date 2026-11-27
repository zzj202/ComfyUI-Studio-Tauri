/**
 * 批量提示词智能拆分（「✂ 拆行提交」/ Ctrl+E 多行识别共用）。
 *
 * 两种模式（自动识别，无需选择）：
 * 1. 编号块模式——分镜/步骤类文本：每块以编号起始行开头（跨多行），整块 = 一条提示词。
 *    识别的编号形式：`1️⃣ 标题`、`1. / 1、/ 1) / 1） / 1: / 1： / 01｜标题`、
 *    `1. 【标题】正文`（编号+点号+【】标题，2026-11-27 升强起点免递增——多稿拼接
 *    编号各自从 1 重置也能整组识别）、
 *    `01 标题`（裸编号+空格+标题，无分隔符——双人 GIF 三字段稿「01 红绳拔河 +
 *    integrated_multimodal_description: …」2026-11-26；弱模式需递增校验，标题不跟数字防
 *    撞时间轴/序数行）、`01【分类】标题`、`【1】`、
 *    `【1. 标题】`（【】包裹编号+点号，2026-11-21；编号分隔符后不跟数字——0.0-1.2s 这类
 *    时间轴行不是编号，防止把整稿的编号序列打断回落按行拆）、`【图1｜下班进门 · 有字版】标题`（前缀词+数字+竖线，四格漫画格子批量稿；
 *    分隔符扩到 ·・:：、——`【参考图1 · 小金毛抱臂生气】正文` 2026-11-23 同支持；
 *    无包裹的 `图1｜标题`（行独立、正文下一段）2026-11-23 同支持）、`【1】`、
 *    `【第 1 条｜标题】`/`【新第 61 条｜标题（短语）】`（「新」前缀可选）、`提示词 1：标题`（含 `提示词 1-1：` 子编号）、`--- 提示词 1-1 ---`（分隔线包裹，2026-11-23）、`【提示词 1-1】标题`、`[1]`、`[Shot 1]`、`#1`、
 *    `▍1-1 毛线球逃跑记`（▍ 前缀+编号/子编号，参考图系列横幅稿的条目行，2026-11-24：
 *    配合 `==== 横幅【参考图 NN】描述 ====` 使用——横幅行本就走【N】分支自成起点、单行横幅
 *    由「纯标题横幅块并入下一块」并入首个条目；▍ 行才是真正的条目边界），`【玩球 · 动作一】标题正文`（前缀词+中文数字，一~九十九，前缀可含 ref-0 这类
 *    阿拉伯数字片段、最长 20 字符）、`标题：xxx`（无数字独立标题行，按出现顺序赋号），以及无数字的
 *    `【纯中文标题】`（整行仅标题、≥4 字符，按出现顺序赋号）。
 *    `## 1. 坐下`（Markdown 标题编号，2026-11-21）：≥2 个 `##` 开头编号标题 = 条目边界，
 *    此时块内行首的 `[Shot N]` 视为条目内部结构不再切块（英文稿 detailed_description 分镜行）。
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

/** 纯分隔线行（======== / -------- / ******** 等 ≥3 个同一分隔字符；
 *  2026-11-21 从 {6,} 放宽到 {3,}——英文批量稿块间常用 Markdown 的 --- 分隔） */
const SEPARATOR_LINE_RE = /^\s*([-=_*~#×])\1{2,}\s*$/

/** 行首字段标签（如 integrated_multimodal_description: / overall_soundscape:）。
 *  要求标签 ≥3 字符且纯 ASCII 标识符，避免把普通句子冒号误当字段。 */
const FIELD_LABEL_RE = /^\s*([A-Za-z_][A-Za-z0-9_]{2,})\s*:/

/** 行首编号判定结果：n = 编号值；strong = 强模式（行首有【】包裹/「第 N 条」/「提示词 N」/
 *  keycap/[Shot]/#/「数字｜」等强特征，多系列编号各自从 03 重置也不做递增校验）。
 *  弱模式（裸数字 1. / 1、/ 1) / 1：等）仍需严格递增防误伤普通文本。
 *  kind：mdhead = Markdown 标题编号（## 1. 标题）；shot = 行首 [Shot N]。
 *  两者同时出现时 mdhead 是条目边界、[Shot N] 是条目内部结构（见 splitBatchLines）。 */
export interface BlockStart {
  n: number
  strong: boolean
  kind?: 'mdhead' | 'shot'
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
  m = line.match(/^\s*[【\[]\s*([^\d】\]]{1,10})\s*(\d{1,3})\s*[｜|·・:：、]/) // 【图1｜下班进门 · 有字版】标题 /【参考图1 · 小金毛抱臂生气】正文（前缀词+数字+竖线/间隔点，四格漫画与参考图批量稿）
  if (m) return { n: Number(m[2]), strong: true }
  m = line.match(/^\s*[【\[]\s*新?\s*第\s*(\d{1,3})\s*条/) // 【第 01 条｜标题】/【新第 61 条｜标题】（视频提示词批量稿常用编号式，「新」前缀可选）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*提示词\s*(\d{1,3})(?:-\d{1,3})?\s*[：:]/) // 提示词 1：标题 / 提示词 1-1：标题（批量稿分隔线式，支持子编号）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*[【\[]\s*提示词\s*(\d{1,3})(?:-\d{1,3})?\s*[】\]]/) // 【提示词 1-1】标题（【】包裹的提示词编号，视频字段块批量稿常用）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*\[\s*shot\s*(\d{1,3})\s*\]/i) // [Shot 1]（行首英文 Shot 编号，打 shot 标记——与 Markdown 标题编号同现时降级为内部结构）
  if (m) return { n: Number(m[1]), strong: true, kind: 'shot' }
  m = line.match(/^\s*[【\[]\s*[^\d】\]]{0,10}?(\d{1,3})\s*[】\]]/) // [Shot 1] / 【镜头01】（前缀词+编号）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*[【\[]\s*[^】\]]{0,20}?([一二三四五六七八九十]{1,3})\s*[】\]]/) // 【玩球 · 动作一】标题（前缀词+中文数字；{0,20} 容纳「床 · ref-0 · 动作」这类带 ref 编号的较长前缀）
  if (m) {
    const n = cnNum(m[1])
    if (n) return { n, strong: true }
  }
  m = line.match(/^\s*(\d{1,3})\s*[【\[][^】\]]*[】\]]/) // 01【双人互动】标题（行首编号+【分类】包裹，表情包批量稿常用）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*(\d{1,3})\s*[.、．]\s*[【\[]/) // 1. 【标题】正文（编号+点号+【】标题，参考图批量稿常用；
  if (m) return { n: Number(m[1]), strong: true } // 【】标题特征强 → 强模式免递增校验：多个 txt/多稿拼接时
  // 各自从 1 重置也能整组识别（2026-11-27 30031/30032 双稿拖入实测：弱模式递增校验
  // 会被第二稿的重置编号打断，整体回落按行拆，头部/通用要求全变条目）
  m = line.match(/^\s*[-=_*]{3,}\s*(\d{1,3})\s*[｜|]\s*\S/) // ========== 01 | 标题 ==========（分隔线行内包裹编号式，英文批量稿常用）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*[-=_*]{3,}\s*提示词\s*(\d{1,3})(?:-\d{1,3})?\s*[-=_*]{3,}/) // --- 提示词 1-1 ---（分隔线包裹提示词编号，英文视频字段块批量稿；不修复会被字段块锚点把标题行与 For the target video 行丢块外）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*▍\s*(\d{1,3})(?:\s*-\s*\d{1,3})?\s*(?:[｜|:：]\s*)?\S/) // ▍1-1 毛线球逃跑记（▍ 前缀+编号/子编号，参考图系列横幅稿的条目行；编号 1-1/2-1 每组重置 → strong 免递增校验）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*(\d{1,3})\s*([.、)）：:｜])\s*(?!\d)\S/) // 1. / 1、 / 1) / 1） / 1: / 1： / 01｜标题（数字+全角竖线编号式）
  if (m) return { n: Number(m[1]), strong: m[2] === '｜' } // ｜ 竖线特征强可免递增校验；裸数字仍需递增
  // 编号分隔符后 (?!\d)：时间轴行 0.0-1.2s（1.2秒）： / 0:30s 不是编号（编号后不会紧跟数字），
  m = line.match(/^\s*[一-鿿A-Za-z]{1,6}(\d{1,3})\s*[｜|]\s*\S/) // 图1｜深夜独自回家 · 有字版（前缀词+数字+竖线，无包裹，四格漫画批量稿；标题行独立、正文在下一段）
  if (m) return { n: Number(m[1]), strong: true }
  m = line.match(/^\s*#{1,4}\s*(\d+)\b/) // #1 / ##1 / ## 1. 标题（Markdown 标题编号）
  if (m) {
    // ≥2 个 # 且编号后跟标题文字 → Markdown 标题编号（条目边界，级别高于块内 [Shot N]）
    const mdhead = /^\s*#{2,4}\s*\d+\b\s*[.、．]?\s*\S/.test(line)
    return { n: Number(m[1]), strong: true, kind: mdhead ? 'mdhead' : undefined }
  }
  m = line.match(/^\s*(\d{1,3})\s+(?!\d)(\S.*)$/) // 01 标题（裸编号+空格+标题，无任何分隔符；
  if (m) return { n: Number(m[1]), strong: false } // 弱模式递增校验；(?!\d) 防撞「1 2 3」并列数字行）
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
      if (s) return { i, n: s.n, strong: s.strong, kind: s.kind }
      const m = l.match(/^\s*【([^】\d]{4,})】\s*$/)
      if (m) return { i, n: ++titleSeq, strong: true, kind: undefined }
      // 标题：双人举小旗挥舞（批量稿的独立标题行，无数字编号，按出现顺序赋号；
      // 中文标签不会撞 FIELD_LABEL_RE 的 ASCII 字段块锚点，两类模式互不干扰）
      const t = l.match(/^\s*标题\s*[：:]\s*(\S.*)$/)
      if (t) return { i, n: ++titleSeq, strong: true, kind: undefined }
      // 裸标题行 + 字段块（2026-11-27 农场稿「农场·播种」+ integrated_multimodal_description：
      // 无任何编号/包裹的独立标题行，下一个非空行是 ASCII 字段标签 → 该行是条目起点，
      // 标题随块保留——原行为下标题行掉进上一块尾部、首条标题丢失）。
      // 约束防误判：无空白、无句末标点、2-20 字、CJK 开头（英文说明行带空格进不来）
      if (/^[一-鿿][一-鿿·・×—\-0-9]{1,19}$/.test(l)) {
        let k = i + 1
        while (k < lines.length && !lines[k].trim()) k++
        if (k < lines.length && FIELD_LABEL_RE.test(lines[k])) {
          return { i, n: ++titleSeq, strong: true, kind: undefined }
        }
      }
      return { i, n: null, strong: false, kind: undefined }
    })
    .filter((x): x is { i: number; n: number; strong: boolean; kind?: 'mdhead' | 'shot' } => x.n != null)
  // Markdown 标题编号（## 1. 坐下）与行首 [Shot N] 同现：标题是条目边界，
  // [Shot N] 是条目内部结构（英文稿 detailed_description 里的分镜行），不切块
  if (starts.filter((s) => s.kind === 'mdhead').length >= 2) {
    for (let i = starts.length - 1; i >= 0; i--) if (starts[i].kind === 'shot') starts.splice(i, 1)
  }
  if (starts.length >= 2) {
    // 弱编号前言段吞并（2026-11-27 30033+ 参考图稿）：正文条目是强模式 `N. 【标题】`，
    // 但稿子头部带弱编号的「通用要求」逐条说明（1. 角色召唤… 6. 每条内…），弱模式递增
    // 校验会被强条目的重置编号打断 → 整体回落按行拆。规则：一段严格递增的弱起点，
    // 紧跟一个编号 ≤ 其末尾的强起点（= 正文条目重新从 1 计数）→ 该弱段是前言：
    // 整段吞掉不产生条目，其内容随段丢弃（多稿拼接时也不粘进上一稿末条）。
    const skip = new Set<number>()
    {
      let i = 0
      while (i < starts.length) {
        if (starts[i].strong) {
          i++
          continue
        }
        let j = i
        while (j + 1 < starts.length && !starts[j + 1].strong && starts[j + 1].n > starts[j].n) j++
        if (j + 1 < starts.length && starts[j + 1].strong && starts[j + 1].n <= starts[j].n) {
          for (let k = i; k <= j; k++) skip.add(k)
        }
        i = j + 1
      }
    }
    const eff = starts.filter((_, k) => !skip.has(k))
    const nums = eff.map((s) => s.n)
    const allStrong = eff.every((s) => s.strong)
    const increasing = nums.every((n, i) => i === 0 || n > nums[i - 1])
    if (eff.length >= 2 && (allStrong || increasing)) {
      // 块首行若为「分隔线+编号+标题+分隔线」包裹式，剥掉首尾分隔线段
      // （========== 01 | 标题 ========== → 01 | 标题），提交的提示词不带 ==== 前后缀
      const stripWrappedSep = (l: string) =>
        l.replace(/^\s*[-=_*]{3,}\s*/, '').replace(/\s*[-=_*]{3,}\s*$/, '')
      const blocks: string[] = []
      starts.forEach((s, k) => {
        if (skip.has(k)) return // 前言弱编号段：连同其内容整段丢弃，不产生条目
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
      // 纯标题横幅块并入下一块（2026-11-24）：横幅式稿「====【N · 标题】==== + --- 提示词 N --- + 字段」
      // 里【N · 标题】自成起点且整块只有一行 → 标题与正文分离成 2N 条。仅合并整块单行且以【[ 开头的
      // 横幅（裸编号单行列表 1. xxx 不受影响）；从后往前并，连续横幅也能落到最终正文块。
      for (let i = blocks.length - 2; i >= 0; i--) {
        if (!blocks[i].includes('\n') && /^[【\[]/.test(blocks[i])) {
          blocks[i + 1] = `${blocks[i]}\n${blocks[i + 1]}`
          blocks.splice(i, 1)
        }
      }
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
 *  - 01 红绳拔河（裸编号+空格，无分隔符）    → 「01 红绳拔河」
 *  - ## 1. 坐下（Markdown 标题编号）        → 「1 坐下」
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
    // ▍1-1 毛线球逃跑记 / ▍12-3 碗里转圈（▍前缀编号标题行，参考图系列横幅稿条目；
    // 建议保留 N-N 子编号——横幅【参考图 NN】是分组上下文，条目名才对应单个任务）
    m = line.match(/^▍\s*(\d{1,3}(?:-\d{1,3})?)\s*(?:[｜|:：]\s*)?(\S.*)$/)
    if (m) {
      const tail = m[2].trim()
      return sanitizeFileName(`${m[1]} ${tail.length <= 60 ? tail : tail.slice(0, 60)}`)
    }
    m = line.match(/^[【\[]\s*新?\s*第\s*(\d{1,3})\s*条\s*[｜|：:]\s*(.+?)[】\]]\s*$/)
    if (m) {
      // 标题末尾带（短语）简称的（如【新第61条｜小白递纸巾…（递纸巾擦泪）】）优先用短语：
      // 长句是场景描述，短语才是作者起的名字，做文件名更干净
      const tag = m[2].match(/^(.*)\s*[（(]([^（）()]{2,20})[）)]\s*$/)
      return sanitizeFileName(tag ? `${m[1]} ${tag[2]}` : `${m[1]} ${m[2]}`)
    }
    m = line.match(/^[【\[]\s*(\d{1,3})\s*[｜|]\s*(.+?)[】\]]\s*$/) // 【01｜标题】
    if (m) return sanitizeFileName(`${m[1]} ${m[2]}`)
    m = line.match(/^[【\[]\s*(\d{1,3})\s*[.、．·・:：]\s*(.+?)[】\]]\s*$/) // 【91. 踩水洼嬉戏】/【1 · 贴脸蹭】（【】包裹编号+分隔符+标题，分隔符含点/顿号/间隔点/冒号）
    if (m) return sanitizeFileName(`${m[1]} ${m[2]}`)
    m = line.match(/^#{1,4}\s*(\d{1,3})\s*[.、．]?\s*(\S.+)$/) // ## 1. 坐下（Markdown 标题编号，标题在编号后同行）
    if (m) return sanitizeFileName(`${m[1]} ${m[2]}`)
    m = line.match(/^[【\[]\s*([^\d】\]]{1,10})\s*(\d{1,3})\s*[｜|]\s*(.+?)[】\]]/) // 【图1｜下班进门 · 有字版】标题正文（】后可粘正文，标题取】内）
    if (m) return sanitizeFileName(`${m[1]}${m[2]} ${m[3]}`)
    m = line.match(/^[【\[]\s*([^\d】\]]{1,10})(\d{1,3})\s*[·・:：、]\s*([^】\]]+?)[】\]]/) // 【参考图1 · 小金毛抱臂生气】正文（前缀词+数字+间隔点/冒号/顿号，分隔符不含 ｜/-：｜ 走上一分支、- 会撞【提示词 1-1】）
    if (m) return sanitizeFileName(`${m[1]}${m[2]} ${m[3]}`)
    m = line.match(/^提示词\s*(\d{1,3}(?:-\d{1,3})?)\s*[：:]\s*(.+)$/) // 提示词 3：标题 / 提示词 1-1：标题
    if (m) return sanitizeFileName(`${m[1]} ${m[2]}`)
    m = line.match(/^[-=_*]{3,}\s*提示词\s*(\d{1,3}(?:-\d{1,3})?)\s*[-=_*]{3,}\s*$/) // --- 提示词 1-1 ---（分隔线包裹提示词编号，建议 = 1-1 保留子编号）
    if (m) return sanitizeFileName(m[1])
    m = line.match(/^提示词\s*(\d{1,3}(?:-\d{1,3})?)\s*$/) // 提示词 1-1（裸编号行 = 分隔线剥离后的块首，建议同上）
    if (m) return sanitizeFileName(m[1])
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
    // 图1｜深夜独自回家 · 有字版（前缀词+数字+竖线，无包裹）：建议 = 前缀+编号 标题；
    // 标题与正文粘在同一行时截到 60 字防正文撑爆建议名
    m = line.match(/^([一-鿿A-Za-z]{1,6})(\d{1,3})\s*[｜|]\s*(.+)$/)
    if (m) {
      const tail = m[3].trim()
      return sanitizeFileName(`${m[1]}${m[2]} ${tail.length <= 60 ? tail : tail.slice(0, 60)}`)
    }
    // 01【双人互动】击掌！说定了（行首编号+【分类】+标题）/ 1. 【伸爪击掌】小金毛……
    // （编号+点号分隔+【标题】，2026-11-26 伸爪测试稿）：建议 = 编号 分类 标题；
    // 标题超长（正文粘成一行）时只取分类，避免建议名被正文撑爆
    m = line.match(/^(\d{1,3})\s*[.、)）：:｜]?\s*[【\[]\s*([^】\]]{1,30})\s*[】\]]\s*(.*)$/)
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
    // 01 红绳拔河（裸编号+空格+标题，无分隔符无包裹；2026-11-26 双人 GIF 三字段稿条目行）
    // 与 splitBatchLines 同款分支：标题过长（正文粘行）截到 60 字
    m = line.match(/^(\d{1,3})\s+(?!\d)(\S.*)$/)
    if (m) {
      const tail = m[2].trim()
      return sanitizeFileName(`${m[1]} ${tail.length <= 60 ? tail : tail.slice(0, 60)}`)
    }
    // 农场·播种（无编号裸标题行独立成行；与 splitBatchLines 同款约束：无空白、CJK 开头、
    // 2-20 字、无句末标点。2026-11-27 农场三字段稿，建议 = 标题本身）
    m = line.match(/^([一-鿿][一-鿿·・×—\-0-9]{1,19})$/)
    if (m) return sanitizeFileName(m[1])
  }
  return null
}
