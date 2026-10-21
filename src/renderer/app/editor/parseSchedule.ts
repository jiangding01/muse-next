/**
 * 解析调度状态机（M3 T3a；`docs/M3_EDITOR_CORE_PLAN.md` §8.2，T3 Preflight r3 §6；纯逻辑）。
 *
 * `stepParseSchedule(state, event)` 返回新状态与要执行的副作用（建定时器、取消定时器、立即解析）；不读时钟、不建定时器、
 * 不解析，这些都在 `parseController.ts`。
 *
 * - 源码变化：取消旧定时器，按新令牌重新计时 500ms（debounce）。组字中只记下「有待解析」，组字结束后再计时（F3）。
 * - flush（blur / Reparse / undo / redo）：取消定时器并立即解析；组字中一律忽略（IME 期间不解析）。
 * - 只有显式 Reparse 产生 `force: true`：同版本也重新调用 `loadJcx`（外部审查 H3-3）。自动调度、blur、undo / redo 为
 *   `force: false`，由控制器在当前版本已解析时跳过（undo / redo 的版本必然已改变，等价于立即解析）。
 * - 定时器到期只在令牌仍是当前令牌时有效；旧定时器的迟到回调一律忽略。
 * - 文档被替换：取消定时器、清除待解析与组字标记。
 */

export const PARSE_DEBOUNCE_MS = 500;

export type FlushReason = 'blur' | 'reparse' | 'undo' | 'redo';

export interface ParseScheduleState {
  /** 最近一次发出的定时器令牌（单调递增，0 表示尚未发出）。 */
  readonly lastToken: number;
  /** 当前仍有效的定时器令牌；null 表示没有在计时。 */
  readonly armed: number | null;
  readonly composing: boolean;
  /** 组字期间发生过源码变化（组字结束后需要计时）。 */
  readonly pending: boolean;
}

export type ParseScheduleEvent =
  | { readonly type: 'source-changed' }
  | { readonly type: 'flush'; readonly reason: FlushReason }
  | { readonly type: 'composition-start' }
  | { readonly type: 'composition-end' }
  | { readonly type: 'document-replaced' }
  | { readonly type: 'timer-fired'; readonly token: number };

export type ParseScheduleEffect =
  | { readonly type: 'arm-timer'; readonly token: number; readonly delayMs: number }
  | { readonly type: 'cancel-timer'; readonly token: number }
  | { readonly type: 'parse-now'; readonly force: boolean };

export interface ParseScheduleStep {
  readonly state: ParseScheduleState;
  readonly effects: readonly ParseScheduleEffect[];
  /** flush 因组字而被忽略（控制器据此给出轻提示）。 */
  readonly ignoredWhileComposing: boolean;
}

export function initialParseSchedule(): ParseScheduleState {
  return { lastToken: 0, armed: null, composing: false, pending: false };
}

const cancelArmed = (state: ParseScheduleState): ParseScheduleEffect[] => (state.armed === null ? [] : [{ type: 'cancel-timer', token: state.armed }]);

function arm(state: ParseScheduleState): ParseScheduleStep {
  const token = state.lastToken + 1;
  return {
    state: { ...state, lastToken: token, armed: token, pending: false },
    effects: [...cancelArmed(state), { type: 'arm-timer', token, delayMs: PARSE_DEBOUNCE_MS }],
    ignoredWhileComposing: false,
  };
}

const step = (state: ParseScheduleState, effects: readonly ParseScheduleEffect[] = [], ignoredWhileComposing = false): ParseScheduleStep => ({
  state,
  effects,
  ignoredWhileComposing,
});

export function stepParseSchedule(state: ParseScheduleState, event: ParseScheduleEvent): ParseScheduleStep {
  switch (event.type) {
    case 'source-changed':
      return state.composing ? step({ ...state, pending: true }) : arm(state);
    case 'flush':
      if (state.composing) return step(state, [], true);
      return step({ ...state, armed: null, pending: false }, [...cancelArmed(state), { type: 'parse-now', force: event.reason === 'reparse' }]);
    case 'composition-start':
      return step({ ...state, composing: true, armed: null, pending: state.pending || state.armed !== null }, cancelArmed(state));
    case 'composition-end': {
      const ended = { ...state, composing: false };
      return ended.pending ? arm(ended) : step(ended);
    }
    case 'document-replaced':
      return step({ ...state, armed: null, composing: false, pending: false }, cancelArmed(state));
    case 'timer-fired':
      if (state.armed === null || event.token !== state.armed) return step(state);
      return step({ ...state, armed: null }, [{ type: 'parse-now', force: false }]);
  }
}
