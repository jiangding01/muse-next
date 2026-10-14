/**
 * M3 T2 History —— 随机性质测试（测试 #11、#19）。
 *
 * 随机执行 commit（三类合并提示、无提示的多补丁事务、可视化命令）/ undo / redo / endCoalescing / 移动光标，与只记录
 * 文本的朴素参照模型逐步比对：合并组的 undo 回到组首文本、redo 回到组尾文本；版本在每次成功变化时严格 +1，失败与
 * 无变化时不变；从不出现 history-corrupt。失败消息带 seed 与步号，保证可复现。
 */

import { describe, expect, it } from 'vitest';

import { endCoalescing, redo, undo } from '../../../src/editor/history/history';
import type { CoalesceKind } from '../../../src/editor/history/types';
import type { TextPatch } from '../../../src/editor/text/types';
import { begin, caretAt, commit, rangeOf } from './historyKit';
import type { Editor } from './historyKit';
import { createPrng, randomText } from './prng';
import type { Prng } from './prng';

const ALPHABET = ['a', 'b', '中', '\r', '\n', '\r\n', '\uD83D', '\uDE00', '😀', ' '];
const PLAIN = ['a', 'b', '中', '😀', ' '];

interface ModelEntry {
  readonly before: string;
  after: string;
}

function randomPatch(prng: Prng, length: number): TextPatch {
  const start = prng.int(length + 1);
  const end = start + prng.int(Math.min(3, length - start) + 1);
  return { start, end, text: randomText(prng, ALPHABET, 3) };
}

interface Stats {
  changed: number;
  merged: number;
  unchanged: number;
  rejected: number;
  undos: number;
  redos: number;
}

function runSeed(seed: number, steps: number): Stats {
  const stats: Stats = { changed: 0, merged: 0, unchanged: 0, rejected: 0, undos: 0, redos: 0 };
  const prng = createPrng(seed);
  const protectedStart = seed % 2 === 0;
  let editor: Editor = begin(`${protectedStart ? '﻿' : ''}ab\r\ncd\ref`);
  const undoModel: ModelEntry[] = [];
  const redoModel: ModelEntry[] = [];
  let time = 0;
  let lastOp = -1;
  const initial = editor.session.source;

  for (let step = 0; step < steps; step += 1) {
    const where = `seed ${String(seed)} step ${String(step)}`;
    const source = editor.session.source;
    const version = editor.session.sourceVersion;
    // 让同类编辑经常连续出现、时间间隔大多落在合并窗口内，以充分覆盖合并路径；偶尔超窗。
    const repeatEdit = lastOp >= 4 && lastOp <= 7 && prng.int(3) > 0;
    const op = repeatEdit ? lastOp : lastOp === 0 && prng.int(2) === 0 ? 1 : prng.int(10);
    lastOp = op;
    time += prng.int(5) === 0 ? 900 + prng.int(400) : prng.int(300);

    if (op === 0 && undoModel.length > 0) {
      const result = undo(editor.session, editor.history);
      expect(result.ok, where).toBe(true);
      if (!result.ok) return stats;
      stats.undos += 1;
      const entry = undoModel.pop();
      expect(result.session.source, where).toBe(entry?.before);
      expect(result.session.sourceVersion, where).toBe(version + 1);
      if (entry !== undefined) redoModel.push(entry);
      editor = result;
      continue;
    }
    if (op === 1 && redoModel.length > 0) {
      const result = redo(editor.session, editor.history);
      expect(result.ok, where).toBe(true);
      if (!result.ok) return stats;
      stats.redos += 1;
      const entry = redoModel.pop();
      expect(result.session.source, where).toBe(entry?.after);
      expect(result.session.sourceVersion, where).toBe(version + 1);
      if (entry !== undefined) undoModel.push(entry);
      editor = result;
      continue;
    }
    if (op === 2) {
      editor = { ...editor, history: endCoalescing(editor.history) };
      continue;
    }
    if (op === 3) {
      const a = prng.int(source.length + 1);
      const b = prng.int(3) === 0 ? a : a + prng.int(source.length - a + 1);
      editor = { ...editor, selection: b === a ? caretAt(editor.session, a) : rangeOf(editor.session, a, b) };
      continue;
    }

    const caret = editor.selection.ranges[0]?.start ?? 0;
    let patches: TextPatch[];
    let coalesce: CoalesceKind | undefined;
    let origin: 'source-input' | 'visual-command' = 'source-input';
    if (op <= 5) {
      coalesce = 'insert';
      patches = [{ start: caret, end: caret, text: prng.int(5) === 0 ? prng.pick(ALPHABET) : prng.pick(PLAIN) }];
    } else if (op === 6) {
      coalesce = 'delete-backward';
      patches = [{ start: Math.max(0, caret - 1), end: caret, text: '' }];
    } else if (op === 7) {
      coalesce = 'delete-forward';
      patches = [{ start: caret, end: Math.min(source.length, caret + 1), text: '' }];
    } else {
      origin = op === 8 ? 'source-input' : 'visual-command';
      patches = [randomPatch(prng, source.length)];
      if (prng.int(2) === 0) patches.push(randomPatch(prng, source.length + 4));
    }
    const result = commit(editor, patches, { origin, timestamp: time, ...(coalesce === undefined ? {} : { coalesce }) });
    if (!result.ok) {
      expect(result.reason, where).not.toBe('history-corrupt');
      stats.rejected += 1;
      continue;
    }
    if (!result.changed) {
      expect(result.session.source, where).toBe(source);
      expect(result.session.sourceVersion, where).toBe(version);
      expect(result.history.undo, where).toBe(editor.history.undo);
      expect(result.history.redo, where).toBe(editor.history.redo);
      stats.unchanged += 1;
      editor = result;
      continue;
    }
    expect(result.session.sourceVersion, where).toBe(version + 1);
    expect(result.history.redo, where).toBeNull();
    stats.changed += 1;
    if (result.merged) stats.merged += 1;
    redoModel.length = 0;
    const top = undoModel.at(-1);
    if (result.merged && top !== undefined) top.after = result.session.source;
    else undoModel.push({ before: source, after: result.session.source });
    expect(result.history.undo?.size, where).toBe(undoModel.length);
    editor = result;
  }

  // 全部 undo 回到初始，全部 redo 回到最终。
  const final = editor.session.source;
  while (editor.history.undo !== null) {
    const result = undo(editor.session, editor.history);
    if (!result.ok) throw new Error(`undo-all ${String(seed)}: ${result.reason}`);
    editor = result;
  }
  expect(editor.session.source, `seed ${String(seed)} undo-all`).toBe(initial);
  while (editor.history.redo !== null) {
    const result = redo(editor.session, editor.history);
    if (!result.ok) throw new Error(`redo-all ${String(seed)}: ${result.reason}`);
    editor = result;
  }
  expect(editor.session.source, `seed ${String(seed)} redo-all`).toBe(final);
  return stats;
}

describe('M3 T2 History —— 随机性质（#11、#19）', () => {
  it.each([11, 23, 97])('seed %d：与朴素参照模型逐步一致、版本严格单调、全部 undo / redo 往返', (seed) => {
    const stats = runSeed(seed, 800);
    // 防空跑：每类路径都必须被真实执行足够多次。
    expect(stats.changed).toBeGreaterThan(300);
    expect(stats.merged).toBeGreaterThan(50);
    expect(stats.undos).toBeGreaterThan(30);
    expect(stats.redos).toBeGreaterThan(15);
    expect(stats.unchanged).toBeGreaterThan(10);
    expect(stats.rejected).toBeGreaterThan(30);
  });
});
