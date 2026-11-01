<script setup lang="ts">
/**
 * 颜色选择：原生取色器 + 常用色板一键填充。
 * v-model 绑定颜色值（#rrggbb）。
 */
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

function pick(c: string) {
  model.value = c
}
</script>

<template>
  <div class="cpick">
    <input v-model="model" type="color" title="自定义颜色" />
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
.sw:hover {
  transform: scale(1.15);
}
.sw.on {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
