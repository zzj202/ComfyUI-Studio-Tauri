<script setup lang="ts">
/**
 * 颜色选择：原生取色器 + 常用色板 + 最近使用（跨会话记在 localStorage）。
 * v-model 绑定颜色值（#rrggbb）。
 */
import { ref } from 'vue'

const model = defineModel<string>({ required: true })

const SWATCHES = [
  '#ffffff',
  '#f5f5f5',
  '#111111',
  '#000000',
  '#cfe8ff',
  '#ffe9f1',
  '#fff7d6',
  '#e2ffe2',
  '#f0e6ff',
  '#ffd9c9',
]

const RECENT_KEY = 'comfyui-studio.recentColors:v1'

function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((c) => typeof c === 'string').slice(0, 6) : []
  } catch {
    return []
  }
}

const recent = ref<string[]>(loadRecent())

/** 记一次使用（最新的排最前，去重，最多 6 个） */
function remember(c: string) {
  const v = c.toLowerCase()
  recent.value = [v, ...recent.value.filter((x) => x !== v)].slice(0, 6)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value))
  } catch {
    /* 存储满等异常忽略 */
  }
}

function pick(c: string) {
  model.value = c
  remember(c)
}

/** 原生取色器：拖动过程不记，松手（change）才记一次 */
function onNativePick(e: Event) {
  remember((e.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="cpick">
    <input v-model="model" type="color" title="自定义颜色" @change="onNativePick" />
    <template v-if="recent.length">
      <button
        v-for="c in recent"
        :key="'r' + c"
        class="sw recent"
        :class="{ on: model.toLowerCase() === c }"
        :style="{ background: c }"
        :title="`最近使用 ${c}`"
        @click="pick(c)"
      />
      <span class="cpick-sep" />
    </template>
    <button
      v-for="c in SWATCHES"
      :key="c"
      class="sw"
      :class="{ on: model.toLowerCase() === c }"
      :style="{ background: c }"
      :title="c"
      @click="pick(c)"
    />
  </div>
</template>

<style scoped>
.cpick {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  min-width: 0;
}
.cpick input[type='color'] {
  width: 34px;
  height: 22px;
  padding: 0 2px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: none;
  cursor: pointer;
  flex: none;
}
.sw {
  width: 18px;
  height: 18px;
  border-radius: 5px;
  border: 1px solid var(--border);
  cursor: pointer;
  padding: 0;
  flex: none;
  transition: transform 0.1s;
}
/* 最近使用：右下角小三角做个区分 */
.sw.recent {
  position: relative;
  border-color: var(--accent);
  border-style: dashed;
}
.sw:hover {
  transform: scale(1.15);
}
.sw.on {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.cpick-sep {
  width: 1px;
  height: 14px;
  background: var(--border);
  flex: none;
  margin: 0 1px;
}
</style>
