/**
 * T5 补充 —— `notation/layout/fallbackSummary.ts` 单测（P1-4：D12 方案 B 的摘要逻辑
 * 从 `ScoreView.tsx` 移出后的纯函数覆盖）。
 *
 * 每个 `MusicEvent.kind` 一条用例 + 一条确定性用例（同输入多次调用结果相等）。
 * 关键断言：`Rest.variant`（`z`/`Z`/`@`）**原样显示**，不得改写成简谱的 `0`
 * ——这条占位摘要不假装在用简谱规则渲染。
 */
import { describe, expect, it } from 'vitest';

import type { MusicEvent, Note, Rest } from '../../../src/domain';
import { eventId, voiceId } from '../../../src/domain';
import { summarizeEvent, summarizeEvents, summarizePitch } from '../../../src/notation/layout/fallbackSummary';

const EVENT_ID = eventId(voiceId(1), 0);

function note(overrides: Partial<Note> = {}): Note {
  return { pitch: { letter: 'C', register: 'upper' }, origin: 'L1', ...overrides };
}

function rest(variant: Rest['variant']): Rest {
  return { variant, origin: 'L1' };
}

describe('summarizePitch', () => {
  it('upper register 保持大写，lower register 转小写；octaveRaw 原样追加', () => {
    expect(summarizePitch({ letter: 'C', register: 'upper' })).toBe('C');
    expect(summarizePitch({ letter: 'C', register: 'lower' })).toBe('c');
    expect(summarizePitch({ letter: 'G', register: 'lower', octaveRaw: "'" })).toBe("g'");
    expect(summarizePitch({ letter: 'G', register: 'upper', octaveRaw: ',,' })).toBe('G,,');
  });
});

describe('summarizeEvent —— 每个 MusicEvent.kind 一条用例', () => {
  it('note → summarizePitch(note.pitch)', () => {
    const event: MusicEvent = { kind: 'note', id: EVENT_ID, origin: 'L1', note: note() };
    expect(summarizeEvent(event)).toBe('C');
  });

  it('rest → variant 原样显示（z/Z/@ 都不得改写成简谱的 0）', () => {
    for (const variant of ['z', 'Z', '@'] as const) {
      const event: MusicEvent = { kind: 'rest', id: EVENT_ID, origin: 'L1', rest: rest(variant) };
      expect(summarizeEvent(event)).toBe(variant);
      expect(summarizeEvent(event)).not.toBe('0');
    }
  });

  it('chord → 方括号包住每个成员的摘要（Note 用音高字母，Rest 用原样 variant）', () => {
    const event: MusicEvent = {
      kind: 'chord',
      id: EVENT_ID,
      origin: 'L1',
      members: [note({ pitch: { letter: 'C', register: 'upper' } }), rest('z')],
    };
    expect(summarizeEvent(event)).toBe('[Cz]');
  });

  it('grace → 固定占位 "~"（不占布局时值，摘要也不展开成员）', () => {
    const event: MusicEvent = { kind: 'grace', id: EVENT_ID, origin: 'L1', members: [note()], after: false };
    expect(summarizeEvent(event)).toBe('~');
  });

  it('barline → 原样 raw', () => {
    const event: MusicEvent = { kind: 'barline', id: EVENT_ID, origin: 'L1', raw: '|:' };
    expect(summarizeEvent(event)).toBe('|:');
  });

  it('decoration → simple 显示 !name!，complex 显示占位 !...!', () => {
    const simple: MusicEvent = {
      kind: 'decoration', id: EVENT_ID, origin: 'L1',
      decoration: { form: 'simple', name: 'trill' },
    };
    expect(summarizeEvent(simple)).toBe('!trill!');
    const complex: MusicEvent = {
      kind: 'decoration', id: EVENT_ID, origin: 'L1',
      decoration: { form: 'complex', payloadRaw: 'x=1', raw: '!@x=1!' },
    };
    expect(summarizeEvent(complex)).toBe('!...!');
  });

  it('chordSymbol → 引号包住原文', () => {
    const event: MusicEvent = {
      kind: 'chordSymbol', id: EVENT_ID, origin: 'L1',
      symbol: { raw: 'Gm7', empty: false, displayOnly: false },
    };
    expect(summarizeEvent(event)).toBe('"Gm7"');
  });

  it('tabNote → 品位数字原样转字符串', () => {
    const event: MusicEvent = {
      kind: 'tabNote', id: EVENT_ID, origin: 'L1',
      note: { stringIndex: 3, fret: 12, origin: 'L1' },
    };
    expect(summarizeEvent(event)).toBe('12');
  });

  it('tabGroup → 方括号包住各成员品位', () => {
    const event: MusicEvent = {
      kind: 'tabGroup', id: EVENT_ID, origin: 'L1',
      members: [
        { stringIndex: 1, fret: 'x', origin: 'L1' },
        { stringIndex: 2, fret: 3, origin: 'L1' },
      ],
    };
    expect(summarizeEvent(event)).toBe('[x3]');
  });

  it('unknown → 原样 raw', () => {
    const event: MusicEvent = { kind: 'unknown', id: EVENT_ID, origin: 'L1', raw: '???', tokenKind: 'raw' };
    expect(summarizeEvent(event)).toBe('???');
  });
});

describe('确定性：同一事件多次调用结果逐字符相等', () => {
  it('note/rest/chord 各跑两次结果相等', () => {
    const events: MusicEvent[] = [
      { kind: 'note', id: EVENT_ID, origin: 'L1', note: note() },
      { kind: 'rest', id: EVENT_ID, origin: 'L1', rest: rest('Z') },
      { kind: 'chord', id: EVENT_ID, origin: 'L1', members: [note({ pitch: { letter: 'E', register: 'lower' } })] },
    ];
    expect(summarizeEvents(events)).toBe(summarizeEvents(events));
    expect(events.map(summarizeEvent)).toEqual(events.map(summarizeEvent));
  });
});
