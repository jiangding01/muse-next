/**
 * M2.5 T1 —— `groupVoices`：`Score.voices → SystemGroup[]` 的视觉分组
 * （`docs/M2.5_SYSTEM_LAYOUT_PLAN.md` v1.0 §Q1 + 用户 2026-10-04 的 T1 裁决 ①–④）。
 *
 * **语料口径（裁决 ④）**：本文件是 **synthetic shape coverage**——用自造源码复刻语料已知的
 * 四种结构形态（1 声部无 bracket / 2 声部 `bracket=2` / 3 声部 `bracket=3` / 9 声部无
 * bracket，见方案 §Q1.1 表），由 CI 覆盖；**不代表真实语料在本轮重新跑过**。真实语料
 * probe 留到 T8 system matrix / T9 smoke 前。fixture 一律走运行时 glob，数量不写死。
 */
import { describe, expect, it } from 'vitest';

import type { Voice } from '../../../src/domain';
import { loadJcx } from '../../../src/formats/jcx';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import type { RenderDiagnostic } from '../../../src/notation/model/types';
import { groupVoices } from '../../../src/notation/system/groupVoices';
import type { VoiceGrouping } from '../../../src/notation/system/groupVoices';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import { anchorResolves, matrixScoreFrom } from './renderMatrix.helpers';

type CodeKey = keyof typeof CODES;

/** 只有头部 `V:` 行的合成源码：`attrs[i]` 是第 i+1 个声部的属性串（空串 = 无属性）。 */
function sourceOf(attrs: readonly string[]): string {
  const lines = attrs.map((attr, i) => `V:${String(i + 1)}${attr === '' ? '' : ` ${attr}`}`);
  return ['X:1', 'M:4/4', 'L:1/4', ...lines, 'K:C', ''].join('\n');
}

function voicesOf(source: string): readonly Voice[] {
  return loadJcx(source).score.voices;
}

/** group 摘要：`'bracket:v1,v2'` / `'none:v3'`。 */
function groupShape(grouping: VoiceGrouping): string[] {
  return grouping.groups.map((group) => `${group.connector}:${group.voiceIds.join(',')}`);
}

/** 诊断摘要：`'v1 systemGroupSpanOverflow'`，按产出顺序。 */
function diagnosticShape(diagnostics: readonly RenderDiagnostic[]): string[] {
  const keyByCode = new Map<string, string>(Object.entries(CODES).map(([key, code]) => [code, key]));
  return diagnostics.map((d) => `${d.anchor.kind === 'voice' ? d.anchor.voiceId : d.anchor.kind} ${keyByCode.get(d.code) ?? d.code}`);
}

interface GroupCase {
  readonly name: string;
  readonly attrs: readonly string[];
  readonly groups: readonly string[];
  readonly diagnostics: readonly `v${number} ${CodeKey}`[];
}

const CASES: readonly GroupCase[] = [
  { name: '#1 1 声部无属性（corpus#01/#05/#06 形态）', attrs: [''], groups: ['none:v1'], diagnostics: [] },
  { name: '#2 2 声部 v1 bracket=2（corpus#02/03/04/07/10/11 形态）', attrs: ['style=tab bracket=2', 'style=jianpu'], groups: ['bracket:v1,v2'], diagnostics: [] },
  { name: '#3 3 声部 v1 bracket=3（corpus#09 形态）', attrs: ['bracket=3', '', ''], groups: ['bracket:v1,v2,v3'], diagnostics: [] },
  {
    name: '#4 9 声部无 bracket（corpus#08 形态，F-7 不合并）',
    attrs: ['', '', '', '', '', '', '', '', ''],
    groups: ['none:v1', 'none:v2', 'none:v3', 'none:v4', 'none:v5', 'none:v6', 'none:v7', 'none:v8', 'none:v9'],
    diagnostics: [],
  },
  { name: '#5 越界截断到 2 层', attrs: ['bracket=5', ''], groups: ['bracket:v1,v2'], diagnostics: ['v1 systemGroupSpanOverflow'] },
  { name: '#6 末声部越界 → 单声部', attrs: ['', 'bracket=3'], groups: ['none:v1', 'none:v2'], diagnostics: ['v2 systemGroupSpanOverflow'] },
  { name: '#7 bracket=1 → 单声部、无诊断', attrs: ['bracket=1', ''], groups: ['none:v1', 'none:v2'], diagnostics: [] },
  {
    name: '#8 bracket=0 / -1 → 单声部 + 每个声明一条 ignored',
    attrs: ['bracket=0', 'bracket=-1', ''],
    groups: ['none:v1', 'none:v2', 'none:v3'],
    diagnostics: ['v1 systemGroupDeclarationIgnored', 'v2 systemGroupDeclarationIgnored'],
  },
  { name: '#9 两组并存（多 group 按 spec 字面）', attrs: ['bracket=2', '', 'bracket=2', ''], groups: ['bracket:v1,v2', 'bracket:v3,v4'], diagnostics: [] },
  {
    name: '#10 被覆盖声部的 bracket 只发诊断，不重分组',
    attrs: ['bracket=3', 'bracket=2', '', ''],
    groups: ['bracket:v1,v2,v3', 'none:v4'],
    diagnostics: ['v2 systemGroupDeclarationIgnored'],
  },
  {
    name: '#11 brace / staves（含别名 brc / stv）→ 单声部 + info，不吞并后续声部',
    attrs: ['brace=2', 'bracket=2', '', 'stv=2', 'brc=3'],
    groups: ['none:v1', 'bracket:v2,v3', 'none:v4', 'none:v5'],
    diagnostics: ['v1 systemConnectorNotModeled', 'v4 systemConnectorNotModeled', 'v5 systemConnectorNotModeled'],
  },
  {
    name: '#12 同一声部 bracket=2 + brace=2 → 按 bracket 分组，brace 另发 info',
    attrs: ['bracket=2 brace=2', ''],
    groups: ['bracket:v1,v2'],
    diagnostics: ['v1 systemConnectorNotModeled'],
  },
  { name: '#13 v1 brace=2、v2 bracket=2', attrs: ['brace=2', 'bracket=2', ''], groups: ['none:v1', 'bracket:v2,v3'], diagnostics: ['v1 systemConnectorNotModeled'] },
  {
    name: '#14 precedence：bracket=0 + brace=2 不回退执行 brace',
    attrs: ['bracket=0 brace=2', ''],
    groups: ['none:v1', 'none:v2'],
    diagnostics: ['v1 systemGroupDeclarationIgnored', 'v1 systemConnectorNotModeled'],
  },
  {
    name: '#15 被覆盖声部的 brace / staves 只发 connector-not-modeled（每个属性一条原因）',
    attrs: ['bracket=3', 'brace=2 staves=2', 'bracket=1 brace=2'],
    groups: ['bracket:v1,v2,v3'],
    diagnostics: [
      'v2 systemConnectorNotModeled',
      'v2 systemConnectorNotModeled',
      'v3 systemGroupDeclarationIgnored',
      'v3 systemConnectorNotModeled',
    ],
  },
  { name: '#16 越界截断后仍 ≥ 2 层', attrs: ['', 'bracket=4', ''], groups: ['none:v1', 'bracket:v2,v3'], diagnostics: ['v2 systemGroupSpanOverflow'] },
  {
    name: '#17 被覆盖声部的 bracket 不得把 group 往后扩',
    attrs: ['bracket=2', 'bracket=3', '', ''],
    groups: ['bracket:v1,v2', 'none:v3', 'none:v4'],
    diagnostics: ['v2 systemGroupDeclarationIgnored'],
  },
  {
    name: '#18 被覆盖声部的 bracket=0 / 越界 bracket 各只发一条 ignored（不重复报、不报 overflow）',
    attrs: ['bracket=3', 'bracket=0', 'bracket=9'],
    groups: ['bracket:v1,v2,v3'],
    diagnostics: ['v2 systemGroupDeclarationIgnored', 'v3 systemGroupDeclarationIgnored'],
  },
  { name: '#19 单声部 bracket=2 → 单声部 + overflow', attrs: ['bracket=2'], groups: ['none:v1'], diagnostics: ['v1 systemGroupSpanOverflow'] },
];

/** 不变量（§Q1.2）：覆盖全部声部、无重叠、无遗漏、保持文档顺序；index 连续。 */
function expectPartition(voices: readonly Voice[], grouping: VoiceGrouping): void {
  expect(grouping.groups.flatMap((group) => group.voiceIds)).toEqual(voices.map((voice) => voice.id));
  expect(grouping.groups.map((group) => group.index)).toEqual(grouping.groups.map((_group, i) => i));
  for (const group of grouping.groups) {
    expect(group.voiceIds.length).toBeGreaterThan(0);
    const declared = group.connector === 'bracket';
    expect(group.evidence).toBe(declared ? 'declared' : 'singleton');
    expect(declared ? group.voiceIds.length >= 2 : group.voiceIds.length === 1).toBe(true);
  }
}

describe('M2.5 T1 —— groupVoices 分组矩阵', () => {
  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const voices = voicesOf(sourceOf(c.attrs));
    const grouping = groupVoices(voices);
    expect(groupShape(grouping)).toEqual(c.groups);
    expect(diagnosticShape(grouping.diagnostics)).toEqual(c.diagnostics);
    expectPartition(voices, grouping);
  });

  it('零声部 → 零 group、零诊断', () => {
    expect(groupVoices([])).toEqual({ groups: [], diagnostics: [] });
  });
});

describe('M2.5 T1 —— 诊断契约（C3 / level / 措辞 / sourceRef / id）', () => {
  it('新码字面量钉死（用户 2026-10-04 批准的 post-freeze amendment）', () => {
    expect(CODES.systemGroupDeclarationIgnored).toBe('muse.render.system.group-declaration-ignored');
  });

  const LEVEL: Partial<Record<string, RenderDiagnostic['level']>> = {
    [CODES.systemGroupSpanOverflow]: 'warning',
    [CODES.systemConnectorNotModeled]: 'info',
    [CODES.systemGroupDeclarationIgnored]: 'info',
  };

  it.each(CASES.filter((c) => c.diagnostics.length > 0).map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const source = sourceOf(c.attrs);
    const matrix = matrixScoreFrom(source);
    const { diagnostics } = groupVoices(matrix.score.voices);
    const codeValues: readonly string[] = Object.values(CODES);
    for (const diagnostic of diagnostics) {
      expect(codeValues).toContain(diagnostic.code);
      expect(diagnostic.level).toBe(LEVEL[diagnostic.code]);
      // 裁决 ②：只描述本版处理，不替 JCX 格式下「非法」结论。
      expect(diagnostic.message).not.toMatch(/非法|不合法|invalid/i);
      expect(diagnostic.anchor.kind).toBe('voice');
      expect(anchorResolves(diagnostic.anchor, matrix)).toBe(true);
      const voice = matrix.score.voices.find((v) => diagnostic.anchor.kind === 'voice' && v.id === diagnostic.anchor.voiceId);
      expect(diagnostic.sourceRef).toBe(voice?.origins[0]);
    }
    expect(new Set(diagnostics.map((d) => d.id)).size).toBe(diagnostics.length);
  });

  it('origins 为空的 Voice 不带 sourceRef（不强断言 origin 存在）', () => {
    const [voice] = voicesOf(sourceOf(['bracket=0']));
    expect(voice).toBeDefined();
    if (voice === undefined) return;
    const [diagnostic] = groupVoices([{ ...voice, origins: [] }]).diagnostics;
    expect(diagnostic?.code).toBe(CODES.systemGroupDeclarationIgnored);
    expect(diagnostic !== undefined && 'sourceRef' in diagnostic).toBe(false);
  });

  it('同一声部多条诊断的 id 按文档顺序稳定派生', () => {
    const voices = voicesOf(sourceOf(['bracket=0 brace=2 staves=3', '']));
    const first = groupVoices(voices).diagnostics.map((d) => d.id);
    expect(first).toEqual(groupVoices(voices).diagnostics.map((d) => d.id));
    expect(first).toEqual([
      `voice:v1|${CODES.systemGroupDeclarationIgnored}#0`,
      `voice:v1|${CODES.systemConnectorNotModeled}#0`,
      `voice:v1|${CODES.systemConnectorNotModeled}#1`,
    ]);
  });
});

describe('M2.5 T1 —— 纯函数与确定性', () => {
  it('同输入两次逐字段相等；不修改入参；voiceIds 引用原 id', () => {
    const voices = voicesOf(sourceOf(['bracket=3', 'bracket=2 brace=2', '', 'staves=2']));
    const snapshot = JSON.stringify(voices);
    const once = groupVoices(voices);
    expect(groupVoices(voices)).toEqual(once);
    expect(JSON.stringify(voices)).toBe(snapshot);
    expect(once.groups[0]?.voiceIds[0]).toBe(voices[0]?.id);
  });
});

describe('M2.5 T1 —— 非安全整数 bracket（人工破坏 Domain 的防御性输入，裁决 2026-10-04）', () => {
  /**
   * `loadJcx` 经 `parseIntegerAttr` 保证 bracket 是安全整数；手工构造的 Voice 才可能带
   * 非整数 / NaN / Infinity / 超出安全范围的值。一律按单声部 + 一条 ignored info，
   * 不丢后续声部；`MAX_SAFE_INTEGER + 1` 是整数但不安全，防止实现退化成 `Number.isInteger`。
   */
  const base = voicesOf(sourceOf(['', '', '']));

  it.each([
    [1.5, '1.5'],
    [2.5, '2.5'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [Number.MAX_SAFE_INTEGER + 1, '9007199254740992'],
  ])('bracket=%s → 单声部 + ignored，后续声部不丢', (value, label) => {
    const input = base.map((voice, i) => (i === 0 ? { ...voice, bracket: value } : voice));
    const grouping = groupVoices(input);
    expect(groupShape(grouping)).toEqual(['none:v1', 'none:v2', 'none:v3']);
    expectPartition(input, grouping);
    expect(grouping.diagnostics.map((d) => [d.code, d.level, d.message])).toEqual([
      [
        CODES.systemGroupDeclarationIgnored,
        'info',
        `bracket=${label} 的分组范围无法形成有效 system group，本版忽略该声明并按单声部系统处理`,
      ],
    ]);
  });
});

describe('M2.5 T1 —— 重复 VoiceId（人工破坏 Domain 的防御性输入）', () => {
  /**
   * 正常 `loadJcx` 保证 VoiceId 唯一；重复 id 只作防御：不新增诊断、不去重，只要求确定性、
   * 不抛异常、不改输入、按数组位置处理（用户 2026-10-04 审查口径）。
   */
  const [a, b] = voicesOf(sourceOf(['bracket=2 brace=3', 'bracket=0']));

  it('同一 Voice 对象重复出现：按位置划分，诊断 id 不冲突', () => {
    expect(a !== undefined && b !== undefined).toBe(true);
    if (a === undefined || b === undefined) return;
    const input = Object.freeze([a, a, b, b]);
    const snapshot = JSON.stringify(input);
    const once = groupVoices(input);
    expect(groupShape(once)).toEqual(['bracket:v1,v1', 'none:v2', 'none:v2']);
    expect(once.groups.flatMap((group) => group.voiceIds)).toEqual(input.map((voice) => voice.id));
    expect(new Set(once.diagnostics.map((d) => d.id)).size).toBe(once.diagnostics.length);
    expect(groupVoices(input)).toEqual(once);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('不同对象同 id：仍按位置处理', () => {
    expect(a !== undefined && b !== undefined).toBe(true);
    if (a === undefined || b === undefined) return;
    const input = [a, { ...b, id: a.id, bracket: 2 }, b];
    const grouping = groupVoices(input);
    expect(groupShape(grouping)).toEqual(['bracket:v1,v1', 'none:v2']);
    expect(grouping.groups.flatMap((group) => group.voiceIds)).toEqual(input.map((voice) => voice.id));
    expect(groupVoices(input)).toEqual(grouping);
  });
});

describe('M2.5 T1 —— fixture 全集（运行时 glob）', () => {
  it.each(fixtureNames)('%s：分组满足划分不变量', (name) => {
    const voices = loadJcx(fixtureBytes(name)).score.voices;
    expectPartition(voices, groupVoices(voices));
  });

  it.each(['voice.jcx', 'canonical-header-roles.jcx'])('%s 产出一个 bracket group', (name) => {
    expect(fixtureNames).toContain(name);
    const voices = loadJcx(fixtureBytes(name)).score.voices;
    const bracketGroups = groupVoices(voices).groups.filter((group) => group.connector === 'bracket');
    expect(bracketGroups).toHaveLength(1);
    expect(bracketGroups[0]?.voiceIds).toEqual(voices.slice(0, 2).map((voice) => voice.id));
  });
});
