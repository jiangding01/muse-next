import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildAst } from '../../../../src/formats/jcx/ast';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import type { JcxDiagnostic } from '../../../../src/formats/jcx/lexer/diagnostics';
import { buildDomainIndex, parseJcxDocument, splitVoiceAttributes } from '../../../../src/formats/jcx/parse';
import { voiceId } from '../../../../src/domain';

/**
 * M1.6 T4：全部走 `lexJcx` → `buildAst` → `parseJcxDocument` 真实链路，
 * 只对投影（Voice 字段、unknownAttributes、诊断 code）断言，不做整树快照。
 */
function fixture(name: string) {
  const ast = buildAst(lexJcx(readFileSync(resolve(__dirname, `../../../fixtures/jcx/${name}.jcx`))));
  return { ast, result: parseJcxDocument(ast) };
}

function parsed(name: string) {
  return fixture(name).result;
}

/** 只看 parse 层新增的诊断（lexer 的那批不在本任务职责内）。 */
function parseCodes(diagnostics: readonly JcxDiagnostic[]): string[] {
  return diagnostics.filter((d) => d.code.startsWith('jcx.parse.')).map((d) => d.code);
}

describe('voice fixture（spec §12.1–§12.4，属性顺序 name style clef ins vol bracket）', () => {
  const { score, diagnostics } = parsed('voice');

  it('三条 V: 依声明序号得到 v1/v2/v3', () => {
    expect(score.voices.map((v) => v.id)).toEqual([voiceId(1), voiceId(2), voiceId(3)]);
  });

  it('V:1 全称/简写混用属性正确归一化', () => {
    const v1 = score.voices[0];
    expect(v1).toMatchObject({
      name: 'Lead', style: 'staff', instrument: 24, volume: 40, bracket: 2,
    });
    expect(v1?.unknownAttributes).toEqual([]);
  });

  it('V:2 style=jianpu 且 play= 落 unknownAttributes（不提升为布尔）', () => {
    const v2 = score.voices[1];
    expect(v2).toMatchObject({ style: 'jianpu', instrument: 0, volume: 64 });
    expect(v2?.name).toBeUndefined();
    expect(v2?.unknownAttributes).toEqual([{ key: 'play', value: '1' }]);
  });

  it('V:3 无属性；style 仍是可选字段', () => {
    const v3 = score.voices[2];
    expect(v3?.style).toBeUndefined();
    expect(v3?.unknownAttributes).toEqual([]);
  });

  it('play= 只发一条 unverified-attribute info', () => {
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.voice.unverified-attribute']);
    const d = diagnostics.find((x) => x.code === 'jcx.parse.voice.unverified-attribute');
    expect(d?.severity).toBe('info');
  });
});

describe('voice-alias-old / voice-alias-new fixture（spec §12.3 别名归一化）', () => {
  it('旧写法 ins=/vol= 归一化为 instrument/volume', () => {
    const { score, diagnostics } = parsed('voice-alias-old');
    expect(score.voices[0]).toMatchObject({ instrument: 24, volume: 40 });
    expect(parseCodes(diagnostics)).toEqual([]);
  });

  it('新写法 instrument=/volumn= 归一化为同名字段；play= 仍进 unknownAttributes', () => {
    const { score, diagnostics } = parsed('voice-alias-new');
    expect(score.voices[0]).toMatchObject({ instrument: 24, volume: 46 });
    expect(score.voices[0]?.unknownAttributes).toEqual([{ key: 'play', value: '1' }]);
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.voice.unverified-attribute']);
  });
});

describe('voice-no-style fixture（spec §12.6.1：style 可选）', () => {
  it('两个声部均无 style，也无任何 parse 诊断', () => {
    const { score, diagnostics } = parsed('voice-no-style');
    expect(score.voices).toHaveLength(2);
    expect(score.voices.every((v) => v.style === undefined)).toBe(true);
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});

describe('voice-unknown-attr fixture（未识别 key 不猜别名）', () => {
  it('foo=bar 原样进 unknownAttributes，并发一条 unverified-attribute info', () => {
    const { score, diagnostics } = parsed('voice-unknown-attr');
    expect(score.voices[0]?.unknownAttributes).toEqual([{ key: 'foo', value: 'bar' }]);
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.voice.unverified-attribute']);
    const d = diagnostics.find((x) => x.code === 'jcx.parse.voice.unverified-attribute');
    expect(d?.severity).toBe('info');
  });
});

describe('voice-unknown-style fixture（spec §12.6.5：未知 style 不报错）', () => {
  it('style 原值保留；lexer 已发 unknown-style，parse 层不重复发', () => {
    const { score, diagnostics } = parsed('voice-unknown-style');
    expect(score.voices[0]?.style).toBe('hexagram');
    expect(diagnostics.some((d) => d.code === 'jcx.voice.unknown-style')).toBe(true);
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});

describe('voice-quoted-name fixture（spec §12.4：引号值含空格与中文）', () => {
  it('带空格的引号值与中文名都正确切分', () => {
    const { score, diagnostics } = parsed('voice-quoted-name');
    expect(score.voices[0]?.name).toBe('a b');
    expect(score.voices[1]?.name).toBe('伴奏');
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});

describe('voice-duplicate-id fixture（spec §8.12 INFERRED：属性级覆盖）', () => {
  it('后者覆盖已写属性，未写属性保留前者，origins 累加', () => {
    const { score, diagnostics } = parsed('voice-duplicate-id');
    expect(score.voices).toHaveLength(1);
    const v1 = score.voices[0];
    expect(v1).toMatchObject({ name: 'Lead', style: 'staff', instrument: 24, volume: 40 });
    expect(v1?.origins).toEqual(['L6', 'L7']);
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.voice.redeclared']);
  });

  it('回归：合并后 origins 的全部 path 都登记为同一个 VoiceId，不与其他对象冲突', () => {
    const { score } = parsed('voice-duplicate-id');
    const v1 = score.voices[0];
    expect(v1).toBeDefined();
    if (v1 === undefined) {
      return;
    }
    const index = buildDomainIndex(score);
    expect(v1.origins.length).toBeGreaterThan(1);
    for (const origin of v1.origins) {
      expect(index.byPath.get(origin)).toBe(v1.id);
    }
  });
});

describe('voice-numeric-bad fixture（数值属性解析失败）', () => {
  it('ins=abc 落 unknownAttributes（归一化键）并发 warning', () => {
    const { score, diagnostics } = parsed('voice-numeric-bad');
    expect(score.voices[0]?.instrument).toBeUndefined();
    expect(score.voices[0]?.unknownAttributes).toEqual([{ key: 'instrument', value: 'abc' }]);
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.voice.attribute-unparsed']);
    const d = diagnostics.find((x) => x.code === 'jcx.parse.voice.attribute-unparsed');
    expect(d?.severity).toBe('warning');
  });
});

describe('splitVoiceAttributes（空 key 不产生 key === "" 的属性）', () => {
  it('=x 不切成 attrs，而是整体计入 unparsed', () => {
    const { id, attrs, unparsed } = splitVoiceAttributes('1 =x name=Lead');
    expect(id).toBe('1');
    expect(attrs).toEqual([{ key: 'name', value: 'Lead', quoted: false }]);
    expect(unparsed).toEqual(['=x']);
    expect(attrs.some((a) => a.key === '')).toBe(false);
  });
});

describe('voice-play fixture（spec §12.2 UNVERIFIED：play= 禁止提升为布尔）', () => {
  it('play= 留在 unknownAttributes；Voice 上不存在 play 字段', () => {
    const { score, diagnostics } = parsed('voice-play');
    const v1 = score.voices[0];
    expect(v1).toMatchObject({ style: 'jianpu' });
    expect(v1?.unknownAttributes).toEqual([{ key: 'play', value: '1' }]);
    expect(v1).not.toHaveProperty('play');
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.voice.unverified-attribute']);
  });
});
