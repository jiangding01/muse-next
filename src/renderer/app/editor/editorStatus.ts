/**
 * 状态栏的纯派生与文案（M3 T3b；方案 §7.1 / §8.2 的 F3 三态，T3 Preflight r3 §10 T3b，用户裁决 Q-B2）。
 *
 * - 三个派生状态互不合并，全部来自 Editor Core 的 `derive`：`sourceDirty`（源码已修改）、`parseStale`（谱面与诊断来自
 *   旧版本，等待解析）、`saveInFlight`（T3 没有保存，恒为 false）。stale 与 dirty 独立：undo 回到保存点后仍可能 stale。
 * - 编辑器轻提示的文案穷举 `EditorNoticeKind`（新增种类而未写文案时类型检查失败）。T3 没有 Save，文案不写「先保存」。
 * 纯模块：只依赖 Editor Core 与同目录的类型，不用平台全局（`architecture.m3t3` 钉住）。
 */

import { isParseStale, isSaveInFlight, isSourceDirty } from '../../../editor/session/derive';
import type { DocumentSession } from '../../../editor/session/types';
import type { EditorNoticeKind } from './editorTransitions';

export interface EditorStatusView {
  readonly sourceVersion: number;
  /** 当前快照所属的版本；没有快照时为 null。 */
  readonly parsedVersion: number | null;
  readonly sourceDirty: boolean;
  readonly parseStale: boolean;
  readonly saveInFlight: boolean;
}

export function editorStatusView(session: DocumentSession): EditorStatusView {
  return {
    sourceVersion: session.sourceVersion,
    parsedVersion: session.parsed === null ? null : session.parsed.sourceVersion,
    sourceDirty: isSourceDirty(session),
    parseStale: isParseStale(session),
    saveInFlight: isSaveInFlight(session),
  };
}

/** 状态栏的状态文案（按显示顺序）；clean 且已解析时为空数组。 */
export function editorStatusLabels(view: EditorStatusView): string[] {
  const labels: string[] = [];
  if (view.sourceDirty) labels.push('源码已修改');
  if (view.parseStale) labels.push('待解析：谱面与诊断来自旧版本');
  if (view.saveInFlight) labels.push('正在保存…');
  return labels;
}

const NOTICE_TEXT: Readonly<Record<EditorNoticeKind, string>> = {
  'open-refused-dirty': '当前文档有未保存的修改；本阶段尚不能保存。撤销到未修改状态后才能打开其它文件。',
  'open-refused-composing': '请先完成或取消正在进行的输入，再打开文件。',
  'open-candidate-dropped-dirty': '打开期间当前文档出现了修改，已放弃本次打开；当前文档未改变。',
  'open-commit-refused-dirty': '打开时检测到未保存的修改，没有替换当前文档；原文件授权未确认，重新打开文件即可恢复。',
  'command-ignored-composing': '正在输入，撤销 / 重做暂不可用。',
  'command-ignored-replacing': '正在打开文件，撤销 / 重做暂不可用。',
  'nothing-to-undo': '没有可撤销的操作。',
  'nothing-to-redo': '没有可重做的操作。',
  'reparse-ignored-composing': '正在输入，完成输入后再重新解析。',
  reparsed: '已重新解析。',
  'parse-failed': '解析失败，谱面保留上一次的结果。',
  'editor-error': '编辑器发生内部错误，本次操作没有生效。',
  'unload-blocked-dirty': '有未保存的修改，窗口未关闭（本阶段不能保存；撤销到未修改状态后可关闭）。',
  'unload-blocked-composing': '正在输入，窗口未关闭；完成或取消输入后可关闭。',
};

export function editorNoticeText(kind: EditorNoticeKind): string {
  return NOTICE_TEXT[kind];
}
