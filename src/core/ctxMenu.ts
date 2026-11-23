import { nextTick } from 'vue'
import type { Ref } from 'vue'

/**
 * 右键菜单两段式定位（全局统一方案）：
 * 先在点击位置渲染（组件模板需在 placed=false 时 visibility:hidden），
 * nextTick 实测菜单实际尺寸后夹紧到视口内（4px 边距）再显示。
 *
 * 为什么不能用固定估值：菜单高度随内容变化（工作流菜单的分组列表、
 * 任务菜单的节点数等），固定估值会在靠近视口底部或菜单项多的场景被截断。
 * Storyboard / 工作流面板 / 素材面板 / 收藏面板 / 结果区统一走这里。
 */
export type CtxPos = { x: number; y: number; placed: boolean }

export function openCtxMenu<T extends CtxPos>(
  e: MouseEvent,
  state: Ref<T | null>,
  el: Ref<HTMLElement | null>,
  extra: Omit<T, keyof CtxPos>,
): void {
  e.preventDefault() // 屏蔽 WebView 默认右键菜单（必须，否则两个菜单一起弹）
  state.value = { ...(extra as object), x: e.clientX, y: e.clientY, placed: false } as T
  void nextTick(() => {
    const node = el.value
    const cur = state.value
    if (!node || !cur) return
    const w = node.offsetWidth
    const h = node.offsetHeight
    cur.x = Math.max(4, Math.min(e.clientX, window.innerWidth - w - 4))
    cur.y = Math.max(4, Math.min(e.clientY, window.innerHeight - h - 4))
    cur.placed = true
  })
}
