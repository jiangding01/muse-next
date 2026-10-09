import { describe, expect, it } from 'vitest';

import { createInitialProjection } from '../../../src/editor/projection/build';
import { CR_PLACEHOLDER } from '../../../src/editor/projection/types';
import { applyViewPatchToSource } from '../../../src/editor/projection/viewPatch';
import type { TextPatch } from '../../../src/editor/text/types';

const FEFF = '\uFEFF';
const v = (start: number, end: number, text: string): TextPatch => ({ start, end, text });

function sourceAfter(source: string, patch: TextPatch): string {
  const result = applyViewPatchToSource(createInitialProjection(source), patch);
  if (!result.ok) throw new Error(`意外拒绝：${result.reason}`);
  return result.nextProjection.source;
}

function rejection(source: string, patch: TextPatch): string {
  const result = applyViewPatchToSource(createInitialProjection(source), patch);
  return result.ok ? 'accepted' : result.reason;
}

describe('M3 T0 —— applyViewPatchToSource（§6.5–§6.7）', () => {
  it('CRLF 文件单键编辑只改一处，其余换行逐字节保留', () => {
    expect(sourceAfter('a\r\nb\r\nc', v(2, 3, 'X'))).toBe('a\r\nX\r\nc');
  });

  it('新插入的换行使用冻结的 dominant EOL；已有混合换行不被重写', () => {
    expect(sourceAfter('a\r\nb\r\nc\n', v(1, 1, '\n'))).toBe('a\r\n\r\nb\r\nc\n');
    expect(sourceAfter('a\nb\r\nc\n', v(1, 1, '\n'))).toBe('a\n\nb\r\nc\n');
  });

  it('删除 view 中的换行即删除整个换行序列', () => {
    expect(sourceAfter('a\r\nb', v(1, 2, ''))).toBe('ab');
  });

  it('删除登记的占位符即删除对应 CR；插入的 U+240D 是普通字符', () => {
    expect(sourceAfter('a\rb', v(1, 2, ''))).toBe('ab');
    const inserted = applyViewPatchToSource(createInitialProjection('ab'), v(1, 1, CR_PLACEHOLDER));
    expect(inserted).toMatchObject({ ok: true, sourcePatch: { start: 1, end: 1, text: CR_PLACEHOLDER } });
    if (inserted.ok) expect(inserted.nextProjection.loneCrSourceOffsets).toEqual([]);
  });

  it('受保护前缀：view 偏移 0 处插入落在前缀之后，前缀不可被修改', () => {
    expect(sourceAfter(`${FEFF}ab`, v(0, 0, 'X'))).toBe(`${FEFF}Xab`);
    expect(sourceAfter(`${FEFF}ab`, v(0, 2, ''))).toBe(FEFF);
    expect(sourceAfter(`${FEFF}ab`, v(0, 0, FEFF))).toBe(`${FEFF}${FEFF}ab`);
  });

  it('拒绝：使无受保护前缀的文档首字符成为 U+FEFF（插入与删除两种途径）', () => {
    expect(rejection('ab', v(0, 0, FEFF))).toBe('creates-leading-feff');
    expect(rejection(`a${FEFF}b`, v(0, 1, ''))).toBe('creates-leading-feff');
    expect(rejection(`a${FEFF}b`, v(0, 1, 'X'))).toBe('accepted');
  });

  it('拒绝：孤立 CR 与 LF 合并成 CRLF（在孤立 CR 后插入换行 / 删除二者之间的内容）', () => {
    expect(rejection('a\rb', v(2, 2, '\n'))).toBe('merges-cr-lf');
    expect(rejection('a\rX\nb', v(2, 3, ''))).toBe('merges-cr-lf');
  });

  it('拒绝：插入文本含 CR、越界补丁', () => {
    expect(rejection('ab', v(1, 1, 'x\ry'))).toBe('view-text-contains-cr');
    expect(rejection('ab', v(1, 3, ''))).toBe('view-range-out-of-range');
  });

  it('dominant EOL 为 CRLF 时，在孤立 CR 前后插入换行都不会合并（新换行以 CR 开头，形成 CR + CRLF）', () => {
    expect(rejection('a\r\nb\r\nc\rd', v(5, 5, '\n'))).toBe('accepted');
    expect(rejection('a\r\nb\r\nc\rd', v(6, 6, '\n'))).toBe('accepted');
  });
});
