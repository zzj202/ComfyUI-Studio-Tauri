<script setup lang="ts">
/**
 * 应用内现代化确认弹窗 v2：左对齐排版（图标徽章 + 标题同行）、毛玻璃背景、
 * 卡片缩放入场、渐变主按钮。状态与 API 在 core/confirm.ts（appConfirm），
 * App.vue 全局挂载一份。
 *
 * 交互要点：
 * - Esc / 点背景 / 点取消 = 取消；
 * - Enter 走浏览器原生「聚焦按钮即激活」：危险弹窗初始聚焦取消键（按 Enter 不会误确认），
 *   普通弹窗聚焦确认键 —— 本组件不全局拦截 Enter。
 */
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { answerConfirm, confirmState } from '../core/confirm'

const cancelBtn = ref<HTMLButtonElement | null>(null)
const okBtn = ref<HTMLButtonElement | null>(null)

watch(
  () => confirmState.open,
  (v) => {
    if (v) {
      // 危险操作把焦点放在「取消」上：连按 Enter 不会直接执行破坏性操作
      void nextTick(() => (confirmState.danger ? cancelBtn.value : okBtn.value)?.focus())
    }
  }
)

function onKey(e: KeyboardEvent) {
  if (!confirmState.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    answerConfirm(false)
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div v-if="confirmState.open" class="cfd-mask" @click.self="answerConfirm(false)" @contextmenu.prevent>
      <div class="cfd-card" :class="{ danger: confirmState.danger }" role="alertdialog">
        <header class="cfd-head">
          <span class="cfd-icon" :class="{ danger: confirmState.danger }">
            {{ confirmState.danger ? '⚠' : 'ℹ' }}
          </span>
          <h3 class="cfd-title">{{ confirmState.title }}</h3>
        </header>
        <p class="cfd-msg">{{ confirmState.message }}</p>
        <footer class="cfd-foot">
          <button ref="cancelBtn" class="cfd-btn cfd-cancel" @click="answerConfirm(false)">
            {{ confirmState.cancelLabel }}
          </button>
          <button
            ref="okBtn"
            class="cfd-btn cfd-ok"
            :class="confirmState.danger ? 'danger' : 'primary'"
            @click="answerConfirm(true)"
          >
            {{ confirmState.okLabel }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cfd-mask {
  position: fixed;
  inset: 0;
  z-index: 400;
  background: rgba(6, 9, 15, 0.5);
  backdrop-filter: blur(8px) saturate(1.1);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  animation: cfd-fade 0.18s ease-out;
}
@keyframes cfd-fade {
  from {
    opacity: 0;
  }
}
.cfd-card {
  width: 380px;
  max-width: 100%;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow:
    0 28px 72px rgba(0, 0, 0, 0.5),
    0 0 0 1px rgba(255, 255, 255, 0.04) inset;
  padding: 22px 22px 18px;
  animation: cfd-pop 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.15);
}
@keyframes cfd-pop {
  from {
    opacity: 0;
    transform: scale(0.9) translateY(10px);
  }
}
/* 头部：图标徽章 + 标题同行，左对齐 */
.cfd-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.cfd-icon {
  flex: none;
  width: 38px;
  height: 38px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
}
.cfd-icon.danger {
  background: color-mix(in srgb, var(--err, #e84e4e) 15%, transparent);
  color: var(--err, #e84e4e);
}
.cfd-title {
  margin: 0;
  font-size: 15.5px;
  font-weight: 600;
  color: var(--text);
  line-height: 1.3;
}
.cfd-msg {
  margin: 10px 2px 0;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-all;
}
/* 按钮行 */
.cfd-foot {
  display: flex;
  justify-content: flex-end;
  gap: 9px;
  margin-top: 20px;
}
.cfd-btn {
  min-width: 84px;
  padding: 8px 16px;
  border-radius: 10px;
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: filter 0.15s, background 0.15s, border-color 0.15s, transform 0.1s, box-shadow 0.15s;
}
.cfd-btn:active {
  transform: scale(0.97);
}
.cfd-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.cfd-cancel {
  background: var(--bg-2);
  border-color: var(--border);
  color: var(--text);
}
.cfd-cancel:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.cfd-ok.primary {
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 72%, #6a5cff 28%));
  color: #fff;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--accent) 35%, transparent);
}
.cfd-ok.primary:hover {
  filter: brightness(1.08);
  box-shadow: 0 6px 20px color-mix(in srgb, var(--accent) 45%, transparent);
}
.cfd-ok.danger {
  background: linear-gradient(135deg, #f87171, #d94b4b);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 4px 14px rgba(232, 78, 78, 0.35);
}
.cfd-ok.danger:hover {
  filter: brightness(1.08);
  box-shadow: 0 6px 20px rgba(232, 78, 78, 0.45);
}
</style>
