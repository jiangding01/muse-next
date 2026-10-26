/**
 * beforeinput → 输入计划（M3 T3c；`docs/M3_EDITOR_CORE_PLAN.md` §9.1；T3c Preflight r0 §4；纯逻辑）。
 *
 * - 补丁只由 inputType、事件携带的数据与**事件发生时**的 view 选区构造，不做全文 diff，也不读 `getTargetRanges()`（textarea 中恒为空）。
 * - 插入文本中的 CRLF / CR 先规范为 LF（view 中不存在 CR；换行序列由 T0 投影按 dominant EOL 转换）。
 *   实测：粘贴时 beforeinput 的 `data` 保留原始 CR，原生插入结果却已是 LF，所以必须在补丁前规范，不能依赖原生结果。
 * - 折叠光标的删除按字素簇（`graphemes.ts`）；在 view 开头的 Backspace、末尾的 Delete 是无操作。
 * - 只有冻结表中的类型会产生补丁；其它可取消类型（删词、删到行首 / 行尾、Ctrl+K / Y / T、拖放、拼写替换、未知类型）一律 fail closed。
 * 不依赖 DOM / 平台全局。
 */

import type { CoalesceKind } from '../../../editor/history/types';
import type { SourceRange, TextPatch } from '../../../editor/text/types';
import { nextGraphemeEnd, previousGraphemeStart } from './graphemes';

/** 计划所需的事件事实（适配层从 InputEvent 与 textarea 同步读取）。 */
export interface InputFacts {
  readonly inputType: string;
  readonly data: string | null;
  /** `dataTransfer?.getData('text/plain')`；没有 dataTransfer 时为 null。 */
  readonly dataTransferText: string | null;
  /** 事件发生时的 textarea 选区（view 坐标）。 */
  readonly selection: SourceRange;
  /** 当前会话的 editor view（适配层已确认 DOM 与它一致）。 */
  readonly view: string;
}

export type InputRejectReason = 'unsupported' | 'no-data';

export type InputPlan =
  | { readonly kind: 'patch'; readonly viewPatch: TextPatch; readonly coalesce: CoalesceKind | null; readonly label: string }
  | { readonly kind: 'history'; readonly command: 'undo' | 'redo' }
  | { readonly kind: 'noop' }
  | { readonly kind: 'composition' }
  | { readonly kind: 'reject'; readonly reason: InputRejectReason };

/** CRLF / 孤立 CR → LF。 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

const patch = (start: number, end: number, text: string, coalesce: CoalesceKind | null, label: string): InputPlan => ({
  kind: 'patch',
  viewPatch: { start, end, text },
  coalesce,
  label,
});

function insertPlan(text: string, selection: SourceRange, label: string, mergeable: boolean): InputPlan {
  const collapsed = selection.start === selection.end;
  const coalesce = mergeable && collapsed && !text.includes('\n') ? 'insert' : null;
  return patch(selection.start, selection.end, text, coalesce, label);
}

export function planInput(facts: InputFacts): InputPlan {
  const { inputType, selection, view } = facts;
  const { start, end } = selection;
  switch (inputType) {
    case 'insertText': {
      if (facts.data === null || facts.data === '') return { kind: 'reject', reason: 'no-data' };
      return insertPlan(normalizeNewlines(facts.data), selection, 'insert-text', true);
    }
    case 'insertLineBreak':
    case 'insertParagraph':
      return patch(start, end, '\n', null, 'line-break');
    case 'deleteContentBackward': {
      if (start !== end) return patch(start, end, '', null, 'delete-selection');
      if (start === 0) return { kind: 'noop' };
      return patch(previousGraphemeStart(view, start), start, '', 'delete-backward', 'delete-backward');
    }
    case 'deleteContentForward': {
      if (start !== end) return patch(start, end, '', null, 'delete-selection');
      if (start >= view.length) return { kind: 'noop' };
      return patch(start, nextGraphemeEnd(view, start), '', 'delete-forward', 'delete-forward');
    }
    case 'insertFromPaste': {
      const data = facts.data ?? facts.dataTransferText;
      if (data === null) return { kind: 'reject', reason: 'no-data' };
      if (data === '') return { kind: 'noop' };
      return insertPlan(normalizeNewlines(data), selection, 'paste', false);
    }
    case 'deleteByCut':
      return start === end ? { kind: 'noop' } : patch(start, end, '', null, 'cut');
    case 'historyUndo':
      return { kind: 'history', command: 'undo' };
    case 'historyRedo':
      return { kind: 'history', command: 'redo' };
    case 'insertCompositionText':
      return { kind: 'composition' };
    default:
      return { kind: 'reject', reason: 'unsupported' };
  }
}
