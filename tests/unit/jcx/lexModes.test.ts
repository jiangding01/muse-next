import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createModeState,
  prescanVoices,
  resolveMode,
} from '../../../src/formats/jcx/lexer/lexModes';
import { lexJcx } from '../../../src/formats/jcx/lexer';
import { lexDocument } from '../../../src/formats/jcx/lexer/lexDocument';
import { createDiagnosticBag } from '../../../src/formats/jcx/lexer/diagnostics';
import { flattenTokens, rawOf } from '../../../src/formats/jcx/lexer/token';
import type { JcxLexLine } from '../../../src/formats/jcx/lexer/token';
import type { JcxDiagnostic } from '../../../src/formats/jcx/lexer/diagnostics';
import { emptySpanAt } from '../../../src/formats/jcx/lexer/sourceSpan';

const FIXTURES_DIR = resolve(__dirname, '../../fixtures/jcx');

const ZERO_SPAN = emptySpanAt({ offset: 0, line: 1, column: 0 });

function lex(text: string): { lines: JcxLexLine[]; diagnostics: readonly JcxDiagnostic[] } {
  const bag = createDiagnosticBag();
  const lines = lexDocument(text, bag);
  return { lines, diagnostics: bag.list() };
}

function bodyModes(lines: readonly JcxLexLine[]): (string | undefined)[] {
  return lines.filter((line) => line.kind === 'body').map((line) => line.mode);
}

function codes(diagnostics: readonly JcxDiagnostic[]): string[] {
  return diagnostics.map((item) => item.code);
}

describe('prescanVoices —— style 的各种写法（§12.1 / §12.4 / §12.6）', () => {
  it('裸值 style=tab → tab 模式', () => {
    const prescan = prescanVoices('V:1 style=tab clef=standardtab\n');
    expect(prescan.order).toEqual(['1']);
    expect(prescan.byId.get('1')).toMatchObject({ style: 'tab', mode: 'tab', knownStyle: true });
  });

  it('引号值 style="tab" → tab 模式，引号不进值', () => {
    const prescan = prescanVoices('V:2 name="Lead Line" style="tab"\n');
    expect(prescan.byId.get('2')).toMatchObject({ style: 'tab', mode: 'tab' });
  });

  it('冒号后空格 `V: 3` 先 trim 再取 id（§12.1）', () => {
    const prescan = prescanVoices('V: 3 style=jianpu\n');
    expect(prescan.order).toEqual(['3']);
    expect(prescan.byId.get('3')).toMatchObject({ style: 'jianpu', mode: 'pitch' });
  });

  it('staff / jianpu / 缺省一律模式 A', () => {
    const prescan = prescanVoices('V:1 style=staff\nV:2 style=jianpu\nV:3\n');
    expect([...prescan.order].map((id) => prescan.byId.get(id)?.mode)).toEqual([
      'pitch',
      'pitch',
      'pitch',
    ]);
    // §12.6.1：缺省不是「未知」，不得标记为 unknown style。
    expect(prescan.byId.get('3')?.style).toBeUndefined();
    expect(prescan.byId.get('3')?.knownStyle).toBe(true);
  });

  it('未知 style 保留原值、模式 A、knownStyle=false（§12.6.5）', () => {
    const prescan = prescanVoices('V:1 style=hexagram\n');
    expect(prescan.byId.get('1')).toMatchObject({
      style: 'hexagram',
      mode: 'pitch',
      knownStyle: false,
    });
  });

  it('大小写敏感：style=TAB 按未知 style 处理（§12.6 只登记小写）', () => {
    const prescan = prescanVoices('V:1 style=TAB\n');
    expect(prescan.byId.get('1')).toMatchObject({ mode: 'pitch', knownStyle: false });
  });

  it('引号内的 style= 不被误认为属性', () => {
    const prescan = prescanVoices('V:1 name="a style=tab b"\n');
    expect(prescan.byId.get('1')?.style).toBeUndefined();
    expect(prescan.byId.get('1')?.mode).toBe('pitch');
  });

  it('§8.12 同 id 重复声明：后者属性覆盖前者，order 只记首次', () => {
    const prescan = prescanVoices('V:1 style=tab\nV:1 style=staff\n');
    expect(prescan.order).toEqual(['1']);
    expect(prescan.byId.get('1')?.style).toBe('staff');
    expect(prescan.byId.get('1')?.mode).toBe('pitch');
  });

  it('§8.12 覆盖方向：先 staff 后 tab 取 tab', () => {
    const prescan = prescanVoices('V:1 style=staff\nV:1 style=tab\n');
    expect(prescan.order).toEqual(['1']);
    expect(prescan.byId.get('1')?.mode).toBe('tab');
  });

  it('§8.12 属性级覆盖：后者未写 style 时保留前者的 style', () => {
    const prescan = prescanVoices('V:1 style=tab\nV:1 name="Guitar"\n');
    expect(prescan.byId.get('1')?.style).toBe('tab');
    expect(prescan.byId.get('1')?.mode).toBe('tab');
  });

  it('§11.3 文本块内的 `V:` 行不是声部声明', () => {
    const prescan = prescanVoices('V:1 style=tab\n%%begintext\nV: 副歌\n%%endtext\n');
    expect(prescan.order).toEqual(['1']);
  });

  it('§11.3 文本块内的 `[V:1]` 不算内联字段', () => {
    expect(prescanVoices('V:1\n%%begintext\n[V:1]\n%%endtext\n').hasInlineVoice).toBe(false);
  });

  it('§5.6 注释行不是声部声明', () => {
    expect(prescanVoices('% V:9 style=tab\nV:1\n').order).toEqual(['1']);
  });

  it('CRLF 行尾不污染最后一个属性值', () => {
    const prescan = prescanVoices('V:1 style=tab\r\nV:2 style=staff\r\n');
    expect(prescan.byId.get('1')?.style).toBe('tab');
    expect(prescan.byId.get('2')?.style).toBe('staff');
  });

  it('hasInlineVoice 反映全文是否出现 `[V:...]`', () => {
    expect(prescanVoices('V:1\nCDEF|\n').hasInlineVoice).toBe(false);
    expect(prescanVoices('V:1\n[V:1]\nCDEF|\n').hasInlineVoice).toBe(true);
    expect(prescanVoices('V:1\n[V: 1] CDEF|\n').hasInlineVoice).toBe(true);
  });
});

describe('resolveMode —— `[V:id]` 切换（§9.1 / §13.2）', () => {
  const source = [
    'V:1 style=staff',
    'V:2 style=tab',
    'K:C',
    '[V:1]',
    'CDEF|',
    '[V:2]',
    'a0 b2*2|',
    '[V:1]',
    'GABc|',
    '',
  ].join('\n');

  it('[V:2] 切到 tab、[V:1] 切回 pitch', () => {
    const { lines } = lex(source);
    expect(bodyModes(lines)).toEqual(['pitch', 'tab', 'pitch']);
  });

  it('`[V: 1]` 冒号后空格同样触发切换', () => {
    const spaced = source.replace('[V:2]', '[V: 2]');
    const { lines } = lex(spaced);
    expect(bodyModes(lines)).toEqual(['pitch', 'tab', 'pitch']);
  });

  it('未声明的 voice id 回退模式 A 且不报错', () => {
    const { lines, diagnostics } = lex('K:C\n[V:9]\nCDEF|\n');
    expect(bodyModes(lines)).toEqual(['pitch']);
    expect(diagnostics.every((d) => d.severity !== 'error')).toBe(true);
  });

  it('未知 style 发一次 warning 且仍按模式 A 切分（§12.6.5）', () => {
    const { lines, diagnostics } = lex(
      'V:1 style=hexagram\nK:C\n[V:1]\nCDEF|\n[V:1]\nGABc|\n',
    );
    expect(bodyModes(lines)).toEqual(['pitch', 'pitch']);
    const unknown = diagnostics.filter((d) => d.code === 'jcx.voice.unknown-style');
    // 去重：同一声部重复切换只发一次，避免交替式文件刷屏。
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.severity).toBe('warning');
  });

  it('style 缺省不发 unknown-style diagnostic', () => {
    const { diagnostics } = lex('V:1\nK:C\n[V:1]\nCDEF|\n');
    expect(codes(diagnostics)).not.toContain('jcx.voice.unknown-style');
  });

  it('bodyLine 事件只查询、不改状态', () => {
    const prescan = prescanVoices('V:1 style=tab\n');
    const bag = createDiagnosticBag();
    const state = createModeState();
    expect(resolveMode(state, prescan, { type: 'bodyLine' }, bag)).toBe('pitch');
    resolveMode(state, prescan, { type: 'inlineVoice', id: '1', span: ZERO_SPAN }, bag);
    expect(resolveMode(state, prescan, { type: 'bodyLine' }, bag)).toBe('tab');
    expect(state.currentVoiceId).toBe('1');
  });
});

describe('§11.3 文本块不得干扰 §9.4 顺序推进（P1-1 回归）', () => {
  const source = [
    'K:C',
    'V:1 style=staff',
    'CDEF|',
    '%%begintext',
    'V: 副歌',
    '%%endtext',
    'V:2 style=tab',
    'a0 b2*2|',
    '',
  ].join('\n');

  it('块内 `V: 副歌` 既不进声明表，也不推进段落', () => {
    const { lines, diagnostics } = lex(source);
    // 若块内那行被误当成声明，第 2 段会错位到它身上而切不到 tab。
    expect(bodyModes(lines)).toEqual(['pitch', 'tab']);
    expect(diagnostics.filter((d) => d.code === 'jcx.voice.segment-by-order')).toHaveLength(2);
  });

  it('块内容行仍按 textBlockContent 分类', () => {
    const { lines } = lex(source);
    expect(lines.filter((line) => line.kind === 'textBlockContent')).toHaveLength(1);
  });
});

describe('resolveMode —— §9.4 无 inline field 时按声明顺序推进段落', () => {
  const source = [
    'K:C',
    'V:1 style=staff',
    'CDEF|',
    'V:2 style=tab',
    'a0 b2*2|',
    'V:3 style=staff',
    'GABc|',
    '',
  ].join('\n');

  it('第 k 段正文对应第 k 个声明的声部', () => {
    const { lines } = lex(source);
    expect(bodyModes(lines)).toEqual(['pitch', 'tab', 'pitch']);
  });

  it('每次推进都发 info 级 jcx.voice.segment-by-order', () => {
    const { diagnostics } = lex(source);
    const segment = diagnostics.filter((d) => d.code === 'jcx.voice.segment-by-order');
    expect(segment).toHaveLength(3);
    expect(segment.every((d) => d.severity === 'info')).toBe(true);
  });

  it('header 区（`K:` 之前）的 V: 声明不推进段落（§6.2）', () => {
    const { diagnostics } = lex('V:1 style=tab\nV:2 style=staff\nK:C\nCDEF|\n');
    expect(codes(diagnostics)).not.toContain('jcx.voice.segment-by-order');
  });

  it('文件用了 `[V:...]` 时不启用顺序推进', () => {
    const { diagnostics, lines } = lex(
      'V:1 style=staff\nV:2 style=tab\nK:C\n[V:1]\nCDEF|\nV:2\nGABc|\n',
    );
    expect(codes(diagnostics)).not.toContain('jcx.voice.segment-by-order');
    // 仍停留在 `[V:1]` 选定的 pitch 模式。
    expect(bodyModes(lines)).toEqual(['pitch', 'pitch']);
  });
});

describe('`[V:n]` 同行余下正文（§9.2 / 方案 §3 第 7 条）', () => {
  const source = 'V:1 style=tab\nK:C\n[V:1] a0 b2*2|\n';

  it('余下正文按新模式切分，不再是 raw 占位', () => {
    const { lines } = lex(source);
    const inline = lines.find((line) => line.kind === 'inlineField');
    expect(inline).toBeDefined();
    const kinds = (inline?.tokens ?? []).map((token) => token.kind);
    expect(kinds).toContain('stringLetter');
    expect(kinds).toContain('fret');
    expect(kinds).toContain('tabDurSep');
    expect(kinds).toContain('barline');
  });

  it('发 info 级 jcx.inline-field.trailing-body', () => {
    const { diagnostics } = lex(source);
    const trailing = diagnostics.filter((d) => d.code === 'jcx.inline-field.trailing-body');
    expect(trailing).toHaveLength(1);
    expect(trailing[0]?.severity).toBe('info');
  });

  it('同行正文仍满足逐行无损不变量', () => {
    const { lines } = lex(source);
    for (const line of lines) {
      expect(rawOf(line.tokens)).toBe(
        source.slice(line.span.start.offset, line.span.end.offset),
      );
    }
  });
});

describe('diagnostic span 精确指向引发它的 token（P2-1）', () => {
  function spanTextOf(source: string, code: string): string | undefined {
    const { diagnostics } = lex(source);
    const hit = diagnostics.find((d) => d.code === code);
    return hit === undefined
      ? undefined
      : source.slice(hit.span.start.offset, hit.span.end.offset);
  }

  it('jcx.voice.unknown-style → style 属性值本身', () => {
    expect(
      spanTextOf('V:1 style=hexagram\nK:C\n[V:1]\nCDEF|\n', 'jcx.voice.unknown-style'),
    ).toBe('hexagram');
  });

  it('jcx.voice.unknown-style → 引号值不含引号', () => {
    expect(
      spanTextOf('V:1 style="hexagram"\nK:C\n[V:1]\nCDEF|\n', 'jcx.voice.unknown-style'),
    ).toBe('hexagram');
  });

  it('jcx.voice.segment-by-order → 该 V: 行的 fieldKey token', () => {
    expect(
      spanTextOf('K:C\nV:1 style=staff\nCDEF|\n', 'jcx.voice.segment-by-order'),
    ).toBe('V');
  });

  it('jcx.field.unknown → 未知字段的 fieldKey token', () => {
    expect(spanTextOf('Z:whatever\n', 'jcx.field.unknown')).toBe('Z');
  });

  it('jcx.inline-field.odd-whitespace → 异常空白 token 本身', () => {
    expect(spanTextOf('[ V:1]\n', 'jcx.inline-field.odd-whitespace')).toBe(' ');
    expect(spanTextOf('[V :1]\n', 'jcx.inline-field.odd-whitespace')).toBe(' ');
  });

  it('jcx.inline-field.trailing-body → 余下正文本身', () => {
    expect(spanTextOf('[V:1] ABCD|\n', 'jcx.inline-field.trailing-body')).toBe(' ABCD|');
  });
});

describe('lexJcx —— 对外入口（方案 §1 / §5）', () => {
  it('字符串输入：encoding 缺省 utf-8，行/诊断齐备', () => {
    const text = 'X:1\nK:C\nCDEF|\n';
    const result = lexJcx(text);
    expect(result.encoding).toBe('utf-8');
    expect(result.hasBom).toBe(false);
    expect(result.hasTrailingNewline).toBe(true);
    expect(rawOf(flattenTokens([...result.lines]))).toBe(text);
  });

  it('字符串输入：opts.encoding 覆盖来源标注', () => {
    expect(lexJcx('K:C\n', { encoding: 'gb18030' }).encoding).toBe('gb18030');
  });

  it('字节输入：走 decodeJcx 检测编码', () => {
    const bytes = new TextEncoder().encode('X:1\nK:C\nCDEF|');
    const result = lexJcx(bytes);
    expect(result.encoding).toBe('utf-8');
    expect(result.hasTrailingNewline).toBe(false);
  });

  it('字节输入：GB18030 fixture 被识别为 gb18030', () => {
    const bytes = readFileSync(resolve(FIXTURES_DIR, 'encoding/encoding-gb18030.jcx'));
    expect(lexJcx(new Uint8Array(bytes)).encoding).toBe('gb18030');
  });

  it('BOM：hasBom 为 true 且 BOM 以 token 形式保留（§5.5）', () => {
    const bytes = readFileSync(resolve(FIXTURES_DIR, 'encoding/encoding-bom.jcx'));
    const result = lexJcx(new Uint8Array(bytes));
    expect(result.hasBom).toBe(true);
    expect(result.lines[0]?.tokens[0]?.kind).toBe('bom');
  });

  it('末尾无换行：hasTrailingNewline 为 false', () => {
    const bytes = readFileSync(resolve(FIXTURES_DIR, 'no-trailing-newline.jcx'));
    expect(lexJcx(new Uint8Array(bytes)).hasTrailingNewline).toBe(false);
  });

  it('永不抛异常：畸形输入降级为 token + diagnostic', () => {
    expect(() => lexJcx('')).not.toThrow();
    expect(() => lexJcx('[V:\n%%\n?:\n\u00ff\u00ff')).not.toThrow();
    expect(lexJcx('[V:\n%%\n?:').diagnostics.every((d) => d.severity !== 'error')).toBe(true);
  });

  it('4 个 T7 fixture 端到端：模式判定正确且无 error 级', () => {
    const expected: ReadonlyArray<readonly [string, readonly string[]]> = [
      // K: 已在 header 末尾（§6.2），三条 V: 全在 header 区。
      ['voice.jcx', ['pitch']],
      ['inline-voice.jcx', ['pitch', 'tab', 'pitch']],
      ['inline-voice-spaced.jcx', []],
      ['voice-unknown-style.jcx', ['pitch']],
    ];
    for (const [name, modes] of expected) {
      const bytes = readFileSync(resolve(FIXTURES_DIR, name));
      const result = lexJcx(new Uint8Array(bytes));
      expect(bodyModes(result.lines), name).toEqual([...modes]);
      expect(result.diagnostics.filter((d) => d.severity === 'error'), name).toEqual([]);
    }
  });

  it('voice.jcx：V: 均在 header 区，不触发 §9.4 顺序推进', () => {
    const bytes = readFileSync(resolve(FIXTURES_DIR, 'voice.jcx'));
    const result = lexJcx(new Uint8Array(bytes));
    expect(codes(result.diagnostics)).not.toContain('jcx.voice.segment-by-order');
  });

  it('inline-voice-spaced.jcx：正文全部挂在 inlineField 行上并按各自模式切分', () => {
    const bytes = readFileSync(resolve(FIXTURES_DIR, 'inline-voice-spaced.jcx'));
    const result = lexJcx(new Uint8Array(bytes));
    const inlineLines = result.lines.filter((line) => line.kind === 'inlineField');
    expect(inlineLines).toHaveLength(2);
    expect(inlineLines[0]?.tokens.map((t) => t.kind)).toContain('pitchLetter');
    expect(inlineLines[1]?.tokens.map((t) => t.kind)).toContain('stringLetter');
  });
});
