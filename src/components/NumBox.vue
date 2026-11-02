<script setup lang="ts">
/**
 * 参数数值：平时是一段灰色数值文字，点一下变输入框。
 * - 单击 → 变成输入框（选中全部），回车/失焦生效，Esc 取消
 * - 双击 → 恢复默认值（dflt）
 * - 输入框内 ↑/↓ 微调一格，按住 Shift 走 10 格
 * 目的：滑块调不到精确值、也没法一眼看出当前值的时候能直接敲数字。
 */
import { nextTick, ref } from 'vue'

const props = defineProps<{
  min?: number
  max?: number
  /** ↑/↓ 一次走多少 */
  step?: number
  unit?: string
  /** 双击恢复到的默认值（不传则双击无效） */
  dflt?: number
}>()

const model = defineModel<number>({ required: true })

const editing = ref(false)
const draft = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
let clickTimer: number | null = null

function clamp(v: number): number {
  let x = v
  if (props.min != null) x = Math.max(props.min, x)
  if (props.max != null) x = Math.min(props.max, x)
  // 避免 0.30000000000000004 这类浮点尾巴
  return Math.round(x * 1000) / 1000
}

async function begin() {
  draft.value = String(model.value)
  editing.value = true
  await nextTick()
  inputEl.value?.focus()
  inputEl.value?.select()
}

function commit() {
  if (!editing.value) return
  editing.value = false
  const v = Number(draft.value.replace(/[^\d.+-]/g, ''))
  if (Number.isFinite(v)) model.value = clamp(v)
}

function cancel() {
  editing.value = false
}

function reset() {
  if (props.dflt == null) return
  model.value = clamp(props.dflt)
}

/** 延迟开输入框：200ms 内来了第二下点击就当成双击 = 恢复默认 */
function onClick() {
  if (clickTimer != null) {
    clearTimeout(clickTimer)
    clickTimer = null
    reset()
    return
  }
  clickTimer = window.setTimeout(() => {
    clickTimer = null
    void begin()
  }, 200)
}

function stepBy(d: number, shift: boolean) {
  const s = props.step ?? 1
  model.value = clamp(model.value + d * s * (shift ? 10 : 1))
}
</script>

<template>
  <span class="numbox-wrap">
    <input
      v-if="editing"
      ref="inputEl"
      v-model="draft"
      class="numbox-in"
      inputmode="decimal"
      @blur="commit"
      @keydown.enter.prevent="commit"
      @keydown.esc.prevent="cancel"
      @keydown.up.prevent="stepBy(1, $event.shiftKey)"
      @keydown.down.prevent="stepBy(-1, $event.shiftKey)"
    />
    <button
      v-else
      class="numbox"
      :title="`点击输入精确值${dflt != null ? ' · 双击恢复默认' : ''}`"
      @click="onClick"
    >
      {{ model }}{{ unit ?? '' }}
    </button>
  </span>
</template>

<style scoped>
.numbox-wrap {
  display: inline-flex;
  min-width: 0;
}
.numbox,
.numbox-in {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
  white-space: nowrap;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  padding: 1px 5px;
  cursor: text;
  text-align: right;
  font-family: inherit;
  min-width: 0;
}
.numbox:hover {
  color: var(--accent);
  border-color: var(--border);
  background: var(--bg-2);
}
.numbox-in {
  width: 54px;
  color: var(--text);
  border-color: var(--accent);
  background: var(--bg-1);
  outline: none;
}
</style>
