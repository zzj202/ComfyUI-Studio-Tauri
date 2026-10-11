<script setup lang="ts">
/**
 * 右侧「📁 本地素材」列：上下两个独立窗格，可同时操作两个文件夹
 * （如上面 Downloads 找素材、下面 output 看产出，互相对照/拖拽）。
 * 每个窗格各自记忆目录、独立 5s 自动轮询；时间分组折叠状态两组共享。
 */
import { ui } from '../ui'
import LocalFilesPane from './LocalFilesPane.vue'
</script>

<template>
  <aside v-if="ui.localFilesOpen" class="lf">
    <LocalFilesPane pane-id="a" />
    <div class="lf-divider" title="以下为第二个素材文件夹" />
    <LocalFilesPane pane-id="b" />
  </aside>
</template>

<style scoped>
.lf {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 268px;
  min-height: 0;
  background: var(--bg-1);
  border-left: 1px solid var(--border-soft);
  overflow: hidden;
}
.lf-divider {
  flex: none;
  height: 1px;
  background: var(--border-soft);
}
</style>
