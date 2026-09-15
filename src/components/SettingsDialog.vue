<script setup lang="ts">
import { ref } from 'vue'
import { api } from '../api/tauri'
import { open } from '@tauri-apps/plugin-dialog'
import { checkConnection, notify, saveSettings, state } from '../store'
import { ui } from '../ui'

const testing = ref(false)
const detecting = ref(false)
const running = ref<any[]>([])
const installs = ref<any[]>([])

async function browseDir() {
  const picked = await open({ directory: true, multiple: false })
  if (picked && !Array.isArray(picked)) state.settings.comfyDir = picked
}

async function browsePython() {
  const picked = await open({
    multiple: false,
    filters: [{ name: 'Python', extensions: ['exe'] }],
  })
  if (picked && !Array.isArray(picked)) state.settings.pythonPath = picked
}

async function browseOutput() {
  const picked = await open({ directory: true, multiple: false })
  if (picked && !Array.isArray(picked)) state.settings.outputDir = picked
}

async function test() {
  testing.value = true
  try {
    await saveSettings({ baseUrl: state.settings.baseUrl })
    notify(state.connection === 'ok' ? '连接成功' : `连接失败：${state.connText}`, state.connection === 'ok' ? 'ok' : 'error')
  } finally {
    testing.value = false
  }
}

async function detect() {
  detecting.value = true
  try {
    const r = await api.detectLocal()
    running.value = r.running ?? []
    installs.value = r.installs ?? []
    if (!running.value.length && !installs.value.length) {
      notify('没有自动发现 ComfyUI，请手动填写目录和地址', 'warn', 6000)
    }
  } catch (e) {
    notify(`探测失败：${e}`, 'error')
  } finally {
    detecting.value = false
  }
}

async function save() {
  await saveSettings({
    baseUrl: state.settings.baseUrl,
    comfyDir: state.settings.comfyDir,
    pythonPath: state.settings.pythonPath,
    launchArgs: state.settings.launchArgs,
    outputDir: state.settings.outputDir,
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
          <label>ComfyUI 服务地址</label>
          <div class="inline">
            <input v-model="state.settings.baseUrl" class="input mono" placeholder="http://127.0.0.1:8188" />
            <button class="btn" :disabled="testing" @click="test">测试并保存</button>
          </div>
          <div class="hint">
            远程服务器填 <code>http://服务器IP:8188</code>；本机默认 <code>http://127.0.0.1:8188</code>。
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
          <div class="detect-title">检测到正在运行：</div>
          <button
            v-for="r in running"
            :key="r.url"
            class="chip ok"
            @click="state.settings.baseUrl = r.url"
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
