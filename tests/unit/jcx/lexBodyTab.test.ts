import { describe, expect, it } from 'vitest';
import { lexBodyTab } from '../../../src/formats/jcx/lexer/lexBodyTab';
import { lexBody } from '../../../src/formats/jcx/lexer/lexBody';
import { rawOf } from '../../../src/formats/jcx/lexer/token';
import type { JcxToken } from '../../../src/formats/jcx/lexer/token';
import { createDiagnosticBag } from '../../../src/formats/jcx/lexer/diagnostics';
import type { SourcePosition } from '../../../src/formats/jcx/lexer/sourceSpan';

/**
 * 模式 B（TAB）正文词法器测试（方案 §7 T6，规格 §26）。
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
  const tokens = lexBodyTab(input, BASE, bag);

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

describe('§26.2 弦号 stringLetter', () => {
  it('a–f 是弦号，每个字母独立成 token', () => {
    expect(pairs('a0 f0')).toEqual([
      ['stringLetter', 'a'],
      ['fret', '0'],
      ['whitespace', ' '],
      ['stringLetter', 'f'],
      ['fret', '0'],
    ]);
  });

  it('小写字母在 TAB 下不是音高：g 不是弦号，降级 raw', () => {
    expect(pairs('g1')).toEqual([
      ['raw', 'g'],
      ['raw', '1'],
    ]);
  });
});

describe('§26.3 品位 fret', () => {
  it('多位品位整体成一个 token（a10 是 10 品，不是 1 + 0）', () => {
    expect(pairs('a10')).toEqual([
      ['stringLetter', 'a'],
      ['fret', '10'],
    ]);
  });

  it('x 是「品位由和弦图决定的右手拨弦」，与数字品位同级', () => {
    expect(pairs('ax')).toEqual([
      ['stringLetter', 'a'],
      ['fret', 'x'],
    ]);
  });

  it('两位以上品位同样不拆（c24）', () => {
    expect(pairs('c24')).toEqual([
      ['stringLetter', 'c'],
      ['fret', '24'],
    ]);
  });
});

describe('§26.4 拨弦 / 扫弦前缀 strokePrefix', () => {
  it('B[ 是下琶音前缀（§2.4 C8 结论），不是弦号也不是音高', () => {
    expect(pairs('B[ax/bx/]')).toEqual([
      ['strokePrefix', 'B'],
      ['tabGroupOpen', '['],
      ['stringLetter', 'a'],
      ['fret', 'x'],
      ['tabDurSep', '/'],
      ['stringLetter', 'b'],
      ['fret', 'x'],
      ['tabDurSep', '/'],
      ['tabGroupClose', ']'],
    ]);
  });

  it('V[ 上扫弦：组内空白保留，品位数字不被当时值', () => {
    expect(pairs('V[a1 b2]')).toEqual([
      ['strokePrefix', 'V'],
      ['tabGroupOpen', '['],
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['whitespace', ' '],
      ['stringLetter', 'b'],
      ['fret', '2'],
      ['tabGroupClose', ']'],
    ]);
  });

  it('U[ 下扫弦', () => {
    expect(pairs('U[cx/dx/ex/]')).toEqual([
      ['strokePrefix', 'U'],
      ['tabGroupOpen', '['],
      ['stringLetter', 'c'],
      ['fret', 'x'],
      ['tabDurSep', '/'],
      ['stringLetter', 'd'],
      ['fret', 'x'],
      ['tabDurSep', '/'],
      ['stringLetter', 'e'],
      ['fret', 'x'],
      ['tabDurSep', '/'],
      ['tabGroupClose', ']'],
    ]);
  });

  it('前缀也可直接作用于单音（Ba1）', () => {
    expect(pairs('Ba1')).toEqual([
      ['strokePrefix', 'B'],
      ['stringLetter', 'a'],
      ['fret', '1'],
    ]);
  });

  it('D[ 在 TAB 模式下不是前缀：D 不在 §26.4 符号表内 → raw', () => {
    expect(pairs('D[a1]')).toEqual([
      ['raw', 'D'],
      ['tabGroupOpen', '['],
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['tabGroupClose', ']'],
    ]);
    expect(lex('D[a1]').codes).toEqual(['jcx.body.unknown-token']);
  });

  it('悬空前缀仍产出 strokePrefix，但发 info（§26.4 / I15）', () => {
    const run = lex('H |');
    expect(run.tokens.map((t) => t.kind)).toEqual(['strokePrefix', 'whitespace', 'barline']);
    expect(run.codes).toEqual(['jcx.tab.dangling-stroke-prefix']);
  });

  it("加重符号 ' 是前缀而非八度修饰（与模式 A 的分歧，§26.10）", () => {
    expect(pairs("'a1")).toEqual([
      ['strokePrefix', "'"],
      ['stringLetter', 'a'],
      ['fret', '1'],
    ]);
  });
});

describe('§26.5 TAB 时值 tabDurSep + duration', () => {
  it('a1*2：* 分隔品位与时值，2 是时值不是品位', () => {
    expect(pairs('a1*2')).toEqual([
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['tabDurSep', '*'],
      ['duration', '2'],
    ]);
  });

  it('a1/2：/ 分隔符同理', () => {
    expect(pairs('a1/2')).toEqual([
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['tabDurSep', '/'],
      ['duration', '2'],
    ]);
  });

  it('a1*3/2：附点形态的 N/N 时值整体成一个 duration', () => {
    expect(pairs('a1*3/2')).toEqual([
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['tabDurSep', '*'],
      ['duration', '3/2'],
    ]);
  });

  it('// 最长匹配优先于 /，且后面无数值时只产出分隔符', () => {
    expect(pairs('ax//bx//')).toEqual([
      ['stringLetter', 'a'],
      ['fret', 'x'],
      ['tabDurSep', '//'],
      ['stringLetter', 'b'],
      ['fret', 'x'],
      ['tabDurSep', '//'],
    ]);
  });
});

describe('§26.6 同弦相邻音关系标记 tabRelation', () => {
  it('-S- 先于 tie 匹配，绝不切成 - + S + -', () => {
    expect(pairs('a1-S-a3')).toEqual([
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['tabRelation', '-S-'],
      ['stringLetter', 'a'],
      ['fret', '3'],
    ]);
  });

  it('-H- 与 -P- 同理', () => {
    expect(kinds('b8-H-b9-P-b7')).toEqual([
      'stringLetter', 'fret', 'tabRelation',
      'stringLetter', 'fret', 'tabRelation',
      'stringLetter', 'fret',
    ]);
  });

  it('单独的 - 仍是 tie（§22.1）', () => {
    expect(pairs('a1-a1')).toEqual([
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['tie', '-'],
      ['stringLetter', 'a'],
      ['fret', '1'],
    ]);
  });

  it('未收录的 -X- 形态不猜语义：切成 tie + raw + tie', () => {
    expect(pairs('a1-Q-a1')).toEqual([
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['tie', '-'],
      ['raw', 'Q'],
      ['tie', '-'],
      ['stringLetter', 'a'],
      ['fret', '1'],
    ]);
  });
});

describe('§26.8 TAB 弦组 tabGroup', () => {
  it('[a1 b2 c3] 是同时拨响的多根弦', () => {
    expect(pairs('[a1 b2 c3]')).toEqual([
      ['tabGroupOpen', '['],
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['whitespace', ' '],
      ['stringLetter', 'b'],
      ['fret', '2'],
      ['whitespace', ' '],
      ['stringLetter', 'c'],
      ['fret', '3'],
      ['tabGroupClose', ']'],
    ]);
  });

  it('紧邻弦组的组间无空白也能切开', () => {
    expect(kinds('[a1][b2]')).toEqual([
      'tabGroupOpen', 'stringLetter', 'fret', 'tabGroupClose',
      'tabGroupOpen', 'stringLetter', 'fret', 'tabGroupClose',
    ]);
  });
});

describe('§26.7 / §21 TAB 装饰音 grace', () => {
  it('{a1} 外壳与内容分开，内容按 TAB 模式切', () => {
    expect(pairs('{a1}')).toEqual([
      ['graceOpen', '{'],
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['graceClose', '}'],
    ]);
  });

  it('装饰音内可内嵌关系标记（{b8-H-b9-P-}）', () => {
    expect(kinds('{b8-H-b9-P-}')).toEqual([
      'graceOpen',
      'stringLetter', 'fret', 'tabRelation',
      'stringLetter', 'fret', 'tabRelation',
      'graceClose',
    ]);
  });

  it('{@ 后倚音整体成一个 graceOpen（§21 grammar 与模式无关）', () => {
    expect(pairs('{@a1}')).toEqual([
      ['graceOpen', '{@'],
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['graceClose', '}'],
    ]);
  });
});

describe('§23 / §25 共享记号在 TAB 行中', () => {
  it('!st! 简单装饰整体一 token', () => {
    expect(pairs('!st!a1')).toEqual([
      ['decorationSimple', '!st!'],
      ['stringLetter', 'a'],
      ['fret', '1'],
    ]);
  });

  it('相邻简单装饰不跨越已闭合记号（§23.1 C6 回归）', () => {
    expect(pairs('!st!a1!st!')).toEqual([
      ['decorationSimple', '!st!'],
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['decorationSimple', '!st!'],
    ]);
  });

  it('复合装饰内部的 $ / \' / 字母不被当成 TAB token', () => {
    expect(pairs("!@y'10'$f'SimSun'$s'15'A!a1")).toEqual([
      ['decorationComplex', "!@y'10'$f'SimSun'$s'15'A!"],
      ['stringLetter', 'a'],
      ['fret', '1'],
    ]);
  });

  it('"C" 和弦符号在 TAB 行中整体一 token', () => {
    expect(pairs('"C"ax/')).toEqual([
      ['chordSymbol', '"C"'],
      ['stringLetter', 'a'],
      ['fret', 'x'],
      ['tabDurSep', '/'],
    ]);
  });

  it('"" 空和弦占位不被丢弃（§25.2）', () => {
    expect(pairs('""ax/')).toEqual([
      ['chordSymbol', '""'],
      ['stringLetter', 'a'],
      ['fret', 'x'],
      ['tabDurSep', '/'],
    ]);
  });
});

describe('§18 小节线', () => {
  it('| 单竖线', () => {
    expect(pairs('a1 |')).toEqual([
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['whitespace', ' '],
      ['barline', '|'],
    ]);
  });

  it('|] 最长匹配优先，不被拆成 | + tabGroupClose', () => {
    expect(pairs('a1|]')).toEqual([
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['barline', '|]'],
    ]);
  });

  it(':| 反复小节线优先于 tabGroup', () => {
    expect(pairs(':|a1')).toEqual([
      ['barline', ':|'],
      ['stringLetter', 'a'],
      ['fret', '1'],
    ]);
  });
});

describe('§26.9 TAB 声部中的共享构造（语料证据）', () => {
  it('z2：rest 切出，其后裸数字无定义 → raw（§26.5 时值必须用 * / 分隔）', () => {
    const run = lex('z2');
    expect(run.tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['rest', 'z'],
      ['raw', '2'],
    ]);
    expect(run.tokens[0]).toMatchObject({ kind: 'rest', letter: 'z' });
    expect(run.codes).toEqual(['jcx.body.unknown-token']);
  });

  it('z*2 / z/：TAB 休止的时值仍按 §26.5 用分隔符引出', () => {
    expect(pairs('z*2 z/')).toEqual([
      ['rest', 'z'],
      ['tabDurSep', '*'],
      ['duration', '2'],
      ['whitespace', ' '],
      ['rest', 'z'],
      ['tabDurSep', '/'],
    ]);
  });

  it('zzz：连续休止切成三个独立 rest，不合并语义', () => {
    expect(pairs('zzz')).toEqual([
      ['rest', 'z'],
      ['rest', 'z'],
      ['rest', 'z'],
    ]);
  });

  it('Z 在 TAB 下同样是 rest（附 info，§15.2）', () => {
    const run = lex('Z');
    expect(run.tokens[0]).toMatchObject({ kind: 'rest', letter: 'Z' });
    expect(run.codes).toEqual(['jcx.rest.uppercase-z']);
  });

  it('(3:0:3：三连音头整体成一个 tupletStart，不被切碎', () => {
    expect(pairs('(3:0:3a11a10a8')).toEqual([
      ['tupletStart', '(3:0:3'],
      ['stringLetter', 'a'],
      ['fret', '11'],
      ['stringLetter', 'a'],
      ['fret', '10'],
      ['stringLetter', 'a'],
      ['fret', '8'],
    ]);
  });

  it('(3 简写形式同样成立', () => {
    expect(kinds('(3a1a2a3')).toEqual([
      'tupletStart', 'stringLetter', 'fret', 'stringLetter', 'fret', 'stringLetter', 'fret',
    ]);
  });

  it('(a1 b2)：不紧跟数字的括号是连音线（§22.2）', () => {
    const run = lex('(a1 b2)');
    expect(run.tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['slurOpen', '('],
      ['stringLetter', 'a'],
      ['fret', '1'],
      ['whitespace', ' '],
      ['stringLetter', 'b'],
      ['fret', '2'],
      ['slurClose', ')'],
    ]);
    expect(run.codes).toEqual([]);
  });

  it('语料原形 (c10*2c10*2)-c10：slur 包裹 + tie 尾随', () => {
    expect(kinds('(c10*2c10*2)-c10')).toEqual([
      'slurOpen',
      'stringLetter', 'fret', 'tabDurSep', 'duration',
      'stringLetter', 'fret', 'tabDurSep', 'duration',
      'slurClose', 'tie',
      'stringLetter', 'fret',
    ]);
  });
});

describe('§29.3 未知 token 兜底', () => {
  it('孤立的 . 无规格记载 → raw + warning，不中止整行', () => {
    const run = lex('U[ax/].V[ax/]');
    expect(run.tokens.map((t) => t.kind)).toEqual([
      'strokePrefix', 'tabGroupOpen', 'stringLetter', 'fret', 'tabDurSep', 'tabGroupClose',
      'raw',
      'strokePrefix', 'tabGroupOpen', 'stringLetter', 'fret', 'tabDurSep', 'tabGroupClose',
    ]);
    expect(run.tokens[6]?.raw).toBe('.');
    expect(run.codes).toEqual(['jcx.body.unknown-token']);
  });

  it('# 同样按最短可疑片段切出，后续 token 正常', () => {
    const run = lex('#a1');
    expect(run.tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['raw', '#'],
      ['stringLetter', 'a'],
      ['fret', '1'],
    ]);
    expect(run.codes).toEqual(['jcx.body.unknown-token']);
  });

  it('连续同类未知字符合并为一个 raw（字母归一类）', () => {
    expect(pairs('国乐a1')).toEqual([
      ['raw', '国乐'],
      ['stringLetter', 'a'],
      ['fret', '1'],
    ]);
  });
});

describe('lexBody 分发（T7 入口）', () => {
  it("mode='tab' 与直接调用 lexBodyTab 等价", () => {
    const bag = createDiagnosticBag();
    expect(lexBody('a1*2', BASE, bag, 'tab').map((t) => t.kind)).toEqual([
      'stringLetter', 'fret', 'tabDurSep', 'duration',
    ]);
  });

  it("同一串 a1 在 pitch 与 tab 下切分结果不同（§13.2 反证）", () => {
    const bag = createDiagnosticBag();
    expect(lexBody('a1', BASE, bag, 'pitch').map((t) => t.kind)).toEqual([
      'pitchLetter', 'duration',
    ]);
    expect(lexBody('a1', BASE, bag, 'tab').map((t) => t.kind)).toEqual([
      'stringLetter', 'fret',
    ]);
  });
});

describe('整行综合（fixture 正文行）', () => {
  it('tab-direction.jcx 的正文行', () => {
    const input = '"C"V[ax/bx/cx/]U[ax/bx/cx/]B[ax*3/2bx*3/2] |';
    const run = lex(input);
    expect(run.codes).toEqual([]);
    expect(run.tokens.filter((t) => t.kind === 'strokePrefix').map((t) => t.raw)).toEqual([
      'V', 'U', 'B',
    ]);
  });
});
