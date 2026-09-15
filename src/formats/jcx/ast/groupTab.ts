/**
 * JCX Lossless AST —— TAB 侧组合：tabNote（M1.5 T4）。
 *
 * **mode-free**：与 `groupPitch.ts` 同理，只按 token kind 组合。`stringLetter` /
 * `fret` / `tabDurSep` / `strokePrefix` 这几种 kind 只可能由 `lexBodyTab` 产出
 * （§13.2 模式状态机的结论已经固化在 kind 里），因此不需要、也不允许再看一次 mode。
 *
 * §26.3 / §26.5 grammar：`tab-note = [stroke-prefix] string-letter fret [ ("*"|"/") duration ]`。
 * lexer 侧两条产出顺序保证让这里可以只看相邻 kind：
 * - `fret` 只在紧跟 `stringLetter` 时产出（`lexBodyTab.ts` 显式检查上一个 token）；
 * - `tabDurSep` 与其后的 `duration` 由 `lexTabDuration` 一次性成对切出。
 */

import type { JcxToken } from '../lexer/token';
import type { AstPath, JcxTabNoteNode } from './nodes';
import type { GroupAttempt } from './groupPitch';
import { isTokenOfKind, spanFrom, startRun, takeOne } from './tokenCursor';

type TabNoteChildKind = 'strokePrefix' | 'stringLetter' | 'fret' | 'tabDurSep' | 'duration';

const STROKE_PREFIX: readonly TabNoteChildKind[] = ['strokePrefix'];
const STRING_LETTER: readonly TabNoteChildKind[] = ['stringLetter'];
const FRET: readonly TabNoteChildKind[] = ['fret'];
const TAB_DUR_SEP: readonly TabNoteChildKind[] = ['tabDurSep'];
const TAB_DURATION: readonly TabNoteChildKind[] = ['duration'];

/** tabNote 的起始 token kind，供主循环派发用。 */
export const TAB_NOTE_START_KINDS: readonly TabNoteChildKind[] = ['strokePrefix', 'stringLetter'];

/**
 * §26.4：`strokePrefix` 是否应当被**本音符**吸收。
 *
 * 只看下一个 token 的 kind，三种结论：
 * - 下一个是 `stringLetter` → 吸收（`Va1` 的 `V` 属于这个 tabNote）；
 * - 下一个是 `tabGroupOpen` → **不吸收**（`V[ax/bx/]` 的 `V` 作用于整个弦组，
 *   而弦组是兄弟节点；硬塞进某个 tabNote 会伪造一个规格里不存在的从属关系）；
 * - 其余（空白、行尾、小节线……）→ 悬空前缀，作独立叶子。lexer 已在此处发过
 *   `jcx.tab.dangling-stroke-prefix` 的 info，AST 层零自产 diagnostic，不重复。
 */
export function absorbsStrokePrefix(tokens: readonly JcxToken[], index: number): boolean {
  return isTokenOfKind(tokens[index + 1], STRING_LETTER);
}

/**
 * §26：`strokePrefix? stringLetter fret? tabDurSep? duration?`。
 *
 * 返回 `undefined` 表示「这里不是一个 tabNote」——调用方把 `tokens[index]`
 * 单独降级为叶子（`strokePrefix` 有专用叶子 kind，走 `bodyLeaf`）。
 */
export function tryTabNote(
  tokens: readonly JcxToken[],
  index: number,
  path: AstPath,
): GroupAttempt<JcxTabNoteNode> | undefined {
  if (isTokenOfKind(tokens[index], STROKE_PREFIX) && !absorbsStrokePrefix(tokens, index)) {
    return undefined;
  }
  const run = startRun<TabNoteChildKind>(index);
  takeOne(tokens, run, STROKE_PREFIX, path);
  if (!takeOne(tokens, run, STRING_LETTER, path)) {
    return undefined;
  }
  takeOne(tokens, run, FRET, path);
  if (takeOne(tokens, run, TAB_DUR_SEP, path)) {
    // §26.5：时值数值可缺省（`ax//bx//`），缺省时只留分隔符。
    takeOne(tokens, run, TAB_DURATION, path);
  }

  const head = run.leaves[0];
  if (head === undefined) {
    // 不可达：`takeOne(STRING_LETTER)` 成功即至少有一枚叶子。
    return undefined;
  }
  return {
    node: { kind: 'tabNote', path, span: spanFrom(head, run.leaves), children: run.leaves },
    next: run.index,
  };
}
