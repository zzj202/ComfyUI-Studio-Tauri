<script setup lang="ts">
import { ref, watch } from 'vue'
import type { FieldSchema } from '../core/types'
import { notify, state } from '../store'

/**
 * 人物Lora强度 组件：节点标题叫「人物Lora强度」（或字段喂给 LoraLoader 的
 * strength_model / strength_clip / lora_strength）时启用。
 * −/＋ 固定 0.1 步进 + 默认快捷键 0.9~1.5 + 自定义快捷键
 * （全局共享，localStorage 持久化，悬停 × 删除，上限 24 条）。
 */
const props = defineProps<{ field: FieldSchema }>()

const STEP = 0.1

/** 默认快捷键：0.9 到 1.5（0.1 一档） */
const PRESETS = [0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5]

/** −/＋ 步进：0.1 一档，浮点精度修正到 2 位，min/max 有定义时夹紧 */
function bump(dir: 1 | -1) {
  const f = props.field
  let v = Number(f.value) || 0
  v = Math.round((v + dir * STEP) * 100) / 100
  if (f.min != null) v = Math.max(f.min, v)
  if (f.max != null) v = Math.min(f.max, v)
  f.value = v
}

/** 浮点相等（快捷键高亮用，避开 0.1+0.2 类精度坑） */
function numEq(a: any, b: any): boolean {
  const x = Number(a)
  const y = Number(b)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  return Math.abs(x - y) < 1e-6
}

// ---- 自定义快捷键：按工作流分隔（各工作流各存一套，localStorage 持久化，上限 24 条） ----

const SC_KEY = 'comfyui-studio.strengthShortcuts:v1'

/** 读当前工作流的快捷键（旧版全局数组迁移：一次性并入当前工作流） */
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

// 切工作流：换读对应工作流那套快捷键
watch(
  () => state.currentWorkflow,
  () => {
    shortcuts.value = loadScArr()
    scAdding.value = false
  }
)
const scAdding = ref(false)
const scInput = ref('')

function addShortcut() {
  const raw = scInput.value.trim()
  scAdding.value = false
  if (!raw) return
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    notify('快捷键要填数字，比如 0.85', 'warn', 3000)
    return
  }
  const v = String(Math.round(n * 100) / 100)
  if (!shortcuts.value.some((x) => Number(x) === Number(v))) {
    shortcuts.value.unshift(v)
    if (shortcuts.value.length > 24) shortcuts.value.length = 24
    saveScArr()
  }
  props.field.value = Number(v)
}

function removeShortcut(i: number) {
  shortcuts.value.splice(i, 1)
  saveScArr()
}
</script>

<template>
  <div class="ls-field">
    <div class="num-row">
      <button class="btn sm step-btn" title="减小 0.1" @click="bump(-1)">−</button>
      <input v-model.number="field.value" type="number" class="input" :step="STEP" :min="field.min" :max="field.max" />
      <button class="btn sm step-btn" title="加大 0.1" @click="bump(1)">＋</button>
    </div>
    <div class="presets">
      <!-- 自定义快捷键 chips：点一下填入，悬停 × 删除 -->
      <button
        v-for="(s, i) in shortcuts"
        :key="'sc' + s"
        class="chip sc"
        :class="{ on: numEq(field.value, s) }"
        :title="`快捷键：一键填入 ${s}（悬停 × 可删除）`"
        @click="field.value = Number(s)"
      >
        {{ s }}
        <span class="q-del" title="删除该快捷键" @click.stop="removeShortcut(i)">×</span>
      </button>
      <!-- 默认快捷键 0.9~1.5 -->
      <button
        v-for="p in PRESETS"
        :key="p"
        class="chip"
        :class="{ on: numEq(field.value, p) }"
        :title="`一键填入 ${p}`"
        @click="field.value = p"
      >
        {{ p.toFixed(1) }}
      </button>
      <button
        v-if="!scAdding"
        class="chip ghost"
        title="把常用强度值存成快捷键（如 0.85），点一下就能填入"
        @click="scAdding = true"
      >
        ＋ 快捷
      </button>
      <span v-else class="sc-editor">
        <input
          v-model="scInput"
          class="input sc-input"
          placeholder="强度值，如 0.85"
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
.ls-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.num-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.num-row .input[type='number'] {
  width: 96px;
  flex: none;
}
.step-btn {
  flex: none;
  min-width: 30px;
  padding: 0 8px;
  font-size: 13px;
  line-height: 1;
}
.presets {
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
  font-variant-numeric: tabular-nums;
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
.sc-editor {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sc-input {
  width: 110px;
  font-size: 11.5px;
  padding: 2px 8px;
}
</style>
