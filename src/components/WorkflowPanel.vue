<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from '../api/tauri'
import { open } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { dragGhost, dropZones, loadWorkflows, notify, openAssetWorkflow, selectWorkflow, state } from '../store'
import { ui } from '../ui'

// 拖拽落点区：结果资产 / 本地资产拖到这里 → 打开它内嵌的工作流
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

    <div class="body">
      <div v-if="!state.workflows.length" class="empty">
        还没有工作流。<br />
        点「+ 导入」，选择 ComfyUI 里<br /><b>导出 (API)</b> 得到的 JSON 文件。<br /><br />
        或者把 ComfyUI 生成的<b>图片/视频直接拖进窗口</b>，<br />自动反查它内嵌的工作流。
      </div>

      <button
        v-for="w in state.workflows"
        :key="w.name"
        class="wf-item"
        :class="{ active: w.name === state.currentWorkflow }"
        @click="selectWorkflow(w.name)"
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
