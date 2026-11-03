/**
 * 列表的 Windows 式批量勾选，账号与 API Key 列表共用：
 *  - 按住 Shift 点击：从上一次点击的条目到这一次之间（按当前排序与筛选后的顺序）全部设为同一状态；
 *    Shift 点击不移动锚点，可以连续调整范围的另一端，和资源管理器一致
 *  - Ctrl / Cmd + A：勾选当前筛选结果
 *  - Esc：取消全部勾选
 *
 * 卡片与复选框只把「勾 / 不勾」往外抛，拿不到点击事件，所以 Shift 是否按下
 * 在 window 的捕获阶段记录下来，toggle 时读取。
 */
import { onBeforeUnmount, onMounted } from 'vue'

interface RangeSelectOptions {
  /** 当前列表顺序（已筛选、已排序）的 id */
  order: () => string[]
  /** 把一批 id 设为勾选或取消勾选 */
  apply: (ids: string[], checked: boolean) => void
  /** Ctrl / Cmd + A 时勾选当前筛选结果 */
  selectAll: () => void
  /** 按 Esc 时取消全部勾选 */
  clear: () => void
}

/** 焦点在输入控件里、或有弹窗 / 抽屉开着时，快捷键交给它们（全选输入框文字等） */
function shortcutBlocked(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null
  if (el?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return true
  return !!document.querySelector('.ant-modal-wrap:not([style*="display: none"]), .ant-drawer-open')
}

export function useRangeSelect(options: RangeSelectOptions): {
  toggle: (id: string, checked: boolean) => void
  /** 清空锚点：切换筛选条件后范围勾选应从新的起点重新开始 */
  resetAnchor: () => void
} {
  let shift = false
  let anchor: string | null = null

  const recordShift = (e: MouseEvent): void => {
    shift = e.shiftKey
    // Shift 点击会把两次点击之间的文字选中，范围勾选时没有意义；输入框里的 Shift 选字不拦
    if (e.shiftKey && !shortcutBlocked(e.target)) e.preventDefault()
  }

  const onKeydown = (e: KeyboardEvent): void => {
    /*
     * Esc：取消全部勾选。
     * 弹窗开着时不拦——Esc 是关闭弹窗的通用操作，此时清勾选会顺手改掉用户
     * 看不见的列表状态。输入框里的 Esc 也交给它自己（清空联想等）。
     */
    if (e.key === 'Escape') {
      if (shortcutBlocked(e.target)) return
      anchor = null
      options.clear()
      return
    }

    if (e.key.toLowerCase() !== 'a' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
    if (shortcutBlocked(e.target)) return
    e.preventDefault()
    options.selectAll()
  }

  onMounted(() => {
    window.addEventListener('mousedown', recordShift, true)
    window.addEventListener('keydown', onKeydown)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('mousedown', recordShift, true)
    window.removeEventListener('keydown', onKeydown)
  })

  function toggle(id: string, checked: boolean): void {
    if (shift && anchor && anchor !== id) {
      const order = options.order()
      const from = order.indexOf(anchor)
      const to = order.indexOf(id)
      // 锚点被筛掉了就退回单个勾选
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        options.apply(order.slice(lo, hi + 1), checked)
        return
      }
    }
    anchor = id
    options.apply([id], checked)
  }

  return { toggle, resetAnchor: () => (anchor = null) }
}
