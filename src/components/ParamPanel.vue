<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import FieldControl from './FieldControl.vue'
import BatchTextDialog from './BatchTextDialog.vue'
import PairedDialog from './PairedDialog.vue'
import type { FieldSchema } from '../core/types'
import { api } from '../api/tauri'
import { appConfirm } from '../core/confirm'
import { applyValues, collectValues } from '../core/parseWorkflow'
import {
  enabledWorkers,
  interrupt,
  notify,
  randomizeSeeds,
  setActiveTemplate,
  state,
  submit,
  submitBatch,
  submitWorkerId,
} from '../store'
import { ui } from '../ui'

/**
 * 把当前表单参数固化回工作流 JSON 文件（覆盖保存）。
 * applyValues 深拷贝原图 + 只覆盖有值字段 + 被连线占用的输入不碰——
 * 保存的就是「提交时发给 ComfyUI 的那份图」，工作流其余结构原样保留。
 */
async function saveToWorkflow() {
  if (!state.currentWorkflow || !state.graph) return
  if (
    !window.confirm(
      `把当前参数写入工作流文件「${state.currentWorkflow}」？\n将覆盖原 JSON，此操作不可撤销。`
    )
  )
    return
  try {
    const graph = applyValues(state.graph, collectValues(state.fields))
    await api.saveWorkflow(state.currentWorkflow, graph)
    notify(`已把当前参数写入工作流文件「${state.currentWorkflow}」`, 'ok', 4000)
  } catch (e) {
    notify(`写入工作流失败：${e}`, 'error', 8000)
  }
}

// ---- 分组折叠状态：按工作流记忆（localStorage），刷新 / 重开不丢 ----

const FOLD_KEY = 'comfyui-studio.groupFold:v1'

function loadFolds(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(FOLD_KEY)
    const o = raw ? JSON.parse(raw) : null
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

const allFolds = ref(loadFolds())

function saveFolds() {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(allFolds.value))
  } catch {
    /* 忽略存储失败 */
  }
}

const collapsed = ref<Record<string, boolean>>({})

watch(
  () => state.currentWorkflow,
  (wf) => {
    const set: Record<string, boolean> = {}
    for (const g of wf ? (allFolds.value[wf] ?? []) : []) set[g] = true
    collapsed.value = set
  },
  { immediate: true }
)

const templatesForWorkflow = computed(() =>
  state.templates.filter((t) => t.workflow === state.currentWorkflow)
)

interface RenderGroup {
  group: string
  fields: FieldSchema[]
  /** 行号相同的字段 → 合成一条横向参数行（跨节点也生效，归属到行里第一个字段所在的组） */
  lines: { row: number; fields: FieldSchema[] }[]
  /** 没配行号的字段 → 走自动网格 */
  singles: FieldSchema[]
}

const groups = computed<RenderGroup[]>(() => {
  const all = state.fields
  // 1) 全局按行号聚合：相同行号的字段合成一行（不管它们属于哪个节点/分组）
  const lineMap = new Map<number, FieldSchema[]>()
  for (const f of all) {
    if (f.row == null) continue
    let list = lineMap.get(f.row)
    if (!list) {
      list = []
      lineMap.set(f.row, list)
    }
    list.push(f)
  }
  const lined = new Set([...lineMap.values()].flatMap((l) => l.map((f) => f.key)))
  // 2) 行归属到「行内第一个字段」所在的分组；组顺序按字段首次出现
  const order: string[] = []
  for (const f of all) if (!order.includes(f.group)) order.push(f.group)
  const out: RenderGroup[] = order.map((g) => ({ group: g, fields: [], lines: [], singles: [] }))
  const byGroup = new Map(out.map((g) => [g.group, g]))
  for (const [row, list] of lineMap) {
    byGroup.get(list[0].group)?.lines.push({ row, fields: list })
  }
  for (const f of all) {
    if (lined.has(f.key)) continue
    byGroup.get(f.group)?.singles.push(f)
  }
  // 3) 组内字段数 = 行内字段 + 散字段；字段全被吸进别组行的组不再显示
  for (const g of out) {
    g.fields = [...g.lines.flatMap((l) => l.fields), ...g.singles]
  }
  return out.filter((g) => g.fields.length)
})

const selected = computed({
  get: () => state.activeTemplate?.name ?? 'auto',
  set: (v: string) => {
    setActiveTemplate(v === 'auto' ? null : (templatesForWorkflow.value.find((t) => t.name === v) ?? null))
  },
})

// ---- 字段搜索：参数几十个时按名字直达（匹配显示名 / 输入名 / 节点号 / 分组名）----
const fieldSearch = ref('')

function fieldHit(f: FieldSchema, q: string): boolean {
  const hay = `${f.label} ${f.nodeId}.${f.inputName} ${f.group}`.toLowerCase()
  return hay.includes(q)
}

/** 搜索过滤后的分组（搜索时忽略折叠状态全展开；无匹配的组隐藏） */
const visibleGroups = computed<RenderGroup[]>(() => {
  const q = fieldSearch.value.trim().toLowerCase()
  if (!q) return groups.value
  const out: RenderGroup[] = []
  for (const g of groups.value) {
    const lines = g.lines
      .map((l) => ({ row: l.row, fields: l.fields.filter((f) => fieldHit(f, q)) }))
      .filter((l) => l.fields.length)
    const singles = g.singles.filter((f) => fieldHit(f, q))
    const fields = [...lines.flatMap((l) => l.fields), ...singles]
    if (fields.length) out.push({ group: g.group, fields, lines, singles })
  }
  return out
})

function toggleGroup(g: string) {
  collapsed.value[g] = !collapsed.value[g]
  // 折叠名单按工作流落盘，刷新后保持
  const wf = state.currentWorkflow
  if (!wf) return
  allFolds.value[wf] = Object.keys(collapsed.value).filter((k) => collapsed.value[k])
  saveFolds()
}

// ---- 参数预设包：当前表单存成命名预设，一键切换回填（按工作流隔离，localStorage 持久化） ----

const PRESET_KEY = 'comfyui-studio.paramPresets:v1'

function loadPresets(): Record<string, Record<string, Record<string, any>>> {
  try {
    const raw = localStorage.getItem(PRESET_KEY)
    const o = raw ? JSON.parse(raw) : null
    return o && typeof o === 'object' ? o : {}
  } catch {
    return {}
  }
}

const allPresets = ref(loadPresets())

function savePresets() {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(allPresets.value))
  } catch {
    /* 忽略存储失败 */
  }
}

const presetNames = computed(() => {
  const wf = state.currentWorkflow
  return wf ? Object.keys(allPresets.value[wf] ?? {}) : []
})
const presetSel = ref('')
const presetAdding = ref(false)
const presetName = ref('')
const presetNameEl = ref<HTMLInputElement | null>(null)

watch(presetAdding, (v) => {
  if (v) void nextTick(() => presetNameEl.value?.focus())
})

/** 重命名期间切选中不触发回填（否则改名会把手头改动冲掉） */
let suppressApply = false

watch(presetSel, (v) => {
  if (suppressApply) {
    suppressApply = false
    return
  }
  applyPreset(v)
})

watch(
  () => state.currentWorkflow,
  () => {
    presetSel.value = ''
    presetAdding.value = false
    renaming.value = ''
  }
)

/** 应用预设：逐项回填字段值（种子不回填——预设是场景切换，种子交给随机/复现链路） */
function applyPreset(name: string) {
  if (!name) return
  const wf = state.currentWorkflow
  const vals = wf ? allPresets.value[wf]?.[name] : undefined
  if (!vals) return
  let n = 0
  for (const [k, v] of Object.entries(vals)) {
    const f = state.fields.find((x) => x.key === k)
    if (!f || f.kind === 'seed') continue
    f.value = Array.isArray(v) ? [...v] : v
    n++
  }
  notify(`已应用预设「${name}」（回填 ${n} 项，种子保持当前值）`, 'ok', 3500)
}

function savePreset() {
  const name = presetName.value.trim()
  const wf = state.currentWorkflow
  if (!name || !wf) return
  const snap: Record<string, any> = {}
  for (const f of state.fields) {
    snap[f.key] = Array.isArray(f.value) ? [...f.value] : f.value
  }
  if (!allPresets.value[wf]) allPresets.value[wf] = {}
  const existed = !!allPresets.value[wf][name]
  allPresets.value[wf][name] = snap
  savePresets()
  presetAdding.value = false
  presetName.value = ''
  presetSel.value = name
  notify(existed ? `预设「${name}」已覆盖更新` : `已存预设「${name}」`, 'ok', 3000)
}

/** 删除预设（chips 悬停出的 ×；有确认拦截） */
async function removePreset(name: string) {
  const wf = state.currentWorkflow
  if (!name || !wf) return
  if (!(await appConfirm({ title: '删除预设', message: `删除预设「${name}」？此操作不可恢复。` }))) return
  delete allPresets.value[wf][name]
  savePresets()
  if (presetSel.value === name) presetSel.value = ''
  notify(`已删除预设「${name}」`, 'info', 3000)
}

/** 预设里存了几项参数（chip 上的小计数） */
function presetCount(name: string): number {
  const wf = state.currentWorkflow
  return wf ? Object.keys(allPresets.value[wf]?.[name] ?? {}).length : 0
}

/** 当前表单与选中预设是否有出入（种子不参与对比）——有出入时亮「更新预设」 */
const presetDirty = computed(() => {
  const wf = state.currentWorkflow
  if (!wf || !presetSel.value) return false
  const vals = allPresets.value[wf]?.[presetSel.value]
  if (!vals) return false
  for (const f of state.fields) {
    if (f.kind === 'seed') continue
    if (JSON.stringify(f.value) !== JSON.stringify(vals[f.key])) return true
  }
  return false
})

/** 用当前表单参数覆盖选中预设（种子照旧不存） */
function updatePreset(name: string) {
  const wf = state.currentWorkflow
  if (!wf || !allPresets.value[wf]?.[name]) return
  const snap: Record<string, any> = {}
  for (const f of state.fields) {
    snap[f.key] = Array.isArray(f.value) ? [...f.value] : f.value
  }
  allPresets.value[wf][name] = snap
  savePresets()
  notify(`预设「${name}」已更新为当前参数`, 'ok', 3000)
}

// ---- 预设就地重命名（chip 悬停 ✎） ----

const renaming = ref('')
const renameText = ref('')
const renameEl = ref<HTMLInputElement | null>(null)

function startRename(name: string) {
  renaming.value = name
  renameText.value = name
  void nextTick(() => renameEl.value?.select())
}

function commitRename() {
  if (!renaming.value) return
  const from = renaming.value
  const to = renameText.value.trim()
  const wf = state.currentWorkflow
  renaming.value = ''
  if (!wf || !to || to === from) return
  const bucket = allPresets.value[wf]
  if (!bucket || !bucket[from]) return
  if (bucket[to]) {
    notify(`已有同名预设「${to}」`, 'warn', 3000)
    return
  }
  // 保序改名：重建对象而不是 delete+add（避免预设跑到末尾）
  allPresets.value[wf] = Object.fromEntries(
    Object.entries(bucket).map(([k, v]) => (k === from ? [to, v] : [k, v]))
  )
  savePresets()
  if (presetSel.value === from) {
    suppressApply = true
    presetSel.value = to
  }
  notify(`预设已重命名为「${to}」`, 'ok', 3000)
}

function expandAll() {
  collapsed.value = {}
  const wf = state.currentWorkflow
  if (wf && allFolds.value[wf]?.length) {
    allFolds.value[wf] = []
    saveFolds()
  }
}

const modeLabel = computed(() =>
  state.activeTemplate?.mode === 'custom' ? '定制模式' : '通用模式'
)

/** 批次数量：存在 store 里全局共享并持久化（提交按钮 / 一键粘贴提交等入口共用） */

/** 多图字段当前已有的图片张数 */
const multiCount = computed(() => {
  const multi = state.fields.find((f) => f.kind === 'multiimage')
  if (!multi) return 0
  const v = multi.value
  return Array.isArray(v) ? v.filter(Boolean).length : v ? 1 : 0
})

/** 本次提交总任务数：有图走 图数 × 批次，否则就是批次数 */
const totalCount = computed(() =>
  multiCount.value > 0 ? multiCount.value * submitBatch.value : submitBatch.value
)

const submitLabel = computed(() =>
  totalCount.value > 1 ? `提交生成 ×${totalCount.value}` : '提交生成'
)

/** 节点池 ≥2 时显示节点下拉（auto = 空闲优先自动分配） */
const workerOptions = computed(() => enabledWorkers())

// ---- 参数撤回 / 回退（整个参数区）：值快照栈，按 field.key 存取；
//  切工作流/模板（字段键集变化）自动清栈重新基线，避免把 A 工作流的值套到 B 上 ----

const undoStack = ref<string[]>([])
const redoStack = ref<string[]>([])
let histLast = ''
let histTimer = 0

const canUndo = computed(() => undoStack.value.length > 0)
const canRedo = computed(() => redoStack.value.length > 0)

/** 当前全部字段值 → 快照串（键→值对象，回填按 key 对号，字段重建也安全） */
function sigNow(): string {
  const o: Record<string, any> = {}
  for (const f of state.fields) o[f.key] = f.value
  return JSON.stringify(o)
}

/** 把一份快照写回字段（只碰两边都有的 key） */
function applySig(sig: string): boolean {
  let o: Record<string, any>
  try {
    o = JSON.parse(sig)
  } catch {
    return false
  }
  let hit = 0
  for (const [k, v] of Object.entries(o)) {
    const f = state.fields.find((x) => x.key === k)
    if (!f) continue
    f.value = Array.isArray(v) ? [...v] : v
    hit++
  }
  return hit > 0
}

/** 字段键集变化（切工作流 / 切模板 / 字段重建）：清栈 + 以当前值为新基线 */
function resetHistory() {
  window.clearTimeout(histTimer)
  histLast = sigNow()
  undoStack.value = []
  redoStack.value = []
}

watch(() => state.fields.map((f) => f.key).join('\n'), resetHistory, { immediate: true })

watch(
  () => sigNow(),
  () => {
    // 300ms 合并连续小改动（打字、连续点 ±），一次改动只进一条历史
    window.clearTimeout(histTimer)
    histTimer = window.setTimeout(() => {
      const cur = sigNow()
      if (cur === histLast) return
      undoStack.value.push(histLast)
      if (undoStack.value.length > 100) undoStack.value.shift()
      redoStack.value = []
      histLast = cur
    }, 300)
  }
)

function undoParams() {
  const target = undoStack.value.pop()
  if (target == null) return
  if (!applySig(target)) {
    undoStack.value.push(target)
    return
  }
  redoStack.value.push(histLast)
  histLast = target
}

function redoParams() {
  const nxt = redoStack.value.pop()
  if (nxt == null) return
  if (!applySig(nxt)) {
    redoStack.value.push(nxt)
    return
  }
  undoStack.value.push(histLast)
  histLast = nxt
}

/** Ctrl+Enter 快捷提交（长提示词时不用挪鼠标去点按钮） */
function onKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'Enter') {
    e.preventDefault()
    if (state.currentWorkflow && state.fields.length) submit()
    return
  }
  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y：参数区撤回 / 回退。
  // 焦点在输入框里时让位给原生文本撤销/重做，不拦。
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase()
    if (k !== 'z' && k !== 'y') return
    const t = e.target as HTMLElement | null
    const typing =
      !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    if (typing) return
    e.preventDefault()
    if (k === 'y' || e.shiftKey) redoParams()
    else undoParams()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <section class="panel">
    <header class="head">
      <div class="title">
        <span class="wf-ico" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="13" height="13">
            <circle cx="4" cy="4" r="2.1" fill="none" stroke="currentColor" stroke-width="1.4" />
            <circle cx="12" cy="12" r="2.1" fill="none" stroke="currentColor" stroke-width="1.4" />
            <path d="M6 4h4.5A1.5 1.5 0 0 1 12 5.5V9.8M10 12H5.5A1.5 1.5 0 0 1 4 10.5V6.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </span>
        <div class="t-main">
          <h2 :title="state.currentWorkflow ?? ''">{{ state.currentWorkflow || '未选择工作流' }}</h2>
          <span class="badge" :class="{ custom: state.activeTemplate?.mode === 'custom' }">
            {{ modeLabel }}
          </span>
        </div>
      </div>
      <div class="actions">
        <button
          class="btn sm ghost hist-btn"
          :disabled="!canUndo"
          title="撤回上一次参数改动（Ctrl+Z；焦点在输入框里时是原生文本撤销）"
          @click="undoParams"
        >
          ↶
        </button>
        <button
          class="btn sm ghost hist-btn"
          :disabled="!canRedo"
          title="回退刚被撤回的改动（Ctrl+Shift+Z / Ctrl+Y）"
          @click="redoParams"
        >
          ↷
        </button>
        <select v-model="selected" class="select tpl-select" :disabled="!state.currentWorkflow">
          <option value="auto">通用模式（自动全部字段）</option>
          <option v-for="t in templatesForWorkflow" :key="t.name" :value="t.name">
            定制：{{ t.name }}
          </option>
        </select>
        <button class="btn sm" :disabled="!state.currentWorkflow" @click="ui.templateOpen = true">
          编辑模板
        </button>
        <button class="btn sm ghost" :disabled="!groups.length" @click="expandAll">展开全部</button>
      </div>
    </header>

    <div class="body">
      <!-- 字段搜索：参数多时按名字直达（搜索时全部分组展开） -->
      <div v-if="state.currentWorkflow && state.fields.length > 8" class="search-row">
        <input v-model="fieldSearch" class="input f-search" placeholder="🔍 搜参数名…（显示名 / 输入名 / 节点号）" />
        <button v-if="fieldSearch" class="btn ghost sm" title="清空搜索" @click="fieldSearch = ''">✕</button>
        <span class="faint f-count">
          {{ fieldSearch ? `匹配 ${visibleGroups.reduce((n, g) => n + g.fields.length, 0)}/${state.fields.length} 项` : `共 ${state.fields.length} 项参数` }}
        </span>
      </div>
      <!-- 参数预设包 v2：chips 一键切换（选中亮 ✓；悬停出 ✎改名 ×删除）；参数有改动亮琥珀「更新预设」胶囊；＋存当前展开新建卡片 -->
      <div v-if="state.currentWorkflow && state.fields.length" class="preset-bar">
        <span class="pb-label">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 2.5h8a1 1 0 0 1 1 1V14l-5-3-5 3V3.5a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
          </svg>
          预设
        </span>
        <div class="pb-chips">
          <template v-for="n in presetNames" :key="n">
            <!-- 就地重命名中 -->
            <div v-if="renaming === n" class="p-chip renaming">
              <input
                :ref="(el) => (renameEl = el as HTMLInputElement | null)"
                v-model="renameText"
                class="rn-input"
                @keydown.enter.prevent="commitRename"
                @keydown.esc="renaming = ''"
                @blur="commitRename"
                @click.stop
              />
              <button class="rn-ok" title="确认重命名" @mousedown.prevent @click.stop="commitRename">✓</button>
            </div>
            <div
              v-else
              class="p-chip"
              :class="{ on: presetSel === n }"
              :title="presetSel === n ? `已应用「${n}」· 再点一次取消（种子不回填）` : `应用预设「${n}」· 悬停可改名/删除`"
              @click="presetSel = presetSel === n ? '' : n"
            >
              <span v-if="presetSel === n" class="pc-check">✓</span>
              <span class="pc-name">{{ n }}</span>
              <span class="pc-count">{{ presetCount(n) }}项</span>
              <span class="pc-ops">
                <span class="pc-op ren" title="重命名" @click.stop="startRename(n)">✎</span>
                <span class="pc-op del" title="删除预设" @click.stop="removePreset(n)">×</span>
              </span>
            </div>
          </template>
          <!-- 手头参数和选中预设对不上：一键回写 -->
          <button
            v-if="presetSel && presetDirty"
            class="pb-dirty"
            :title="`用当前参数覆盖更新预设「${presetSel}」`"
            @click="updatePreset(presetSel)"
          >
            ↻ 已修改 · 更新预设
          </button>
          <button
            v-if="!presetAdding"
            class="p-chip add"
            title="把当前表单参数存成命名预设（含图片引用；种子不存）"
            @click="presetAdding = true"
          >
            ＋ 存当前
          </button>
          <span v-if="!presetNames.length && !presetAdding" class="pb-hint">把调好的参数存成预设，随时一键切换场景</span>
        </div>
        <!-- 新建预设卡片：占满一整行，附带保存范围说明 -->
        <div v-if="presetAdding" class="pb-add">
          <input
            ref="presetNameEl"
            v-model="presetName"
            class="input pb-add-name"
            placeholder="预设名，如「竖图 · 高品质」，回车保存"
            @keydown.enter.prevent="savePreset"
            @keydown.esc="presetAdding = false"
          />
          <span class="pb-add-meta">保存当前 {{ state.fields.length }} 项参数 · 种子不存</span>
          <button class="btn sm" :disabled="!presetName.trim()" @click="savePreset">保存</button>
          <button class="btn sm ghost" @click="presetAdding = false">取消</button>
        </div>
      </div>

      <div v-if="!state.currentWorkflow" class="empty">
        左侧选择一个工作流开始<br />
        没有的话点「导入工作流」，把 ComfyUI 里<b>导出 (API)</b> 的 JSON 加进来
      </div>

      <div v-else-if="!state.fields.length" class="empty">
        这个工作流没有暴露任何参数。<br />
        <b>默认所有节点都不显示</b>：在 ComfyUI 里给节点标题加标识（如 <code>提示词|1|长文</code>、<code>人脸参考|5|图</code>、<code>参考图|多图</code>，相同数字的参数排成一行）后重新导入，
        或点「编辑模板」手动勾选——<b>完整标识规则见模板编辑器顶部</b>。<br />
        <span class="faint">也可能：导出的是 UI 格式（请改用「导出 (API)」）或参数都被连线占用。</span>
      </div>
      <div v-else-if="!visibleGroups.length" class="empty">没有匹配「{{ fieldSearch }}」的参数</div>

      <div v-for="g in visibleGroups" v-else :key="g.group" class="group">
        <button class="group-head" @click="toggleGroup(g.group)">
          <span class="caret" :class="{ collapsed: collapsed[g.group] && !fieldSearch }">▾</span>
          <span class="gname">{{ g.group }}</span>
          <span class="count">{{ g.fields.length }}</span>
        </button>
        <div v-show="!collapsed[g.group] || !!fieldSearch" class="group-body">
          <div v-for="line in g.lines" :key="'row' + line.row" class="param-line">
            <FieldControl
              v-for="f in line.fields"
              :key="f.key"
              :field="f"
              :class="{ wide: f.kind === 'textarea' || f.kind === 'multiimage' }"
            />
          </div>
          <FieldControl
            v-for="f in g.singles"
            :key="f.key"
            :field="f"
            :class="{ wide: f.kind === 'textarea' || f.kind === 'multiimage' }"
          />
        </div>
      </div>
    </div>

    <footer class="foot">
      <div class="right">
        <select
          v-if="workerOptions.length > 1"
          v-model="submitWorkerId"
          class="select worker-select"
          title="计算节点：自动分配 = 空闲优先；也可固定派给某一台"
        >
          <option value="auto">自动分配</option>
          <option v-for="w in workerOptions" :key="w.id" :value="w.id">{{ w.name }}</option>
        </select>
        <select
          v-model.number="submitBatch"
          class="select batch-select"
          :disabled="!state.fields.length"
          title="批次数量：批次为 2 即提交 2 次（每次自动随机种子）"
        >
          <option v-for="n in 10" :key="n" :value="n">批次 ×{{ n }}</option>
        </select>
        <button class="btn" :disabled="!state.fields.length" @click="randomizeSeeds">随机种子</button>
        <button
          class="btn ghost"
          :disabled="!state.fields.length || !state.currentWorkflow"
          title="把当前参数写入工作流 JSON 文件（覆盖保存；连线输入不受影响）"
          @click="saveToWorkflow"
        >
          💾 写入工作流
        </button>
        <button
          class="btn ghost"
          :disabled="!state.fields.length"
          title="中断当前节点上运行中的任务"
          @click="interrupt"
        >
          中断
        </button>
        <button
          class="btn hero"
          :disabled="!state.fields.length"
          title="Ctrl+Enter 也可提交"
          @click="submit()"
        >
          {{ submitLabel }}
        </button>
      </div>
    </footer>

    <!-- 批量拆行确认弹窗：粘贴/拆行按钮识别到多行提示词时弹出 -->
    <BatchTextDialog />
    <!-- 图文配对弹窗：多图 × 多条提示词均分配对批量提交 -->
    <PairedDialog />
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  min-width: 0;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 14px;
  border-bottom: 1px solid var(--border-soft);
  flex: none;
  flex-wrap: wrap; /* 窄窗口：动作区换行，不压标题 */
  row-gap: 6px;
  background: linear-gradient(180deg, var(--bg-2), transparent);
}
/* 工作流图标徽标：渐变小方块，标题左侧的视觉锚点（紧凑尺寸压头部高度） */
.wf-ico {
  flex: none;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid #7c8cff33;
}
.wf-ico svg {
  width: 11px;
  height: 11px;
}
.title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.t-main {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.title h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 字段搜索行（body 顶部，字段 >8 个才出现） */
.search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 0;
  flex: none;
}
.f-search {
  flex: 1;
  font-size: 12px;
  padding: 4px 10px;
}
.f-count {
  flex: none;
  font-size: 11.5px;
  white-space: nowrap;
}
/* 参数预设包 v2：书签标签 + 小卡片 chips（✓选中 / 计数 / 悬停 ✎×）+ 琥珀「更新预设」胶囊 + 新建卡片行 */
.preset-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  row-gap: 8px;
  padding: 6px 12px 0;
  flex: none;
}
.pb-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--text-faint);
  padding: 3px 10px 3px 0;
  border-right: 1px solid var(--border-soft);
}
.pb-label svg {
  flex: none;
  opacity: 0.75;
}
.pb-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.p-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  height: 26px;
  padding: 0 8px 0 10px;
  font-size: 11.5px;
  color: var(--text-dim);
  background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s, border-color 0.15s, color 0.15s, background 0.15s;
}
.p-chip:hover {
  color: var(--text);
  border-color: #7c8cff66;
  transform: translateY(-1px);
  box-shadow: 0 3px 10px #0000002b;
}
.p-chip.on {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: #7c8cff88;
  box-shadow: 0 0 0 1px #7c8cff2b, 0 2px 10px #7c8cff22;
}
.p-chip.on:hover {
  color: var(--accent);
}
.p-chip .pc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.p-chip.on .pc-name {
  font-weight: 600;
}
/* 选中态的 ✓ 前标 */
.pc-check {
  flex: none;
  font-size: 10.5px;
  font-weight: 700;
  line-height: 1;
}
/* 存了几项参数的微型计数 */
.pc-count {
  flex: none;
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 999px;
  color: var(--text-faint);
  background: var(--border-soft);
}
.p-chip.on .pc-count {
  color: var(--accent);
  background: #7c8cff1f;
}
/* 悬停（或选中）才出的操作：✎ 改名 / × 删除 */
.pc-ops {
  display: none;
  align-items: center;
  gap: 1px;
  flex: none;
  margin-right: -3px;
}
.p-chip:hover .pc-ops,
.p-chip.on .pc-ops {
  display: inline-flex;
}
.pc-op {
  width: 16px;
  height: 16px;
  line-height: 15px;
  text-align: center;
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-faint);
  transition: color 0.12s, background 0.12s;
}
.pc-op.ren:hover {
  color: var(--accent);
  background: #7c8cff1f;
}
.pc-op.del:hover {
  color: var(--err);
  background: #f8717122;
}
/* 就地重命名的 chip：输入 + ✓ 确认 */
.p-chip.renaming {
  gap: 4px;
  padding: 0 4px 0 10px;
  cursor: default;
  color: var(--text);
  border-color: #7c8cff88;
  background: var(--bg-2);
  transform: none;
  box-shadow: 0 0 0 1px #7c8cff2b;
}
.rn-input {
  width: 130px;
  font-size: 11.5px;
  color: var(--text);
  background: transparent;
  border: none;
  outline: none;
}
.rn-ok {
  flex: none;
  width: 18px;
  height: 18px;
  line-height: 16px;
  text-align: center;
  border: none;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
  cursor: pointer;
}
/* 手头参数与选中预设不一致：琥珀胶囊一键回写（与字段改动琥珀点同一语义色） */
.pb-dirty {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--warn);
  background: #fbbf2414;
  border: 1px dashed #fbbf2455;
  border-radius: 8px;
  cursor: pointer;
  animation: pb-dirty-pulse 2.2s ease-in-out infinite;
  transition: background 0.15s, border-color 0.15s;
}
@keyframes pb-dirty-pulse {
  50% {
    border-color: #fbbf24aa;
  }
}
.pb-dirty:hover {
  background: #fbbf2426;
  border-style: solid;
  border-color: #fbbf24aa;
}
/* ＋存当前：虚线胶囊，与实心预设 chips 区分 */
.p-chip.add {
  color: var(--text-faint);
  background: transparent;
  border-style: dashed;
}
.p-chip.add:hover {
  color: var(--accent);
  border-color: #7c8cff88;
  background: var(--accent-soft);
  transform: none;
  box-shadow: none;
}
.pb-hint {
  font-size: 11px;
  color: var(--text-faint);
}
/* 新建预设卡片：占满整行，输入 + 范围说明 + 操作 */
.pb-add {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: linear-gradient(180deg, var(--bg-2), transparent);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  animation: pb-add-in 0.18s ease;
}
@keyframes pb-add-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}
.pb-add-name {
  flex: 1;
  min-width: 140px;
  font-size: 12px;
  padding: 5px 10px;
}
.pb-add-meta {
  flex: none;
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
}
.badge {
  flex: none;
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  border: 1px solid #7c8cff44;
}
.badge.custom {
  background: #f59e0b1f;
  color: var(--warn);
  border-color: #f59e0b44;
}
.actions {
  display: flex;
  gap: 8px;
  flex: none;
  flex-wrap: wrap;
  row-gap: 6px;
  min-width: 0;
}
/* 撤回/回退：图标化小方钮，窄窗口也不挤标题 */
.hist-btn {
  width: 28px;
  padding: 0;
  justify-content: center;
  font-size: 13px;
  flex: none;
}
.tpl-select {
  width: 220px;
  max-width: 100%;
}
.body {
  flex: 1;
  overflow: auto;
  padding: 10px 12px 16px;
}
.group {
  margin-bottom: 8px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  background: var(--panel);
}
/* 组头吸顶：长表单滚动时组名始终可见（.group 不再 overflow:hidden，圆角自担） */
.group-head {
  position: sticky;
  top: -1px;
  z-index: 2;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  background: var(--bg-2);
  border: none;
  border-radius: calc(var(--radius) - 1px) calc(var(--radius) - 1px) 0 0;
  box-shadow: inset 0 -1px 0 var(--border-soft);
  cursor: pointer;
  text-align: left;
  backdrop-filter: blur(6px);
}
.group-head:hover {
  background: var(--bg-3);
}
.caret {
  color: var(--text-faint);
  transition: transform 0.15s;
  display: inline-block;
}
.caret.collapsed {
  transform: rotate(-90deg);
}
/* 组名前的强调小条：组卡片的色彩锚点 */
.gname {
  font-weight: 600;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.gname::before {
  content: '';
  flex: none;
  width: 3px;
  height: 12px;
  border-radius: 2px;
  background: linear-gradient(180deg, var(--accent), #9f6fff);
  opacity: 0.85;
}
.count {
  color: var(--text-faint);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  background: var(--bg);
  border: 1px solid var(--border-soft);
  padding: 1px 7px;
  border-radius: 999px;
}
.group-body {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px 10px;
  padding: 8px 10px;
}
/* 模板里配置了同行号的参数 → 一条横向参数行（字段多时自动换行） */
.param-line {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 10px;
  align-items: flex-start;
  padding: 4px 8px;
  border: 1px dashed var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
}
.param-line > :deep(.field) {
  flex: 1;
  min-width: 140px;
}
/* 人物Lora / 人物Lora强度 同行两列：等宽并列，内容再宽也不挤换行 */
.param-line > :deep(.field.lora-cmp) {
  flex: 1 1 0;
  min-width: 0;
}
/* 参数行内的媒体卡压缩：小缩略图 + 更小的行间距，整行高度不被卡片撑高 */
.param-line > :deep(.thumb) {
  width: 56px;
  height: 56px;
}
.param-line > :deep(.img-side) {
  gap: 5px;
}
/* 长文本 / 多图节点：默认占满整行 */
.group-body > .wide {
  grid-column: 1 / -1;
}
.param-line > .wide {
  flex: 1 1 100%;
  min-width: 0;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: flex-end; /* 左侧信息已撤，动作区整体靠右 */
  padding: 10px 16px;
  border-top: 1px solid var(--border-soft);
  background: linear-gradient(0deg, var(--bg-2), var(--panel));
  flex: none;
}
.foot .right {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap; /* 窄窗口时换行，hero 主按钮不被挤压 */
}
/* 提交主按钮：渐变 + 光晕，视觉重心压在动作区 */
.foot :deep(.btn.hero) {
  background: linear-gradient(135deg, var(--accent), #9f8cff);
  border: none;
  box-shadow: 0 2px 14px #7c8cff3d;
}
.foot :deep(.btn.hero:hover:not(:disabled)) {
  background: linear-gradient(135deg, #8f9dff, #a58dff);
  box-shadow: 0 3px 18px #7c8cff55;
}
.batch-select {
  width: 104px;
}
.worker-select {
  width: 118px;
}
</style>
