<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { api, type AssetInfo } from '../api/tauri'
import { groupFields, parseGraph } from '../core/parseWorkflow'
import { addComicPaths } from '../core/comic'
import { SB_MAX_FRAMES, activeBoard, insertStoryboardPaths, sbExtHover, type SbFrame } from '../core/storyboard'
import { IMG_EXT_RE } from '../core/clipboard'
import { loadWorkflows, clearDropHot, dropHot, imageDropTargets, notify, selectWorkflow, state, updateDropHot } from '../store'
import { ui } from '../ui'

/**
 * 把 ComfyUI 的产出图/视频拖进窗口 → 读取它内嵌的工作流元数据 → 展示这份工作流。
 * ComfyUI 出图时会把完整 API 图写进 PNG 文本块（`prompt` 字段），所以能原样反查。
 */

const hovering = ref(false)
const loading = ref(false)
const asset = ref<AssetInfo | null>(null)
const error = ref('')
const droppedCount = ref(0)

/** 物理 → 逻辑坐标 */
function logical(position: { x: number; y: number }) {
  return { x: position.x / window.devicePixelRatio, y: position.y / window.devicePixelRatio }
}

let unlisten: (() => void) | null = null

onMounted(async () => {
  // Windows 上 drag-drop 事件挂在 webview 上（dragDropEnabled:true 时 WebView2 接管拖拽），
  // window 级监听收不到 —— 必须用 getCurrentWebview().onDragDropEvent
  unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
    const e = event.payload
    if (e.type === 'enter' || e.type === 'over') {
      hovering.value = true
      sbExtHover.value = sbZoneAt(e.position)
      // 悬停实时高亮落点 + 生成「松手 → …」提示（遮罩是半透明的，目标看得见）
      const p = logical(e.position)
      updateDropHot(p.x, p.y)
    } else if (e.type === 'leave') {
      hovering.value = false
      sbExtHover.value = null
      clearDropHot()
    } else if (e.type === 'drop') {
      hovering.value = false
      sbExtHover.value = null
      clearDropHot()
      droppedCount.value = e.paths.length
      await routeDrop(e.paths, logical(e.position))
    }
  })
})

// 其它组件（工作流面板等）可以通过 ui.assetPick / ui.assetInspect 请求打开对应界面
watch(
  () => ui.assetPick,
  (v) => {
    if (v) {
      ui.assetPick = false
      pickFile()
    }
  }
)
watch(
  () => ui.assetInspect,
  (p) => {
    if (p) {
      ui.assetInspect = null
      handleFile(p)
    }
  }
)

onUnmounted(() => unlisten?.())

const groups = computed(() => {
  if (!asset.value?.prompt) return []
  // 只读展示：连着服务器时用 /object_info 把字段名和取值翻译得更好懂
  return groupFields(parseGraph(asset.value.prompt, state.objectInfo))
})

const sizeText = computed(() => {
  const s = asset.value?.size ?? 0
  if (s < 1024) return `${s} B`
  if (s < 1024 * 1024) return `${(s / 1024).toFixed(1)} KB`
  return `${(s / 1048576).toFixed(1)} MB`
})

const sourceText = computed(() => {
  switch (asset.value?.source) {
    case 'png':
      return 'PNG 文本块（完整元数据）'
    case 'scan':
      return '二进制扫描（原文本块已丢失，从文件里捞回来的）'
    default:
      return ''
  }
})

async function handleFile(path: string) {
  loading.value = true
  error.value = ''
  asset.value = null
  try {
    asset.value = await api.readAsset(path)
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

/** 拖入落点路由：漫画页 → 全部加进漫画列表；JSON → 导入工作流；图片控件 → 上传参考图；其他 → 资产反查工作流 */
async function routeDrop(paths: string[], position: { x: number; y: number }) {
  if (!paths.length) return
  const path = paths[0]

  // ⓪ 漫画工坊页：拖进来的图片全部按顺序加入漫画列表
  if (ui.view === 'comic') {
    const imgs = paths.filter((p) => IMG_EXT_RE.test(p))
    if (imgs.length) {
      addComicPaths(imgs)
      return
    }
  }

  // ⓪½ 连续插画栏：外部图片拖入 —— 落在具体帧上 = 精确放入该帧（后续图顺延插到它后面），
  // 落在追加条 / 面板其他位置 = 追加到末尾
  if (ui.view === 'workbench' && ui.storyboardOpen) {
    const zone = sbZoneAt(position)
    if (zone) {
      const imgs = paths.filter((p) => IMG_EXT_RE.test(p))
      if (imgs.length) {
        let target: SbFrame | null = null
        if (zone.startsWith('sb:frame:')) {
          const id = zone.slice('sb:frame:'.length)
          target = activeBoard()?.frames.find((f) => f.id === id) ?? null
        }
        const n = insertStoryboardPaths(imgs, target)
        if (n > 0) notify(target ? `已放入 ${n} 张到第 ${frameNum(target.id)} 帧` : `已追加 ${n} 帧到连续插画板`, 'ok', 4000)
        if (n < imgs.length) notify(`画板已满（上限 ${SB_MAX_FRAMES} 帧），只加了 ${n} 张`, 'warn', 5000)
        return
      }
    }
  }

  // ① 工作流 JSON → 直接导入
  if (/\.json$/i.test(path)) {
    try {
      const r = await api.importWorkflow(path)
      await loadWorkflows()
      await selectWorkflow(r.name)
      notify(`已导入工作流「${r.name}」`, 'ok', 6000)
    } catch (err) {
      notify(`导入工作流失败：${err}`, 'error', 9000)
    }
    return
  }

  // ② 落点在图片控件（缩略卡）上 → 上传（回调内部筛选：单图取第一张，多图全收）
  const key = await hitImageKey(position)
  const uploader = key ? imageDropTargets.get(key) : undefined
  if (uploader) {
    uploader(paths)
    return
  }

  // ③ 其他文件 → 资产反查工作流
  handleFile(path)
}

/** 逻辑坐标 → 找落点下的图片控件（FieldControl 在缩略卡上标了 data-image-key） */
function hitImageKey(position: { x: number; y: number }): string | null {
  try {
    const el = document.elementFromPoint(position.x, position.y)
    const card = el?.closest('[data-image-key]')
    return card?.getAttribute('data-image-key') ?? null
  } catch {
    return null
  }
}

/** 逻辑坐标 → 取落点下的插画板落点（sb:frame:<id> / sb:append）；
 *  在面板上但不在具体落点上（页签区/空白）时按追加处理 */
function sbZoneAt(position: { x: number; y: number }): string | null {
  try {
    const el = document.elementFromPoint(position.x, position.y)
    const zone = el?.closest('[data-drop-zone]')?.getAttribute('data-drop-zone') ?? null
    if (zone?.startsWith('sb:')) return zone
    return el?.closest('.sb') ? 'sb:append' : null
  } catch {
    return null
  }
}

/** 帧序号（通知文案用） */
function frameNum(frameId: string): number {
  return (activeBoard()?.frames.findIndex((f) => f.id === frameId) ?? -2) + 1
}

async function pickFile() {
  const picked = await open({
    multiple: false,
    filters: [
      {
        name: 'ComfyUI 产出',
        extensions: ['png', 'webp', 'jpg', 'jpeg', 'mp4', 'webm', 'mov'],
      },
    ],
  })
  if (picked && !Array.isArray(picked)) handleFile(picked)
}

async function importAsWorkflow() {
  if (!asset.value) return
  try {
    const r = await api.importAssetWorkflow(asset.value.path)
    await loadWorkflows()
    await selectWorkflow(r.name)
    notify(`已载入为工作流「${r.name}」，可以改参数重新生成了`, 'ok', 6000)
    close()
  } catch (e) {
    notify(String(e), 'error', 9000)
  }
}

function close() {
  asset.value = null
  error.value = ''
  droppedCount.value = 0
}

function fmt(v: any): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? '开启' : '关闭'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}
</script>

<template>
  <!-- 拖拽遮罩：半透明（不挡住落点，目标卡实时高亮），提示卡吸顶 -->
  <div v-if="hovering" class="drop-mask">
    <div class="drop-inner">
      <div class="title">拖放文件</div>
      <div class="hot" v-if="dropHot.label">🎯 松手 → {{ dropHot.label }}</div>
      <div class="sub" v-else-if="ui.view === 'comic'">全部图片按拖入顺序加入漫画列表</div>
      <div class="sub" v-else-if="ui.storyboardOpen">
        图片拖到「🎞 连续插画」栏的帧上 = 放入该帧 · 拖到其他位置 = 追加 · JSON → 导入工作流
      </div>
      <div class="sub" v-else>
        工作流 JSON → 直接导入 · 图片拖到参数卡 → 设为参考图 · ComfyUI 产出 → 反查工作流
      </div>
    </div>
  </div>

  <!-- 载入中 -->
  <div v-if="loading" class="loading">正在解析资产…</div>

  <!-- 错误提示 -->
  <div v-if="error && !asset" class="modal-mask" @click.self="close">
    <div class="modal narrow">
      <div class="modal-head"><h3>读取失败</h3></div>
      <div class="modal-body">
        <div class="err-box">{{ error }}</div>
        <div class="hint">
          如果这张图被外部工具转存或压缩过，内嵌的工作流元数据可能已经丢失 —— 那样就只能去 ComfyUI
          的 output 目录找原图了。
        </div>
      </div>
      <div class="modal-foot"><button class="btn primary" @click="close">知道了</button></div>
    </div>
  </div>

  <!-- 资产详情 -->
  <div v-if="asset" class="modal-mask" @click.self="close">
    <div class="modal viewer">
      <div class="modal-head">
        <h3>资产工作流 · {{ asset.name }}</h3>
        <button class="btn ghost sm" @click="close">✕</button>
      </div>

      <div class="modal-body">
        <div class="cols">
          <!-- 左：预览 -->
          <div class="left">
            <div class="preview">
              <img v-if="asset.preview" :src="asset.preview" :alt="asset.name" />
              <div v-else class="no-preview">
                <template v-if="asset.tooLarge">文件太大（&gt;64MB），跳过解析</template>
                <template v-else>无预览（{{ asset.kind }}）</template>
              </div>
            </div>
            <dl class="meta">
              <div><dt>大小</dt><dd>{{ sizeText }}</dd></div>
              <div><dt>类型</dt><dd>{{ asset.kind }}</dd></div>
              <div v-if="asset.nodeCount"><dt>节点数</dt><dd>{{ asset.nodeCount }}</dd></div>
              <div v-if="sourceText"><dt>来源</dt><dd>{{ sourceText }}</dd></div>
              <div class="path"><dt>路径</dt><dd class="mono">{{ asset.path }}</dd></div>
            </dl>
          </div>

          <!-- 右：解析出的参数 -->
          <div class="right">
            <div v-if="!asset.prompt" class="empty">
              这个资产里没有可执行的 API 格式工作流。
              <template v-if="asset.workflow">
                <br /><br />它内嵌的是 <b>UI 格式</b>（节点+连线），只能看结构、不能直接提交执行。<br />
                想重跑的话，请去 ComfyUI 里加载这份工作流后用「导出 (API)」。
              </template>
              <template v-else>
                <br /><br />可能原因：不是 ComfyUI 生成的、或元数据已被外部工具剥离。
              </template>
            </div>

            <template v-else>
              <div class="ro-tip">以下是从资产里还原出的参数（只读）</div>
              <div v-for="g in groups" :key="g.group" class="ro-group">
                <div class="ro-group-head">{{ g.group }}</div>
                <div v-for="f in g.fields" :key="f.key" class="ro-row">
                  <span class="k">{{ f.label }}</span>
                  <span class="v mono" :title="fmt(f.value)">{{ fmt(f.value) }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <span v-if="droppedCount > 1" class="faint drop-hint">
          一次只处理第一个文件（共拖入 {{ droppedCount }} 个）
        </span>
        <span class="spacer" />
        <button class="btn" @click="pickFile">选择其他文件…</button>
        <button class="btn primary" :disabled="!asset.prompt" @click="importAsWorkflow">
          载入为工作流
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.drop-mask {
  position: fixed;
  inset: 0;
  z-index: 300;
  /* 半透明：拖文件过来时落点目标仍然可见（配合 .drop-hot 实时高亮瞄准） */
  background: rgba(10, 14, 22, 0.22);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  pointer-events: none;
}
.drop-inner {
  margin-top: 52px;
  border: 2px dashed var(--accent);
  border-radius: 14px;
  padding: 16px 30px;
  text-align: center;
  background: var(--bg-1);
  box-shadow: var(--shadow);
}
.drop-inner .title {
  font-size: 14px;
  font-weight: 600;
  color: var(--accent);
}
.drop-inner .hot {
  margin-top: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent);
}
.drop-inner .sub {
  margin-top: 5px;
  font-size: 12px;
  color: var(--text-dim);
}
.loading {
  position: fixed;
  top: 56px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 16px;
  font-size: 12px;
  z-index: 300;
  box-shadow: var(--shadow);
}
.viewer {
  width: 1000px;
}
.narrow {
  width: 480px;
}
.cols {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: 18px;
}
.preview {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  overflow: hidden;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 200px;
}
.preview img {
  width: 100%;
  display: block;
}
.no-preview {
  color: var(--text-faint);
  font-size: 12px;
  padding: 40px 16px;
  text-align: center;
}
.meta {
  margin: 12px 0 0;
  font-size: 12px;
}
.meta > div {
  display: flex;
  gap: 10px;
  padding: 3px 0;
}
.meta dt {
  color: var(--text-faint);
  width: 46px;
  flex: none;
}
.meta dd {
  margin: 0;
  word-break: break-all;
}
.meta .path {
  flex-direction: column;
  gap: 2px;
}
.meta .path dt {
  width: auto;
}
.meta .path dd {
  font-size: 11px;
  color: var(--text-dim);
}
.right {
  max-height: 460px;
  overflow: auto;
  padding-right: 4px;
}
.ro-tip {
  font-size: 11.5px;
  color: var(--text-faint);
  margin-bottom: 10px;
}
.ro-group {
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  margin-bottom: 8px;
  overflow: hidden;
}
.ro-group-head {
  background: var(--bg-2);
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
}
.ro-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 10px;
  padding: 5px 10px;
  font-size: 12px;
  border-top: 1px solid var(--border-soft);
}
.ro-row .k {
  color: var(--text-dim);
}
.ro-row .v {
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.err-box {
  background: #f8717114;
  border: 1px solid #f8717133;
  border-radius: var(--radius-sm);
  padding: 10px;
  color: #fca5a5;
  font-size: 12.5px;
  white-space: pre-wrap;
}
.hint {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.6;
}
.drop-hint {
  font-size: 11.5px;
}
.spacer {
  flex: 1;
}
</style>
