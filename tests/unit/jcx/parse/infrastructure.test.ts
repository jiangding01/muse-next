import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildAst, documentPath, parseAstPath } from '../../../../src/formats/jcx/ast';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { createDiagnosticBag } from '../../../../src/formats/jcx/lexer/diagnostics';
import type { SourceSpan } from '../../../../src/formats/jcx/lexer/sourceSpan';
import type { Rest, Score, Voice } from '../../../../src/domain';
import { eventId, noteRefKey, relationId, voiceId } from '../../../../src/domain';
import {
  buildDomainIndex,
  onceKeyed,
  originOf,
  originsOf,
  parseJcxDocument,
  reportParse,
} from '../../../../src/formats/jcx/parse';

/**
 * M1.6 T2 DoD：minimal fixture 走完 lex → ast → parse，得到「空但合法」的 Score
 * 与空 DomainIndex，且诊断数组与 AST 的不是同一引用。
 */
const MINIMAL = resolve(__dirname, '../../../fixtures/jcx/minimal.jcx');

function parseMinimal() {
  return parseJcxDocument(buildAst(lexJcx(readFileSync(MINIMAL))));
}

const SPAN: SourceSpan = {
  start: { offset: 0, line: 1, column: 0 },
  end: { offset: 1, line: 1, column: 1 },
};

describe('parseJcxDocument（T2 骨架 + T3 描述头 + T4 声部）', () => {
  it('minimal fixture 只有一个 V:1 声部；其余正文聚合仍为空（T5–T9 未接入）', () => {
    const { score } = parseMinimal();
    expect(score.voices).toHaveLength(1);
    expect(score.voices[0]?.id).toBe(voiceId(1));
    expect(score.chordShapes).toEqual([]);
    expect(score.directives).toEqual([]);
    expect(score.textBlocks).toEqual([]);
    expect(score.unknownFields).toEqual([]);
    expect(score.ignoredFields).toEqual([]);
    expect(score.origin).toBe(documentPath());
    // 描述头字段的断言在 header.test.ts；这里只锁「T3 确已接入」。
    expect(score.titles).toEqual(['Test Piece One']);
  });

  it('index：voiceById 有一条，其余四张表全空', () => {
    const { index } = parseMinimal();
    expect(index.eventById.size).toBe(0);
    expect(index.relationById.size).toBe(0);
    expect(index.relationsByNote.size).toBe(0);
    expect(index.voiceById.size).toBe(1);
    expect(index.byPath.size).toBe(1);
    expect(index.voiceById.has(voiceId(1))).toBe(true);
  });

  it('diagnostics 与 AST 的内容相等但不是同一引用', () => {
    const ast = buildAst(lexJcx(readFileSync(MINIMAL)));
    const result = parseJcxDocument(ast);
    expect(result.diagnostics).toEqual(ast.diagnostics);
    expect(result.diagnostics).not.toBe(ast.diagnostics);
  });

  it('不产生 error 级诊断', () => {
    expect(parseMinimal().diagnostics.some((d) => d.severity === 'error')).toBe(false);
  });

  it('重复解析同一 AST 结果稳定', () => {
    const ast = buildAst(lexJcx(readFileSync(MINIMAL)));
    expect(parseJcxDocument(ast).score).toEqual(parseJcxDocument(ast).score);
  });
});

describe('documentPath', () => {
  it('形态为 D.document 且可被 parseAstPath 往返识别', () => {
    expect(documentPath()).toBe('D.document');
    expect(parseAstPath(documentPath())).toEqual({ kind: 'document', segment: 'document' });
  });

  it('与行路径、bom 路径都不冲突', () => {
    expect(parseAstPath('L0')).toEqual({ kind: 'line', line: 0, indices: [] });
    expect(parseAstPath('D.bom')).toEqual({ kind: 'document', segment: 'bom' });
  });
});

describe('origin', () => {
  it('originOf / originsOf 取节点 path 字符串', () => {
    const ast = buildAst(lexJcx(readFileSync(MINIMAL)));
    const first = ast.lines[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    expect(originOf(first)).toBe(first.path);
    expect(originsOf(ast.lines)).toEqual(ast.lines.map((line) => line.path));
  });
});

describe('reportParse / onceKeyed', () => {
  it('reportParse 把 path 写进 diagnostic', () => {
    const bag = createDiagnosticBag();
    reportParse(bag, 'jcx.parse.unit-length.unresolved', 'warning', 'no L:', SPAN, 'L3');
    const [only] = bag.list();
    expect(only).toMatchObject({
      code: 'jcx.parse.unit-length.unresolved',
      severity: 'warning',
      path: 'L3',
    });
  });

  it('lexer 诊断不带 path 字段', () => {
    const bag = createDiagnosticBag();
    bag.report('jcx.field.unknown', 'info', 'x', SPAN);
    expect(bag.list()[0]).not.toHaveProperty('path');
  });

  it('同 key 只上报一次，不同 key 各报一次', () => {
    const bag = createDiagnosticBag();
    const once = onceKeyed(bag);
    expect(once.reportOnce('rest-Z', 'jcx.parse.rest.uppercase-z', 'info', 'Z', SPAN, 'L4')).toBe(true);
    expect(once.reportOnce('rest-Z', 'jcx.parse.rest.uppercase-z', 'info', 'Z', SPAN, 'L9')).toBe(false);
    expect(once.reportOnce('rest-at', 'jcx.parse.rest.hidden', 'info', '@', SPAN, 'L5')).toBe(true);
    expect(bag.list().map((d) => d.path)).toEqual(['L4', 'L5']);
    expect(once.seen('rest-Z')).toBe(true);
    expect(once.seen('never')).toBe(false);
  });

  it('两个 onceKeyed 作用域互相独立', () => {
    const bag = createDiagnosticBag();
    expect(onceKeyed(bag).reportOnce('k', 'jcx.parse.a.b', 'info', 'm', SPAN, 'L0')).toBe(true);
    expect(onceKeyed(bag).reportOnce('k', 'jcx.parse.a.b', 'info', 'm', SPAN, 'L0')).toBe(true);
    expect(bag.list()).toHaveLength(2);
  });
});

/** 字面量构造，不依赖 parseMinimal()：minimal fixture 自 T4 起已带一个 V:1 声部。 */
const EMPTY_SCORE: Score = {
  titles: [], credits: [], notes: [], voices: [], chordShapes: [], directives: [],
  textBlocks: [], unknownFields: [], ignoredFields: [], origin: documentPath(),
};

describe('buildDomainIndex', () => {
  it('空 Score 产出五张空表', () => {
    const index = buildDomainIndex(EMPTY_SCORE);
    expect(index.byPath.size + index.eventById.size + index.relationById.size).toBe(0);
    expect(index.relationsByNote.size + index.voiceById.size).toBe(0);
  });

  /** T7 之后 Score 里会真有 relation；提前用手搓的 Score 锁定遍历规则。 */
  it('填入 voice / event / relation 后五张表正确', () => {
    const v = voiceId(1);
    const e0 = eventId(v, 0);
    const e1 = eventId(v, 1);
    const tieId = relationId(v, 'tie', 0);
    const slurId = relationId(v, 'slur', 0);
    const rest: Rest = { variant: 'z', origin: 'L7.0' };
    const voice: Voice = {
      id: v,
      unknownAttributes: [],
      events: [
        { id: e0, origin: 'L7.0', kind: 'rest', rest },
        { id: e1, origin: 'L7.1', kind: 'barline', raw: '|' },
      ],
      ties: [
        {
          id: tieId,
          origins: ['L7.0'],
          kind: 'tie',
          status: 'resolved',
          from: { eventId: e0, memberIndex: 1 },
          to: { eventId: e1 },
        },
      ],
      slurs: [{ id: slurId, origins: ['L6.2'], kind: 'slur', status: 'unclosed', from: e0 }],
      tuplets: [],
      tabRelations: [],
      lyricLines: [],
      origins: ['L6'],
    };
    const score: Score = { ...parseMinimal().score, voices: [voice] };

    const index = buildDomainIndex(score);
    expect(index.voiceById.get(v)).toBe(voice);
    expect(index.eventById.get(e1)?.voiceId).toBe(v);
    expect(index.relationById.get(slurId)?.kind).toBe('slur');
    // 'L7.0' 被 event 与 tie 共用：先写者（event）赢。
    expect(index.byPath.get('L7.0')).toBe(e0);
    expect(index.byPath.get('L6')).toBe(v);
    expect(index.byPath.get('L6.2')).toBe(slurId);
    expect(index.relationsByNote.get(noteRefKey({ eventId: e0, memberIndex: 1 }))).toEqual([tieId]);
    // slur 的端点以整事件形式落 key（memberIndex 省略）。
    expect(index.relationsByNote.get(`${e0}#`)).toEqual([slurId]);
    expect(index.relationsByNote.get(`${e1}#`)).toEqual([tieId]);
  });
});
