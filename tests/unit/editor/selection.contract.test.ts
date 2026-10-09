import { describe, expect, expectTypeOf, it } from 'vitest';

import { DEFAULT_RANGE_BIAS } from '../../../src/editor/selection/types';
import type {
  EditorSelection,
  FingerprintValue,
  PersistedSelection,
  RangeBias,
  SelectionKind,
  SemanticFingerprint,
  SourceRange,
} from '../../../src/editor/selection/types';

describe('M3 T0 —— EditorSelection 持久合同（§16.1）', () => {
  it('持久合同只有 kind / ranges / fingerprint / bias，不含任何快照 id（类型层）', () => {
    expectTypeOf<keyof PersistedSelection>().toEqualTypeOf<'kind' | 'ranges' | 'fingerprint' | 'bias'>();
    expectTypeOf<keyof EditorSelection>().toEqualTypeOf<'kind' | 'ranges' | 'fingerprint' | 'bias' | 'basisVersion'>();
    expectTypeOf<keyof SemanticFingerprint>().toEqualTypeOf<'kind' | 'fields'>();
    expectTypeOf<keyof SourceRange>().toEqualTypeOf<'start' | 'end'>();
    expectTypeOf<keyof RangeBias>().toEqualTypeOf<'start' | 'end' | 'caret'>();
    expectTypeOf<FingerprintValue>().toEqualTypeOf<string | number | boolean | null>();
    expectTypeOf<SelectionKind>().toEqualTypeOf<'none' | 'source' | 'voice' | 'event' | 'note' | 'relation' | 'document'>();
  });

  it('PersistedSelection 是纯数据：经 JSON 往返保持不变', () => {
    const selection: PersistedSelection = {
      kind: 'note',
      ranges: [
        { start: 10, end: 11 },
        { start: 20, end: 22 },
      ],
      fingerprint: { kind: 'note', fields: { letter: 'C', accidental: null, duration: '2', member: 0, grace: false } },
      bias: DEFAULT_RANGE_BIAS,
    };
    expect(JSON.parse(JSON.stringify(selection))).toEqual(selection);
    const withoutFingerprint: PersistedSelection = { kind: 'source', ranges: [{ start: 3, end: 3 }], bias: DEFAULT_RANGE_BIAS };
    expect(JSON.parse(JSON.stringify(withoutFingerprint))).toEqual(withoutFingerprint);
  });

  it('默认 bias：端点不吸收边界插入，折叠光标移到插入内容之后；运行时不可修改', () => {
    expect(DEFAULT_RANGE_BIAS).toEqual({ start: 'exclude', end: 'exclude', caret: 'after' });
    expect(Object.isFrozen(DEFAULT_RANGE_BIAS)).toBe(true);
  });
});
