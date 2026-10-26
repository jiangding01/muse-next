/**
 * 字素簇边界（M3 T3c；`docs/M3_EDITOR_CORE_PLAN.md` §9.1；纯逻辑）。
 *
 * - 折叠光标的 Backspace / Delete 删除光标前 / 后**一个字素簇**（`Intl.Segmenter`，在 editor view 坐标上计算）：emoji、
 *   ZWJ 序列、旗帜、组合符序列都整体删除，代理对不会被拆开。view 中 CRLF 已是一个 LF，孤立 CR 是一个占位符，都各自成簇。
 * - 与 Chromium 原生不同：原生 Backspace 对「基字符 + 组合符」只删组合符一个码点（T3c Preflight r0 §4.3，Q-C2 裁决保持方案口径）。
 * 不依赖 DOM / 平台全局。
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** `offset` 之前那个字素簇的起点；`offset` 为 0 时返回 0。偏移按 UTF-16 code unit。 */
export function previousGraphemeStart(text: string, offset: number): number {
  if (offset <= 0) return 0;
  const segment = segmenter.segment(text).containing(Math.min(offset, text.length) - 1);
  return segment === undefined ? offset - 1 : segment.index;
}

/** `offset` 之后那个字素簇的终点；`offset` 在末尾时返回 `text.length`。 */
export function nextGraphemeEnd(text: string, offset: number): number {
  if (offset >= text.length) return text.length;
  const segment = segmenter.segment(text).containing(Math.max(offset, 0));
  return segment === undefined ? offset + 1 : segment.index + segment.segment.length;
}
