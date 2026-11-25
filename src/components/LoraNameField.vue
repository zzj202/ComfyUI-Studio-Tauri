<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { FieldSchema } from '../core/types'
import { api } from '../api/tauri'
import { notify, primaryBase, state } from '../store'

/**
 * 人物Lora 组件：节点标题叫「人物Lora」（或字段喂给 LoraLoader 的 lora_name）时启用。
 * 可文本输入（手动填完整文件名）；⌄ 按钮下面垫一层透明的原生 <select>——
 * 点它弹的是操作系统级列表（搜索靠输入框自己，列表零 CSS 风险）；
 * 自定义快捷键 chips 一行（按工作流分隔，localStorage 持久化，上限 24 条）。
 */
const props = defineProps<{ field: FieldSchema }>()

/** 纯图结构扫描：本字段喂给哪个 LoraLoader 类节点的 lora_name（离线也能识别） */
const loraLink = computed<string | null>(() => {
  const g = state.graph as Record<string, any> | null
  const nid = props.field.nodeId
  if (!g || !nid) return null
  for (const n of Object.values<any>(g)) {
    if (!/loraloader/i.test(String(n?.class_type ?? ''))) continue
    const v = n?.inputs?.lora_name
    if (Array.isArray(v) && v[0] === nid) return String(n.class_type)
  }
  return null
})

const loraOpts = ref<string[] | null>(null)
const loadingLoras = ref(false)

async function loadLoraOptions() {
  if (loraOpts.value || !loraLink.value || loadingLoras.value) return
  loadingLoras.value = true
  try {
    const def = await api.objectInfo(primaryBase(), loraLink.value)
    const list = def?.[loraLink.value]?.input?.required?.lora_name?.[0]
    loraOpts.value = Array.isArray(list) ? list.map(String) : []
    if (!loraOpts.value.length) notify('服务器没返回 Lora 列表，可直接在输入框里填文件名', 'warn', 4000)
  } catch {
    loraOpts.value = []
    notify('拉取服务器 Lora 列表失败（离线或连不上节点），可直接在输入框里填文件名', 'warn', 4000)
  } finally {
    loadingLoras.value = false
  }
}

function onNativePick(e: Event) {
  const v = (e.target as HTMLSelectElement).value
  if (v) props.field.value = v
}

/** chips 显示名：去掉 .safetensors 等扩展名 */
function loraLabel(name: string) {
  return name.replace(/\.(safetensors|sft|pt|ckpt)$/i, '')
}

const hasList = computed(() => (loraOpts.value?.length ?? 0) > 0)

// ---- 自定义快捷键：按工作流分隔（各工作流各存一套，localStorage 持久化，上限 24 条） ----

const SC_KEY = 'comfyui-studio.loraShortcuts:v1'

/** 读当前工作流的快捷键（旧版全局数组一次性并入当前工作流做迁移） */
function loadScArr(): string[] {
  const wf = state.currentWorkflow ?? ''
  try {
    const raw = JSON.parse(localStorage.getItem(SC_KEY) ?? 'null')
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean).slice(0, 24) // 旧版全局数组
    const bucket = raw && typeof raw === 'object' ? raw[wf] : null
    return Array.isArray(bucket) ? bucket.map(String).filter(Boolean).slice(0, 24) : []
  } catch {
    return []
  }
}

function saveScArr() {
  const wf = state.currentWorkflow ?? ''
  try {
    let obj: Record<string, any> = {}
    const raw = JSON.parse(localStorage.getItem(SC_KEY) ?? 'null')
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) obj = raw
    obj[wf] = shortcuts.value
    localStorage.setItem(SC_KEY, JSON.stringify(obj))
  } catch {
    /* ignore */
  }
}

const shortcuts = ref<string[]>(loadScArr())
const scAdding = ref(false)
const scPick = ref('')
const scText = ref('')

// 切工作流：换读对应工作流那套快捷键
watch(
  () => state.currentWorkflow,
  () => {
    shortcuts.value = loadScArr()
    scAdding.value = false
  }
)

function startSc() {
  scPick.value = String(props.field.value ?? '')
  scText.value = ''
  scAdding.value = true
}

function addShortcut() {
  const v = (hasList.value ? scPick.value : scText.value).trim()
  scAdding.value = false
  if (!v) return
  if (!shortcuts.value.includes(v)) {
    shortcuts.value.unshift(v)
    if (shortcuts.value.length > 24) shortcuts.value.length = 24
    saveScArr()
  }
  props.field.value = v // 存完顺手填过去
}

function removeShortcut(i: number) {
  shortcuts.value.splice(i, 1)
  saveScArr()
}

if (loraLink.value) loadLoraOptions()
</script>

<template>
  <div class="ln-field">
    <div class="in-row">
      <!-- 可文本输入：手动填完整文件名（也能吃其他方式写进来的值） -->
      <input
        v-model="field.value"
        class="input"
        placeholder="Lora 文件名，如 xxx.safetensors"
        @focus="loadLoraOptions"
      />
      <!-- ⌄ 面壳：下面垫透明原生 select，点它弹系统级列表（列表样式零风险） -->
      <span v-if="hasList" class="dd-wrap" title="点开服务器 Lora 列表选择">
        <select
          class="dd-native"
          :value="String(field.value ?? '')"
          @change="onNativePick"
        >
          <option v-for="o in loraOpts ?? []" :key="o" :value="o">{{ o }}</option>
        </select>
        <button class="btn sm dd-btn" tabindex="-1">⌄</button>
      </span>
      <button
        v-else-if="loraLink"
        class="btn sm dd-btn"
        :disabled="loadingLoras"
        :title="loadingLoras ? '正在拉取服务器 Lora 列表…' : '拉取服务器 Lora 列表'"
        @click="loadLoraOptions"
      >
        {{ loadingLoras ? '…' : '⌄' }}
      </button>
    </div>

    <!-- 自定义快捷键行：点一下填入，悬停 × 删除；＋快捷存当前常用 -->
    <div class="sc-row">
      <button
        v-for="(s, i) in shortcuts"
        :key="s"
        class="chip sc"
        :class="{ on: field.value === s }"
        :title="`快捷键：一键填入 ${s}（悬停 × 可删除）`"
        @click="field.value = s"
      >
        <span class="q-text">{{ loraLabel(s) }}</span>
        <span class="q-del" title="删除该快捷键" @click.stop="removeShortcut(i)">×</span>
      </button>
      <button
        v-if="!scAdding"
        class="chip ghost"
        title="把常用 Lora 存成快捷键，点一下就能填入"
        @click="startSc"
      >
        ＋ 快捷
      </button>
      <span v-else class="sc-editor">
        <select v-if="hasList" v-model="scPick" class="select sc-select" title="选择要存成快捷键的 Lora">
          <option v-for="o in loraOpts ?? []" :key="o" :value="o">{{ loraLabel(o) }}</option>
        </select>
        <input
          v-else
          v-model="scText"
          class="input sc-input"
          placeholder="完整文件名，回车保存"
          @keydown.enter.prevent="addShortcut"
          @keydown.esc="scAdding = false"
        />
        <button class="btn sm" @click="addShortcut">保存</button>
        <button class="btn sm ghost" @click="scAdding = false">取消</button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.ln-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.in-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.in-row > .input {
  flex: 1;
  min-width: 0;
}
/* ⌄ 列表按钮：面壳 + 垫在下面的透明原生 select（内联样式兜底，见模板） */
.dd-wrap {
  position: relative;
  display: inline-flex;
  flex: none;
}
.dd-native {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  border: 0;
  padding: 0;
  margin: 0;
}
.dd-btn {
  pointer-events: none;
  min-width: 30px;
  padding: 0 8px;
  font-size: 13px;
  line-height: 1;
}
/* 快捷键行 */
.sc-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-2);
  color: var(--text-dim);
  cursor: pointer;
  line-height: 1.5;
  white-space: nowrap;
}
.chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.chip.on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.chip.ghost {
  color: var(--text-faint);
  background: transparent;
  border-style: dashed;
}
.chip.sc .q-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}
.chip.sc .q-del {
  color: var(--text-faint);
  font-size: 12px;
  line-height: 1;
  padding: 0 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.chip.sc:hover .q-del {
  opacity: 1;
}
.chip.sc .q-del:hover {
  color: var(--err);
}
/* 快捷键编辑器 */
.sc-editor {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sc-input {
  width: 170px;
  font-size: 11.5px;
  padding: 2px 8px;
}
.sc-select {
  width: 190px;
  font-size: 11.5px;
  padding: 2px 8px;
}
</style>
