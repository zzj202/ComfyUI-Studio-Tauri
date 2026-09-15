<script setup lang="ts">
import { state } from '../store'

function dismiss(id: number) {
  const i = state.toasts.findIndex((t) => t.id === id)
  if (i >= 0) state.toasts.splice(i, 1)
}
</script>

<template>
  <div class="toasts">
    <div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.type" @click="dismiss(t.id)">
      <span class="msg">{{ t.text }}</span>
      <span class="close">✕</span>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 200;
  max-width: 460px;
}
.toast {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-left: 3px solid var(--text-faint);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  cursor: pointer;
  font-size: 12.5px;
  white-space: pre-wrap;
  animation: slide-in 0.18s ease-out;
}
@keyframes slide-in {
  from {
    opacity: 0;
    transform: translateX(12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.toast.ok {
  border-left-color: var(--ok);
}
.toast.error {
  border-left-color: var(--err);
}
.toast.warn {
  border-left-color: var(--warn);
}
.toast.info {
  border-left-color: var(--accent);
}
.msg {
  flex: 1;
  line-height: 1.6;
}
.close {
  color: var(--text-faint);
  font-size: 11px;
}
</style>
