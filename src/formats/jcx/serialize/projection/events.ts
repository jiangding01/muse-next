/**
 * L2 投影 —— 事件与值对象（M1.7 T6）。
 *
 * 每个事件都投影成同一个**定宽形状**（`ProjectedEvent`，无关字段填 `null`）：
 * 这样 `toEqual` 比较两个不同 kind 的事件时，差异会落在具体字段上而不是
 * 「一边有这个 key，一边没有」，读起来更接近「哪一项事实变了」。
 * 事件自身的 `EventId` 与 `origin` 在此被删除（位置由数组下标表达）。
 */

import type {
  ChordEvent,
  Decoration,
  GraceEvent,
  MusicEvent,
  Note,
  Rest,
  TabGroupEvent,
  TabNote,
} from '../../../../domain';
import { rationalOf } from './refs';
import type {
  ProjectedChordMember,
  ProjectedDecoration,
  ProjectedEvent,
  ProjectedGraceMember,
  ProjectedNote,
  ProjectedRest,
  ProjectedTabNote,
} from './types';

export function projectNote(note: Note): ProjectedNote {
  return {
    member: 'note',
    pitch: {
      letter: note.pitch.letter,
      register: note.pitch.register,
      octaveRaw: note.pitch.octaveRaw ?? null,
      octaveShift: note.pitch.octaveShift ?? null,
    },
    duration: rationalOf(note.duration),
    durationRaw: note.durationRaw ?? null,
    accidental: note.accidental ?? null,
  };
}

export function projectRest(rest: Rest): ProjectedRest {
  return {
    member: 'rest',
    variant: rest.variant,
    duration: rationalOf(rest.duration),
    durationRaw: rest.durationRaw ?? null,
  };
}

export function projectTabNote(note: TabNote): ProjectedTabNote {
  return {
    member: 'tabNote',
    stringIndex: note.stringIndex,
    fret: note.fret,
    stroke: note.stroke ?? null,
    duration: rationalOf(note.duration),
    durationRaw: note.durationRaw ?? null,
  };
}

/** 和弦成员是 `Note | Rest`：`Rest` 独有 `variant`，用 `in` 判别，不用 `as`。 */
function projectChordMember(member: Note | Rest): ProjectedChordMember {
  return 'variant' in member ? projectRest(member) : projectNote(member);
}

/** 倚音成员是 `Note | TabNote`：`TabNote` 独有 `stringIndex`。 */
function projectGraceMember(member: Note | TabNote): ProjectedGraceMember {
  return 'stringIndex' in member ? projectTabNote(member) : projectNote(member);
}

function projectDecoration(decoration: Decoration): ProjectedDecoration {
  if (decoration.form === 'simple') {
    return {
      form: 'simple',
      name: decoration.name,
      x: null,
      y: null,
      font: null,
      size: null,
      payloadRaw: null,
      raw: null,
    };
  }
  return {
    form: 'complex',
    name: null,
    x: decoration.x ?? null,
    y: decoration.y ?? null,
    font: decoration.font ?? null,
    size: decoration.size ?? null,
    payloadRaw: decoration.payloadRaw,
    raw: decoration.raw,
  };
}

const EMPTY_EVENT = {
  note: null,
  rest: null,
  members: null,
  duration: null,
  stroke: null,
  after: null,
  raw: null,
  tokenKind: null,
  decoration: null,
  chordSymbol: null,
} as const;

function projectGroupMembers(
  event: ChordEvent | GraceEvent | TabGroupEvent,
): readonly (ProjectedChordMember | ProjectedGraceMember)[] {
  if (event.kind === 'chord') {
    return event.members.map(projectChordMember);
  }
  if (event.kind === 'grace') {
    return event.members.map(projectGraceMember);
  }
  return event.members.map(projectTabNote);
}

export function projectEvent(event: MusicEvent): ProjectedEvent {
  switch (event.kind) {
    case 'note':
      return { ...EMPTY_EVENT, kind: 'note', note: projectNote(event.note) };
    case 'rest':
      return { ...EMPTY_EVENT, kind: 'rest', rest: projectRest(event.rest) };
    case 'chord':
      return {
        ...EMPTY_EVENT,
        kind: 'chord',
        members: projectGroupMembers(event),
        duration: rationalOf(event.duration),
      };
    case 'grace':
      return {
        ...EMPTY_EVENT,
        kind: 'grace',
        members: projectGroupMembers(event),
        after: event.after,
      };
    case 'barline':
      return { ...EMPTY_EVENT, kind: 'barline', raw: event.raw };
    case 'decoration':
      return {
        ...EMPTY_EVENT,
        kind: 'decoration',
        decoration: projectDecoration(event.decoration),
      };
    case 'chordSymbol':
      return {
        ...EMPTY_EVENT,
        kind: 'chordSymbol',
        chordSymbol: {
          raw: event.symbol.raw,
          empty: event.symbol.empty,
          displayOnly: event.symbol.displayOnly,
        },
      };
    case 'tabNote':
      return { ...EMPTY_EVENT, kind: 'tabNote', note: projectTabNote(event.note) };
    case 'tabGroup':
      return {
        ...EMPTY_EVENT,
        kind: 'tabGroup',
        members: projectGroupMembers(event),
        stroke: event.stroke ?? null,
        duration: rationalOf(event.duration),
      };
    case 'unknown':
      return { ...EMPTY_EVENT, kind: 'unknown', raw: event.raw, tokenKind: event.tokenKind };
  }
}
