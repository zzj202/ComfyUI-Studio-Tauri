import { ref } from 'vue'

/**
 * 指针拖拽排序（插入线模式，flex-wrap 缩略图网格通用）：
 * 按住条目拖动 → 原条目变暗、最近插入位显示竖线指示 → 松手一次性挪过去。
 *
 * 为什么不做「拖动中实时换位」：换位会让列表在指针越过两张图交界时来回抖动，
 * 且条目 key 含下标时 Vue 会整段重建 DOM、缩略图闪——插入线模式拖动中列表完全不动，
 * 只在松手时切一次最终结果，从机制上消除闪烁。
 *
 * 为什么不用 HTML5 DnD：Tauri 的文件拖放接管了 WebView 的拖放管线，
 * 元素级 dragstart/dragover 会被吞（外部文件拖入必须走 onDragDropEvent），
 * 所以用 pointer 事件自实现，与文件拖入互不干扰。
 *
 * 用法：
 *   const wrap = ref<HTMLElement | null>(null)
 *   const { onDown, dragging, insertAt } = useDragSort(() => wrap.value, () => list.value, commit)
 *   <div ref="wrap"> <div v-for=... :key="keys[i]" data-ds
 *     :class="{ 'ds-dim': dragging === i, 'ds-line-l': insertAt === i, 'ds-line-r': insertAt === i + 1 }"
 *     @pointerdown="onDown($event, i)"> ...
 *   条目内部若有按钮（如删除 ✕），onDown 会自动忽略来自按钮的按下。
 */
export function useDragSort(
  container: () => HTMLElement | null,
  list: () => string[],
  commit: (arr: string[]) => void
) {
  /** 拖动中条目的下标（原位变暗样式），未拖动为 -1 */
  const dragging = ref(-1)
  /** 当前插入位：0..n（相对拖动条目仍处原位的列表，插到 insertAt 之前），未拖动为 -1 */
  const insertAt = ref(-1)

  let src = -1
  let sx = 0
  let sy = 0
  let moved = false

  function items(): HTMLElement[] {
    const c = container()
    if (!c) return []
    return Array.from(c.querySelectorAll<HTMLElement>('[data-ds]'))
  }

  /** 指针最近的插入位：找中心最近的条目，指针在其中心左/上 = 插它前面，否则后面 */
  function nearestInsert(x: number, y: number): number {
    const els = items()
    let best = -1
    let bd = Infinity
    let before = false
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect()
      const cx = r.left + r.width / 2
      const cy = r.top + r.height / 2
      const dx = x - cx
      const dy = y - cy
      const d = dx * dx + dy * dy
      if (d < bd) {
        bd = d
        best = i
        before = dx + dy < 0 // 以中心为界：指针在中心左/上 = 前插
      }
    })
    if (best < 0) return -1
    const pos = before ? best : best + 1
    if (pos === src || pos === src + 1) return src // 悬在原位附近 = 不动，指示线停在原条目上
    return pos
  }

  function onMove(e: PointerEvent) {
    if (src < 0) return
    if (!moved && Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) < 6) return
    moved = true
    dragging.value = src
    insertAt.value = nearestInsert(e.clientX, e.clientY)
  }

  function onUp() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    const from = src
    const to = insertAt.value
    src = -1
    moved = false
    dragging.value = -1
    insertAt.value = -1
    if (from < 0 || to < 0 || to === from || to === from + 1) return
    const arr = list().slice()
    const [it] = arr.splice(from, 1)
    arr.splice(to > from ? to - 1 : to, 0, it)
    commit(arr)
  }

  /** 拖拽被浏览器打断（pointercancel：原生图片拖拽接管等）→ 只复位，不提交 */
  function onCancel() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    src = -1
    moved = false
    dragging.value = -1
    insertAt.value = -1
  }

  function onDown(e: PointerEvent, i: number) {
    if (e.button !== 0) return
    if ((e.target as HTMLElement | null)?.closest('button')) return // 删除 ✕ 等按钮照常工作
    src = i
    sx = e.clientX
    sy = e.clientY
    moved = false
    // 不 preventDefault：点了缩略图后卡片仍要拿到焦点（Ctrl+V 粘贴依赖它），
    // 拖动时的文本选中由条目上的 user-select: none 挡住
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }

  return { onDown, dragging, insertAt }
}

// 缩略图里的 <img> 是浏览器默认可拖拽的：按住一动就触发原生图片拖放，
// pointer 事件被 pointercancel 打断 → 排序整个失效。条目内一律禁掉原生拖拽
//（模板 img 上也加了 draggable="false"，这里是事件级兜底）。
document.addEventListener(
  'dragstart',
  (e) => {
    if ((e.target as HTMLElement | null)?.closest?.('[data-ds]')) e.preventDefault()
  },
  true
)

/**
 * 稳定的 v-for key：值 + 同值出现序号（列表重排后每条目 key 不变 → Vue 移动节点而非重建，
 * 缩略图不闪）。列表允许重复值，所以不能用裸值当 key。
 */
export function stableKeys(list: string[]): string[] {
  const seen = new Map<string, number>()
  return list.map((v) => {
    const k = seen.get(v) ?? 0
    seen.set(v, k + 1)
    return `${v}#${k}`
  })
}
