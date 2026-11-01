import { computed, reactive, watch } from 'vue'
import { ui } from '../ui'

/**
 * 主题三态：跟随系统 / 亮色 / 深色，**每个主视图独立记忆**（出图工作台 / 漫画工坊）。
 * 实现：深色变量是 styles.css 的 :root 默认；亮色通过 <html class="light"> 覆盖。
 * 切换页签时自动套用该页的主题；跟随系统模式下系统切换明暗实时跟随。
 * 旧版全局 KEY 自动迁移为出图工作台的主题。
 */
export type ThemeMode = 'auto' | 'light' | 'dark'

export type ViewKey = 'workbench' | 'comic'

const OLD_KEY = 'comfyui-studio.theme:v1'

function keyFor(v: ViewKey): string {
  return `comfyui-studio.theme:${v}:v1`
}

function isMode(v: unknown): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'auto'
}

function loadView(v: ViewKey): ThemeMode {
  try {
    const raw = localStorage.getItem(keyFor(v))
    if (isMode(raw)) return raw
    if (v === 'workbench') {
      const old = localStorage.getItem(OLD_KEY)
      if (isMode(old)) return old
    }
  } catch {
    /* ignore */
  }
  return 'auto'
}

export const viewThemes = reactive<Record<ViewKey, ThemeMode>>({
  workbench: loadView('workbench'),
  comic: loadView('comic'),
})

/** 当前所在视图的主题（TopBar 图标随页签变化） */
export const themeMode = computed<ThemeMode>(() => viewThemes[ui.view])

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

export function isDarkNow(): boolean {
  const m = viewThemes[ui.view]
  return m === 'dark' || (m === 'auto' && systemDark.matches)
}

function apply() {
  document.documentElement.classList.toggle('light', !isDarkNow())
}

// 跟随系统模式：系统切换明暗时实时跟随
systemDark.addEventListener('change', () => {
  if (viewThemes[ui.view] === 'auto') apply()
})

// 切页签 → 套用那一页的主题
watch(
  () => ui.view,
  () => apply()
)

export function setViewTheme(v: ViewKey, m: ThemeMode) {
  viewThemes[v] = m
  try {
    localStorage.setItem(keyFor(v), m)
  } catch {
    /* 存储失败不影响功能 */
  }
  apply()
}

export function setThemeMode(m: ThemeMode) {
  setViewTheme(ui.view, m)
}

/** 循环切换当前视图：跟随系统 → 深色 → 亮色 → 跟随系统 */
export function cycleTheme() {
  const cur = viewThemes[ui.view]
  setViewTheme(ui.view, cur === 'auto' ? 'dark' : cur === 'dark' ? 'light' : 'auto')
}

apply()
