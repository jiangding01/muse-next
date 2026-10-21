/**
 * 解析调度的副作用适配（M3 T3a；T3 Preflight r3 §6，外部审查 H3-3）。
 *
 * 把纯状态机 `parseSchedule.ts` 的效果落到定时器、`loadJcx` 与 store：
 * - `arm-timer` / `cancel-timer` → 注入的一次性定时器（测试用假时钟）；旧令牌的回调由状态机忽略。
 * - `parse-now{force}` → 读当前会话；`force === false` 且当前版本已解析时跳过（自动调度去重）；否则捕获
 *   `(documentId, sourceVersion)`，调用 `loadJcx(source, { sourceEncoding: writeEncoding })`，再读 store，经 T0
 *   `acceptParsedSnapshot` 校验两者都未变才发布；不一致丢弃（`loadJcx` 是同步的，这是零成本防线）。
 * - 显式 Reparse（`force: true`）不改变 sourceVersion、不创建 History 事务；同版本的新快照对象照常发布。
 * - 整个立即解析过程（读取、`loadJcx`、校验、发布）中的异常都归入编辑器错误：报告、保留原有快照不变（stale 或同版本
 *   旧快照）、给出「解析失败」提示，不向定时器回调或 undo / redo 的调用方抛出（方案 §19.2）。发布被 store 拒绝说明不变量
 *   被破坏（刚用当前会话校验通过），同样报告。
 * 控制器是模块级对象，不在任何 React 组件生命周期里。
 */

import { acceptParsedSnapshot } from '../../../editor/session/reducer';
import { isParseStale } from '../../../editor/session/derive';
import type { DocumentSession } from '../../../editor/session/types';
import { loadJcx } from '../../../formats/jcxParse';
import type { JcxEncoding, LoadResult } from '../../../formats/jcxParse';
import { reportEditorError } from '../fatalError';
import { publishEditorView, publishParsedSession, useMuseAppStore } from '../store';
import type { StoreWriteResult } from '../store';
import type { EditorNotice } from './editorTransitions';
import { initialParseSchedule, stepParseSchedule } from './parseSchedule';
import type { FlushReason, ParseScheduleEvent, ParseScheduleState } from './parseSchedule';

export interface ParseControllerDeps {
  /** 一次性定时器；返回取消函数。 */
  readonly schedule: (delayMs: number, task: () => void) => () => void;
  readonly read: () => DocumentSession;
  readonly load: (source: string, sourceEncoding: JcxEncoding) => LoadResult;
  readonly publish: (session: DocumentSession) => StoreWriteResult;
  readonly notify: (notice: EditorNotice) => void;
  readonly report: (error: unknown) => void;
}

/** 一次立即解析的结果（测试与诊断）。 */
export type ParseOutcome = 'parsed' | 'skipped' | 'discarded' | 'failed';

export type FlushOutcome = ParseOutcome | 'ignored-composing';

export interface ParseController {
  sourceChanged(): void;
  /** blur / Reparse / undo / redo：取消定时器并立即解析；组字中忽略。 */
  flush(reason: FlushReason): FlushOutcome;
  compositionStart(): void;
  compositionEnd(): void;
  documentReplaced(): void;
  /** 只读诊断快照（测试）。 */
  state(): ParseScheduleState;
}

export function createParseController(deps: ParseControllerDeps): ParseController {
  let state = initialParseSchedule();
  const timers = new Map<number, () => void>();

  function parseOnce(force: boolean): ParseOutcome {
    const session = deps.read();
    if (!force && !isParseStale(session)) return 'skipped';
    const { documentId, sourceVersion } = session;
    const load: LoadResult = deps.load(session.source, session.writeEncoding);
    const accepted = acceptParsedSnapshot(deps.read(), { documentId, sourceVersion, load });
    if (!accepted.ok) return 'discarded';
    const published = deps.publish(accepted.session);
    if (!published.ok) {
      deps.report(new Error(`parse publish rejected: ${published.reason}`));
      return 'discarded';
    }
    if (force) deps.notify({ kind: 'reparsed' });
    return 'parsed';
  }

  function parseNow(force: boolean): ParseOutcome {
    try {
      return parseOnce(force);
    } catch (error) {
      deps.report(error);
      deps.notify({ kind: 'parse-failed' });
      return 'failed';
    }
  }

  function dispatch(event: ParseScheduleEvent): { outcome: ParseOutcome | null; ignored: boolean } {
    const next = stepParseSchedule(state, event);
    state = next.state;
    let outcome: ParseOutcome | null = null;
    for (const effect of next.effects) {
      if (effect.type === 'arm-timer') {
        const { token } = effect;
        timers.set(
          token,
          deps.schedule(effect.delayMs, () => {
            timers.delete(token);
            dispatch({ type: 'timer-fired', token });
          }),
        );
      } else if (effect.type === 'cancel-timer') {
        timers.get(effect.token)?.();
        timers.delete(effect.token);
      } else {
        outcome = parseNow(effect.force);
      }
    }
    return { outcome, ignored: next.ignoredWhileComposing };
  }

  return {
    sourceChanged: () => {
      dispatch({ type: 'source-changed' });
    },
    flush: (reason) => {
      const result = dispatch({ type: 'flush', reason });
      if (result.ignored) {
        if (reason === 'reparse') deps.notify({ kind: 'reparse-ignored-composing' });
        return 'ignored-composing';
      }
      return result.outcome ?? 'skipped';
    },
    compositionStart: () => {
      dispatch({ type: 'composition-start' });
    },
    compositionEnd: () => {
      dispatch({ type: 'composition-end' });
    },
    documentReplaced: () => {
      dispatch({ type: 'document-replaced' });
    },
    state: () => state,
  };
}

/** 产品使用的模块级解析控制器。 */
export const museParseController: ParseController = createParseController({
  schedule: (delayMs, task) => {
    const timer = setTimeout(task, delayMs);
    return () => clearTimeout(timer);
  },
  read: () => useMuseAppStore.getState().session,
  load: (source, sourceEncoding) => loadJcx(source, { sourceEncoding }),
  publish: publishParsedSession,
  notify: (notice) => publishEditorView({ notice }),
  report: (error) => reportEditorError(error, 'parse'),
});
