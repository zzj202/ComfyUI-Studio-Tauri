<script setup lang="ts">
/**
 * 节点健康看板（TopBar 触发点下方的弹层）：
 * 每机一张卡——在线状态 / GPU 显存占用 / 服务器队列深度 / 当前任务进度条。
 * 数据全部来自既有通道：健康轮询顺带抓的 systemStats（workerStats）、
 * refreshQueue 投影的 queueByBase（服务器真实队列，含非本应用提交的任务）、任务列表。
 */
import { computed, onMounted, onUnmounted } from 'vue'
import { enabledWorkers, healthOf, pingNow, queueByBase, state, workerStats } from '../store'

const emit = defineEmits<{ close: [] }>()

const cards = computed(() =>
  enabledWorkers().map((w) => {
    const st = workerStats.value[w.base]
    const running = state.jobs.find((j) => j.base === w.base && j.status === 'running')
    const localQueued = state.jobs.filter((j) => j.base === w.base && j.status === 'queued').length
    const total = st?.vramTotal ?? 0
    const free = st?.vramFree ?? 0
    const used = total > 0 ? total - free : 0
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
    return {
      base: w.base,
      name: w.name || w.base,
      health: healthOf(w.base),
      device: st?.device,
      hasVram: total > 0,
      used,
      total,
      pct,
      /** 服务器队列深度（refreshQueue 投影）；节点不可达或未刷新时退回本地 queued 数 */
      queue: queueByBase.value[w.base] ?? localQueued,
      running,
      offline: healthOf(w.base) === 'down',
    }
  })
)

const hasAnyVram = computed(() => cards.value.some((c) => c.hasVram))

function gb(n: number): string {
  return (n / 1073741824).toFixed(1)
}

/** 显存条配色：<75% 正常、<90% 偏高、≥90% 吃紧 */
function vramCls(pct: number): string {
  if (pct >= 90) return 'err'
  if (pct >= 75) return 'warn'
  return 'ok'
}

function jobPct(j: { value: number; max: number }): number {
  return j.max > 0 ? Math.min(100, Math.round((j.value / j.max) * 100)) : 0
}

function refresh() {
  void pingNow()
}

// 点击外部关闭（capture 阶段抢先，内部点击靠 closest 保护）
function onDocClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null
  if (!t?.closest('.worker-board') && !t?.closest('[data-wb-anchor]')) emit('close')
}

onMounted(() => {
  window.addEventListener('click', onDocClick, true)
  window.addEventListener('contextmenu', onDocClick, true)
  refresh() // 打开即拿一次新鲜数据
})

function dispose() {
  window.removeEventListener('click', onDocClick, true)
  window.removeEventListener('contextmenu', onDocClick, true)
}

onUnmounted(dispose)
</script>

<template>
  <div class="worker-board" @click.stop @contextmenu.prevent>
    <div class="wb-head">
      <span class="wb-title">节点看板</span>
      <span class="faint wb-sub">显存 · 队列 · 进度</span>
      <span class="spacer" />
      <button class="wb-refresh" title="立即刷新（平时每 30 秒自动）" @click="refresh">↻</button>
    </div>

    <div v-if="!cards.length" class="wb-empty">没有配置计算节点（在设置里添加）</div>

    <div v-for="c in cards" :key="c.base" class="wb-card" :class="{ off: c.offline }">
      <div class="wb-row">
        <span class="wb-dot" :class="c.health" />
        <span class="wb-name" :title="c.name">{{ c.name }}</span>
        <span v-if="c.device" class="wb-device" :title="c.device">{{ c.device }}</span>
      </div>
      <div class="wb-base mono" :title="c.base">{{ c.base }}</div>

      <!-- 显存：占用条 + 数字；非 GPU 节点显示占位 -->
      <div v-if="!c.offline && c.hasVram" class="wb-vram">
        <div class="wb-vram-bar">
          <div class="wb-vram-fill" :class="vramCls(c.pct)" :style="{ width: c.pct + '%' }" />
        </div>
        <span class="wb-vram-text mono">
          {{ gb(c.used) }} / {{ gb(c.total) }} GB · {{ c.pct }}%
        </span>
      </div>
      <div v-else-if="!c.offline && hasAnyVram" class="wb-vram wb-nogpu">无显存信息</div>

      <!-- 队列 + 运行中任务 -->
      <div class="wb-meta">
        <span :class="{ hot: c.queue > 0 }">队列 {{ c.queue }}</span>
        <span v-if="c.running" class="wb-jobname" :title="c.running.workflow">
          · {{ c.running.workflow || '任务' }}
        </span>
        <span v-else-if="!c.offline" class="wb-idle">· 空闲</span>
      </div>
      <div v-if="c.running" class="wb-job">
        <div class="wb-job-bar">
          <div class="wb-job-fill" :style="{ width: jobPct(c.running) + '%' }" />
        </div>
        <span class="wb-job-pct mono">{{ jobPct(c.running) }}%</span>
      </div>

      <div v-if="c.offline" class="wb-offline">离线 · 不参与派发</div>
    </div>

    <div class="wb-foot faint">每 30 秒自动刷新 · ↻ 手动刷新</div>
  </div>
</template>

<style scoped>
.worker-board {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 60;
  width: 300px;
  max-height: 70vh;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 10px 32px #00000045;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wb-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wb-title {
  font-weight: 700;
  font-size: 12.5px;
}
.wb-sub {
  font-size: 11px;
}
.wb-refresh {
  border: none;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 6px;
}
.wb-refresh:hover {
  background: var(--hover, #ffffff14);
  color: var(--text);
}
.wb-empty,
.wb-foot {
  font-size: 11.5px;
  text-align: center;
  padding: 6px 0;
}
.wb-card {
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  background: var(--bg-1);
}
.wb-card.off {
  opacity: 0.55;
}
.wb-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.wb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.wb-dot.up {
  background: var(--ok);
}
.wb-dot.down {
  background: var(--err);
}
.wb-dot.unknown {
  background: var(--text-faint);
  opacity: 0.5;
}
.wb-name {
  font-weight: 600;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-device {
  font-size: 11px;
  color: var(--text-faint);
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
  flex: none;
}
.wb-base {
  font-size: 10.5px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-vram {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wb-vram-bar {
  flex: 1;
  height: 6px;
  border-radius: 4px;
  background: var(--border-soft);
  overflow: hidden;
}
.wb-vram-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.4s ease;
}
.wb-vram-fill.ok {
  background: var(--ok);
}
.wb-vram-fill.warn {
  background: var(--warn, #f59e0b);
}
.wb-vram-fill.err {
  background: var(--err);
}
.wb-vram-text {
  font-size: 10.5px;
  color: var(--text-dim);
  flex: none;
}
.wb-nogpu {
  font-size: 10.5px;
  color: var(--text-faint);
  justify-content: center;
}
.wb-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--text-dim);
  min-width: 0;
}
.wb-meta .hot {
  color: var(--cyan);
}
.wb-jobname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wb-idle {
  color: var(--text-faint);
}
.wb-job {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wb-job-bar {
  flex: 1;
  height: 5px;
  border-radius: 4px;
  background: var(--border-soft);
  overflow: hidden;
}
.wb-job-fill {
  height: 100%;
  border-radius: 4px;
  background: var(--accent);
  transition: width 0.3s ease;
}
.wb-job-pct {
  font-size: 10.5px;
  color: var(--text-dim);
  width: 34px;
  text-align: right;
  flex: none;
}
.wb-offline {
  font-size: 11px;
  color: var(--err);
}
</style>
