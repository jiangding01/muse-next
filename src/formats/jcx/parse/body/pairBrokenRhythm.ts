/**
 * Parse 层 —— broken rhythm `>` / `<` 改写（M1.6 T7；spec §16.2，CONFIRMED）。
 *
 * 通用倍率（n = 符号个数）：`a>b` 前音 ×(2 − 1/2ⁿ)、后音 ×1/2ⁿ；`a<b` 左右镜像。
 * n=1 → 3/2 : 1/2，n=2 → 7/4 : 1/4，n=3 → 15/8 : 1/8（与 help / ABC 2.1 §4.4 一致）。
 *
 * 改写产出**新的事件对象**（`Voice.events` 是 readonly，id 与 `durationRaw` 均不变：
 * `durationRaw` 是事实，改写后的 `duration` 是 §1.7 允许进 Domain 的派生值）。
 * 任一侧缺失、不是 note/rest/chord、或没有 `duration`（`L:` 未知，方案 §7 E1）→
 * warning 且**不改时值**。
 *
 * **关系的登记边界**（M1.7 T0）：只要 marker 形态合法、两侧是相邻的合法结构端点，就
 * 立即登记一条 `BrokenRhythm`——「源文本里写过这个 `>`」是文本事实，与「这次能不能算出
 * 新 duration」无关。`durationRaw` 记的仍是原文倍数，不记下 marker 本身这条事实就无从
 * 恢复。时值缩放随后进行：失败（E1 无单位音长 / 越界）只发 warning 且不动 events，
 * **关系保留**；只有 marker 非法、缺一侧、或两侧类型不合法才不登记。
 *
 * 诊断补充：
 * | `jcx.parse.broken-rhythm.overflow` | warning | 缩放后的时值超出安全整数范围，只保留关系 |
 */

import type { BrokenRhythmRaw, MusicEvent, Rational } from '../../../../domain';
import { fromParts } from '../../../../domain';
import { safeMul } from '../duration';
import type { PairState } from './pairShared';
import {
  consume,
  isBrokenTarget,
  markerEventIndex,
  nextRelationId,
  originsOfPair,
  report,
  reportOnce,
} from './pairShared';
import type { ScanMarker } from './scanLeaf';

interface Factors {
  readonly left: Rational;
  readonly right: Rational;
}

/** `raw` 形如 `>`、`>>`、`>>>`、`<`、`<<`、`<<<`（lexer 只产出这六种）。 */
export function brokenFactors(raw: string): Factors | undefined {
  const n = raw.length;
  const first = raw[0];
  if (n < 1 || n > 3 || (first !== '>' && first !== '<')) {
    return undefined;
  }
  if (!raw.split('').every((ch) => ch === first)) {
    return undefined;
  }
  const den = 2 ** n;
  const dotted = fromParts(2 * den - 1, den);
  const halved = fromParts(1, den);
  return first === '>' ? { left: dotted, right: halved } : { left: halved, right: dotted };
}

/** 把 marker 原文收窄到 `BrokenRhythmRaw`；表外形态返回 `undefined`（不用 `as` 伪造）。 */
export function brokenRhythmRawOf(raw: string): BrokenRhythmRaw | undefined {
  switch (raw) {
    case '>':
    case '>>':
    case '>>>':
    case '<':
    case '<<':
    case '<<<':
      return raw;
    default:
      return undefined;
  }
}

function durationOf(event: MusicEvent): Rational | undefined {
  switch (event.kind) {
    case 'note':
      return event.note.duration;
    case 'rest':
      return event.rest.duration;
    case 'chord':
      return event.duration;
    default:
      return undefined;
  }
}

/**
 * 按倍率产出新事件。
 *
 * chord 只缩放**事件级**时值：成员各自的 `duration` 是 `durationRaw × L:` 的逐音事实，
 * broken rhythm 作用于「这个事件占多久」，不改写成员事实（§14.4 的取首音规则只在扫描期生效）。
 */
function scale(event: MusicEvent, factor: Rational, duration: Rational): MusicEvent | undefined {
  // `mul` 越界会抛 RangeError；parse 层永不抛异常，改走吞异常的 `safeMul`。
  const next = safeMul(duration, factor);
  if (next === undefined) {
    return undefined;
  }
  switch (event.kind) {
    case 'note':
      return { ...event, note: { ...event.note, duration: next } };
    case 'rest':
      return { ...event, rest: { ...event.rest, duration: next } };
    case 'chord':
      return { ...event, duration: next };
    default:
      return undefined;
  }
}

function reportUnresolved(state: PairState, marker: ScanMarker, why: string): void {
  report(
    state,
    'jcx.parse.broken-rhythm.unresolved',
    'warning',
    `broken rhythm ${JSON.stringify(marker.raw)} ${why}，不改写任何时值`,
    marker,
  );
}

export function applyBrokenRhythm(state: PairState, marker: ScanMarker): void {
  consume(state, marker);
  const factors = brokenFactors(marker.raw);
  const raw = brokenRhythmRawOf(marker.raw);
  if (factors === undefined || raw === undefined) {
    reportUnresolved(state, marker, '形态不符合 spec §16.2');
    return;
  }
  if (raw.startsWith('<')) {
    reportOnce(
      state,
      'broken-rhythm.left-unobserved',
      'jcx.parse.broken-rhythm.left-unobserved',
      'info',
      "左向 broken rhythm '<' 在语料中零出现（spec §16.2 标 DOC-ONLY）：按 help 的镜像规则实现，仅作观测提示",
      marker,
    );
  }

  const index = markerEventIndex(marker);
  const prev = index >= 1 ? state.events[index - 1] : undefined;
  const next = state.events[index];
  if (prev === undefined || next === undefined || !isBrokenTarget(prev) || !isBrokenTarget(next)) {
    reportUnresolved(state, marker, '两侧不是相邻的 note / rest / chord');
    return;
  }

  // 两端已经是合法的结构端点 —— marker 存在这一条文本事实到此已完全确定，
  // 先登记关系，再去试时值缩放：缩放失败（E1 无单位音长 / 越界）只是「这次没能
  // 派生出新 duration」，不能反过来抹掉「源文本里写过这个 `>`」。
  state.brokenRhythms.push({
    kind: 'brokenRhythm',
    id: nextRelationId(state, 'brokenRhythm'),
    origins: originsOfPair(marker, prev, next),
    raw,
    from: prev.id,
    to: next.id,
  });

  const prevDuration = durationOf(prev);
  const nextDuration = durationOf(next);
  if (prevDuration === undefined || nextDuration === undefined) {
    // 方案 §7 E1：`L:` 不可知时事件本就没有 duration，此处不得凭空造一个。
    reportUnresolved(state, marker, '有一侧没有时值（单位音长未知）');
    return;
  }
  const scaledPrev = scale(prev, factors.left, prevDuration);
  const scaledNext = scale(next, factors.right, nextDuration);
  if (scaledPrev === undefined || scaledNext === undefined) {
    report(
      state,
      'jcx.parse.broken-rhythm.overflow',
      'warning',
      `broken rhythm ${JSON.stringify(marker.raw)} 改写后的时值超出安全整数范围，只保留关系与 durationRaw，不改写 duration`,
      marker,
    );
    return;
  }
  state.events[index - 1] = scaledPrev;
  state.events[index] = scaledNext;
}
