import { describe, expect, it } from 'vitest';
import { lexBodyPitch } from '../../../src/formats/jcx/lexer/lexBodyPitch';
import { rawOf } from '../../../src/formats/jcx/lexer/token';
import type { JcxToken } from '../../../src/formats/jcx/lexer/token';
import { createDiagnosticBag } from '../../../src/formats/jcx/lexer/diagnostics';
import type { SourcePosition } from '../../../src/formats/jcx/lexer/sourceSpan';

/**
 * 模式 A（pitch）正文词法器测试（方案 §7 T5）。
 *
 * 每个用例都必须同时满足两条不变量（§29.3 / §29.5）：
 * ① `rawOf(tokens) === input`；② 每个 token 的 `raw === input.slice(span)`。
 * 这两条由 `lex()` 统一断言，任何用例都无法绕过。
 */
const BASE: SourcePosition = { offset: 0, line: 1, column: 0 };

interface LexRun {
  readonly tokens: readonly JcxToken[];
  readonly codes: readonly string[];
}

function lex(input: string): LexRun {
  const bag = createDiagnosticBag();
  const tokens = lexBodyPitch(input, BASE, bag);

  // 不变量①：无损拼接。
  expect(rawOf(tokens)).toBe(input);
  // 不变量②：span 与 raw 自洽。
  for (const token of tokens) {
    expect(token.raw).toBe(input.slice(token.span.start.offset, token.span.end.offset));
    expect(token.span.end.offset - token.span.start.offset).toBe(token.raw.length);
  }

  return { tokens, codes: bag.list().map((d) => d.code) };
}

function pairs(input: string): [string, string][] {
  return lex(input).tokens.map((t) => [t.kind, t.raw]);
}

function kinds(input: string): string[] {
  return lex(input).tokens.map((t) => t.kind);
}

describe('§13.4 whitespace', () => {
  it('空格独立成 token 且不 collapse（连梁语义）', () => {
    expect(pairs('C D')).toEqual([
      ['pitchLetter', 'C'],
      ['whitespace', ' '],
      ['pitchLetter', 'D'],
    ]);
  });

  it('连续空格与 Tab 合并为一个 whitespace token，原文完整保留', () => {
    expect(pairs('C \t  D')).toEqual([
      ['pitchLetter', 'C'],
      ['whitespace', ' \t  '],
      ['pitchLetter', 'D'],
    ]);
  });
});

describe('§17 accidental', () => {
  it('^^ 最长匹配，不切成两个 ^', () => {
    expect(pairs('^^C')).toEqual([
      ['accidental', '^^'],
      ['pitchLetter', 'C'],
    ]);
  });

  it('__ 同样最长匹配（语料零覆盖路径）', () => {
    expect(pairs('__E')).toEqual([
      ['accidental', '__'],
      ['pitchLetter', 'E'],
    ]);
  });

  it('_ 降号 + 八度修饰', () => {
    expect(pairs('_B,')).toEqual([
      ['accidental', '_'],
      ['pitchLetter', 'B'],
      ['octaveMark', ','],
    ]);
  });

  it('= 还原号 + 升八度撇号', () => {
    expect(pairs("=c'")).toEqual([
      ['accidental', '='],
      ['pitchLetter', 'c'],
      ['octaveMark', "'"],
    ]);
  });
});

describe('§14.1 / §14.2 pitchLetter 与 octaveMark', () => {
  it('大小写字母均为 pitchLetter，逐字符切分', () => {
    expect(kinds('CDEFGABcdefgab')).toEqual(Array.from({ length: 14 }, () => 'pitchLetter'));
  });

  it('连续 , / \' 串整体一个 octaveMark token', () => {
    expect(pairs('F,,,')).toEqual([
      ['pitchLetter', 'F'],
      ['octaveMark', ',,,'],
    ]);
  });

  it("c'' 双撇号也是一个 token", () => {
    expect(pairs("c''")).toEqual([
      ['pitchLetter', 'c'],
      ['octaveMark', "''"],
    ]);
  });
});

describe('§16.1 duration', () => {
  it('整数倍数与 N/N 分数', () => {
    expect(pairs('G8')).toEqual([
      ['pitchLetter', 'G'],
      ['duration', '8'],
    ]);
    expect(pairs('A3/2')).toEqual([
      ['pitchLetter', 'A'],
      ['duration', '3/2'],
    ]);
  });

  it('/ 与 // 简写，// 最长匹配优先于 /', () => {
    expect(pairs('d/')).toEqual([
      ['pitchLetter', 'd'],
      ['duration', '/'],
    ]);
    expect(pairs('d//')).toEqual([
      ['pitchLetter', 'd'],
      ['duration', '//'],
    ]);
    expect(pairs('c/2')).toEqual([
      ['pitchLetter', 'c'],
      ['duration', '/2'],
    ]);
  });
});

describe('§16.2 brokenRhythm', () => {
  it('>> 最长匹配（不切成两个 >）', () => {
    expect(pairs('A>>B')).toEqual([
      ['pitchLetter', 'A'],
      ['brokenRhythm', '>>'],
      ['pitchLetter', 'B'],
    ]);
  });

  it('< 与 <<< 同样识别（语料零覆盖路径）', () => {
    expect(pairs('A<B')).toEqual([
      ['pitchLetter', 'A'],
      ['brokenRhythm', '<'],
      ['pitchLetter', 'B'],
    ]);
    expect(pairs('A<<<B')).toEqual([
      ['pitchLetter', 'A'],
      ['brokenRhythm', '<<<'],
      ['pitchLetter', 'B'],
    ]);
  });
});

describe('§15 rest / hiddenRest', () => {
  it('z 带时值，letter 字段记录原字母', () => {
    const run = lex('z2');
    expect(run.tokens[0]).toMatchObject({ kind: 'rest', raw: 'z', letter: 'z' });
    expect(run.tokens[1]).toMatchObject({ kind: 'duration', raw: '2' });
    expect(run.codes).toEqual([]);
  });

  it('z/ 与 z3/2 的时值形态', () => {
    expect(pairs('z/')).toEqual([
      ['rest', 'z'],
      ['duration', '/'],
    ]);
    expect(pairs('z3/2')).toEqual([
      ['rest', 'z'],
      ['duration', '3/2'],
    ]);
  });

  it('Z 不与 z 合并，且发 info（§15.2 语义 UNVERIFIED）', () => {
    const run = lex('Z');
    expect(run.tokens[0]).toMatchObject({ kind: 'rest', raw: 'Z', letter: 'Z' });
    expect(run.codes).toEqual(['jcx.rest.uppercase-z']);
  });

  it('ZD/E/ 中 Z 后紧跟音符，不吞并后续（禁 ABC 多小节休止语义）', () => {
    expect(pairs('ZD/E/')).toEqual([
      ['rest', 'Z'],
      ['pitchLetter', 'D'],
      ['duration', '/'],
      ['pitchLetter', 'E'],
      ['duration', '/'],
    ]);
  });

  it('@ 作隐藏休止符并发 info', () => {
    const run = lex('@');
    expect(run.tokens.map((t) => t.kind)).toEqual(['hiddenRest']);
    expect(run.codes).toEqual(['jcx.rest.hidden']);
  });

  it('@2 隐藏休止符带时值', () => {
    expect(pairs('@2')).toEqual([
      ['hiddenRest', '@'],
      ['duration', '2'],
    ]);
  });
});

describe('§18 barline 最长匹配', () => {
  it('|] || |: :| :: 各自整体匹配', () => {
    expect(pairs('|]')).toEqual([['barline', '|]']]);
    expect(pairs('||')).toEqual([['barline', '||']]);
    expect(pairs('|:')).toEqual([['barline', '|:']]);
    expect(pairs(':|')).toEqual([['barline', ':|']]);
    expect(pairs('::')).toEqual([['barline', '::']]);
  });

  it('[| [:] [|] 以 [ 开头的形态先于 chordOpen 匹配', () => {
    expect(pairs('[|')).toEqual([['barline', '[|']]);
    expect(pairs('[:]')).toEqual([['barline', '[:]']]);
    expect(pairs('[|]')).toEqual([['barline', '[|]']]);
  });

  it('|] 不会被切成 | + ]（否则 ] 会与和弦块闭括号混淆）', () => {
    expect(pairs('CD|]')).toEqual([
      ['pitchLetter', 'C'],
      ['pitchLetter', 'D'],
      ['barline', '|]'],
    ]);
  });

  it('普通 | 在非最长形态处仍单独成 token', () => {
    expect(pairs('C|D')).toEqual([
      ['pitchLetter', 'C'],
      ['barline', '|'],
      ['pitchLetter', 'D'],
    ]);
  });
});

describe('§19.2 / §20 / §14.4 / §22.2 「[ 与 ( 后是否紧跟数字」消歧', () => {
  it('[1 / [2 是跳房子段号', () => {
    expect(pairs('[1')).toEqual([['repeatEnding', '[1']]);
    expect(pairs('|:CD:|[2EF')).toEqual([
      ['barline', '|:'],
      ['pitchLetter', 'C'],
      ['pitchLetter', 'D'],
      ['barline', ':|'],
      ['repeatEnding', '[2'],
      ['pitchLetter', 'E'],
      ['pitchLetter', 'F'],
    ]);
  });

  it('[CEG] 是和弦块而不是跳房子', () => {
    expect(pairs('[CEG]')).toEqual([
      ['chordOpen', '['],
      ['pitchLetter', 'C'],
      ['pitchLetter', 'E'],
      ['pitchLetter', 'G'],
      ['chordClose', ']'],
    ]);
  });

  it('D[CEG]E：音符紧邻和弦块（pitch-chord-adjacent 回归）', () => {
    expect(kinds('D[CEG]E')).toEqual([
      'pitchLetter',
      'chordOpen',
      'pitchLetter',
      'pitchLetter',
      'pitchLetter',
      'chordClose',
      'pitchLetter',
    ]);
  });

  it('(3 是 tuplet，( 是 slur', () => {
    expect(pairs('(3CDE')).toEqual([
      ['tupletStart', '(3'],
      ['pitchLetter', 'C'],
      ['pitchLetter', 'D'],
      ['pitchLetter', 'E'],
    ]);
    expect(pairs('(CDE)')).toEqual([
      ['slurOpen', '('],
      ['pitchLetter', 'C'],
      ['pitchLetter', 'D'],
      ['pitchLetter', 'E'],
      ['slurClose', ')'],
    ]);
  });

  it('(p:q:r 一般式整体一个 tupletStart，闭合 ) 归 slurClose（§20 grammar 无闭括号）', () => {
    expect(pairs('(3:2:3)')).toEqual([
      ['tupletStart', '(3:2:3'],
      ['slurClose', ')'],
    ]);
    expect(pairs('(3:0:3')).toEqual([['tupletStart', '(3:0:3']]);
  });
});

describe('§22.1 tie', () => {
  it('C-C 中的 - 是 tie', () => {
    expect(pairs('C-C')).toEqual([
      ['pitchLetter', 'C'],
      ['tie', '-'],
      ['pitchLetter', 'C'],
    ]);
  });

  it('和弦块内的 tie：[C/2-C/2]', () => {
    expect(kinds('[C/2-C/2]')).toEqual([
      'chordOpen',
      'pitchLetter',
      'duration',
      'tie',
      'pitchLetter',
      'duration',
      'chordClose',
    ]);
  });
});

describe('§21 grace notes', () => {
  it('{...} 前倚音', () => {
    expect(pairs('{G}A')).toEqual([
      ['graceOpen', '{'],
      ['pitchLetter', 'G'],
      ['graceClose', '}'],
      ['pitchLetter', 'A'],
    ]);
  });

  it('{@ 后倚音整体一个 graceOpen，内部 @ 不会被误判为隐藏休止符', () => {
    const run = lex('{@d}e');
    expect(run.tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['graceOpen', '{@'],
      ['pitchLetter', 'd'],
      ['graceClose', '}'],
      ['pitchLetter', 'e'],
    ]);
    expect(run.codes).toEqual([]);
  });
});

describe('§23 decorations', () => {
  it('!st! 简单记号', () => {
    expect(pairs('!st!C')).toEqual([
      ['decorationSimple', '!st!'],
      ['pitchLetter', 'C'],
    ]);
  });

  it('!st!!st! 相邻：两个独立记号，中间不产生空 token', () => {
    expect(pairs('!st!!st!')).toEqual([
      ['decorationSimple', '!st!'],
      ['decorationSimple', '!st!'],
    ]);
  });

  it('§23.1 误判防护：(!st!E!st!D 中的 !E! 不存在，E 是音符', () => {
    expect(pairs('(!st!E!st!D |')).toEqual([
      ['slurOpen', '('],
      ['decorationSimple', '!st!'],
      ['pitchLetter', 'E'],
      ['decorationSimple', '!st!'],
      ['pitchLetter', 'D'],
      ['whitespace', ' '],
      ['barline', '|'],
    ]);
  });

  it('§23.2 复合记号整体一个 token，parts 做 best-effort 拆解', () => {
    const run = lex("!@x'3'@y'2'$f'1'$s'12'xyz!");
    expect(run.tokens).toHaveLength(1);
    expect(run.tokens[0]).toMatchObject({
      kind: 'decorationComplex',
      raw: "!@x'3'@y'2'$f'1'$s'12'xyz!",
      parts: ["@x'3'", "@y'2'", "$f'1'", "$s'12'", 'xyz'],
    });
  });

  it('§23.2 转义载荷形态，内部 $ / \\ / 数字不进入正文 token 流', () => {
    const input = "!$f'Maestro'$s'40'\\070!";
    const run = lex(input);
    expect(run.tokens).toHaveLength(1);
    expect(run.tokens[0]).toMatchObject({
      kind: 'decorationComplex',
      parts: ["$f'Maestro'", "$s'40'", '\\070'],
    });
    expect(run.codes).toEqual([]);
  });

  it('复合记号相邻时同样从左向右成对匹配', () => {
    expect(kinds("!@y'10'$f'SimSun'$s'15'A!F!@y'10'$f'SimSun'$s'15'B!")).toEqual([
      'decorationComplex',
      'pitchLetter',
      'decorationComplex',
    ]);
  });

  it('无闭合 ! 时降级为 raw，不吞到行尾', () => {
    const run = lex('!st');
    // `s` / `t` 都不是 §14.1 的音高字母，连续未知字母合并为一个最短可疑片段。
    expect(run.tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['raw', '!'],
      ['raw', 'st'],
    ]);
    expect(run.codes).toEqual(['jcx.body.unknown-token', 'jcx.body.unknown-token']);
  });
});

describe('§25 chord symbols', () => {
  it('"Am" 普通和弦符号', () => {
    expect(pairs('"Am"CDEF')).toEqual([
      ['chordSymbol', '"Am"'],
      ['pitchLetter', 'C'],
      ['pitchLetter', 'D'],
      ['pitchLetter', 'E'],
      ['pitchLetter', 'F'],
    ]);
  });

  it('"^text" 的 ^ 前缀与内部文字不进入正文 token 流', () => {
    expect(pairs('"^text"C')).toEqual([
      ['chordSymbol', '"^text"'],
      ['pitchLetter', 'C'],
    ]);
  });

  it('"" 空引号是独立占位 token（§25.2），不得丢弃', () => {
    expect(pairs('""C')).toEqual([
      ['chordSymbol', '""'],
      ['pitchLetter', 'C'],
    ]);
  });

  it('"D/#F" 斜杠低音整体一个 token', () => {
    expect(pairs('"D/#F"')).toEqual([['chordSymbol', '"D/#F"']]);
  });

  it('无闭合引号时降级为 raw', () => {
    const run = lex('"Am');
    expect(run.tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['raw', '"'],
      ['pitchLetter', 'A'],
      ['raw', 'm'],
    ]);
    expect(run.codes).toEqual(['jcx.body.unknown-token', 'jcx.body.unknown-token']);
  });
});

describe('§29.3 未知 token 兜底', () => {
  it('# 得到 raw + warning，且不中止整行', () => {
    const run = lex('CD#EF');
    expect(run.tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['pitchLetter', 'C'],
      ['pitchLetter', 'D'],
      ['raw', '#'],
      ['pitchLetter', 'E'],
      ['pitchLetter', 'F'],
    ]);
    expect(run.codes).toEqual(['jcx.body.unknown-token']);
  });

  it('连续同类未知字符合并为一个最短可疑片段', () => {
    expect(pairs('C##D')).toEqual([
      ['pitchLetter', 'C'],
      ['raw', '##'],
      ['pitchLetter', 'D'],
    ]);
  });

  it('不同类未知字符分别切出，各发一条 warning', () => {
    const run = lex('#?');
    expect(run.tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['raw', '#'],
      ['raw', '?'],
    ]);
    expect(run.codes).toEqual(['jcx.body.unknown-token', 'jcx.body.unknown-token']);
  });

  it('孤立 : 不匹配任何小节线形态，降级为 raw 且不死循环', () => {
    const run = lex('C:D');
    expect(run.tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['pitchLetter', 'C'],
      ['raw', ':'],
      ['pitchLetter', 'D'],
    ]);
  });

  it('中文等非 ASCII 字母成串切出一个 raw', () => {
    expect(pairs('C测试D')).toEqual([
      ['pitchLetter', 'C'],
      ['raw', '测试'],
      ['pitchLetter', 'D'],
    ]);
  });
});

describe('永不抛异常', () => {
  const inputs = [
    '',
    '!',
    '"',
    '{',
    '}',
    '(',
    ')',
    '[',
    ']',
    ':',
    '::::',
    '!!!',
    '""""',
    '@@@',
    '///',
    '<<<<',
    "!@x'",
    '\r',
  ];

  it.each(inputs)('lexBodyPitch(%j) 不抛异常且满足无损不变量', (input) => {
    expect(() => lex(input)).not.toThrow();
  });
});
