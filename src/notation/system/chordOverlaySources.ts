/**
 * notation/system —— 和弦图 overlay 的**来源选择与语义去重**（M2.5 T6，方案 §Q5.2；用户裁决 E / F / 附加裁决 4–7，
 * 2026-10-05）。从 `chordOverlay.ts` 拆出的单一职责：只处理「同一共享时间位置上有哪些 chordSymbol、保留哪些」，
 * 不认识几何、不调用 `layoutChord`、不做查表与碰撞。
 *
 * 规则（shared 同一位置 = 同一 group、同一 measureOrdinal、同一 T3 `OverlayOnset` 位置）：
 * - base = 该位置按 (voiceOrder, itemIndex) 最早的实际 chordSymbol；
 * - 与已保留事件**同文本且不同声部** → 去重（不出 overlay；它在 voice layout 里的 primary 节点不受影响）；
 * - 与 base **文本不同且不同声部** → 每个这样的事件一条 `chord.symbol-conflict`（warning），挂该事件；
 * - 同一声部同一位置的多个事件逐个保留，不判冲突；
 * - tier 3 候选（无 `position`）原样保留，不跨声部去重 / 判冲突。
 *
 * 顺序约定（附加裁决：ambiguous 语义）：调用方必须**先**经本文件得到保留下来的候选，**再**对它们做 `chordShapes`
 * 查表——`chord.name-ambiguous` 是 overlay 决策诊断，只对保留下来的候选发，不对被去重的原始事件重复发。
 */

import type { VoiceId } from '../../domain';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../model/diagnostics';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { RenderItem } from '../model/types';
import type { EventAnchor } from './contracts';

/** 一个 chordSymbol 事件作为 overlay 来源的候选（x 已按 shared / tier 3 规则定好）。 */
export interface ChordCandidate {
  readonly item: RenderItem;
  readonly voiceId: VoiceId;
  /** 在所属 group `voiceIds` 中的层序。 */
  readonly voiceOrder: number;
  /** 在所属 measure 切片中的下标。 */
  readonly itemIndex: number;
  readonly groupIndex: number;
  readonly measureOrdinal: number;
  readonly systemIndex: number;
  /** system box 内的时间锚点。 */
  readonly x: number;
  /** `chordSymbolDisplayText(raw)`。 */
  readonly text: string;
  /** shared 位置键；tier 3 缺席（不跨声部去重 / 判冲突）。 */
  readonly position?: string;
}

export function candidateAnchor(candidate: ChordCandidate): EventAnchor {
  return { kind: 'event', voiceId: candidate.voiceId, eventId: candidate.item.eventId };
}

export function candidateDraft(
  code: RenderDiagnosticDraft['code'],
  level: 'info' | 'warning',
  message: string,
  candidate: ChordCandidate,
): RenderDiagnosticDraft {
  return { code, level, message, anchor: candidateAnchor(candidate), sourceRef: candidate.item.sourceRef };
}

/** shared 同一位置的去重与冲突；返回保留下来的候选（保持输入顺序），冲突诊断写入 `sink`。 */
export function resolveChordSources(
  candidates: readonly ChordCandidate[],
  sink: (draft: RenderDiagnosticDraft) => void,
): ChordCandidate[] {
  const byPosition = new Map<string, ChordCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.position === undefined) continue;
    const key = `${String(candidate.groupIndex)}/${String(candidate.measureOrdinal)}/${candidate.position}`;
    byPosition.set(key, [...(byPosition.get(key) ?? []), candidate]);
  }
  const dropped = new Set<ChordCandidate>();
  for (const list of byPosition.values()) {
    const ordered = [...list].sort((a, b) => a.voiceOrder - b.voiceOrder || a.itemIndex - b.itemIndex);
    const [base] = ordered;
    if (base === undefined) continue;
    const kept: ChordCandidate[] = [];
    for (const candidate of ordered) {
      if (candidate !== base && candidate.voiceId !== base.voiceId && candidate.text !== base.text) {
        sink(candidateDraft(
          CODES.chordSymbolConflict,
          'warning',
          `同一时间位置上，和弦符号「${candidate.text}」与首个声部的「${base.text}」不同：不替作者选择，各文本都画在这个时间位置（同文本只画一次）`,
          candidate,
        ));
      }
      if (kept.some((k) => k.text === candidate.text && k.voiceId !== candidate.voiceId)) dropped.add(candidate);
      else kept.push(candidate);
    }
  }
  return candidates.filter((candidate) => !dropped.has(candidate));
}
