/**
 * L2 语义投影（M1.7 T6，方案 v1.1 §6 / §8 拍板 G）。
 *
 * `projectScore` 把一份 `Score` 摊平成纯数据（形状见 `./types`），用于
 * Level 2 round-trip 断言：
 *
 * ```
 * projectScore(parse(x).score) toEqual projectScore(parse(canonical(parse(x))).score)
 * ```
 *
 * ## 只做两件事，一件不多
 *
 * 1. **删除非事实字段**：`origin` / `origins`（`SourceRef` 是 AstPath 字符串，
 *    canonical 重排文本后必然改变）、关系自身的 `RelationId`、事件自身的
 *    `EventId`、`VoiceId`（都是快照内序号，位置已由数组下标表达）。
 * 2. **归一化引用**：`EventId` → `(voiceIndex, eventIndex)`、`NoteRef` →
 *    `(voiceIndex, eventIndex, memberIndex)`。tie / slur / tuplet.members /
 *    tabRelation / brokenRhythm 的端点、`unitLengthChanges[].beforeEventId`、
 *    `LyricBodyRange` 的首尾、`LyricSyllable.target` 全部按同一规则归一化
 *    （见 `./refs` / `./voice`）。
 *
 * 另有两处 canonical normalization 的对齐（不是「删除事实」，是「两边同规则」）：
 * `RawDirective.rawValue` 按 `trimStart` 归一（方案 §3 决策 10：canonical 输出
 * `%%${name} ${rawValue.trimStart()}`），`LyricSyllable.offsetInLine` 归零。
 *
 * **不做的事**：不排序（数组顺序本身是事实，排序会掩盖顺序错误）；不删除任何
 * 事实字段——`unknownFields` / `ignoredFields` / `unknownAttributes` 全保留
 * name / rawValue / 顺序（拍板 G）；不推断语义；不因为「这条关系当前写不回去」
 * 就放宽——放宽投影等于把往返缺陷改写成往返承诺。
 *
 * `diagnostics` 不参与投影：它不是 `Score` 的一部分，且 canonical 会引入自己的
 * renderer / encoder 诊断。
 *
 * 本目录只 import `src/domain`（与 `canonical/**` 同样不碰 ast/lexer），放在
 * `src/` 而不是 `tests/` 是为了让 T7 的语料脚本能复用同一份投影。
 */

import type { GuitarChord, Score } from '../../../../domain';
import { buildEventPositions, rationalOf } from './refs';
import { projectVoice } from './voice';
import type { ProjectedGuitarChord, ProjectedScore } from './types';

export type * from './types';
export { firstProjectionDifference, projectionEquals } from './compare';

function projectChordShape(shape: GuitarChord): ProjectedGuitarChord {
  return {
    name: shape.name,
    capoFret: shape.capoFret,
    strings: shape.strings.map((string) => ({
      state: string.state,
      fret: string.fret,
      finger: string.finger ?? null,
    })),
    barres: shape.barres.map((barre) => ({
      fret: barre.fret,
      fromString: barre.fromString,
      toString: barre.toString,
      finger: barre.finger ?? null,
    })),
    rawValue: shape.rawValue,
  };
}

/** 把一份 `Score` 投影成可直接 `toEqual` 比较的纯数据（确定性：不排序、保序）。 */
export function projectScore(score: Score): ProjectedScore {
  const positions = buildEventPositions(score);
  return {
    titles: [...score.titles],
    credits: [...score.credits],
    notes: [...score.notes],
    refNumber: score.refNumber ?? null,
    meter:
      score.meter === undefined
        ? null
        : {
            kind: score.meter.kind,
            num: score.meter.kind === 'fraction' ? score.meter.num : null,
            den: score.meter.kind === 'fraction' ? score.meter.den : null,
            raw: score.meter.raw,
          },
    unitLength: rationalOf(score.unitLength),
    tempo:
      score.tempo === undefined
        ? null
        : {
            beat: rationalOf(score.tempo.beat),
            bpm: score.tempo.bpm ?? null,
            raw: score.tempo.raw,
          },
    key:
      score.key === undefined
        ? null
        : { tonic: score.key.tonic ?? null, alter: score.key.alter ?? null, raw: score.key.raw },
    voices: score.voices.map((voice) => projectVoice(voice, positions)),
    chordShapes: score.chordShapes.map(projectChordShape),
    directives: score.directives.map((directive) => ({
      name: directive.name,
      rawValue: directive.rawValue.trimStart(),
    })),
    showFinger: score.showFinger ?? null,
    textBlocks: score.textBlocks.map((block) => ({
      lines: [...block.lines],
      closed: block.closed,
    })),
    unknownFields: score.unknownFields.map((field) => ({
      name: field.name,
      rawValue: field.rawValue,
    })),
    ignoredFields: score.ignoredFields.map((field) => ({
      name: field.name,
      rawValue: field.rawValue,
    })),
  };
}
