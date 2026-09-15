<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import FieldControl from './FieldControl.vue'
import type { FieldSchema } from '../core/types'
import { notify, randomizeSeeds, setActiveTemplate, state, submit, interrupt } from '../store'
import { ui } from '../ui'

const collapsed = ref<Record<string, boolean>>({})

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

function toggleGroup(g: string) {
  collapsed.value[g] = !collapsed.value[g]
}

function expandAll() {
  collapsed.value = {}
}

const modeLabel = computed(() =>
  state.activeTemplate?.mode === 'custom' ? '定制模式' : '通用模式'
)

/** 批次数量：批次为 2 就是提交 2 次；选择持久化，刷新后保持上次的选择 */
const BATCH_KEY = 'comfyui-studio.batch:v1'
const batch = ref(1)
try {
  const saved = parseInt(localStorage.getItem(BATCH_KEY) ?? '', 10)
  if (saved >= 1 && saved <= 10) batch.value = saved
} catch {
  /* 忽略读取失败 */
}
watch(batch, (v) => {
  try {
    localStorage.setItem(BATCH_KEY, String(v))
  } catch {
    /* 忽略写入失败 */
  }
})

/** 多图字段当前已有的图片张数 */
const multiCount = computed(() => {
  const multi = state.fields.find((f) => f.kind === 'multiimage')
  if (!multi) return 0
  const v = multi.value
  return Array.isArray(v) ? v.filter(Boolean).length : v ? 1 : 0
})

/** 本次提交总任务数：有图走 图数 × 批次，否则就是批次数 */
const totalCount = computed(() =>
  multiCount.value > 0 ? multiCount.value * batch.value : batch.value
)

const submitLabel = computed(() =>
  totalCount.value > 1 ? `提交生成 ×${totalCount.value}` : '提交生成'
)

/** Ctrl+Enter 快捷提交（长提示词时不用挪鼠标去点按钮） */
function onKeydown(e: KeyboardEvent) {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'Enter') {
    e.preventDefault()
    if (state.currentWorkflow && state.fields.length) submit(batch.value)
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <section class="panel">
    <header class="head">
      <div class="title">
        <h2>{{ state.currentWorkflow || '未选择工作流' }}</h2>
        <span class="badge" :class="{ custom: state.activeTemplate?.mode === 'custom' }">
          {{ modeLabel }}
        </span>
      </div>
      <div class="actions">
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

      <div v-for="g in groups" v-else :key="g.group" class="group">
        <button class="group-head" @click="toggleGroup(g.group)">
          <span class="caret" :class="{ collapsed: collapsed[g.group] }">▾</span>
          <span class="gname">{{ g.group }}</span>
          <span class="count">{{ g.fields.length }}</span>
        </button>
        <div v-show="!collapsed[g.group]" class="group-body">
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
      <div class="left">
        <span class="faint">共 {{ state.fields.length }} 项参数</span>
        <span v-if="state.queueRemaining > 0" class="faint">· 队列 {{ state.queueRemaining }}</span>
      </div>
      <div class="right">
        <select
          v-model.number="batch"
          class="select batch-select"
          :disabled="!state.fields.length"
          title="批次数量：批次为 2 即提交 2 次（每次自动随机种子）"
        >
          <option v-for="n in 10" :key="n" :value="n">批次 ×{{ n }}</option>
        </select>
        <button class="btn" :disabled="!state.fields.length" @click="randomizeSeeds">随机种子</button>
        <button class="btn" :disabled="!state.fields.length" @click="interrupt">中断</button>
        <button
          class="btn primary"
          :disabled="!state.fields.length"
          title="Ctrl+Enter 也可提交"
          @click="submit(batch)"
        >
          {{ submitLabel }}
        </button>
      </div>
    </footer>
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
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-soft);
  flex: none;
}
.title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.title h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  flex: none;
  font-size: 11px;
  padding: 2px 8px;
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
}
.tpl-select {
  width: 220px;
}
.body {
  flex: 1;
  overflow: auto;
  padding: 14px 16px 24px;
}
.group {
  margin-bottom: 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--panel);
}
.group-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  background: var(--bg-2);
  border: none;
  cursor: pointer;
  text-align: left;
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
.gname {
  font-weight: 600;
  flex: 1;
}
.count {
  color: var(--text-faint);
  font-size: 11px;
  background: var(--bg);
  padding: 1px 7px;
  border-radius: 999px;
}
.group-body {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px 16px;
  padding: 14px 12px;
}
/* 模板里配置了同行号的参数 → 一条横向参数行（字段多时自动换行） */
.param-line {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 14px 16px;
  align-items: flex-start;
  padding: 8px 10px;
  border: 1px dashed var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-2);
}
.param-line > :deep(.field) {
  flex: 1;
  min-width: 140px;
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
  justify-content: space-between;
  padding: 11px 16px;
  border-top: 1px solid var(--border-soft);
  background: var(--panel);
  flex: none;
}
.foot .right {
  display: flex;
  gap: 8px;
  align-items: center;
}
.batch-select {
  width: 104px;
}
</style>
