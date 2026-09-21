<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, watchEffect } from 'vue'
import { api } from '../api/tauri'
import { open } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import {
  applyAssetToWorkflow,
  dragGhost,
  dropZones,
  isDragClick,
  loadWorkflows,
  notify,
  openAssetWorkflow,
  persistWorkflowOrder,
  selectWorkflow,
  state,
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
  // 便携模式：数据根目录跟随程序所在位置，动态显示真实路径
  api.appDataDir().then((d) => (dataDir.value = d)).catch(() => {})
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

// ---- 工作流列表拖拽排序（pointer 模拟：HTML5 DnD 被 WebView2 的 dragDropEnabled 吞掉）----
// 按下 → 纵向移动超阈值进入排序 → 实时高亮目标位 → 松手换位并持久化到 settings.workflowOrder
const reorder = reactive({ active: false, from: -1, to: -1 })
let reorderEndedAt = 0

function idxAt(x: number, y: number): number {
  const el = document.elementFromPoint(x, y)?.closest('[data-wf-idx]')
  return el ? Number(el.getAttribute('data-wf-idx')) : -1
}

function onItemPointerDown(e: PointerEvent, idx: number) {
  if (e.button !== 0) return
  if ((e.target as HTMLElement).closest('.del')) return // 删除按钮不触发拖拽
  const startY = e.clientY
  let started = false
  const move = (ev: PointerEvent) => {
    if (!started) {
      if (Math.abs(ev.clientY - startY) < 6) return
      started = true
      reorder.active = true
      reorder.from = idx
      reorder.to = idx
    }
    const t = idxAt(ev.clientX, ev.clientY)
    if (t >= 0) reorder.to = t
  }
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (started) {
      reorderEndedAt = Date.now()
      const to = idxAt(ev.clientX, ev.clientY)
      if (to >= 0 && to !== idx) {
        const [item] = state.workflows.splice(idx, 1)
        state.workflows.splice(to, 0, item)
        void persistWorkflowOrder(state.workflows.map((w) => w.name))
      }
    }
    reorder.active = false
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function onWfClick(w: WorkflowMeta) {
  // 刚结束的排序拖拽 / 资产拖拽派发的 click 不当选择处理
  if (Date.now() - reorderEndedAt < 120 || isDragClick()) return
  void selectWorkflow(w.name)
}

const dataDir = ref('')

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

      <div v-if="!state.workflows.length && !state.workflowsLoading" class="empty">
        还没有工作流。<br />
        点「+ 导入」，选择 ComfyUI 里<br /><b>导出 (API)</b> 得到的 JSON 文件。<br /><br />
        或者把 ComfyUI 生成的<b>图片/视频直接拖进窗口</b>，<br />自动反查它内嵌的工作流。
      </div>

      <button
        v-for="(w, i) in state.workflows"
        :key="w.name"
        class="wf-item"
        :class="{
          active: w.name === state.currentWorkflow,
          dragging: reorder.active && reorder.from === i,
          'drop-target': reorder.active && reorder.to === i && reorder.to !== reorder.from,
        }"
        :data-wf-idx="i"
        :data-drop-zone="'wf:' + w.name"
        :title="'点击载入 · 拖动排序 · 拖入结果图可设为参考图'"
        @click="onWfClick(w)"
        @pointerdown="onItemPointerDown($event, i)"
      >
        <span class="wf-name" :title="w.name">
          {{ w.name }}
          <span v-if="w.broken" class="broken" title="JSON 解析失败">!</span>
        </span>
        <span class="wf-meta">
          {{ w.nodeCount }} 节点<template v-if="!w.hasMeta"> · 无标题</template>
        </span>
        <span class="del" title="删除" @click.stop="remove(w.name)">✕</span>
      </button>
    </div>

    <footer class="foot">
      <span class="faint">
        工作流与模板保存在程序旁
        <code :title="dataDir">{{ dataDir || 'data\\' }}</code>
        （便携模式：整个程序文件夹拷走数据跟着走）
      </span>
    </footer>
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
  padding: 9px 26px 9px 10px;
  margin-bottom: 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  text-align: left;
  transition: background 0.14s, border-color 0.14s;
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
.del {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-faint);
  font-size: 12px;
  padding: 2px 5px;
  border-radius: 4px;
  opacity: 0;
}
.wf-item:hover .del {
  opacity: 1;
}
.del:hover {
  background: #f8717122;
  color: var(--err);
}
.foot {
  padding: 9px 12px;
  border-top: 1px solid var(--border-soft);
  font-size: 11px;
  line-height: 1.6;
  flex: none;
}
.foot code {
  background: var(--bg-3);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 10.5px;
}
</style>
