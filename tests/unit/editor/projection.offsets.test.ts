import { describe, expect, it } from 'vitest';

import { createInitialProjection } from '../../../src/editor/projection/build';
import {
  sourceOffsetToViewOffset,
  sourceRangeToViewRange,
  viewOffsetToSourceOffset,
  viewRangeToSourceRange,
} from '../../../src/editor/projection/offsets';
import { createPrng, randomText } from './prng';

const FEFF = '\uFEFF';
const ok = (offset: number): { ok: true; offset: number } => ({ ok: true, offset });

describe('M3 T0 —— 偏移与区间映射（§6.5）', () => {
  it('CRLF：view 中 LF 之前映射到 CR 之前，LF 之后映射到整个 CRLF 之后', () => {
    const projection = createInitialProjection('a\r\nb');
    expect(viewOffsetToSourceOffset(projection, 0)).toEqual(ok(0));
    expect(viewOffsetToSourceOffset(projection, 1)).toEqual(ok(1));
    expect(viewOffsetToSourceOffset(projection, 2)).toEqual(ok(3));
    expect(viewOffsetToSourceOffset(projection, 3)).toEqual(ok(4));
  });

  it('source 偏移落在 CRLF 中间时取该换行在 view 中的位置', () => {
    const projection = createInitialProjection('a\r\nb\r\nc');
    expect(sourceOffsetToViewOffset(projection, 2)).toEqual(ok(1));
    expect(sourceOffsetToViewOffset(projection, 5)).toEqual(ok(3));
    expect(sourceOffsetToViewOffset(projection, 3)).toEqual(ok(2));
  });

  it('受保护前缀：view 偏移 0 映射到前缀之后；前缀内的 source 偏移映射到 view 0', () => {
    const projection = createInitialProjection(`${FEFF}ab`);
    expect(viewOffsetToSourceOffset(projection, 0)).toEqual(ok(1));
    expect(sourceOffsetToViewOffset(projection, 0)).toEqual(ok(0));
    expect(sourceOffsetToViewOffset(projection, 1)).toEqual(ok(0));
    expect(sourceOffsetToViewOffset(projection, 2)).toEqual(ok(1));
  });

  it('孤立 CR 与占位符 1 : 1 映射', () => {
    const projection = createInitialProjection('a\rb');
    for (const offset of [0, 1, 2, 3]) {
      expect(viewOffsetToSourceOffset(projection, offset)).toEqual(ok(offset));
      expect(sourceOffsetToViewOffset(projection, offset)).toEqual(ok(offset));
    }
  });

  it('越界与非整数偏移返回带标签的拒绝', () => {
    const projection = createInitialProjection('a\r\nb');
    for (const bad of [-1, 4, 1.5]) {
      expect(viewOffsetToSourceOffset(projection, bad)).toEqual({ ok: false, reason: 'offset-out-of-range' });
    }
    expect(sourceOffsetToViewOffset(projection, 5)).toEqual({ ok: false, reason: 'offset-out-of-range' });
    expect(viewRangeToSourceRange(projection, { start: 2, end: 1 })).toEqual({ ok: false, reason: 'range-out-of-range' });
  });

  it('覆盖整个换行的 view 区间映射为整个换行序列', () => {
    const projection = createInitialProjection('a\r\nb');
    expect(viewRangeToSourceRange(projection, { start: 1, end: 2 })).toEqual({ ok: true, range: { start: 1, end: 3 } });
  });

  it('性质：view 偏移往返恒等；view 区间往返恒等（固定种子）', () => {
    const alphabet = ['a', '\n', '\r', '\r\n', FEFF, '\u240D'];
    for (const seed of [5, 17, 123]) {
      const prng = createPrng(seed);
      for (let caseIndex = 0; caseIndex < 300; caseIndex += 1) {
        const label = `seed=${String(seed)} case=${String(caseIndex)}`;
        const source = (prng.int(2) === 0 ? FEFF : '') + randomText(prng, alphabet, 12);
        const projection = createInitialProjection(source);
        for (let v = 0; v <= projection.view.length; v += 1) {
          const s = viewOffsetToSourceOffset(projection, v);
          expect(s.ok, label).toBe(true);
          if (!s.ok) continue;
          expect(sourceOffsetToViewOffset(projection, s.offset), label).toEqual(ok(v));
        }
        const start = prng.int(projection.view.length + 1);
        const end = start + prng.int(projection.view.length - start + 1);
        const sourceRange = viewRangeToSourceRange(projection, { start, end });
        expect(sourceRange.ok, label).toBe(true);
        if (!sourceRange.ok) continue;
        expect(sourceRangeToViewRange(projection, sourceRange.range), label).toEqual({ ok: true, range: { start, end } });
      }
    }
  });
});
