/**
 * L2 投影 —— 声部、关系与歌词（M1.7 T6，方案 v1.1 §8 拍板 G）。
 *
 * 关系自身的 `RelationId` 与 `origins` 删除，两端引用全部归一化（`./refs`）；
 * 五类关系共用一个定宽形状（`ProjectedRelation`），无关字段填 `null`。
 * `VoiceId` 同样删除：它就是声明序号（`voiceId(n)`），已由数组下标表达。
 *
 * `LyricSyllable.offsetInLine` 归零：行内偏移是源文本排版事实，canonical 重排
 * 行边界后必然改变，不属于语义。`bodyRange` 的首尾则**保留并归一化**——它是
 * 「`w:` 绑定哪一段正文」这条语义事实，漂了就必须比出来。
 */

import type { EventId, Voice } from '../../../../domain';
import { projectEvent } from './events';
import type { EventPositions } from './refs';
import { noteRefOf, refOf } from './refs';
import type {
  ProjectedLyricLine,
  ProjectedRef,
  ProjectedRelation,
  ProjectedVoice,
} from './types';

const EMPTY_RELATION = {
  status: null,
  raw: null,
  to: null,
  p: null,
  q: null,
  r: null,
  members: null,
} as const;

/**
 * tuplet 的「起点」：取首成员。`members` 可能为空（`incomplete` 且一个成员都没
 * 吸收到），此时显式悬空，不伪造引用。
 */
function firstMemberRef(members: readonly EventId[], positions: EventPositions): ProjectedRef {
  const first = members[0];
  return first === undefined ? { unresolved: true } : refOf(positions, first);
}

interface ProjectedRelationGroups {
  readonly ties: readonly ProjectedRelation[];
  readonly slurs: readonly ProjectedRelation[];
  readonly tuplets: readonly ProjectedRelation[];
  readonly tabRelations: readonly ProjectedRelation[];
  readonly brokenRhythms: readonly ProjectedRelation[];
}

function projectRelations(voice: Voice, positions: EventPositions): ProjectedRelationGroups {
  return {
    ties: voice.ties.map((tie) => ({
      ...EMPTY_RELATION,
      kind: 'tie',
      status: tie.status,
      from: noteRefOf(positions, tie.from),
      to: tie.status === 'resolved' ? noteRefOf(positions, tie.to) : null,
    })),
    slurs: voice.slurs.map((slur) => ({
      ...EMPTY_RELATION,
      kind: 'slur',
      status: slur.status,
      from: refOf(positions, slur.from),
      to: slur.status === 'closed' ? refOf(positions, slur.to) : null,
    })),
    tuplets: voice.tuplets.map((tuplet) => ({
      ...EMPTY_RELATION,
      kind: 'tuplet',
      status: tuplet.status,
      raw: tuplet.raw,
      // tuplet 没有单一起点：`from` 取首成员（成员为空时显式悬空），
      // 成员全序列另存于 `members`，顺序即事实。
      from: firstMemberRef(tuplet.members, positions),
      p: tuplet.p,
      q: tuplet.q ?? null,
      r: tuplet.r,
      members: tuplet.members.map((id) => refOf(positions, id)),
    })),
    tabRelations: voice.tabRelations.map((relation) => ({
      ...EMPTY_RELATION,
      kind: relation.kind,
      from: noteRefOf(positions, relation.from),
      to: noteRefOf(positions, relation.to),
    })),
    brokenRhythms: voice.brokenRhythms.map((relation) => ({
      ...EMPTY_RELATION,
      kind: 'brokenRhythm',
      raw: relation.raw,
      from: refOf(positions, relation.from),
      to: refOf(positions, relation.to),
    })),
  };
}

function projectLyricLines(voice: Voice, positions: EventPositions): readonly ProjectedLyricLine[] {
  return voice.lyricLines.map((line) => ({
    verseIndex: line.verseIndex,
    syllables: line.syllables.map((syllable) => ({
      text: syllable.text,
      kind: syllable.kind,
      target: syllable.target === undefined ? null : noteRefOf(positions, syllable.target),
      offsetInLine: 0 as const,
    })),
    bodyRange:
      line.bodyRange === null
        ? null
        : {
            first: refOf(positions, line.bodyRange.firstEventId),
            last: refOf(positions, line.bodyRange.lastEventId),
          },
  }));
}

export function projectVoice(voice: Voice, positions: EventPositions): ProjectedVoice {
  return {
    name: voice.name ?? null,
    sname: voice.sname ?? null,
    style: voice.style ?? null,
    instrument: voice.instrument ?? null,
    volume: voice.volume ?? null,
    bracket: voice.bracket ?? null,
    brace: voice.brace ?? null,
    staves: voice.staves ?? null,
    space: voice.space ?? null,
    gchords: voice.gchords ?? null,
    clef: voice.clef ?? null,
    unknownAttributes: voice.unknownAttributes.map((attribute) => ({
      key: attribute.key,
      value: attribute.value,
    })),
    events: voice.events.map(projectEvent),
    ...projectRelations(voice, positions),
    unitLengthChanges: voice.unitLengthChanges.map((change) => ({
      beforeEvent: refOf(positions, change.beforeEventId),
      unitLength: { num: change.unitLength.num, den: change.unitLength.den },
      raw: change.raw,
    })),
    lyricLines: projectLyricLines(voice, positions),
  };
}
