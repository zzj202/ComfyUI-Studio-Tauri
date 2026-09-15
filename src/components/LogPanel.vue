<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { fetchLogs, state } from '../store'
import { ui } from '../ui'

const box = ref<HTMLElement | null>(null)
let timer: number | null = null

function scrollToBottom() {
  requestAnimationFrame(() => {
    if (box.value) box.value.scrollTop = box.value.scrollHeight
  })
}

onMounted(async () => {
  await fetchLogs(true)
  scrollToBottom()
  timer = window.setInterval(async () => {
    await fetchLogs()
    scrollToBottom()
  }, 1500)
})

onUnmounted(() => {
  if (timer != null) clearInterval(timer)
})

watch(
  () => state.logs.length,
  () => scrollToBottom()
)
</script>

<template>
  <div class="drawer">
    <div class="drawer-head">
      <span>本地 ComfyUI 日志</span>
      <span class="spacer" />
      <span class="faint">{{ state.procRunning ? '运行中' : '未运行' }} · {{ state.logs.length }} 行</span>
      <button class="btn ghost sm" @click="fetchLogs(true)">重载</button>
      <button class="btn ghost sm" @click="ui.logsOpen = false">✕</button>
    </div>
    <div ref="box" class="drawer-body mono">
      <div v-if="!state.logs.length" class="faint pad">
        还没有日志。点顶栏「▶ 启动本地」后，ComfyUI 的 stdout/stderr 会实时显示在这里。
      </div>
      <div v-for="(l, i) in state.logs" :key="i" class="line" :class="{ err: l.startsWith('[E]') }">
        {{ l }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.drawer {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: 260px;
  background: var(--bg-1);
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  z-index: 50;
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.4);
}
.drawer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--border-soft);
  font-size: 12px;
  flex: none;
}
.spacer {
  flex: 1;
}
.drawer-body {
  flex: 1;
  overflow: auto;
  padding: 8px 12px;
  font-size: 11.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-all;
}
.pad {
  padding: 10px 2px;
}
.line.err {
  color: #fca5a5;
}
</style>
