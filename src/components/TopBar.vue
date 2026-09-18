<script setup lang="ts">
import { computed } from 'vue'
import {
  checkConnection,
  enabledWorkers,
  healthOf,
  primaryBase,
  startLocal,
  state,
  stopLocal,
} from '../store'
import { soundEnabled, toggleSound } from '../core/chime'
import { cycleTheme, themeMode } from '../core/theme'
import { ui } from '../ui'

/** 三态主题的按钮外观：跟随系统 → 深色 → 亮色 循环 */
const THEME_UI: Record<string, { icon: string; label: string }> = {
  auto: { icon: '🌗', label: '跟随系统' },
  dark: { icon: '🌙', label: '深色' },
  light: { icon: '☀️', label: '亮色' },
}

/** 连接指示显示主节点地址；多节点时追加「+N」提示池里还有其他节点 */
const connUrl = computed(() => {
  const base = primaryBase()
  const extra = enabledWorkers().length - 1
  return extra > 0 ? `${base} +${extra}` : base
})

/** 每节点健康状态点（多节点时显示；单节点的存活状态由左侧连接胶囊表达） */
const workers = computed(() => enabledWorkers())

function healthInfo(base: string): { cls: string; text: string } {
  const h = healthOf(base)
  if (h === 'up') return { cls: 'up', text: '在线' }
  if (h === 'down') return { cls: 'down', text: '离线' }
  return { cls: 'unknown', text: '检测中' }
}
</script>

<template>
  <header class="topbar">
    <div class="brand">
      <span class="logo">◆</span>
      <span class="name">ComfyUI Studio</span>
    </div>

    <button
      class="pill"
      :class="state.connection"
      :title="state.connText"
      @click="checkConnection"
    >
      <span class="dot" />
      <span class="url mono">{{ connUrl }}</span>
      <span class="dim">·</span>
      <span>{{ state.connection === 'ok' ? '已连接' : state.connection === 'error' ? '未连接' : '检测中' }}</span>
    </button>

    <!-- 每节点健康状态点：绿=在线 红=离线 灰=检测中；点击打开设置 -->
    <span v-if="workers.length > 1" class="node-dots">
      <button
        v-for="w in workers"
        :key="w.id"
        class="node-dot"
        :class="healthInfo(w.base).cls"
        :title="`${w.name || w.base} · ${w.base} · ${healthInfo(w.base).text}（点击打开设置）`"
        @click="ui.settingsOpen = true"
      />
    </span>

    <span v-if="state.stats?.devices?.[0]" class="device faint">
      {{ state.stats.devices[0].name }}
      <template v-if="state.stats.devices[0].vram_total">
        · {{ (state.stats.devices[0].vram_total / 1073741824).toFixed(0) }}GB
      </template>
    </span>

    <div class="spacer" />

    <span v-if="state.queueRemaining > 0" class="faint">队列 {{ state.queueRemaining }}</span>

    <button
      class="btn sm"
      :class="{ danger: state.procRunning }"
      :disabled="!state.settings.comfyDir"
      :title="state.settings.comfyDir ? state.settings.comfyDir : '请先在设置里填写 ComfyUI 目录'"
      @click="state.procRunning ? stopLocal() : startLocal()"
    >
      {{ state.procRunning ? '■ 停止本地' : '▶ 启动本地' }}
    </button>
    <button
      class="btn sm"
      :title="soundEnabled ? '批次完成提示音：已开启，点击关闭' : '批次完成提示音：已关闭，点击开启'"
      @click="toggleSound"
    >
      {{ soundEnabled ? '🔔 音效开' : '🔕 音效关' }}
    </button>
    <button
      class="btn sm"
      :title="`主题：${THEME_UI[themeMode].label}（点击切换 跟随系统/深色/亮色）`"
      @click="cycleTheme"
    >
      {{ THEME_UI[themeMode].icon }}
    </button>
    <button class="btn sm" @click="ui.logsOpen = !ui.logsOpen">日志</button>
    <button class="btn sm" @click="ui.settingsOpen = true">⚙ 设置</button>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex: none;
  user-select: none;
}
.brand {
  display: flex;
  align-items: center;
  gap: 7px;
  font-weight: 700;
  letter-spacing: 0.2px;
}
.logo {
  color: var(--accent);
  font-size: 15px;
}
.pill .url {
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
}
/* 每节点健康状态点 */
.node-dots {
  display: flex;
  align-items: center;
  gap: 5px;
}
.node-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1px solid var(--border);
  padding: 0;
  cursor: pointer;
  flex: none;
}
.node-dot.up {
  background: var(--ok);
  border-color: transparent;
}
.node-dot.down {
  background: var(--err);
  border-color: transparent;
}
.node-dot.unknown {
  background: var(--text-faint);
  opacity: 0.45;
}
.device {
  font-size: 11.5px;
  max-width: 230px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.spacer {
  flex: 1;
}
</style>
