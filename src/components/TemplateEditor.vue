<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../api/tauri'
import { KIND_LABELS, parseGraph } from '../core/parseWorkflow'
import type { FieldAction, FieldBinding, FieldKind, ParamTemplate } from '../core/types'
import { loadTemplates, notify, setActiveTemplate, state } from '../store'
import { ui } from '../ui'

interface Row {
  key: string
  nodeId: string
  inputName: string
  classType: string
  label: string
  kind: FieldKind
  group: string
  visible: boolean
  /** 同行号（文本形式，保存时转数字；空 = 独占一格） */
  rowText: string
  /** 功能按钮 */
  actions: FieldAction[]
  /** 预设值（逗号分隔文本，保存时拆开） */
  presetsText: string
  spec?: any
}

const ACTION_DEFS: { v: FieldAction; label: string; title: string }[] = [
  { v: 'randomize', label: '🎲', title: '随机值' },
  { v: 'clear', label: '⌫', title: '清空 / 重置' },
  { v: 'step', label: '±', title: '步进 +' },
]

const rows = ref<Row[]>([])
const name = ref('')
const description = ref('')
const mode = ref<'auto' | 'custom'>('custom')
const saving = ref(false)

const kindList = (Object.entries(KIND_LABELS) as [FieldKind, string][]).map(([k, label]) => ({
  k,
  label,
}))

onMounted(() => {
  const tpl = state.activeTemplate
  mode.value = 'custom'
  name.value = tpl?.name ?? `${state.currentWorkflow ?? '工作流'}-定制`
  description.value = tpl?.description ?? ''
  buildRows()
})

function buildRows() {
  const all = parseGraph(state.graph, state.objectInfo)
  const tpl = state.activeTemplate
  const bindings = new Map<string, FieldBinding>(
    (tpl?.mode === 'custom' ? tpl.fields : [])?.map((b) => [b.key, b]) ?? []
  )
  const isEdit = !!tpl && tpl.mode === 'custom'

  rows.value = all
    .map((f) => {
      const b = bindings.get(f.key)
      return {
        key: f.key,
        nodeId: f.nodeId,
        inputName: f.inputName,
        classType: f.classType,
        label: b?.label ?? f.label,
        kind: b?.kind ?? f.kind,
        group: b?.group ?? f.group,
        // 编辑已有模板时，没在模板里的字段默认不显示；新建时按标题标记决定（默认只勾带标记的）
        visible: isEdit ? !!b && b.visible !== false : !!f.marked,
        // 预填：模板绑定 > 节点标题约定（titleSyntax）> 空
        rowText: b?.row != null ? String(b.row) : f.row != null ? String(f.row) : '',
        actions: b?.actions ? [...b.actions] : [],
        presetsText: (b?.presets ?? f.presets)?.join(', ') ?? '',
        spec: f.spec,
      }
    })
    .sort((a, b) => {
      const oa = bindings.get(a.key)?.order ?? 0
      const ob = bindings.get(b.key)?.order ?? 0
      return oa - ob
    })
}

function move(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= rows.value.length) return
  const arr = rows.value
  ;[arr[index], arr[target]] = [arr[target], arr[index]]
}

function selectAll() {
  for (const r of rows.value) r.visible = true
}
function selectNone() {
  for (const r of rows.value) r.visible = false
}

function onlyPromptAndSeed() {
  for (const r of rows.value) r.visible = r.kind === 'textarea' || r.kind === 'seed'
}

async function save() {
  if (!state.currentWorkflow) return
  const trimmed = name.value.trim()
  if (!trimmed) {
    notify('请填写模板名称', 'warn')
    return
  }
  saving.value = true
  try {
    const fields: FieldBinding[] =
      mode.value === 'custom'
        ? rows.value
            .filter((r) => r.visible)
            .map((r, i): FieldBinding => {
              const row = parseInt(r.rowText, 10)
              const presets = r.presetsText
                .split(/[,，]/)
                .map((s) => s.trim())
                .filter(Boolean)
              return {
                key: r.key,
                label: r.label,
                kind: r.kind,
                group: r.group,
                order: i,
                visible: true,
                row: Number.isFinite(row) && row > 0 ? row : null,
                actions: r.actions.length ? [...r.actions] : undefined,
                presets: presets.length ? presets : undefined,
              }
            })
        : []

    const tpl: ParamTemplate = {
      name: trimmed,
      workflow: state.currentWorkflow,
      mode: mode.value,
      description: description.value.trim(),
      fields,
    }
    await api.saveTemplate(tpl)
    await loadTemplates()
    const saved = state.templates.find((t) => t.name === trimmed) ?? null
    setActiveTemplate(saved)
    notify(`模板「${trimmed}」已保存`, 'ok')
    ui.templateOpen = false
  } catch (e) {
    notify(`保存模板失败：${e}`, 'error', 8000)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="ui.templateOpen = false">
    <div class="modal editor">
      <div class="modal-head">
        <h3>参数模板编辑器 · {{ state.currentWorkflow }}</h3>
        <button class="btn ghost sm" @click="ui.templateOpen = false">✕</button>
      </div>

      <div class="modal-body">
        <div class="meta">
          <div class="form-row">
            <label>模板名称</label>
            <input v-model="name" class="input" placeholder="例如：电商主图-定制" />
          </div>
          <div class="form-row">
            <label>说明（可选）</label>
            <input v-model="description" class="input" placeholder="这个模板用来做什么" />
          </div>
          <div class="form-row">
            <label>模式</label>
            <select v-model="mode" class="select">
              <option value="custom">定制模式 —— 只显示勾选的参数</option>
              <option value="auto">通用模式 —— 自动显示全部参数</option>
            </select>
            <div class="hint">
              定制模式下可以改名、改控件类型、分组、排序，还能给参数配「同行号」（相同数字的排成一行）、
              功能按钮（🎲 随机 / ⌫ 清空 / ± 步进）和「预设值」（点一下就填入的常用值）。
            </div>
          </div>
        </div>

        <div class="toolbar">
          <span class="faint">
            共 {{ rows.length }} 个可绑定参数，已选
            <b :class="{ warn: rows.filter((r) => r.visible).length === 0 }">
              {{ rows.filter((r) => r.visible).length }}
            </b>
          </span>
          <div class="spacer" />
          <button class="btn sm ghost" @click="selectAll">全选</button>
          <button class="btn sm ghost" @click="selectNone">全不选</button>
          <button class="btn sm ghost" @click="onlyPromptAndSeed">仅提示词+种子</button>
        </div>

        <div class="conv-hint">
          <div class="conv-title">
            💡 <b>节点标题标识规则</b>——<b>默认所有节点都不显示</b>，标题带标识才会暴露。格式：<code>显示名 | 标识 | 标识 | …</code>（用 <code>|</code> 分隔、位置任意、不分大小写）
          </div>
          <div class="conv-grid">
            <span class="conv-item"><code>~</code>彻底隐藏（模板编辑器里也不出现）</span>
            <span class="conv-item"><code>数字</code>排序号，<b>相同数字的参数排成一行</b>（跨节点生效）</span>
            <span class="conv-item"><code>+</code>暴露但不编号（排在带数字的后面）</span>
            <span class="conv-item"><code>图</code>图片上传卡（图片 / 上传 同义）</span>
            <span class="conv-item"><code>多图</code>多图上传，多张图各跑一次（多张 同义）</span>
            <span class="conv-item"><code>种子</code>随机种子控件（随机 同义）</span>
            <span class="conv-item"><code>长文</code>多行文本（长文本 / 多行 同义）</span>
            <span class="conv-item"><code>文本</code>单行文本</span>
            <span class="conv-item"><code>数字(词)</code>数字控件（纯数字是排序号，汉字「数字」才是控件）</span>
            <span class="conv-item"><code>选择</code>下拉框（下拉 同义）</span>
            <span class="conv-item"><code>开关</code>开关切换（切换 同义）</span>
            <span class="conv-item"><code>预设:a,b,c</code>常用值一键填入（=a,b,c 同义）</span>
            <span class="conv-item"><code>交换:A,B</code>⇄ 交换按钮，两个文本内容互换（默认配多行文本）</span>
            <span class="conv-item"><code>旧写法</code>数字开头「10 宽度」、功能词:开头「图:人脸参考」仍兼容</span>
          </div>
          <div class="conv-foot">
            示例：<code>提示词|1|长文</code> · <code>人脸参考|5|图</code> · <code>参考图|多图</code> ·
            <code>步数|20|预设:20,25,30</code> · <code>负面词|3|长文|交换:正,反</code> · <code>批量|+</code> · <code>调试|~</code>
            。优先级：<b>定制模板 &gt; 节点标题约定 &gt; 自动推断</b>
          </div>
        </div>

        <div v-if="!rows.length" class="empty">没有解析到可编辑参数</div>

        <div v-else class="rows">
          <div class="row head-row">
            <div class="main">
              <span></span>
              <span>显示名</span>
              <span>控件</span>
              <span>分组</span>
              <span>节点 / 输入</span>
              <span></span>
            </div>
          </div>
          <div v-for="(r, i) in rows" :key="r.key" class="row" :class="{ off: !r.visible }">
            <div class="main">
              <label class="chk">
                <input v-model="r.visible" type="checkbox" />
              </label>
              <input v-model="r.label" class="input" :disabled="!r.visible" />
              <select v-model="r.kind" class="select" :disabled="!r.visible">
                <option v-for="item in kindList" :key="item.k" :value="item.k">
                  {{ item.label }}
                </option>
              </select>
              <input v-model="r.group" class="input" :disabled="!r.visible" />
              <span class="mono faint src">{{ r.classType }} · {{ r.inputName }}</span>
              <span class="move">
                <button class="btn ghost sm" title="上移" @click="move(i, -1)">↑</button>
                <button class="btn ghost sm" title="下移" @click="move(i, 1)">↓</button>
              </span>
            </div>
            <div v-if="r.visible" class="sub">
              <label class="sub-cell" title="相同行号的参数会排在同一行（如宽×高、步数×CFG）">
                同行
                <input
                  v-model="r.rowText"
                  class="input rownum"
                  inputmode="numeric"
                  placeholder="如 1"
                />
              </label>
              <span class="sub-cell" title="参数旁显示的功能按钮">
                按钮
                <label v-for="a in ACTION_DEFS" :key="a.v" class="act-chk" :title="a.title">
                  <input v-model="r.actions" type="checkbox" :value="a.v" />{{ a.label }}
                </label>
              </span>
              <label class="sub-cell grow" title="常用值，逗号分隔；点一下就填入">
                预设
                <input
                  v-model="r.presetsText"
                  class="input"
                  placeholder="如：1024x1024, 2048x2048"
                />
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="ui.templateOpen = false">取消</button>
        <button class="btn primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存模板' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor {
  width: 940px;
}
.meta {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 12px;
}
.meta .form-row {
  margin-bottom: 0;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.toolbar .spacer {
  flex: 1;
}
.toolbar b {
  color: var(--accent);
}
.toolbar b.warn {
  color: var(--warn);
}
.conv-hint {
  font-size: 11.5px;
  color: var(--text-faint);
  line-height: 1.7;
  background: var(--bg-2);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  margin-bottom: 10px;
}
.conv-hint b {
  color: var(--text-dim);
}
.conv-hint code {
  font-size: 11px;
  background: var(--bg-3);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--accent);
  white-space: nowrap;
}
.conv-title {
  margin-bottom: 6px;
}
/* 标识速查表：两列网格，左列标识右列说明 */
.conv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px 18px;
  margin-bottom: 6px;
}
.conv-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.conv-item code {
  flex: none;
}
.conv-foot {
  border-top: 1px dashed var(--border-soft);
  padding-top: 5px;
}
.conv-foot code {
  margin: 0 1px;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.row {
  display: flex;
  flex-direction: column;
  padding: 3px 2px;
  border-radius: 6px;
}
.row:hover {
  background: var(--bg-2);
}
.main {
  display: grid;
  grid-template-columns: 28px 1.3fr 110px 1fr 1.1fr 62px;
  gap: 8px;
  align-items: center;
}
.head-row {
  font-size: 11.5px;
  color: var(--text-faint);
  padding-bottom: 4px;
}
.row.off {
  opacity: 0.42;
}
.row.off .sub {
  display: none;
}
.chk {
  display: flex;
  justify-content: center;
}
.src {
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.move {
  display: flex;
  gap: 2px;
}
/* 第二行：同行号 / 功能按钮 / 预设值 */
.sub {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 5px 2px 2px 36px;
}
.sub-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-faint);
  white-space: nowrap;
}
.sub-cell.grow {
  flex: 1;
}
.sub-cell.grow .input {
  flex: 1;
  min-width: 0;
}
.rownum {
  width: 56px;
  text-align: center;
}
.act-chk {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  color: var(--text-dim);
  font-size: 12.5px;
}
.act-chk input {
  margin: 0 1px 0 4px;
}
</style>
