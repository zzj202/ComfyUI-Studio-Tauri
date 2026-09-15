<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import { api, type AssetInfo } from '../api/tauri'
import { groupFields, parseGraph } from '../core/parseWorkflow'
import { loadWorkflows, imageDropTargets, notify, selectWorkflow, state } from '../store'
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

let unlisten: (() => void) | null = null

onMounted(async () => {
  // Windows 上 drag-drop 事件挂在 webview 上（dragDropEnabled:true 时 WebView2 接管拖拽），
  // window 级监听收不到 —— 必须用 getCurrentWebview().onDragDropEvent
  unlisten = await getCurrentWebview().onDragDropEvent(async (event) => {
    const e = event.payload
    if (e.type === 'enter' || e.type === 'over') {
      hovering.value = true
    } else if (e.type === 'leave') {
      hovering.value = false
    } else if (e.type === 'drop') {
      hovering.value = false
      droppedCount.value = e.paths.length
      await routeDrop(e.paths, e.position)
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

/** 拖入落点路由：JSON → 导入工作流；图片控件 → 上传参考图；其他 → 资产反查工作流 */
async function routeDrop(paths: string[], position: { x: number; y: number }) {
  if (!paths.length) return
  const path = paths[0]

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

  // ② 落点在图片控件（缩略卡）上 → 作为该控件的参考图上传
  const key = await hitImageKey(position)
  const uploader = key ? imageDropTargets.get(key) : undefined
  if (uploader) {
    uploader(path)
    return
  }

  // ③ 其他文件 → 资产反查工作流
  handleFile(path)
}

/** 物理坐标 → 逻辑坐标，找落点下的图片控件（FieldControl 在缩略卡上标了 data-image-key） */
function hitImageKey(position: { x: number; y: number }): string | null {
  try {
    const el = document.elementFromPoint(position.x / window.devicePixelRatio, position.y / window.devicePixelRatio)
    const card = el?.closest('[data-image-key]')
    return card?.getAttribute('data-image-key') ?? null
  } catch {
    return null
  }
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
  <!-- 拖拽遮罩 -->
  <div v-if="hovering" class="drop-mask">
    <div class="drop-inner">
      <div class="icon">⬇</div>
      <div class="title">松开鼠标</div>
      <div class="sub">
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
  background: rgba(10, 14, 22, 0.82);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.drop-inner {
  border: 2px dashed var(--accent);
  border-radius: 18px;
  padding: 46px 68px;
  text-align: center;
  background: var(--accent-soft);
}
.drop-inner .icon {
  font-size: 30px;
  color: var(--accent);
}
.drop-inner .title {
  margin-top: 10px;
  font-size: 15px;
  font-weight: 600;
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
