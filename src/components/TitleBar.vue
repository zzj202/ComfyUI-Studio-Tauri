<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ui } from '../ui'

/**
 * 自定义标题栏（lib.rs 里 decorations(false) 后接管系统标题栏）：
 * 品牌 + 主视图页签（出图工作台 / 漫画工坊）+ 最小化/最大化/关闭。
 * 空白区域 data-tauri-drag-region 可拖动窗口，双击最大化由 Tauri 原生处理。
 */
const appWindow = getCurrentWindow()
const maximized = ref(false)
let unlisten: (() => void) | null = null

const VIEW_KEY = 'comfyui-studio.view:v1'
function setView(v: 'workbench' | 'comic') {
  ui.view = v
  try {
    localStorage.setItem(VIEW_KEY, v)
  } catch {
    /* ignore */
  }
}

// 最大化时无框窗口内容会溢出屏幕边缘，body.maximized 让 .app 加内边距抵消
watch(maximized, (v) => document.body.classList.toggle('maximized', v))

onMounted(async () => {
  try {
    maximized.value = await appWindow.isMaximized()
    unlisten = await appWindow.onResized(async () => {
      maximized.value = await appWindow.isMaximized()
    })
  } catch {
    /* ignore */
  }
})
onUnmounted(() => unlisten?.())
</script>

<template>
  <div class="titlebar">
    <div class="tb-brand" data-tauri-drag-region>
      <span data-tauri-drag-region class="logo">◆</span>
      <span data-tauri-drag-region class="name">ComfyUI Studio</span>
    </div>

    <nav class="view-tabs">
      <button
        class="vtab"
        :class="{ on: ui.view === 'workbench' }"
        title="工作流出图：参数 → 批量提交 → 结果"
        @click="setView('workbench')"
      >
        出图工作台
      </button>
      <button
        class="vtab"
        :class="{ on: ui.view === 'comic' }"
        title="漫画工坊：多图合并竖版长图（手机阅读）"
        @click="setView('comic')"
      >
        漫画工坊
      </button>
    </nav>

    <div class="tb-spacer" data-tauri-drag-region />

    <button class="tb-btn" title="最小化" @click="appWindow.minimize()">&#x2500;</button>
    <button
      class="tb-btn"
      :title="maximized ? '向下还原' : '最大化'"
      @click="appWindow.toggleMaximize()"
    >
      &#x25A1;
    </button>
    <button class="tb-btn close" title="关闭" @click="appWindow.close()">&#x2715;</button>
  </div>
</template>

<style scoped>
.titlebar {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 0 0 12px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex: none;
  user-select: none;
}
.tb-brand {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  font-size: 12.5px;
  letter-spacing: 0.2px;
  height: 100%;
}
.tb-brand .logo {
  color: var(--accent);
  font-size: 13px;
}
/* 主视图页签（出图工作台 / 漫画工坊） */
.view-tabs {
  display: flex;
  border: 1px solid var(--border);
  border-radius: 999px;
  overflow: hidden;
  flex: none;
}
.view-tabs .vtab {
  border: none;
  background: none;
  color: var(--text-dim);
  font-size: 12px;
  padding: 4px 13px;
  cursor: pointer;
}
.view-tabs .vtab + .vtab {
  border-left: 1px solid var(--border);
}
.view-tabs .vtab.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.tb-spacer {
  flex: 1;
  height: 100%;
}
/* Windows 风格窗口控制按钮 */
.tb-btn {
  width: 44px;
  height: 40px;
  border: none;
  background: none;
  color: var(--text-dim);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.tb-btn:hover {
  background: var(--hover, #ffffff14);
  color: var(--text);
}
.tb-btn.close:hover {
  background: #e81123;
  color: #fff;
}
</style>
