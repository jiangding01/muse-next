import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildAst } from '../../../../src/formats/jcx/ast';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { createDiagnosticBag } from '../../../../src/formats/jcx/lexer/diagnostics';
import type { JcxDiagnostic } from '../../../../src/formats/jcx/lexer/diagnostics';
import {
  assignSegments,
  onceKeyed,
  parseHeader,
  parseVoices,
} from '../../../../src/formats/jcx/parse';
import type { ParseContext, SegmentsResult, VoiceSegment } from '../../../../src/formats/jcx/parse';
import type { JcxAstDocument } from '../../../../src/formats/jcx/ast';
import { voiceId } from '../../../../src/domain';

/**
 * M1.6 T5：全部走 `lexJcx` → `buildAst` → `parseHeader` → `parseVoices` → `assignSegments`
 * 真实链路（比 `parseJcxDocument` 更细粒度，因为本任务要直接检查 `segments`，而
 * `Score` 尚未有位置存放它——那是 T6 的事），只对投影（path → VoiceId 映射、
 * segment kind、诊断 code）断言，不做整树快照。
 */
function fixtureSource(name: string): string {
  return readFileSync(resolve(__dirname, `../../../fixtures/jcx/${name}.jcx`), 'utf-8');
}

function runSegments(source: string): { ast: JcxAstDocument; result: SegmentsResult; diagnostics: readonly JcxDiagnostic[] } {
  const ast = buildAst(lexJcx(source));
  const bag = createDiagnosticBag();
  const ctx: ParseContext = { bag, once: onceKeyed(bag) };
  const header = parseHeader(ast, ctx);
  const { voices, registry } = parseVoices(header.voiceFields, ctx);
  const result = assignSegments(ast, registry, voices, ctx);
  return { ast, result, diagnostics: bag.list() };
}

function fixture(name: string) {
  return runSegments(fixtureSource(name));
}

function parseCodes(diagnostics: readonly JcxDiagnostic[]): string[] {
  return diagnostics.filter((d) => d.code.startsWith('jcx.parse.')).map((d) => d.code);
}

/** 只看 bodyLine 归属：`[path, voiceId]` 有序对，忽略 trailing / lyric。 */
function bodyLinePairs(segments: readonly VoiceSegment[]): [string, string][] {
  return segments
    .filter((s): s is VoiceSegment & { unit: { kind: 'bodyLine' } } => s.unit.kind === 'bodyLine')
    .map((s) => [s.unit.node.path, s.voiceId]);
}

describe('inline-voice fixture（spec §9.3 整段式）', () => {
  it('三段正文按 [V:1]/[V:2]/[V:1] 顺序归属', () => {
    const { result } = fixture('inline-voice');
    expect(bodyLinePairs(result.segments)).toEqual([
      ['L9', voiceId(1)],
      ['L11', voiceId(2)],
      ['L13', voiceId(1)],
    ]);
  });

  it('没有隐式声部、没有新增 diagnostic', () => {
    const { result, diagnostics } = fixture('inline-voice');
    expect(result.voices).toHaveLength(2);
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});

describe('inline-voice-spaced fixture（spec §9.2：[V: n] 同行尾随正文）', () => {
  it('两行都是 trailing 归属，没有独立 bodyLine', () => {
    const { result } = fixture('inline-voice-spaced');
    expect(bodyLinePairs(result.segments)).toEqual([]);
    const trailing = result.segments.filter((s) => s.unit.kind === 'trailing');
    expect(trailing.map((s) => s.voiceId)).toEqual([voiceId(1), voiceId(2)]);
  });
});

describe('inline-voice-alternating fixture（spec §9.3 交替式）', () => {
  it('四段正文按 V1/V2/V1/V2 交替归属', () => {
    const { result } = fixture('inline-voice-alternating');
    expect(bodyLinePairs(result.segments).map(([, id]) => id)).toEqual([
      voiceId(1), voiceId(2), voiceId(1), voiceId(2),
    ]);
  });
});

describe('voice fixture（无 inline，3 个声部声明在 header）', () => {
  it('唯一一段正文归第一个声明的声部；发一条 segment-by-order 警告', () => {
    const { result, diagnostics } = fixture('voice');
    expect(bodyLinePairs(result.segments)).toEqual([['L9', voiceId(1)]]);
    expect(parseCodes(diagnostics)).toEqual([
      'jcx.parse.voice.unverified-attribute',
      'jcx.parse.voice.segment-by-order',
    ]);
    const d = diagnostics.find((x) => x.code === 'jcx.parse.voice.segment-by-order');
    expect(d?.severity).toBe('warning');
  });
});

describe('voice-no-style fixture（K: 在 V:1/V:2 之前，两条 V: 均落 body 区，背靠背声明）', () => {
  it('两条 body 区 V: 行背靠背出现，第一段是空段；正文归第二个声明的声部；发一条 segment-by-order 警告', () => {
    const { result, diagnostics } = fixture('voice-no-style');
    expect(bodyLinePairs(result.segments)).toEqual([['L8', voiceId(2)]]);
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.voice.segment-by-order']);
  });
});

describe('voice-without-inline fixture（spec §9.4 INFERRED，顺延自 §30：header 声明、body 用 V: 分段）', () => {
  it('三段正文按 V:1/V:2/V:3 的声明顺序归属；segment-by-order 只发一次', () => {
    const { result, diagnostics } = fixture('voice-without-inline');
    expect(result.voices.map((v) => v.id)).toEqual([voiceId(1), voiceId(2), voiceId(3)]);
    expect(bodyLinePairs(result.segments)).toEqual([
      ['L9', voiceId(1)],
      ['L11', voiceId(2)],
      ['L13', voiceId(3)],
    ]);
    // body 区的 V:2 / V:3 只是 §8.13 的再声明（T4 已建声部），额外发两条 redeclared info；
    // segment-by-order 尽管有两次触发点（V:2 与 V:3 两条切换行），onceKeyed 只留一条。
    expect(parseCodes(diagnostics)).toEqual([
      'jcx.parse.voice.redeclared',
      'jcx.parse.voice.redeclared',
      'jcx.parse.voice.segment-by-order',
    ]);
  });
});

describe('inline-voice-undeclared fixture（[V:9] 未声明，隐式创建）', () => {
  it('隐式声部承接正文；发一条 implicit 警告', () => {
    const { result, diagnostics } = fixture('inline-voice-undeclared');
    expect(result.voices).toHaveLength(1);
    const implicitId = result.voices[0]?.id;
    expect(implicitId).toBe(voiceId(1));
    expect(bodyLinePairs(result.segments)).toEqual([['L7', implicitId]]);
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.voice.implicit']);
    const d = diagnostics.find((x) => x.code === 'jcx.parse.voice.implicit');
    expect(d?.severity).toBe('warning');
  });
});

describe('no-voice-at-all fixture（既无 [V:...] 也无 V:，隐式建单个声部）', () => {
  it('隐式声部承接全部正文；发一条 implicit 警告', () => {
    const { result, diagnostics } = fixture('no-voice-at-all');
    expect(result.voices).toHaveLength(1);
    const implicitId = result.voices[0]?.id;
    expect(implicitId).toBe(voiceId(1));
    expect(bodyLinePairs(result.segments)).toEqual([['L6', implicitId]]);
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.voice.implicit']);
  });
});

describe('非 V 的 inline field（spec §9.5 UNVERIFIED：不切换声部，只保留原文）', () => {
  it('[K:...] 不影响声部归属，落 ignoredFields 并发 unsupported 警告', () => {
    const { result, diagnostics } = runSegments('%MUSE2\nX:1\nT:t\nM:4/4\nL:1/4\nK:C\nV:1\n[K:D]\nCDEF|\n');
    expect(bodyLinePairs(result.segments)).toEqual([['L8', voiceId(1)]]);
    expect(result.ignoredFields).toEqual([{ name: 'K', rawValue: 'D', origin: 'L7' }]);
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.inline-field.unsupported']);
    const d = diagnostics.find((x) => x.code === 'jcx.parse.inline-field.unsupported');
    expect(d?.severity).toBe('warning');
  });
});

describe('orderly 模式按 body 区 V: 行自身的 id 切换（P1 修复：不按位置 clamp，见 advanceOrderly 注释）', () => {
  it('body 区 V: 出现顺序与声明顺序不一致、且第三条引入新 id 时，仍按每行自身的 id 归属', () => {
    const source = [
      '%MUSE2', 'X:1', 'T:t', 'M:4/4', 'L:1/4',
      'V:1', 'V:2', 'K:C',
      'V:2', 'GABc|',
      'V:1', 'HIJK|',
      'V:9', 'cBAG|', '',
    ].join('\n');
    const { result, diagnostics } = runSegments(source);
    // 声明顺序 = 1, 2；body 区第三条 V:9 是新 id，被 T4 追加为第 3 个声部。
    expect(result.voices.map((v) => v.id)).toEqual([voiceId(1), voiceId(2), voiceId(3)]);
    // 若按「位置 clamp」（旧逻辑）：三条 body V: 行会依次推进到 order[0]/order[1]/order[2]，
    // 即使第一条写的是 V:2、第二条写的是 V:1，也会分别错误地归到 v1 / v2。
    // 按「行自身 id」（新逻辑）：GABc| 归 V:2 声明的 v2，HIJK| 归 V:1 声明的 v1，
    // cBAG| 归新声明的 v3——与每一行写的 id 完全对应。
    expect(bodyLinePairs(result.segments)).toEqual([
      ['L9', voiceId(2)],
      ['L11', voiceId(1)],
      ['L13', voiceId(3)],
    ]);
    // body 区的 V:2 / V:1 都是对已声明 id 的重复声明（§8.12），各发一条 redeclared info；
    // segment-by-order 尽管有三次触发点，onceKeyed 只留一条；没有 implicit（id 都命中）。
    expect(parseCodes(diagnostics)).toEqual([
      'jcx.parse.voice.redeclared',
      'jcx.parse.voice.redeclared',
      'jcx.parse.voice.segment-by-order',
    ]);
  });
});

describe('w: 行归属（spec §8.13：w: 必然在 body 中；本任务只记 voice 与上一个 bodyLine 的引用，音节对齐留给 T8）', () => {
  it('w: 归其上一个 bodyLine 所属的声部', () => {
    const source = '%MUSE2\nX:1\nT:t\nM:4/4\nL:1/4\nK:C\nV:1\nCDEF|\nw:la la la la\n';
    const { result, diagnostics } = runSegments(source);
    expect(bodyLinePairs(result.segments)).toEqual([['L7', voiceId(1)]]);
    const lyric = result.segments.find((s) => s.unit.kind === 'lyric');
    expect(lyric).toBeDefined();
    if (lyric === undefined || lyric.unit.kind !== 'lyric') {
      return;
    }
    expect(lyric.voiceId).toBe(voiceId(1));
    expect(lyric.unit.node.path).toBe('L8');
    expect(lyric.unit.target?.kind).toBe('bodyLine');
    expect(lyric.unit.target?.line.path).toBe('L7');
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});
