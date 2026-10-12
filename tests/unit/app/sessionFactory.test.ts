/**
 * M3 T1c-2：renderer 会话工厂（`src/renderer/app/editor/sessionFactory.ts`）。
 *
 * - demo：documentId 0、无文件、utf-8、无字节 BOM、exact，解析快照与会话同一 (documentId, sourceVersion)。
 * - 候选：exact source 原样（CRLF、孤立 CR、开头 U+FEFF、GB18030 来源），元数据只取自 DecodedDocument（byteBom 不由首字符推断），
 *   `loadJcx` 收到 `sourceEncoding`；`displayPath` 只进入 `file`，票据只来自 documentId 与 capability。
 * - 畸形回复：不建会话；能取到合法票据时给出票据（用于通知 main 丢弃候选）。
 */

import { describe, expect, it } from 'vitest';

import { createDemoSession, DEMO_DOCUMENT_ID, DEMO_SOURCE, prepareCandidate } from '../../../src/renderer/app/editor/sessionFactory';
import type { DecodedDocument } from '../../../src/shared/openContracts';

function decoded(overrides: Partial<DecodedDocument> = {}): DecodedDocument {
  return {
    documentId: 7,
    source: 'X:1\nT:a\nK:C\nCDEF|\n',
    writeEncoding: 'utf-8',
    byteBom: 'none',
    encodingRoundTrip: 'exact',
    file: { capability: { id: 'cap-7' }, displayName: 'a.jcx', displayPath: '/docs/a.jcx' },
    ...overrides,
  };
}

function prepared(document: unknown) {
  const result = prepareCandidate(document);
  if (!result.ok) throw new Error(`prepare failed: ${result.reason}`);
  return result.candidate;
}

describe('createDemoSession', () => {
  it('documentId 0、无文件、utf-8、无字节 BOM、exact；快照与会话一致', () => {
    const session = createDemoSession();
    expect(session.documentId).toBe(DEMO_DOCUMENT_ID);
    expect(session.documentId).toBe(0);
    expect(session.file).toBeNull();
    expect([session.writeEncoding, session.byteBom, session.encodingRoundTrip]).toEqual(['utf-8', 'none', 'exact']);
    expect(session.source).toBe(DEMO_SOURCE);
    expect(session.saved.source).toBe(DEMO_SOURCE);
    expect(session.sourceVersion).toBe(1);
    expect(session.parsed?.documentId).toBe(0);
    expect(session.parsed?.sourceVersion).toBe(1);
    expect(session.parsed?.load.lex.encoding).toBe('utf-8');
    expect(session.fileOp).toBeNull();
  });
});

describe('prepareCandidate —— exact source 与元数据', () => {
  it('会话字段逐项来自 DecodedDocument；票据只来自 documentId 与 capability', () => {
    const { session, ticket } = prepared(decoded());
    expect(ticket).toEqual({ capabilityId: 'cap-7', documentId: 7 });
    expect(session.documentId).toBe(7);
    expect(session.file).toEqual({ capability: { id: 'cap-7' }, displayName: 'a.jcx', displayPath: '/docs/a.jcx' });
    expect(session.parsed?.documentId).toBe(7);
    expect(session.parsed?.sourceVersion).toBe(session.sourceVersion);
  });

  it.each([
    ['CRLF', 'X:1\r\nT:crlf\r\nK:C\r\nCDEF|\r\n'],
    ['孤立 CR', 'X:1\rT:lone\nK:C\nCDEF|\n'],
    ['混合换行且无结尾换行', 'X:1\r\nT:m\nK:C\rCDEF|'],
    ['开头 U+FEFF', '﻿X:1\nT:bom\nK:C\nCDEF|\n'],
    ['首尾空白', '  \nX:1\nT:ws\nK:C\nCDEF|\n\n  '],
  ])('%s：source、saved 与解析输入逐字一致（不 trim、不改换行、不剥 U+FEFF）', (_label, source) => {
    const { session } = prepared(decoded({ source }));
    expect(session.source).toBe(source);
    expect(session.saved.source).toBe(source);
    expect(session.projection.source).toBe(source);
    expect(session.protectedLeadingFeff).toBe(source.startsWith('﻿'));
  });

  it('GB18030 来源：writeEncoding 进入会话并作为 sourceEncoding 传给 loadJcx；开头 U+FEFF 不被当成字节 BOM', () => {
    const { session } = prepared(decoded({ source: '﻿X:1\nT:中文\nK:C\n', writeEncoding: 'gb18030', byteBom: 'none' }));
    expect(session.writeEncoding).toBe('gb18030');
    expect(session.parsed?.load.lex.encoding).toBe('gb18030');
    expect(session.byteBom).toBe('none');
    expect(session.protectedLeadingFeff).toBe(true);
  });

  it('字节 BOM 与往返安全性原样取自 main（不由文本推断）', () => {
    const { session } = prepared(decoded({ source: 'X:1\n', byteBom: 'utf8', encodingRoundTrip: 'unsafe' }));
    expect([session.byteBom, session.encodingRoundTrip, session.protectedLeadingFeff]).toEqual(['utf8', 'unsafe', false]);
  });
});

describe('prepareCandidate —— 畸形回复', () => {
  it.each([
    ['source 不是字符串', { ...decoded(), source: 42 }],
    ['未知编码', { ...decoded(), writeEncoding: 'utf8' }],
    ['未知 byteBom', { ...decoded(), byteBom: 'bom' }],
    ['未知往返安全性', { ...decoded(), encodingRoundTrip: 'maybe' }],
    ['缺少 displayName', { ...decoded(), file: { capability: { id: 'cap-7' }, displayPath: '/docs/a.jcx' } }],
  ])('%s：不建会话，给出票据以便通知 main 丢弃候选', (_label, document) => {
    expect(prepareCandidate(document)).toEqual({ ok: false, reason: 'invalid-document', ticket: { capabilityId: 'cap-7', documentId: 7 } });
  });

  it.each([
    ['documentId 0（demo 号）', { ...decoded(), documentId: 0 }],
    ['documentId 非整数', { ...decoded(), documentId: 1.5 }],
    ['空 capability', { ...decoded(), file: { capability: { id: '' }, displayName: 'a', displayPath: 'a' } }],
    ['缺少 file', { ...decoded(), file: null }],
    ['不是对象', 'opened'],
  ])('%s：没有合法票据', (_label, document) => {
    expect(prepareCandidate(document)).toEqual({ ok: false, reason: 'invalid-document', ticket: null });
  });
});
