/**
 * 批量提示词按行拆分（「✂ 拆行提交」/ Ctrl+E 多行识别共用）。
 *
 * 规则：按换行拆分 → 每行 trim → 丢弃空行 → 每个非空行 = 一条提示词。
 * 拆出 <2 条视为未命中（调用方回落整段提交，不打扰单行场景）。
 */

/** 单次批量提交上限（与批次数量钳制一致） */
export const BATCH_TEXT_MAX = 50

export function splitBatchLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}
