<script setup lang="ts">
/**
 * 批量拆行确认弹窗（方案 A）：粘贴/拆行按钮识别到多行提示词时弹出。
 * 「逐条提交」= 每行一个独立任务（走 runChain，改派/ETA/看板全兼容）；
 * 「整段提交」= 按普通单任务提交；可勾选记住选择（设置里可改回）。
 */
import { computed, ref } from 'vue'
import { BATCH_TEXT_MAX } from '../core/batchText'
import { batchTextPending, confirmBatchText, submitBatch } from '../store'

const remember = ref(false)

/** 每条提示词的批次数：默认跟随顶栏当前批次（1–10 与全局批次同范围） */
const perLine = ref(Math.max(1, Math.min(10, submitBatch.value)))

const p = computed(() => batchTextPending.value)
const lines = computed(() => (p.value ? p.value.lines.slice(0, BATCH_TEXT_MAX) : []))
const total = computed(() => p.value?.lines.length ?? 0)
const truncated = computed(() => total.value > BATCH_TEXT_MAX)
const jobCount = computed(() => lines.value.length * perLine.value)
</script>

<template>
  <div v-if="p" class="modal-mask" @click.self="confirmBatchText('cancel', false)">
    <div class="modal batch-text">
      <div class="modal-head">
        <h3>识别到 {{ total }} 条提示词</h3>
        <button class="btn ghost sm" @click="confirmBatchText('cancel', false)">✕</button>
      </div>
      <div class="modal-body">
        <div class="hint">
          按行拆分「{{ p.fieldLabel }}」：每行一条提示词、独立成任务，第 1 个沿用当前种子、其余自动换新不重样。
        </div>
        <div class="bt-count">
          <span>每条生成</span>
          <input
            v-model.number="perLine"
            type="number"
            min="1"
            max="10"
            class="input bt-num"
            title="每行提示词生成的张数（1–10）"
          />
          <span>张 · 共 <b>{{ jobCount }}</b> 个任务</span>
        </div>
        <div v-if="truncated" class="bt-warn">超过 {{ BATCH_TEXT_MAX }} 条，将只提交前 {{ BATCH_TEXT_MAX }} 条</div>
        <div class="bt-list">
          <div v-for="(l, i) in lines" :key="i" class="bt-line" :title="l">
            <span class="bt-idx">{{ i + 1 }}</span>
            <span class="bt-txt">{{ l }}</span>
          </div>
        </div>
        <label class="bt-remember" title="逐条：之后粘贴多行不再询问，自动拆分提交；整段：之后多行也按一条提交">
          <input v-model="remember" type="checkbox" />
          记住选择，之后粘贴多行不再询问
        </label>
        <div class="bt-btns">
          <button class="btn" @click="confirmBatchText('split', remember, perLine)">
            ⚡ 逐条提交 {{ jobCount }} 个任务
          </button>
          <button class="btn" @click="confirmBatchText('whole', remember, perLine)">整段提交 1 个</button>
          <button class="btn ghost" @click="confirmBatchText('cancel', false)">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal.batch-text {
  width: 480px;
  max-width: 92vw;
}
.bt-warn {
  font-size: 12px;
  color: var(--warn, #f59e0b);
  margin: 6px 0 0;
}
.bt-count {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--text-dim);
}
.bt-num {
  width: 64px;
  padding: 4px 8px;
}
.bt-list {
  margin-top: 10px;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
}
.bt-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-soft);
}
.bt-line:last-child {
  border-bottom: none;
}
.bt-idx {
  flex: none;
  min-width: 22px;
  text-align: right;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.bt-txt {
  font-size: 12px;
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-all;
}
.bt-remember {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
}
.bt-btns {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
</style>
