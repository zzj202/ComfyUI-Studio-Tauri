/**
 * 完成音效引擎 —— 从网页版 ComfyUI-Studio（app.vue）完整移植，行为一致：
 * - 主引擎：WebAudio 合成「叮-叮-咚」上行三连音（A5 880 → C#6 1108.7 → E6 1318.5，正弦波）
 * - 后备：AudioContext 不可用/被暂停时，直接播 public/beep.wav（不依赖 AudioContext）
 * - loud=true（全部任务完成）：3 轮、轮间隔 3.5s + 尾音 2.2s → 总时长约 10 秒，人在别处也听得见
 * - loud=false：单轮短音（开关试听用）
 * - 开关状态持久化 localStorage 'soundEnabled:v1'，顶栏 🔔/🔕 切换
 */
import { ref } from 'vue'

const SOUND_KEY = 'soundEnabled:v1'
export const soundEnabled = ref((() => {
  try {
    return JSON.parse(localStorage.getItem(SOUND_KEY) || 'null') ?? true
  } catch {
    return true
  }
})())

let audioCtx: AudioContext | null = null

/** AudioContext 需要用户手势才能启动：在提交/开关点击时预热 */
export function ensureAudio() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return
    const ctx = (audioCtx ??= new Ctx()) as AudioContext
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  } catch {
    audioCtx = null
  }
}

/** 后备提示音：WebAudio 不可用/被暂停时，直接播 public/beep.wav（不依赖 AudioContext） */
function fallbackBeep(loud: boolean) {
  // loud（全部任务完成）→ 3 遍、间隔 3.5s，总时长约 10 秒
  const rounds = loud ? 3 : 1
  for (let i = 0; i < rounds; i++) {
    window.setTimeout(() => {
      try {
        const a = new Audio('/beep.wav')
        a.volume = 1
        a.play().catch(() => console.warn('[chime] 后备提示音播放失败（可能被浏览器拦截）'))
      } catch {
        console.warn('[chime] 后备提示音异常')
      }
    }, i * 3500)
  }
}

function chime(loud: boolean) {
  if (!audioCtx || audioCtx.state !== 'running') {
    fallbackBeep(loud)
    return
  }
  const t0 = audioCtx.currentTime
  const rounds = loud ? 3 : 1 // 全部任务完成 → 重复 3 遍，人在别处也能听见
  const roundGap = loud ? 3.5 : 1.5 // loud：轮间隔 3.5s + 尾音 2.3s → 总时长约 10 秒
  const noteGap = loud ? 0.35 : 0.18
  const tail = loud ? 2.2 : 1.1
  for (let r = 0; r < rounds; r++) {
    const t = t0 + r * roundGap
    // A5 → C#6 → E6 上行三连音「叮-叮-咚」（音量大、尾音长）
    ;[880, 1108.7, 1318.5].forEach((f, i) => {
      const o = audioCtx!.createOscillator()
      const g = audioCtx!.createGain()
      o.type = 'sine'
      o.frequency.value = f
      const st = t + i * noteGap
      g.gain.setValueAtTime(0.0001, st)
      g.gain.linearRampToValueAtTime(0.45, st + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, st + tail)
      o.connect(g).connect(audioCtx!.destination)
      o.start(st)
      o.stop(st + tail + 0.1)
    })
  }
}

export function playChime(loud = false) {
  if (!soundEnabled.value) return
  try {
    ensureAudio()
    if (!audioCtx) {
      console.warn('[chime] WebAudio 不可用 → 后备提示音')
      fallbackBeep(loud)
      return
    }
    if (audioCtx.state !== 'running') {
      // AudioContext 恢复是异步的：等 resume 成功后再补播；恢复失败/挂起都退回后备提示音
      const ctx = audioCtx
      let handled = false
      const settle = () => {
        if (handled) return
        handled = true
        if (ctx.state === 'running') chime(loud)
        else {
          console.warn('[chime] AudioContext 恢复失败(state=' + ctx.state + ') → 后备提示音')
          fallbackBeep(loud)
        }
      }
      ctx.resume
        ?.()
        .then(settle)
        .catch(() => {
          console.warn('[chime] AudioContext resume 异常 → 后备提示音')
          fallbackBeep(loud)
        })
      // 兜底：resume 被浏览器静默挂起时 promise 永不 resolve → 800ms 后强制走后备，避免彻底无声
      window.setTimeout(settle, 800)
      return
    }
    chime(loud)
  } catch (e) {
    console.warn('[chime] 播放异常 → 后备提示音', e)
    fallbackBeep(loud)
  }
}

export function toggleSound() {
  soundEnabled.value = !soundEnabled.value
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(soundEnabled.value))
  } catch {
    /* 忽略存储失败 */
  }
  if (soundEnabled.value) playChime(false) // 开启时给一声试听确认
}
