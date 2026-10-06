<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watchEffect } from 'vue'
import { api } from '../api/tauri'
import { open } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import {
  applyAssetToWorkflow,
  dragGhost,
  dropZones,
  isDragClick,
  isWorkflowPinned,
  loadWorkflows,
  notify,
  openAssetWorkflow,
  persistWorkflowOrder,
  renameWorkflow,
  selectWorkflow,
  state,
  toggleWorkflowPin,
} from '../store'
import type { DragItem } from '../store'
import type { WorkflowMeta } from '../core/types'
import { ui } from '../ui'

// 拖拽落点区：结果资产 / 本地资产拖到「面板空白处」→ 打开它内嵌的工作流
function onDropZone(item: { asset?: any; path?: string }) {
  if (item.asset) openAssetWorkflow(item.asset)
  else if (item.path) ui.assetInspect = item.path
}
onMounted(() => {
  dropZones.set('workflow-panel', onDropZone)
})
onUnmounted(() => dropZones.delete('workflow-panel'))

// 资产拖到「具体工作流卡片」= 切到该模板并设为参考图（与面板空白处的反查语义并存）。
// 工作流列表是动态的，watchEffect 随列表变化注册/清理每个卡片的落点。
watchEffect((onCleanup) => {
  const keys: string[] = []
  for (const w of state.workflows) {
    const key = `wf:${w.name}`
    keys.push(key)
    dropZones.set(key, (item: DragItem) => {
      if (item.asset) void applyAssetToWorkflow(item.asset, w.name)
      else if (item.path) ui.assetInspect = item.path
    })
  }
  onCleanup(() => {
    for (const k of keys) dropZones.delete(k)
  })
})

// ---- 树形分组渲染：组头（含空组）→ 组内工作流 → 未分组区 ----
// 组 = workflows/ 下的一级子目录（Rust 扫描）；归组/移组/改名 = 文件移动（renameWorkflow 全链路迁移引用）
const COLLAPSE_KEY = 'comfyui-studio.groupCollapsed:v1'

const collapsed = ref<Record<string, boolean>>(
  (() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY)
      if (raw) {
        const obj = JSON.parse(raw)
        if (obj && typeof obj === 'object') return obj
      }
    } catch {
      /* 忽略损坏数据 */
    }
    return {}
  })()
)

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed.value))
  } catch {
    /* 忽略存储失败 */
  }
}

function toggleGroup(name: string) {
  collapsed.value = { ...collapsed.value, [name]: !collapsed.value[name] }
  saveCollapsed()
}

type Row =
  | { kind: 'group'; name: string; count: number; collapsed: boolean }
  | { kind: 'wf'; w: WorkflowMeta }

/** 扁平渲染列表：组头行 + 组内工作流行（折叠则隐藏组内）；末尾固定「未分组」区 */
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const seen = new Set<string>()
  for (const g of state.workflowGroups) {
    const mine = state.workflows.filter((w) => w.group === g)
    seen.add(g)
    out.push({ kind: 'group', name: g, count: mine.length, collapsed: !!collapsed.value[g] })
    if (!collapsed.value[g]) for (const w of mine) out.push({ kind: 'wf', w })
  }
  // 顶层（无组）+ 组目录被手动删掉的兜底回落
  const loose = state.workflows.filter((w) => !w.group || !seen.has(w.group))
  out.push({ kind: 'group', name: '', count: loose.length, collapsed: !!collapsed.value[''] })
  if (!collapsed.value['']) for (const w of loose) out.push({ kind: 'wf', w })
  return out
})

/** 工作流显示名：只显示文件名段（组名在组头） */
function wfLabel(w: WorkflowMeta) {
  return w.name.split('/').pop() ?? w.name
}

/** 归组 / 移出分组：本质是文件移动（组/名 ↔ 名），引用迁移复用 renameWorkflow */
async function moveToGroup(w: WorkflowMeta, group: string) {
  if (w.group === group) return
  const stem = w.name.split('/').pop() ?? w.name
  const target = group ? `${group}/${stem}` : stem
  await renameWorkflow(w.name, target)
  await loadWorkflows() // 组列表/归属变了，重新扫描
}

// ---- 工作流列表拖拽（pointer 模拟）：同组内排序；拖到组头 = 归组，拖到「未分组」头 = 移出 ----
const reorder = reactive({ active: false, from: -1, to: -1, groupHot: '' })
let reorderEndedAt = 0

function dropTargetAt(x: number, y: number): { idx: number; group: string | null } {
  const el = document.elementFromPoint(x, y)
  const gh = el?.closest('[data-group-name]') as HTMLElement | null
  if (gh) return { idx: -1, group: gh.getAttribute('data-group-name') ?? '' }
  const wi = el?.closest('[data-wf-idx]') as HTMLElement | null
  return { idx: wi ? Number(wi.getAttribute('data-wf-idx')) : -1, group: null }
}

function onItemPointerDown(e: PointerEvent, idx: number) {
  if (e.button !== 0) return
  if (editingWf.value || editingGroup.value) return // 改名输入中：不动
  if ((e.target as HTMLElement).closest('.wf-ops') || (e.target as HTMLElement).closest('.g-ops'))
    return // 操作按钮不触发拖拽
  const startY = e.clientY
  let started = false
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.abs(ev.clientY - startY) < 6) return
      started = true
      reorder.active = true
      reorder.from = idx
      reorder.to = -1
      reorder.groupHot = ''
    }
    const t = dropTargetAt(ev.clientX, ev.clientY)
    reorder.to = t.idx
    reorder.groupHot = t.group ?? ''
  }
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (started) {
      reorderEndedAt = Date.now()
      const fromRow = rows.value[idx]
      const t = dropTargetAt(ev.clientX, ev.clientY)
      if (fromRow && fromRow.kind === 'wf') {
        if (t.group !== null) {
          // 拖到组头 / 未分组头：归组（组头都带 data-group-name，包括未分组 ''）
          const g = t.group
          if (g !== fromRow.w.group) void moveToGroup(fromRow.w, g)
        } else if (t.idx >= 0 && t.idx !== idx) {
          const toRow = rows.value[t.idx]
          // 同组内排序：换到目标工作流前面（在全局数组里操作，保持 workflowOrder 全序）
          if (toRow && toRow.kind === 'wf' && toRow.w.group === fromRow.w.group) {
            const gi = state.workflows.indexOf(fromRow.w)
            const gj = state.workflows.indexOf(toRow.w)
            if (gi >= 0 && gj >= 0 && gi !== gj) {
              state.workflows.splice(gi, 1)
              state.workflows.splice(gj, 0, fromRow.w)
              void persistWorkflowOrder(state.workflows.map((w) => w.name))
            }
          }
        }
      }
    }
    reorder.active = false
    reorder.groupHot = ''
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function onWfClick(w: WorkflowMeta) {
  // 刚结束的排序拖拽 / 资产拖拽派发的 click 不当选择处理；改名输入中不响应
  if (Date.now() - reorderEndedAt < 120 || isDragClick()) return
  if (editingWf.value || editingGroup.value) return
  void selectWorkflow(w.name)
}

// ---- 工作流行内改名：✎ → 输入框（只改文件名段，分组不变），Enter/失焦确认，Esc 取消 ----
const editingWf = ref<string | null>(null)
const editWfName = ref('')

function startRename(w: WorkflowMeta) {
  editingWf.value = w.name
  editWfName.value = wfLabel(w)
  nextTick(() => {
    const el = document.getElementById('wf-rename') as HTMLInputElement | null
    el?.focus()
    el?.select()
  })
}

function confirmRename(w: WorkflowMeta) {
  if (editingWf.value !== w.name) return
  const newName = editWfName.value.trim()
  editingWf.value = null
  if (!newName || newName === wfLabel(w)) return
  // 名字可能带点（0.6+5步），只改文件名段、保留分组前缀
  const target = w.group ? `${w.group}/${newName}` : newName
  void renameWorkflow(w.name, target)
}

function cancelRename() {
  editingWf.value = null
}

// ---- 分组管理：新建 / 改名 / 删组（组 = 真实子目录；删组不删工作流，全部回落未分组） ----
const editingGroup = ref<string | null>(null)
const editGroupName = ref('')
const creatingGroup = ref(false)
const newGroupName = ref('')

function startGroupRename(name: string) {
  editingGroup.value = name
  editGroupName.value = name
  nextTick(() => {
    const el = document.getElementById('group-rename') as HTMLInputElement | null
    el?.focus()
    el?.select()
  })
}

async function confirmGroupRename(oldName: string) {
  if (editingGroup.value !== oldName) return
  const newName = editGroupName.value.trim()
  editingGroup.value = null
  if (!newName || newName === oldName) return
  if (state.workflowGroups.includes(newName)) {
    notify(`已存在同名分组「${newName}」`, 'warn', 5000)
    return
  }
  const mine = state.workflows.filter((w) => w.group === oldName)
  try {
    // 组内逐个文件移动到新组（renameWorkflow 同步迁移排序/固定/已填值/模板绑定）
    for (const w of mine) {
      const stem = w.name.split('/').pop() ?? w.name
      await renameWorkflow(w.name, `${newName}/${stem}`)
    }
    if (!mine.length) {
      // 空组：直接建新删旧
      await api.createWorkflowGroup(newName)
      await api.deleteWorkflowGroup(oldName)
    }
    // 折叠状态跟着迁
    if (collapsed.value[oldName]) {
      const next = { ...collapsed.value }
      delete next[oldName]
      next[newName] = true
      collapsed.value = next
      saveCollapsed()
    }
    await loadWorkflows()
    notify(`分组已改名：「${oldName}」→「${newName}」`, 'ok', 3000)
  } catch (e) {
    notify(`分组改名失败：${e}`, 'error', 8000)
    await loadWorkflows()
  }
}

async function removeGroup(name: string) {
  const mine = state.workflows.filter((w) => w.group === name)
  const msg = mine.length
    ? `分组「${name}」里有 ${mine.length} 个工作流，删除分组会把它们移回未分组（不删文件）。继续？`
    : `确定删除空分组「${name}」？`
  if (!window.confirm(msg)) return
  try {
    for (const w of mine) {
      const stem = w.name.split('/').pop() ?? w.name
      await renameWorkflow(w.name, stem) // 移回顶层
    }
    await api.deleteWorkflowGroup(name) // 此时必空；若移出失败会报「还有工作流」
    await loadWorkflows()
    notify(`已删除分组「${name}」`, 'info', 3000)
  } catch (e) {
    notify(`删除分组失败：${e}`, 'error', 8000)
    await loadWorkflows()
  }
}

async function confirmCreateGroup() {
  const name = newGroupName.value.trim()
  creatingGroup.value = false
  newGroupName.value = ''
  if (!name) return
  try {
    await api.createWorkflowGroup(name)
    await loadWorkflows()
    notify(`已创建分组「${name}」，把工作流拖到组头即可归组`, 'ok', 4000)
  } catch (e) {
    notify(`创建分组失败：${e}`, 'error', 8000)
  }
}

async function importWorkflow() {
  const picked = await open({
    multiple: true,
    filters: [{ name: '工作流 JSON', extensions: ['json'] }],
  })
  if (!picked) return
  const files = Array.isArray(picked) ? picked : [picked]
  let ok = 0
  for (const f of files) {
    try {
      await api.importWorkflow(f)
      ok++
    } catch (e) {
      notify(`导入失败（${f.split(/[\\/]/).pop()}）：${e}`, 'error', 9000)
    }
  }
  if (ok) {
    await loadWorkflows()
    notify(`已导入 ${ok} 个工作流`, 'ok')
  }
}

async function remove(name: string) {
  // 双保险：固定的不删（UI 上删除按钮已隐藏）
  if (isWorkflowPinned(name)) {
    notify(`「${name}」已固定，先取消固定再删除`, 'warn', 5000)
    return
  }
  if (!window.confirm(`确定删除工作流「${name}」？此操作不可撤销。`)) return
  try {
    await api.deleteWorkflow(name)
    if (state.currentWorkflow === name) {
      state.currentWorkflow = null
      state.graph = null
      state.fields = []
    }
    await loadWorkflows()
    notify(`已删除 ${name}`, 'info')
  } catch (e) {
    notify(`删除失败：${e}`, 'error')
  }
}

async function openDir() {
  try {
    const dir = await api.appDataDir()
    await revealItemInDir(`${dir}\\workflows`)
  } catch (e) {
    notify(`打开目录失败：${e}`, 'error')
  }
}
</script>

<template>
  <section class="panel" data-drop-zone="workflow-panel" :class="{ 'drag-hot': !!dragGhost.item }">
    <header class="head">
      <h2>工作流</h2>
      <div class="head-actions">
        <button class="btn sm" @click="importWorkflow">+ 导入</button>
        <button class="btn sm ghost" title="从产出图反查工作流" @click="ui.assetPick = true">
          🖼
        </button>
        <button class="btn sm ghost" title="打开工作流目录" @click="openDir">📁</button>
      </div>
    </header>

    <div class="body" :class="{ reordering: reorder.active }">
      <!-- 加载骨架：首次读取列表时占位（列表已有内容时不闪） -->
      <div v-if="state.workflowsLoading && !state.workflows.length" class="skel-list">
        <div v-for="i in 4" :key="i" class="skel-item" />
      </div>

      <div v-if="!state.workflows.length && !state.workflowGroups.length && !state.workflowsLoading" class="empty">
        还没有工作流。<br />
        点「+ 导入」，选择 ComfyUI 里<br /><b>导出 (API)</b> 得到的 JSON 文件。<br /><br />
        或者把 ComfyUI 生成的<b>图片/视频直接拖进窗口</b>，<br />自动反查它内嵌的工作流。
      </div>

      <template v-for="(row, ri) in rows" :key="row.kind === 'group' ? 'g:' + row.name : 'w:' + row.w.name">
        <!-- 组头：点击展开/收起；拖工作流到这里 = 归组（未分组头 = 移出） -->
        <div
          v-if="row.kind === 'group'"
          class="group-head"
          :class="{ 'group-hot': reorder.active && reorder.groupHot === row.name }"
          :data-group-name="row.name"
          :title="row.name ? '点击展开/收起 · 把工作流拖到这里归组' : '未分组：拖到这里移出分组'"
          @click="toggleGroup(row.name)"
        >
          <span class="tri" :class="{ open: !row.collapsed }" />
          <template v-if="editingGroup === row.name">
            <input
              id="group-rename"
              v-model="editGroupName"
              class="wf-rename"
              @click.stop
              @pointerdown.stop
              @keydown.enter.prevent="confirmGroupRename(row.name)"
              @keydown.esc.prevent="editingGroup = null"
              @blur="confirmGroupRename(row.name)"
            />
          </template>
          <template v-else>
            <span class="g-name">{{ row.name || '未分组' }}</span>
          </template>
          <span class="g-count">{{ row.count }}</span>
          <span v-if="row.name" class="g-ops">
            <span class="op ren" title="分组改名" @click.stop="startGroupRename(row.name)">✎</span>
            <span class="op del" title="删除分组（工作流移回未分组）" @click.stop="removeGroup(row.name)">✕</span>
          </span>
          <span v-else class="g-hint">拖到这里移出分组</span>
        </div>

        <!-- 工作流行（组内缩进显示文件名段） -->
        <button
          v-else
          class="wf-item"
          :class="{
            active: row.w.name === state.currentWorkflow,
            dragging: reorder.active && reorder.from === ri,
            'drop-target': reorder.active && reorder.to === ri && reorder.to !== reorder.from,
            'in-group': !!row.w.group,
          }"
          :data-wf-idx="ri"
          :data-drop-zone="'wf:' + row.w.name"
          :title="row.w.name + ' · 点击载入 · 拖动排序 · 拖到组头归组'"
          @click="onWfClick(row.w)"
          @pointerdown="onItemPointerDown($event, ri)"
        >
          <template v-if="editingWf === row.w.name">
            <input
              id="wf-rename"
              v-model="editWfName"
              class="wf-rename"
              @click.stop
              @pointerdown.stop
              @keydown.enter.prevent="confirmRename(row.w)"
              @keydown.esc.prevent="cancelRename"
              @blur="confirmRename(row.w)"
            />
          </template>
          <template v-else>
            <span class="wf-name" :title="row.w.name">
              {{ wfLabel(row.w) }}
              <span v-if="row.w.broken" class="broken" title="JSON 解析失败">!</span>
            </span>
            <span class="wf-meta">
              {{ row.w.nodeCount }} 节点<template v-if="!row.w.hasMeta"> · 无标题</template>
            </span>
          </template>
          <span class="wf-ops">
            <span
              class="op pin"
              :class="{ on: isWorkflowPinned(row.w.name) }"
              :title="isWorkflowPinned(row.w.name) ? '取消固定' : '固定（固定后不可删除）'"
              @click.stop="toggleWorkflowPin(row.w.name)"
            >📌</span>
            <span class="op ren" title="改名" @click.stop="startRename(row.w)">✎</span>
            <span
              v-if="!isWorkflowPinned(row.w.name)"
              class="op del"
              title="删除"
              @click.stop="remove(row.w.name)"
            >✕</span>
          </span>
        </button>
      </template>

      <!-- 新建分组：虚线行，点击变输入 -->
      <div v-if="creatingGroup" class="group-create">
        <input
          v-model="newGroupName"
          class="wf-rename"
          placeholder="分组名，回车确认（Esc 取消）"
          @keydown.enter.prevent="confirmCreateGroup"
          @keydown.esc.prevent="creatingGroup = false"
          @blur="confirmCreateGroup"
        />
      </div>
      <button v-else class="group-add" title="新建分组（workflows/ 下建一个子目录）" @click="creatingGroup = true">
        ＋ 新建分组
      </button>
    </div>
  </section>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-1);
  min-width: 0;
}
/* 拖着资产悬停时的落点提示 */
.panel.drag-hot {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
}
/* 资产拖到具体卡片上：卡片亮边提示「松手设为该模板的参考图」 */
.panel.drag-hot .wf-item:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}
/* 拖拽排序中的状态 */
.body.reordering {
  user-select: none;
  cursor: grabbing;
}
.wf-item.dragging {
  opacity: 0.35;
}
.wf-item.drop-target {
  box-shadow: inset 0 2px 0 var(--accent);
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-soft);
  flex: none;
}
.head h2 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.head-actions {
  display: flex;
  gap: 6px;
}
.body {
  flex: 1;
  overflow: auto;
  padding: 8px;
}
/* 首次加载骨架 */
.skel-item {
  height: 44px;
  border-radius: var(--radius-sm);
  margin-bottom: 4px;
  background: linear-gradient(90deg, var(--bg-2) 25%, var(--bg-3) 45%, var(--bg-2) 65%);
  background-size: 200% 100%;
  animation: wf-skel 1.2s infinite linear;
}
@keyframes wf-skel {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}
.wf-item {
  position: relative;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  padding: 9px 64px 9px 10px; /* 右侧给操作组留位 */
  margin-bottom: 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  transition: background 0.14s, border-color 0.14s;
}
/* 组内工作流：缩进 + 左侧树连接线 */
.wf-item.in-group {
  margin-left: 18px;
  width: calc(100% - 18px);
}
/* 组头行 */
.group-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  margin-bottom: 4px;
  border-radius: var(--radius-sm);
  background: var(--bg-2);
  cursor: pointer;
  user-select: none;
  transition: background 0.14s, box-shadow 0.14s;
}
.group-head:hover {
  background: var(--bg-3);
}
/* 拖工作流悬停在组头上 = 归组落点高亮 */
.group-head.group-hot {
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px var(--accent);
}
/* 展开/收起三角 */
.tri {
  flex: none;
  width: 0;
  height: 0;
  border-left: 5px solid var(--text-faint);
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  transition: transform 0.14s;
}
.tri.open {
  transform: rotate(90deg);
}
.g-name {
  font-size: 12px;
  font-weight: 500;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.g-count {
  font-size: 10.5px;
  color: var(--text-faint);
  background: var(--bg-1);
  border-radius: 999px;
  padding: 1px 7px;
  line-height: 1.4;
}
.g-hint {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--text-faint);
  opacity: 0.7;
}
/* 组头操作组（与 wf-ops 同款 hover 显隐） */
.g-ops {
  position: absolute;
  right: 6px;
  display: flex;
  gap: 2px;
}
.g-ops .op {
  opacity: 0;
}
.group-head:hover .g-ops .op {
  opacity: 1;
}
/* 新建分组虚线行 */
.group-add {
  width: 100%;
  padding: 7px 0;
  margin-top: 2px;
  border: 1px dashed var(--border-soft);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-faint);
  font-size: 11.5px;
  cursor: pointer;
  transition: border-color 0.14s, color 0.14s;
}
.group-add:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.group-create {
  margin-top: 2px;
}
.wf-item:hover {
  background: var(--bg-2);
}
.wf-item.active {
  background: var(--accent-soft);
  border-color: #7c8cff55;
}
.wf-name {
  font-size: 12.5px;
  font-weight: 500;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.broken {
  color: var(--err);
}
.wf-meta {
  font-size: 11px;
  color: var(--text-faint);
}
/* 右侧操作组：固定 / 改名 / 删除（hover 出现；固定的 📌 常亮） */
.wf-ops {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  gap: 2px;
}
.op {
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1;
  padding: 3px 5px;
  border-radius: 4px;
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.12s, background 0.14s, color 0.14s;
}
.wf-item:hover .op {
  opacity: 1;
}
.op.pin.on {
  opacity: 1;
  color: var(--accent);
}
.op.ren:hover {
  background: var(--bg-3);
  color: inherit;
}
.op.del:hover {
  background: #f8717122;
  color: var(--err);
}
/* 行内改名输入框 */
.wf-rename {
  width: 100%;
  font-size: 12.5px;
  padding: 2px 6px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--bg-1);
  color: inherit;
  outline: none;
}
</style>
