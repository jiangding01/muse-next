/**
 * M3 T4 B2：保存载荷与对话框输入（`parseRequestSaveTarget` / `parseSaveDocument`；`sanitizeSuggestedName` /
 * `saveDocumentDialogOptions` / `createSavePathChooser`；T-H7-9，Q-B2-9 / Q-B2-11）。
 */

import { describe, expect, it } from 'vitest';

import { MAX_SAVE_SOURCE_LENGTH, parseRequestSaveTarget, parseSaveDocument } from '../../../src/main/open/ipcValidation';
import { createSavePathChooser, sanitizeSuggestedName, saveDocumentDialogOptions } from '../../../src/main/ipc/wireOpenIpcWindow';

const SAVE = { capabilityId: 'cap-1', documentId: 3, source: 'X:1\n', encoding: 'utf-8' } as const;

describe('parseRequestSaveTarget', () => {
  it('合法输入：键集合恰为三个；sourceCapabilityId 可为 null', () => {
    expect(parseRequestSaveTarget({ suggestedName: 'a.jcx', encoding: 'gb18030', sourceCapabilityId: null })).toEqual({ suggestedName: 'a.jcx', encoding: 'gb18030', sourceCapabilityId: null });
    expect(parseRequestSaveTarget({ suggestedName: '', encoding: 'utf-8', sourceCapabilityId: 'cap-1' })).toEqual({ suggestedName: '', encoding: 'utf-8', sourceCapabilityId: 'cap-1' });
  });

  it.each([
    ['缺 sourceCapabilityId（r1.2 之前的形状）', { suggestedName: 'a', encoding: 'utf-8' }],
    ['多余键', { suggestedName: 'a', encoding: 'utf-8', sourceCapabilityId: null, path: '/x' }],
    ['非法编码', { suggestedName: 'a', encoding: 'utf-16', sourceCapabilityId: null }],
    ['名字非字符串', { suggestedName: 1, encoding: 'utf-8', sourceCapabilityId: null }],
    ['名字过长', { suggestedName: 'a'.repeat(1025), encoding: 'utf-8', sourceCapabilityId: null }],
    ['token 含路径字符', { suggestedName: 'a', encoding: 'utf-8', sourceCapabilityId: '../a' }],
    ['token 为 undefined', { suggestedName: 'a', encoding: 'utf-8', sourceCapabilityId: undefined }],
    ['数组', ['a', 'utf-8', null]],
    ['null', null],
  ] as const)('%s → null', (_label, payload) => {
    expect(parseRequestSaveTarget(payload)).toBeNull();
  });

  it('getter 抛错与非普通原型 → null（不向外传播异常）', () => {
    const hostile = { suggestedName: 'a', encoding: 'utf-8' } as Record<string, unknown>;
    Object.defineProperty(hostile, 'sourceCapabilityId', { enumerable: true, get: () => { throw new Error('boom'); } });
    expect(parseRequestSaveTarget(hostile)).toBeNull();
    expect(parseRequestSaveTarget(Object.assign(Object.create({}) as object, { suggestedName: 'a', encoding: 'utf-8', sourceCapabilityId: null }))).toBeNull();
  });
});

describe('parseSaveDocument（分支只由键集合决定，Q-B2-11）', () => {
  it('四个键 → 普通 Save；五个键 → Save As（含 R19 字段）', () => {
    expect(parseSaveDocument(SAVE)).toEqual({ kind: 'save', request: SAVE });
    expect(parseSaveDocument({ ...SAVE, sourceCapabilityId: null })).toEqual({ kind: 'saveAs', request: { ...SAVE, sourceCapabilityId: null } });
    expect(parseSaveDocument({ ...SAVE, documentId: 0 })).toEqual({ kind: 'save', request: { ...SAVE, documentId: 0 } });
  });

  it.each([
    ['多余的路径字段（M20）', { ...SAVE, path: '/x' }],
    ['多余的 displayPath', { ...SAVE, displayPath: '/x' }],
    ['Save As 分支多余键', { ...SAVE, sourceCapabilityId: null, extra: 1 }],
    ['缺 encoding', { capabilityId: 'cap-1', documentId: 3, source: 'x' }],
    ['documentId 为负', { ...SAVE, documentId: -1 }],
    ['documentId 非整数', { ...SAVE, documentId: 1.5 }],
    ['source 非字符串', { ...SAVE, source: 1 }],
    ['source 超出形状上限', { ...SAVE, source: 'a'.repeat(MAX_SAVE_SOURCE_LENGTH + 1) }],
    ['非法编码', { ...SAVE, encoding: 'latin1' }],
    ['capabilityId 非法', { ...SAVE, capabilityId: 'a b' }],
    ['sourceCapabilityId 非法', { ...SAVE, sourceCapabilityId: 7 }],
  ] as const)('%s → null', (_label, payload) => {
    expect(parseSaveDocument(payload)).toBeNull();
  });
});

describe('保存对话框输入（Q-B2-9）', () => {
  it('建议名只取最后一段、去掉控制字符、空名用 untitled.jcx、按码点截断不拆代理对', () => {
    expect(sanitizeSuggestedName('/etc/passwd')).toBe('passwd');
    expect(sanitizeSuggestedName('..\\..\\evil.jcx')).toBe('evil.jcx');
    expect(sanitizeSuggestedName('a\u0000b\u001f.jcx')).toBe('ab.jcx');
    expect(sanitizeSuggestedName('  ')).toBe('untitled.jcx');
    expect(sanitizeSuggestedName('..')).toBe('untitled.jcx');
    expect(sanitizeSuggestedName('dir/')).toBe('untitled.jcx');
    const long = sanitizeSuggestedName('😀'.repeat(150));
    expect(long.length).toBe(200);
    expect(/[\uD800-\uDBFF]$/.test(long)).toBe(false);
  });

  it('对话框选项：显式覆盖确认与新建目录；JCX 与所有文件两个过滤器', () => {
    expect(saveDocumentDialogOptions('/docs/a.jcx')).toEqual({
      title: 'Save Muse Score As',
      defaultPath: '/docs/a.jcx',
      properties: ['showOverwriteConfirmation', 'createDirectory'],
      filters: [
        { name: 'Muse score', extensions: ['jcx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
  });

  it('生产选择器：取消、空路径、没有路径 → null；选中 → 路径；把父窗口与选项原样交给对话框', async () => {
    const calls: unknown[] = [];
    const results = [{ canceled: true, filePath: '/x' }, { canceled: false, filePath: '' }, { canceled: false }, { canceled: false, filePath: '/docs/b.jcx' }];
    const choose = createSavePathChooser<string>(async (parent, options) => {
      calls.push([parent, options.defaultPath]);
      return results.shift() ?? { canceled: true };
    });
    expect(await choose('win', 'a.jcx')).toBeNull();
    expect(await choose('win', 'a.jcx')).toBeNull();
    expect(await choose('win', 'a.jcx')).toBeNull();
    expect(await choose('win', 'a.jcx')).toBe('/docs/b.jcx');
    expect(calls[0]).toEqual(['win', 'a.jcx']);
  });
});
