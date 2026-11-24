<script setup lang="ts">
/**
 * 图文配对提交弹窗（纯新增入口，不动现有提交路径）：
 * 多图控件里的 N 张图 × 粘贴的 M 条提示词，**均分**配对——
 * 每条提示词只跑一次，按顺序切给图片（5 图 × 3 条 = 15 任务：图1↔1-3、图2↔4-6…）。
 * 复用 splitBatchLines 智能拆块（编号块/字段块/【N. 标题】等全部格式），
 * 提交走 runChain 的 perItem 通道，改派/ETA/看板/完成音效全兼容。
 */
import { computed, ref, watch } from 'vue'
import { BATCH_TEXT_MAX, splitBatchLines } from '../core/batchText'
import { stableKeys, useDragSort } from '../core/dragSort'
import { viewUrl } from '../api/tauri'
import { imageOriginBase, notify, pairedPending, state, submitPaired } from '../store'

const p = computed(() => pairedPending.value)

/** 多图字段的实时图片列表（弹窗打开期间在表单里增删图也会同步） */
const imgs = computed<string[]>(() => {
  if (!p.value) return []
  const f = state.fields.find((x) => x.key === p.value!.multiKey)
  const v = f?.value
  return Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : []
})

/** 可选的提示词字段（text / textarea），默认选第一个 textarea（提示词通常在长文字段） */
const promptKey = ref('')
const candidates = computed(() =>
  p.value ? state.fields.filter((f) => f.kind === 'text' || f.kind === 'textarea') : []
)
watch(
  () => p.value,
  (v) => {
    if (!v) return
    raw.value = ''
    const ta = candidates.value.find((f) => f.kind === 'textarea')
    promptKey.value = ta?.key ?? candidates.value[0]?.key ?? ''
  }
)

const raw = ref('')
/** 拆出的提示词块（粘贴后实时解析预览） */
const prompts = computed(() => (raw.value.trim() ? splitBatchLines(raw.value) : []))
const truncated = computed(() => {
  const n = raw.value.trim() ? splitBatchLines(raw.value).length : 0
  return n > BATCH_TEXT_MAX
})

/** 每条提示词生成几张 */
const perLine = ref(1)

/** 均分切块：base = ⌊M/N⌋，前 rem 张图各多摊一条（与 submitPaired 同一套算式） */
const chunks = computed(() => {
  const n = imgs.value.length
  const m = prompts.value.length
  if (!n || !m || m < n) return []
  const base = Math.floor(m / n)
  const rem = m % n
  let cursor = 0
  return imgs.value.map((img, gi) => {
    const cnt = base + (gi < rem ? 1 : 0)
    const from = cursor
    cursor += cnt
    return { img, from, cnt }
  })
})

const enough = computed(() => imgs.value.length >= 1 && prompts.value.length >= imgs.value.length)
const totalJobs = computed(() => prompts.value.length * Math.max(1, Math.min(10, Math.floor(perLine.value) || 1)))

/** 块首行摘要（截 40 字），预览行里展示 */
function brief(t: string): string {
  const l = t.split('\n')[0].trim()
  return l.length > 40 ? `${l.slice(0, 40)}…` : l
}

// ---- 图片拖拽排序（插入线模式）：与表单多图控件写同一个字段值，两边顺序实时同步 ----

const imgsWrap = ref<HTMLElement | null>(null)
const dsKeys = computed(() => stableKeys(imgs.value))
const { onDown: dsDown, dragging: dsDragging, insertAt: dsInsertAt } = useDragSort(
  () => imgsWrap.value,
  () => imgs.value,
  (arr) => {
    const f = state.fields.find((x) => x.key === p.value?.multiKey)
    if (f) f.value = arr
  }
)

/** 缩略图地址（与 FieldControl 同款：sub/name → 源机器 input 目录） */
function thumb(v: string): string | null {
  const s = String(v ?? '').trim()
  if (!/\.(png|jpe?g|webp|gif|bmp)$/i.test(s)) return null
  const i = s.indexOf('/')
  const name = i >= 0 ? s.slice(i + 1) : s
  const sub = i >= 0 ? s.slice(0, i) : ''
  try {
    return viewUrl(imageOriginBase(s), name, sub, 'input')
  } catch {
    return null
  }
}

function fileName(v: string): string {
  const i = v.lastIndexOf('/')
  return i >= 0 ? v.slice(i + 1) : v
}

function close() {
  pairedPending.value = null
}

function submit() {
  const pk = promptKey.value
  const f = state.fields.find((x) => x.key === pk)
  if (!f) {
    notify('没有可用的提示词字段', 'warn')
    return
  }
  submitPaired({
    multiKey: p.value!.multiKey,
    imgs: imgs.value,
    promptKey: pk,
    prompts: prompts.value,
    perLine: perLine.value,
  })
  close()
}
</script>

<template>
  <div v-if="p" class="modal-mask" @click.self="close">
    <div class="modal paired">
      <div class="modal-head">
        <h3>🔗 图文配对提交</h3>
        <button class="btn ghost sm" @click="close">✕</button>
      </div>
      <div class="modal-body">
        <div class="hint">
          「{{ p.multiLabel }}」里的 <b>{{ imgs.length }}</b> 张图，配粘贴的提示词：每条提示词只跑一次，
          按顺序均分给图片（图 k 拿第 k 段）。<b>按住缩略图拖动可调顺序</b>（和表单里同步）。
          提示词复用批量拆分识别（编号块/字段块/【N. 标题】…）。
        </div>

        <!-- 图片列表 -->
        <div ref="imgsWrap" class="pd-imgs" :class="{ sorting: dsDragging >= 0 }">
          <div
            v-for="(v, i) in imgs"
            :key="dsKeys[i]"
            class="pd-thumb"
            :class="{
              dragging: dsDragging === i,
              'ds-line-l': dsInsertAt === i,
              'ds-line-r': dsInsertAt === i + 1,
            }"
            :title="`${fileName(v)}（按住拖动可调顺序）`"
            data-ds
            @pointerdown="dsDown($event, i)"
          >
            <img v-if="thumb(v)" :src="thumb(v) ?? ''" alt="" draggable="false" />
            <span v-else class="pd-mname">{{ fileName(v) }}</span>
            <span class="pd-gi">图{{ i + 1 }}</span>
          </div>
          <span v-if="!imgs.length" class="pd-warn">多图控件是空的——去表单上传图片后再来</span>
        </div>

        <!-- 提示词字段 + 粘贴框 -->
        <div class="pd-row">
          <span class="lbl">提示词字段</span>
          <select v-model="promptKey" class="input pd-select">
            <option v-for="f in candidates" :key="f.key" :value="f.key">{{ f.label }}</option>
          </select>
        </div>
        <textarea
          v-model="raw"
          class="input pd-raw"
          rows="6"
          placeholder="把提示词整段粘进来（支持【91. 标题】/【第 N 条｜标题】/01【分类】标题/编号列表/字段块等全部批量稿格式，空行自动忽略）"
        />

        <div class="pd-count">
          <span>图片 <b>{{ imgs.length }}</b> 张</span>
          <span>提示词 <b>{{ prompts.length }}</b> 条{{ truncated ? `（超上限，只取前 ${BATCH_TEXT_MAX} 条）` : '' }}</span>
          <span class="pd-per">
            每条生成
            <input v-model.number="perLine" type="number" min="1" max="10" class="input pd-num" title="每条提示词生成几张（1–10）" />
            张
          </span>
          <span>共 <b>{{ totalJobs }}</b> 个任务</span>
        </div>
        <div v-if="prompts.length && prompts.length < imgs.length" class="pd-warn">
          提示词（{{ prompts.length }} 条）比图片（{{ imgs.length }} 张）少——每张图至少要有一条，请补齐提示词或删掉多余的图
        </div>

        <!-- 均分预览 -->
        <div v-if="chunks.length" class="pd-map">
          <div v-for="(c, i) in chunks" :key="i" class="pd-line" :title="c.img">
            <span class="pd-badge">{{ i + 1 }}</span>
            <img v-if="thumb(c.img)" :src="thumb(c.img) ?? ''" alt="" />
            <span v-else class="pd-mname">{{ fileName(c.img) }}</span>
            <span class="pd-range">第 {{ c.from + 1 }}–{{ c.from + c.cnt }} 条（{{ c.cnt }} 条）</span>
            <span class="pd-brief" :title="prompts[c.from]">{{ brief(prompts[c.from] ?? '') }}</span>
          </div>
          <div v-if="prompts.length % imgs.length" class="pd-note">
            提示词不能整除：第 1–{{ prompts.length % imgs.length }} 张图各多摊一条
          </div>
        </div>

        <div class="pd-btns">
          <button class="btn primary" :disabled="!enough" :title="enough ? '' : '提示词条数不能少于图片数'" @click="submit">
            ⚡ 配对提交 {{ totalJobs }} 个任务
          </button>
          <button class="btn ghost" @click="close">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal.paired {
  width: 560px;
  max-width: 94vw;
}
.pd-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
}
.pd-thumb {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 8px;
  overflow: visible;
  border: 1px solid var(--border);
  background: var(--bg-2);
  flex: none;
  cursor: grab;
  user-select: none;
}
/* 拖动中的原条目：变暗 + 虚线框（列表本体不动，松手才挪） */
.pd-thumb.dragging {
  opacity: 0.35;
  border-style: dashed;
  cursor: grabbing;
}
/* 插入位置指示线（dragSort 插入线模式）：亮在目标间隙的左右边缘 */
.pd-thumb.ds-line-l::before,
.pd-thumb.ds-line-r::after {
  content: '';
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 4px;
  border-radius: 2px;
  background: var(--accent);
  z-index: 3;
  box-shadow: 0 0 6px var(--accent);
}
.pd-thumb.ds-line-l::before {
  left: -6px;
}
.pd-thumb.ds-line-r::after {
  right: -6px;
}
.pd-imgs.sorting .pd-thumb:not(.dragging) {
  opacity: 0.85;
}
.pd-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 7px;
  -webkit-user-drag: none;
}
.pd-mname {
  position: absolute;
  inset: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  color: var(--text-dim);
  word-break: break-all;
  text-align: center;
  overflow: hidden;
  border-radius: 5px;
}
.pd-gi {
  position: absolute;
  left: 2px;
  top: 2px;
  font-size: 9px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}
.pd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
}
.pd-select {
  flex: 1;
  font-size: 12px;
}
.pd-raw {
  width: 100%;
  resize: vertical;
  font-size: 12px;
  line-height: 1.5;
  margin: 2px 0 8px;
}
.pd-count {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.pd-per {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.pd-num {
  width: 52px;
  padding: 2px 6px;
  font-size: 12px;
}
.pd-warn {
  font-size: 12px;
  color: var(--warn, #f59e0b);
  margin: 4px 0;
}
.pd-map {
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 6px;
  margin: 6px 0;
  max-height: 180px;
  overflow-y: auto;
}
.pd-line {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 2px;
  font-size: 12px;
}
.pd-badge {
  flex: none;
  width: 34px;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.pd-line img {
  width: 34px;
  height: 24px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid var(--border);
  flex: none;
}
.pd-range {
  color: var(--text);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.pd-brief {
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.pd-note {
  font-size: 11.5px;
  color: var(--text-faint);
  padding: 4px 2px 0;
}
.pd-btns {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
</style>
