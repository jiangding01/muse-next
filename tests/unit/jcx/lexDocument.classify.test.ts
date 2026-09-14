import { describe, expect, it } from 'vitest';
import {
  KNOWN_DIRECTIVE_NAMES,
  KNOWN_FIELD_KEYS,
  lexDocument,
} from '../../../src/formats/jcx/lexer/lexDocument';
import { rawOf } from '../../../src/formats/jcx/lexer/token';
import type { JcxLexLine } from '../../../src/formats/jcx/lexer/token';
import { createDiagnosticBag } from '../../../src/formats/jcx/lexer/diagnostics';
import type { JcxDiagnostic } from '../../../src/formats/jcx/lexer/diagnostics';

interface LexRun {
  readonly lines: JcxLexLine[];
  readonly diagnostics: readonly JcxDiagnostic[];
}

function run(text: string): LexRun {
  const bag = createDiagnosticBag();
  const lines = lexDocument(text, bag);
  // §29.5 逐行不变式：任何用例都必须顺带满足，避免分类逻辑偷偷吞字符。
  for (const line of lines) {
    expect(rawOf(line.tokens)).toBe(
      text.slice(line.span.start.offset, line.span.end.offset),
    );
  }
  return { lines, diagnostics: bag.list() };
}

function pairs(line: JcxLexLine | undefined): [string, string][] {
  return (line?.tokens ?? []).map((t) => [t.kind, t.raw]);
}

function codes(result: LexRun): string[] {
  return result.diagnostics.map((d) => d.code);
}

describe('已知集合常量', () => {
  it('§8：已知字段字母恰好 10 个', () => {
    expect(KNOWN_FIELD_KEYS).toHaveLength(10);
    expect([...KNOWN_FIELD_KEYS].sort()).toEqual(
      ['C', 'I', 'K', 'L', 'M', 'Q', 'T', 'V', 'X', 'w'].sort(),
    );
  });

  it('§10 + §10.7：已知指令名含语料 6 个与 DOC-ONLY 清单，且无重复', () => {
    for (const name of ['gchord', 'showfinger', 'begintext', 'endtext', 'skip', 'indent']) {
      expect(KNOWN_DIRECTIVE_NAMES).toContain(name);
    }
    expect(KNOWN_DIRECTIVE_NAMES).toContain('continueall');
    expect(KNOWN_DIRECTIVE_NAMES).toContain('jpbeamspace');
    expect(new Set(KNOWN_DIRECTIVE_NAMES).size).toBe(KNOWN_DIRECTIVE_NAMES.length);
  });
});

describe('§5.4 空行', () => {
  it('完全空的行与纯空白行都是 blank', () => {
    const result = run('\n \t \n');
    expect(result.lines.map((l) => l.kind)).toEqual(['blank', 'blank']);
    expect(pairs(result.lines[1])).toEqual([
      ['whitespace', ' \t '],
      ['eol', '\n'],
    ]);
  });

  it('blank 行不产生任何 diagnostic', () => {
    expect(codes(run('\n\n\n'))).toEqual([]);
  });
});

describe('§7 magic header', () => {
  it('首行整行 %MUSE2 是 magicHeader', () => {
    const result = run('%MUSE2\n');
    expect(result.lines[0]?.kind).toBe('magicHeader');
    expect(pairs(result.lines[0])).toEqual([
      ['magicHeader', '%MUSE2'],
      ['eol', '\n'],
    ]);
  });

  it('§7.4：其他版本串同样识别为 magicHeader', () => {
    const result = run('%MUSE3\n');
    expect(result.lines[0]?.kind).toBe('magicHeader');
  });

  it('§7.3：出现在非首行的 %MUSE2 退化为普通注释', () => {
    const result = run('X:1\n%MUSE2\n');
    expect(result.lines.map((l) => l.kind)).toEqual(['field', 'comment']);
    expect(pairs(result.lines[1])).toEqual([
      ['comment', '%MUSE2'],
      ['eol', '\n'],
    ]);
  });

  it('§7.1：首行带尾随内容（非整行匹配）时不是 magic header', () => {
    const result = run('%MUSE2 extra\n');
    expect(result.lines[0]?.kind).toBe('comment');
  });

  it('§5.3：首行仅带行尾空白仍是 magic header，空白独立成 token', () => {
    const result = run('%MUSE2  \n');
    expect(pairs(result.lines[0])).toEqual([
      ['magicHeader', '%MUSE2'],
      ['whitespace', '  '],
      ['eol', '\n'],
    ]);
  });

  it('BOM 不占一行：BOM 后的首行仍可识别为 magic header', () => {
    const result = run('\uFEFF%MUSE2\n');
    expect(result.lines[0]?.kind).toBe('magicHeader');
    expect(pairs(result.lines[0])).toEqual([
      ['bom', '\uFEFF'],
      ['magicHeader', '%MUSE2'],
      ['eol', '\n'],
    ]);
  });
});

describe('§5.6 注释行', () => {
  it('空注释（整行仅一个 %）必须保留', () => {
    const result = run('X:1\n%\n');
    expect(result.lines[1]?.kind).toBe('comment');
    expect(pairs(result.lines[1])).toEqual([
      ['comment', '%'],
      ['eol', '\n'],
    ]);
  });

  it('实义注释整串保留到行尾（行尾空白也属于注释原文）', () => {
    const result = run('X:1\n% note here  \n');
    expect(pairs(result.lines[1])).toEqual([
      ['comment', '% note here  '],
      ['eol', '\n'],
    ]);
  });

  it('带前导空白的注释行仍是 comment，空白独立成 token', () => {
    const result = run('X:1\n   % note\n');
    expect(result.lines[1]?.kind).toBe('comment');
    expect(pairs(result.lines[1])).toEqual([
      ['whitespace', '   '],
      ['comment', '% note'],
      ['eol', '\n'],
    ]);
  });
});

describe('§5.7 / §10 指令行', () => {
  it('标准形态 %%skip 1cm：prefix + name + value', () => {
    const result = run('%%skip 1cm\n');
    expect(result.lines[0]?.kind).toBe('directive');
    expect(pairs(result.lines[0])).toEqual([
      ['directivePrefix', '%%'],
      ['directiveName', 'skip'],
      ['directiveValue', ' 1cm'],
      ['eol', '\n'],
    ]);
    expect(codes(result)).toEqual([]);
  });

  it('§10.1：%%gchord 的值整串不拆', () => {
    const result = run('%%gchord Em=1;0,2,2,0,0,0\n');
    const value = result.lines[0]?.tokens.find((t) => t.kind === 'directiveValue');
    expect(value?.raw).toBe(' Em=1;0,2,2,0,0,0');
    expect(codes(result)).toEqual([]);
  });

  it('§5.7 带空格变体：%% + whitespace + name 三个 token', () => {
    const result = run('%% continueall yes\n');
    expect(result.lines[0]?.kind).toBe('directive');
    expect(pairs(result.lines[0])).toEqual([
      ['directivePrefix', '%%'],
      ['whitespace', ' '],
      ['directiveName', 'continueall'],
      ['directiveValue', ' yes'],
      ['eol', '\n'],
    ]);
    // continueall 属 §10.7 DOC-ONLY 清单 → 不发未知指令 diagnostic。
    expect(codes(result)).toEqual([]);
  });

  it('%% 后用 Tab 分隔同样容忍', () => {
    const result = run('%%\tindent 2.5cm\n');
    expect(pairs(result.lines[0])).toEqual([
      ['directivePrefix', '%%'],
      ['whitespace', '\t'],
      ['directiveName', 'indent'],
      ['directiveValue', ' 2.5cm'],
      ['eol', '\n'],
    ]);
  });

  it('§29.2：未知指令名发 info 级 jcx.directive.unknown，仍完整保留', () => {
    const result = run('%%nosuchdirective 1cm\n');
    expect(result.lines[0]?.kind).toBe('directive');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'jcx.directive.unknown',
      severity: 'info',
    });
  });

  it('§10.7 清单内的指令（jp* 排版参数）不发 diagnostic', () => {
    expect(codes(run('%%jpbeamspace 0.5cm\n'))).toEqual([]);
  });

  it('裸 %% 行不崩，发未知指令 info', () => {
    const result = run('%%\n');
    expect(result.lines[0]?.kind).toBe('directive');
    expect(codes(result)).toEqual(['jcx.directive.unknown']);
  });
});

describe('§11 text block', () => {
  it('%%begintext / %%endtext 各自成行类别，中间内容为 textBlockContent', () => {
    const result = run('%%begintext\n      hello\n%%endtext\n');
    expect(result.lines.map((l) => l.kind)).toEqual([
      'textBlockBegin',
      'textBlockContent',
      'textBlockEnd',
    ]);
    expect(pairs(result.lines[0])).toEqual([
      ['textBlockBegin', '%%begintext'],
      ['eol', '\n'],
    ]);
    expect(codes(result)).toEqual([]);
  });

  it('§11.3-1：内容行禁止 trim，前导空白留在 textBlockContent 内', () => {
    const result = run('%%begintext\n      hello\n%%endtext\n');
    expect(pairs(result.lines[1])).toEqual([
      ['textBlockContent', '      hello'],
      ['eol', '\n'],
    ]);
  });

  it('§11.3-2 优先级：块内的 T: 行与 % 行都不再分类为 field / comment', () => {
    const result = run('%%begintext\nT: not a field\n% not a comment\n\n%%endtext\n');
    expect(result.lines.map((l) => l.kind)).toEqual([
      'textBlockBegin',
      'textBlockContent',
      'textBlockContent',
      'textBlockContent',
      'textBlockEnd',
    ]);
    expect(pairs(result.lines[1])).toEqual([
      ['textBlockContent', 'T: not a field'],
      ['eol', '\n'],
    ]);
    // 块内空行也是内容行，不降级为 blank。
    expect(result.lines[3]?.kind).toBe('textBlockContent');
    expect(codes(result)).toEqual([]);
  });

  it('§11.3-5：空块（两指令相邻）按零行内容处理', () => {
    const result = run('%%begintext\n%%endtext\n');
    expect(result.lines.map((l) => l.kind)).toEqual(['textBlockBegin', 'textBlockEnd']);
    expect(codes(result)).toEqual([]);
  });

  it('§11.3-4：EOF 未闭合发 warning 级 jcx.textblock.unterminated，不报错', () => {
    const result = run('%%begintext\nstill inside\n');
    expect(result.lines[1]?.kind).toBe('textBlockContent');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'jcx.textblock.unterminated',
      severity: 'warning',
    });
  });

  it('闭合后恢复正常分类', () => {
    const result = run('%%begintext\nx\n%%endtext\nT:Back\n');
    expect(result.lines[3]?.kind).toBe('field');
  });
});

describe('§8 字段行', () => {
  it('K:C —— 冒号后无空格', () => {
    const result = run('K:C\n');
    expect(result.lines[0]?.kind).toBe('field');
    expect(pairs(result.lines[0])).toEqual([
      ['fieldKey', 'K'],
      ['fieldColon', ':'],
      ['fieldValue', 'C'],
      ['eol', '\n'],
    ]);
    expect(result.lines[0]?.tokens[0]).toMatchObject({ kind: 'fieldKey', key: 'K' });
  });

  it('§5.8：body 中带 1 个前导空白的 L: 字段行仍是 field', () => {
    const result = run(' L: 1/4\n');
    expect(result.lines[0]?.kind).toBe('field');
    expect(pairs(result.lines[0])).toEqual([
      ['whitespace', ' '],
      ['fieldKey', 'L'],
      ['fieldColon', ':'],
      ['whitespace', ' '],
      ['fieldValue', '1/4'],
      ['eol', '\n'],
    ]);
  });

  it('§5.3：fieldValue 不含行尾空白，行尾空白独立成 token', () => {
    const result = run('T: Title  \n');
    expect(pairs(result.lines[0])).toEqual([
      ['fieldKey', 'T'],
      ['fieldColon', ':'],
      ['whitespace', ' '],
      ['fieldValue', 'Title'],
      ['whitespace', '  '],
      ['eol', '\n'],
    ]);
  });

  it('§5.6 反例：K:G % 1 sharps 的 % 落在 fieldValue 内，不切注释', () => {
    const result = run('K:G % 1 sharps\n');
    expect(result.lines[0]?.kind).toBe('field');
    expect(result.lines[0]?.tokens.some((t) => t.kind === 'comment')).toBe(false);
    const value = result.lines[0]?.tokens.find((t) => t.kind === 'fieldValue');
    expect(value?.raw).toBe('G % 1 sharps');
  });

  it('§8.10 / D3：w: 歌词行整串保留在 fieldValue，不切音节', () => {
    const result = run('w:la la la-la la\n');
    expect(pairs(result.lines[0])).toEqual([
      ['fieldKey', 'w'],
      ['fieldColon', ':'],
      ['fieldValue', 'la la la-la la'],
      ['eol', '\n'],
    ]);
  });

  it('空值字段（K: 后无内容）不崩', () => {
    const result = run('K:\n');
    expect(pairs(result.lines[0])).toEqual([
      ['fieldKey', 'K'],
      ['fieldColon', ':'],
      ['eol', '\n'],
    ]);
  });

  it('§29.1：未知字段字母发 warning 级 jcx.field.unknown，仍完整保留', () => {
    const result = run('S:source\nZ:transcriber\n');
    expect(result.lines.map((l) => l.kind)).toEqual(['field', 'field']);
    expect(codes(result)).toEqual(['jcx.field.unknown', 'jcx.field.unknown']);
    expect(result.diagnostics[0]?.severity).toBe('warning');
  });

  it('§8.0：大小写敏感 —— W: 与 w: 不同，W 属未知字段', () => {
    expect(codes(run('w:x\n'))).toEqual([]);
    expect(codes(run('W:x\n'))).toEqual(['jcx.field.unknown']);
  });

  it('§8.0 / §29.4：全角冒号行按未知行（raw）处理并发 diagnostic', () => {
    const result = run('T：Title\n');
    expect(result.lines[0]?.kind).toBe('raw');
    expect(pairs(result.lines[0])).toEqual([
      ['raw', 'T：Title'],
      ['eol', '\n'],
    ]);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'jcx.field.fullwidth-colon',
      severity: 'warning',
    });
  });
});

describe('§9 行首内联字段', () => {
  it('[V:1] —— 冒号后无空格，五个 token', () => {
    const result = run('[V:1]\n');
    expect(result.lines[0]?.kind).toBe('inlineField');
    expect(pairs(result.lines[0])).toEqual([
      ['inlineFieldOpen', '['],
      ['inlineFieldKey', 'V'],
      ['inlineFieldColon', ':'],
      ['inlineFieldValue', '1'],
      ['inlineFieldClose', ']'],
      ['eol', '\n'],
    ]);
    expect(codes(result)).toEqual([]);
  });

  it('§9.1：[V: 1] —— 冒号后空白独立成 token 且不发 diagnostic', () => {
    const result = run('[V: 1]\n');
    expect(pairs(result.lines[0])).toEqual([
      ['inlineFieldOpen', '['],
      ['inlineFieldKey', 'V'],
      ['inlineFieldColon', ':'],
      ['whitespace', ' '],
      ['inlineFieldValue', '1'],
      ['inlineFieldClose', ']'],
      ['eol', '\n'],
    ]);
    expect(codes(result)).toEqual([]);
  });

  it('§9.1：[ V:1] 异常空格仍按内联字段处理，发 odd-whitespace warning', () => {
    const result = run('[ V:1]\n');
    expect(result.lines[0]?.kind).toBe('inlineField');
    expect(pairs(result.lines[0])).toEqual([
      ['inlineFieldOpen', '['],
      ['whitespace', ' '],
      ['inlineFieldKey', 'V'],
      ['inlineFieldColon', ':'],
      ['inlineFieldValue', '1'],
      ['inlineFieldClose', ']'],
      ['eol', '\n'],
    ]);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'jcx.inline-field.odd-whitespace',
      severity: 'warning',
    });
  });

  it('§9.1：[V :1] 异常空格同样容忍并告警', () => {
    const result = run('[V :1]\n');
    expect(result.lines[0]?.kind).toBe('inlineField');
    expect(codes(result)).toEqual(['jcx.inline-field.odd-whitespace']);
  });

  it('§9.2：[V:1] ABCD| 同行跟随正文 —— 余下部分按当前模式切分并发 info', () => {
    const result = run('[V:1] ABCD|\n');
    expect(result.lines[0]?.kind).toBe('inlineField');
    // T7 起余下正文不再是 raw 占位，而是按 `[V:1]` 切换后的模式送 body lexer。
    expect(pairs(result.lines[0])).toEqual([
      ['inlineFieldOpen', '['],
      ['inlineFieldKey', 'V'],
      ['inlineFieldColon', ':'],
      ['inlineFieldValue', '1'],
      ['inlineFieldClose', ']'],
      ['whitespace', ' '],
      ['pitchLetter', 'A'],
      ['pitchLetter', 'B'],
      ['pitchLetter', 'C'],
      ['pitchLetter', 'D'],
      ['barline', '|'],
      ['eol', '\n'],
    ]);
    expect(result.diagnostics[0]).toMatchObject({
      code: 'jcx.inline-field.trailing-body',
      severity: 'info',
    });
  });

  it('§9.5：非 V 的内联字段同样按 inlineField 切分，语义留给 Parser', () => {
    const result = run('[K:C]\n');
    expect(result.lines[0]?.kind).toBe('inlineField');
    expect(result.lines[0]?.tokens[1]).toMatchObject({ kind: 'inlineFieldKey', key: 'K' });
  });

  it('§9.5 消歧：和弦块 [CEG] 不是内联字段，按正文行处理', () => {
    const result = run('[CEG]|\n');
    expect(result.lines[0]?.kind).toBe('body');
    expect(pairs(result.lines[0])).toEqual([
      ['chordOpen', '['],
      ['pitchLetter', 'C'],
      ['pitchLetter', 'E'],
      ['pitchLetter', 'G'],
      ['chordClose', ']'],
      ['barline', '|'],
      ['eol', '\n'],
    ]);
  });

  it('缺少闭合 ] 时不认作内联字段，降级为正文行', () => {
    const result = run('[V:1\n');
    expect(result.lines[0]?.kind).toBe('body');
    // T5 起正文按 pitch 模式细分：`V` 与 `:` 都不是已知 body token → raw + warning（§29.3）。
    expect(codes(result)).toEqual(['jcx.body.unknown-token', 'jcx.body.unknown-token']);
  });
});

describe('§13 正文行', () => {
  it('普通正文行按 pitch 模式逐 token 切分（T5）', () => {
    const result = run('CDEF|GABc|\n');
    expect(result.lines[0]?.kind).toBe('body');
    expect(result.lines[0]?.mode).toBe('pitch');
    expect(pairs(result.lines[0])?.map(([kind]) => kind)).toEqual([
      'pitchLetter',
      'pitchLetter',
      'pitchLetter',
      'pitchLetter',
      'barline',
      'pitchLetter',
      'pitchLetter',
      'pitchLetter',
      'pitchLetter',
      'barline',
      'eol',
    ]);
  });

  it('TAB 形态正文行在 T5 阶段一律按 pitch 模式处理（模式切换留给 T7）', () => {
    const result = run('a0*4b1*4|\n');
    expect(result.lines[0]?.kind).toBe('body');
    expect(result.lines[0]?.mode).toBe('pitch');
    // `*` 是 TAB 专有的时值分隔符（§26.5），pitch 模式下必然降级为 raw。
    expect(codes(result)).toEqual(['jcx.body.unknown-token', 'jcx.body.unknown-token']);
  });

  it('带前导/尾随空白的正文行，空白独立成 token', () => {
    const result = run('  z2  \n');
    expect(pairs(result.lines[0])).toEqual([
      ['whitespace', '  '],
      ['rest', 'z'],
      ['duration', '2'],
      ['whitespace', '  '],
      ['eol', '\n'],
    ]);
  });
});

describe('lexDocument 永不抛异常（§5 / 方案 §5）', () => {
  const inputs = [
    '',
    '\r',
    '\uFEFF',
    '%',
    '%%',
    '[',
    '[:',
    '[V:',
    ':',
    'T：',
    '%%begintext',
    '%%begintext\r\n%%endtext',
    'a\rb\nc',
  ];

  it.each(inputs)('输入 %j 不抛异常且满足全文不变式', (input) => {
    const bag = createDiagnosticBag();
    expect(() => lexDocument(input, bag)).not.toThrow();
    const lines = lexDocument(input, createDiagnosticBag());
    expect(lines.map((l) => rawOf(l.tokens)).join('')).toBe(input);
  });

  it('Lexer 阶段不产生 error 级 diagnostic', () => {
    const bag = createDiagnosticBag();
    lexDocument('%%nope 1\nS:x\n[ V:1]\nT：x\n%%begintext\nz\n', bag);
    expect(bag.hasSeverity('error')).toBe(false);
    expect(bag.list().length).toBeGreaterThan(0);
  });
});
