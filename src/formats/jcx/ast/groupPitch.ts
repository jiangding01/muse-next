/**
 * JCX Lossless AST —— pitch 侧组合：note / rest（M1.5 T4）。
 *
 * **mode-free**：本文件不知道「当前是 pitch 还是 tab 模式」，只按 token kind 的
 * 邻接关系组合。lexer 已经用 kind 把模式固化了（§13.2 的模式状态机决定产出
 * `pitchLetter` 还是 `stringLetter`），AST 再判一次模式只会引入第二个事实来源。
 *
 * 边界 A（M1.5 已拍板，不可放宽）：
 * - `note = accidental* pitchLetter octaveMark* duration?`；
 * - `brokenRhythm` / `tie` / `slurOpen` / `slurClose` / `tupletStart` / `tabRelation`
 *   **永远是兄弟标记**，不进 note；
 * - `accidental*` 之后若不紧跟 `pitchLetter`（如 `^ |`、`^^` 行尾），整段退回叶子
 *   ——本函数返回 `undefined`，主循环对首个 token 走 `buildBodyNode`，
 *   下一轮再从第二个 accidental 重试，逐个降级，原文零丢失。
 */

import type { JcxToken } from '../lexer/token';
import type { AstPath, JcxNoteNode, JcxRestNode } from './nodes';
import { isTokenOfKind, spanFrom, startRun, takeOne, takeWhile } from './tokenCursor';

/** 一次成功组合的结果：节点本体 + 下一个待消费 token 的下标。 */
export interface GroupAttempt<N> {
  readonly node: N;
  readonly next: number;
}

/** §14.3 的 note children，与 `JcxNoteNode.children` 的类型参数严格一致。 */
type NoteChildKind = 'accidental' | 'pitchLetter' | 'octaveMark' | 'duration';

/**
 * §15 的 rest children。`tabDurSep` 在列：TAB 声部里同样出现 `z`（§26.9），
 * 而 TAB 的时值必须由 `*` / `/` 引出（§26.5），所以 `z*2` 的三个 token 属于
 * 同一个休止符，不能把分隔符甩成兄弟叶子。
 */
type RestChildKind = 'rest' | 'hiddenRest' | 'duration' | 'tabDurSep';

const ACCIDENTAL: readonly NoteChildKind[] = ['accidental'];
const PITCH_LETTER: readonly NoteChildKind[] = ['pitchLetter'];
const OCTAVE_MARK: readonly NoteChildKind[] = ['octaveMark'];
const NOTE_DURATION: readonly NoteChildKind[] = ['duration'];

const REST_HEAD: readonly RestChildKind[] = ['rest', 'hiddenRest'];
const REST_DURATION: readonly RestChildKind[] = ['duration'];
const REST_DUR_SEP: readonly RestChildKind[] = ['tabDurSep'];

/** note 的起始 token kind，供主循环派发用（不含 `octaveMark` / `duration`：它们不能独立起头）。 */
export const NOTE_START_KINDS: readonly NoteChildKind[] = ['accidental', 'pitchLetter'];

/** rest 的起始 token kind。 */
export const REST_START_KINDS: readonly RestChildKind[] = ['rest', 'hiddenRest'];

/**
 * §14.3：`accidental* pitchLetter octaveMark* duration?`。
 *
 * 返回 `undefined` 表示「这里不是一个 note」——调用方必须把 `tokens[index]`
 * 单独降级为叶子，绝不可跳过它（跳过即丢失原文）。
 */
export function tryNote(
  tokens: readonly JcxToken[],
  index: number,
  path: AstPath,
): GroupAttempt<JcxNoteNode> | undefined {
  if (!isTokenOfKind(tokens[index], NOTE_START_KINDS)) {
    return undefined;
  }
  const run = startRun<NoteChildKind>(index);
  takeWhile(tokens, run, ACCIDENTAL, path);
  if (!takeOne(tokens, run, PITCH_LETTER, path)) {
    // `accidental*` 后不是音名：整段退回叶子（边界 A）。
    return undefined;
  }
  takeWhile(tokens, run, OCTAVE_MARK, path);
  takeOne(tokens, run, NOTE_DURATION, path);

  const head = run.leaves[0];
  if (head === undefined) {
    // 不可达：上面的 `takeOne(PITCH_LETTER)` 成功即至少有一枚叶子。
    return undefined;
  }
  return {
    node: { kind: 'note', path, span: spanFrom(head, run.leaves), children: run.leaves },
    next: run.index,
  };
}

/**
 * §15 / §26.9：`rest|hiddenRest` 后跟可选时值，两种写法：
 * - pitch 形态 `z2` / `z/` —— 直接跟 `duration`；
 * - tab 形态 `z*2` / `z//` —— 先 `tabDurSep`，其后 `duration` 可缺省
 *   （语料里 `ax//bx//` 的 `//` 后直接接下一个音，§26.5）。
 *
 * 两种形态靠 token kind 区分，不看模式。
 */
export function tryRest(
  tokens: readonly JcxToken[],
  index: number,
  path: AstPath,
): GroupAttempt<JcxRestNode> | undefined {
  const run = startRun<RestChildKind>(index);
  if (!takeOne(tokens, run, REST_HEAD, path)) {
    return undefined;
  }
  if (!takeOne(tokens, run, REST_DURATION, path) && takeOne(tokens, run, REST_DUR_SEP, path)) {
    takeOne(tokens, run, REST_DURATION, path);
  }

  const head = run.leaves[0];
  if (head === undefined) {
    // 不可达：`takeOne(REST_HEAD)` 成功即至少有一枚叶子。
    return undefined;
  }
  return {
    node: { kind: 'rest', path, span: spanFrom(head, run.leaves), children: run.leaves },
    next: run.index,
  };
}
