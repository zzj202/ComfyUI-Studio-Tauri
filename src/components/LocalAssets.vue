<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { beginDrag, notify } from '../store'

/**
 * 界面左下角的「本地资产」条：常用的本地图片集合，按住即可拖到
 * 右侧参数区的图片卡上当参考图（也支持拖到工作流面板反查工作流）。
 */

const KEY = 'comfyui-studio.localAssets.v1'
const paths = ref<string[]>([])
const broken = ref(new Set<string>()) // 加载失败（协议没开/文件被移动）的缩略图

onMounted(() => {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const list = JSON.parse(raw)
      if (Array.isArray(list)) paths.value = list.filter((p: any) => typeof p === 'string')
    }
  } catch {
    /* ignore */
  }
})

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(paths.value))
  } catch {
    /* ignore */
  }
}

function fileName(p: string) {
  return p.split(/[\\/]/).pop() ?? p
}

function thumbUrl(p: string) {
  return convertFileSrc(p)
}

async function addFiles() {
  const picked = await open({
    multiple: true,
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
  })
  if (!picked) return
  const files = Array.isArray(picked) ? picked : [picked]
  let added = 0
  for (const f of files) {
    if (!paths.value.includes(f)) {
      paths.value.push(f)
      broken.value.delete(f)
      added++
    }
  }
  if (added) {
    persist()
    notify(`已添加 ${added} 个本地资产，按住即可拖动`, 'ok', 3000)
  }
}

function removeOne(p: string) {
  const i = paths.value.indexOf(p)
  if (i >= 0) paths.value.splice(i, 1)
  persist()
}

function clearAll() {
  paths.value = []
  persist()
}
</script>

<template>
  <section class="local">
    <header class="head">
      <h2>本地资产</h2>
      <span class="faint">{{ paths.length }}</span>
      <span class="spacer" />
      <button class="btn sm" @click="addFiles">＋ 添加</button>
      <button class="btn sm ghost" :disabled="!paths.length" @click="clearAll">清空</button>
    </header>
    <div class="strip">
      <div v-if="!paths.length" class="empty">常用图片存这里，<br />按住拖到右侧参数卡当参考图</div>
      <div
        v-for="p in paths"
        :key="p"
        class="thumb"
        :title="`${fileName(p)}（按住拖到参数卡）`"
        @pointerdown="beginDrag($event, { path: p, label: fileName(p), thumb: thumbUrl(p) })"
      >
        <img
          v-if="!broken.has(p)"
          :src="thumbUrl(p)"
          :alt="fileName(p)"
          loading="lazy"
          @error="broken.add(p)"
        />
        <span v-else class="ph">🖼</span>
        <button class="x" title="移除" @click.stop="removeOne(p)">✕</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.local {
  flex: none;
  border-top: 1px solid var(--border-soft);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  max-height: 216px;
  min-height: 0;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 6px;
  flex: none;
}
.head h2 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.strip {
  overflow-y: auto;
  padding: 0 12px 10px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
  gap: 6px;
  align-content: start;
}
.empty {
  grid-column: 1 / -1;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.7;
  padding: 4px 0 2px;
}
.thumb {
  position: relative;
  aspect-ratio: 1;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-2);
  cursor: grab;
}
.thumb:hover {
  border-color: var(--accent);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb .ph {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 18px;
}
.x {
  position: absolute;
  top: 0;
  right: 0;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 0 0 0 6px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.thumb:hover .x {
  display: flex;
}
.x:hover {
  background: rgba(220, 38, 38, 0.9);
}
</style>
