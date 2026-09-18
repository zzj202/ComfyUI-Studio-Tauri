<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../api/tauri'
import { open } from '@tauri-apps/plugin-dialog'
import { notify, saveSettings, state } from '../store'
import type { WorkerProfile } from '../core/types'
import { ui } from '../ui'

const detecting = ref(false)
const running = ref<any[]>([])
const installs = ref<any[]>([])
const testingId = ref('')

async function browseDir() {
  const picked = await open({ directory: true, multiple: false })
  if (picked && !Array.isArray(picked)) state.settings.comfyDir = picked
}

async function browsePython() {
  const picked = await open({
    multiple: false,
    filters: [{ name: 'Python', extensions: ['exe'] }],
  })
  if (!Array.isArray(picked) && picked) state.settings.pythonPath = picked
}

async function browseOutput() {
  const picked = await open({ directory: true, multiple: false })
  if (picked && !Array.isArray(picked)) state.settings.outputDir = picked
}

function workerList(): WorkerProfile[] {
  if (!Array.isArray(state.settings.workers)) state.settings.workers = []
  return state.settings.workers
}

/** 扫描本机：正在运行的 ComfyUI + 常见目录安装，结果点一下即可添加为节点 */
async function detect() {
  detecting.value = true
  try {
    const r = await api.detectLocal()
    running.value = r.running ?? []
    installs.value = r.installs ?? []
    if (!running.value.length && !installs.value.length) notify('本机未发现 ComfyUI', 'info', 4000)
  } catch (e) {
    notify(`探测失败：${e}`, 'error', 8000)
  } finally {
    detecting.value = false
  }
}

function addWorker() {
  const list = workerList()
  list.push({
    id: crypto.randomUUID(),
    name: `节点 ${list.length + 1}`,
    base: 'http://127.0.0.1:8188',
    enabled: true,
    weight: 1,
  })
}

function removeWorker(i: number) {
  workerList().splice(i, 1)
}

/** 字节 → GB 显示（无效/缺省返回空串） */
function gb(bytes: unknown): string {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  return (n / 1073741824).toFixed(1) + 'GB'
}

/** 测单个节点连通性（直接打该节点 /system_stats，不走保存逻辑）；成功顺带报显卡/显存 */
async function testWorker(w: WorkerProfile) {
  testingId.value = w.id
  try {
    const stats = await api.systemStats(w.base)
    const d = stats?.devices?.[0] ?? {}
    const parts: string[] = []
    if (d?.name) parts.push(String(d.name))
    const total = gb(d?.vram_total)
    const free = gb(d?.vram_free)
    if (total) parts.push(`显存 ${total}${free ? `（空闲 ${free}）` : ''}`)
    notify(`${w.name || w.base} 连接成功${parts.length ? ' · ' + parts.join(' · ') : ''}`, 'ok', 6000)
  } catch (e) {
    notify(`${w.name || w.base} 连接失败：${String(e).split('\n')[0]}`, 'error', 8000)
  } finally {
    testingId.value = ''
  }
}

/** 自动发现的运行中服务 → 添加为节点（重复地址只提示不重复加） */
function addWorkerFromUrl(url: string, device?: string) {
  const list = workerList()
  if (list.some((w) => w.base === url)) {
    notify('该地址已在节点列表里', 'info', 3000)
    return
  }
  let host = url
  try {
    host = new URL(url).host
  } catch {
    /* 保持原样 */
  }
  list.push({ id: crypto.randomUUID(), name: device || host, base: url, enabled: true, weight: 1 })
  notify(`已添加节点「${device || host}」，记得保存`, 'ok', 5000)
}

async function save() {
  // 过滤空行并规整后再持久化（保存后 saveSettings 会自动重连各启用节点的 WS）
  const workers = workerList()
    .filter((w) => w.base && w.base.trim())
    .map((w) => ({ ...w, base: w.base.trim(), name: (w.name || '').trim() }))
  await saveSettings({
    baseUrl: state.settings.baseUrl,
    comfyDir: state.settings.comfyDir,
    pythonPath: state.settings.pythonPath,
    launchArgs: state.settings.launchArgs,
    outputDir: state.settings.outputDir,
    workers,
  })
  notify('设置已保存', 'ok', 2500)
  ui.settingsOpen = false
}
</script>

<template>
  <div class="modal-mask" @click.self="ui.settingsOpen = false">
    <div class="modal settings">
      <div class="modal-head">
        <h3>设置</h3>
        <button class="btn ghost sm" @click="ui.settingsOpen = false">✕</button>
      </div>

      <div class="modal-body">
        <div class="form-row">
          <label>ComfyUI 服务地址（旧版兼容字段，由下方节点列表自动维护）</label>
          <input :value="state.settings.baseUrl" class="input mono" disabled />
          <div class="hint">
            在下方「计算节点」里管理服务地址；第一个启用的节点即主节点。本机默认
            <code>http://127.0.0.1:8188</code>。
          </div>
        </div>

        <div class="form-row">
          <label>计算节点（提交时自动分摊任务；勾选 = 启用，排序即优先级）</label>
          <div v-for="(w, i) in state.settings.workers || []" :key="w.id" class="worker-row">
            <input v-model="w.enabled" type="checkbox" class="wk-enable" title="启用该节点" />
            <input v-model="w.name" class="input wk-name" placeholder="名称" />
            <input v-model="w.base" class="input mono wk-base" placeholder="http://192.168.1.10:8188" />
            <input
              v-model.number="w.weight"
              type="number"
              min="1"
              class="input wk-weight"
              title="权重"
            />
            <button class="btn sm" :disabled="testingId === w.id" @click="testWorker(w)">
              {{ testingId === w.id ? '…' : '测试' }}
            </button>
            <button class="btn ghost sm" title="删除节点" @click="removeWorker(i)">✕</button>
          </div>
          <div>
            <button class="btn sm" @click="addWorker">＋ 添加节点</button>
          </div>
          <div class="hint">
            任务按「空闲优先」自动分摊，单节点提交失败自动改派；权重仅在空闲度并列时生效。
            远程机需以 <code>--listen 0.0.0.0</code> 启动，公网建议反代加鉴权。
          </div>
        </div>

        <div class="form-row">
          <label>本地 ComfyUI 目录（可选，用于一键启动）</label>
          <div class="inline">
            <input v-model="state.settings.comfyDir" class="input" placeholder="包含 main.py 的目录" />
            <button class="btn" @click="browseDir">浏览</button>
            <button class="btn" :disabled="detecting" @click="detect">
              {{ detecting ? '探测中…' : '自动探测' }}
            </button>
          </div>
        </div>

        <div v-if="running.length" class="detect">
          <div class="detect-title">检测到正在运行（点击添加为节点）：</div>
          <button
            v-for="r in running"
            :key="r.url"
            class="chip ok"
            @click="addWorkerFromUrl(r.url, r.device)"
          >
            {{ r.url }}<span v-if="r.device" class="faint"> · {{ r.device }}</span>
          </button>
        </div>

        <div v-if="installs.length" class="detect">
          <div class="detect-title">发现本机安装：</div>
          <button
            v-for="i in installs"
            :key="i.path"
            class="chip"
            @click="state.settings.comfyDir = i.path"
          >
            {{ i.path }}<span class="faint"> · {{ i.python }}</span>
          </button>
        </div>

        <div class="form-row">
          <label>Python 解释器（留空自动查找 venv / python_embeded / PATH）</label>
          <div class="inline">
            <input v-model="state.settings.pythonPath" class="input" placeholder="留空自动查找" />
            <button class="btn" @click="browsePython">浏览</button>
          </div>
        </div>

        <div class="form-row">
          <label>启动参数</label>
          <input v-model="state.settings.launchArgs" class="input mono" placeholder="--listen 0.0.0.0 --port 8188" />
          <div class="hint">追加到 <code>python main.py</code> 后面，例如 <code>--lowvram</code>、<code>--port 8189</code>。</div>
        </div>

        <div class="form-row">
          <label>输出目录</label>
          <div class="inline">
            <input v-model="state.settings.outputDir" class="input" placeholder="保存产出图片的位置" />
            <button class="btn" @click="browseOutput">浏览</button>
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn" @click="ui.settingsOpen = false">取消</button>
        <button class="btn primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  width: 620px;
}
.inline {
  display: flex;
  gap: 8px;
}
.inline .input {
  flex: 1;
}
.worker-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.wk-enable {
  flex: none;
}
.wk-name {
  width: 110px;
  flex: none;
}
.wk-base {
  flex: 1;
  min-width: 0;
}
.wk-weight {
  width: 58px;
  flex: none;
}
code {
  background: var(--bg-3);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}
.detect {
  margin: -4px 0 14px;
}
.detect-title {
  font-size: 11.5px;
  color: var(--text-dim);
  margin-bottom: 5px;
}
.chip {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 9px;
  margin-bottom: 4px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 11.5px;
  font-family: ui-monospace, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip:hover {
  border-color: var(--accent);
}
.chip.ok {
  border-color: #34d39955;
  background: #34d39912;
}
</style>
