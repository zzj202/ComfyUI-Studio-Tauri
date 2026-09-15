import { ref } from 'vue'

/**
 * 主题三态：跟随系统 / 亮色 / 深色（刷新后记忆）。
 * 实现：深色变量是 styles.css 的 :root 默认；亮色通过 <html class="light"> 覆盖。
 * 模块 import 即应用主题（TopBar 引用了它，App 挂载前就生效，不会闪色）。
 */
export type ThemeMode = 'auto' | 'light' | 'dark'

const KEY = 'comfyui-studio.theme:v1'

function load(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto'
  } catch {
    return 'auto'
  }
}

export const themeMode = ref<ThemeMode>(load())

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

export function isDarkNow(): boolean {
  return themeMode.value === 'dark' || (themeMode.value === 'auto' && systemDark.matches)
}

function apply() {
  document.documentElement.classList.toggle('light', !isDarkNow())
}

// 跟随系统模式：系统切换明暗时实时跟随
systemDark.addEventListener('change', () => {
  if (themeMode.value === 'auto') apply()
})

export function setThemeMode(m: ThemeMode) {
  themeMode.value = m
  try {
    localStorage.setItem(KEY, m)
  } catch {
    /* 存储失败不影响功能 */
  }
  apply()
}

/** 循环切换：跟随系统 → 深色 → 亮色 → 跟随系统 */
export function cycleTheme() {
  const next: ThemeMode =
    themeMode.value === 'auto' ? 'dark' : themeMode.value === 'dark' ? 'light' : 'auto'
  setThemeMode(next)
}

apply()
