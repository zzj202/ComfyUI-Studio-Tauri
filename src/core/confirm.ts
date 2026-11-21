import { reactive } from 'vue'

/**
 * 应用内现代化确认弹窗（替代 tauri-plugin-dialog 的系统原生 ask()）：
 * Promise 化 API，UI 在 components/ConfirmDialog.vue（App.vue 全局挂载一份）。
 *
 * await appConfirm({ title, message, danger: true, okLabel: '清空' }) → true = 确认
 */

export interface ConfirmOptions {
  /** 弹窗标题（加粗主句） */
  title: string
  /** 说明文字（副句，可换行） */
  message: string
  /** 危险操作 = 红色主按钮 + 警示图标；默认主题色确认按钮 */
  danger?: boolean
  okLabel?: string
  cancelLabel?: string
}

interface ConfirmRuntime {
  open: boolean
  title: string
  message: string
  danger: boolean
  okLabel: string
  cancelLabel: string
  resolve: ((v: boolean) => void) | null
}

export const confirmState = reactive<ConfirmRuntime>({
  open: false,
  title: '',
  message: '',
  danger: false,
  okLabel: '确认',
  cancelLabel: '取消',
  resolve: null,
})

/** 弹出确认框；resolve(true) = 点确认/Enter，resolve(false) = 取消/Esc/点背景 */
export function appConfirm(opts: ConfirmOptions): Promise<boolean> {
  // 已有弹窗挂着时：上一个视为取消（不排队，后弹的覆盖）
  if (confirmState.resolve) confirmState.resolve(false)
  confirmState.title = opts.title
  confirmState.message = opts.message
  confirmState.danger = !!opts.danger
  confirmState.okLabel = opts.okLabel ?? '确认'
  confirmState.cancelLabel = opts.cancelLabel ?? '取消'
  confirmState.open = true
  return new Promise<boolean>((resolve) => {
    confirmState.resolve = resolve
  })
}

/** 关闭弹窗并回传结果（组件调用） */
export function answerConfirm(v: boolean): void {
  const r = confirmState.resolve
  confirmState.resolve = null
  confirmState.open = false
  r?.(v)
}
