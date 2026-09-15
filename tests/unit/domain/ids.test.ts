import { describe, expect, it } from 'vitest';

import { eventId, noteRefKey, relationId, voiceId } from '../../../src/domain/ids';

describe('id 工厂', () => {
  it('按方案 §1.1 的形态生成', () => {
    const v = voiceId(1);
    expect(v).toBe('v1');
    expect(eventId(v, 37)).toBe('v1:e37');
    expect(relationId(v, 'slur', 3)).toBe('v1:slur3');
    expect(eventId(voiceId(12), 0)).toBe('v12:e0');
  });

  it('参数必须是非负整数', () => {
    expect(() => voiceId(-1)).toThrow(RangeError);
    expect(() => voiceId(1.5)).toThrow(RangeError);
    expect(() => eventId(voiceId(1), -1)).toThrow(RangeError);
    expect(() => eventId(voiceId(1), Number.NaN)).toThrow(RangeError);
    expect(() => relationId(voiceId(1), 'tie', -2)).toThrow(RangeError);
  });
});

describe('noteRefKey', () => {
  it('省略 memberIndex 时以空串结尾', () => {
    expect(noteRefKey({ eventId: eventId(voiceId(1), 4) })).toBe('v1:e4#');
  });

  it('带 memberIndex 时拼接下标，0 不退化为空串', () => {
    expect(noteRefKey({ eventId: eventId(voiceId(1), 4), memberIndex: 0 })).toBe('v1:e4#0');
    expect(noteRefKey({ eventId: eventId(voiceId(1), 4), memberIndex: 2 })).toBe('v1:e4#2');
  });

  it('不同引用不会撞 key', () => {
    const a = noteRefKey({ eventId: eventId(voiceId(1), 4) });
    const b = noteRefKey({ eventId: eventId(voiceId(1), 4), memberIndex: 0 });
    expect(a).not.toBe(b);
  });
});
