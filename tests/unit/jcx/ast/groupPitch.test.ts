import { describe, expect, it } from 'vitest';
import { childKinds, kindsOf, pitchItems, tabItems } from './groupHelpers';

/**
 * M1.5 T4：`note` / `rest` 组合规则的逐条回归。
 *
 * 每条规则至少两例，全部走 `lexJcx` 真实输出；每例都由 `pitchItems` / `tabItems`
 * 顺带断言 path 连续无重复与 `printLine` 还原。
 */

describe('tryNote —— accidental* pitchLetter octaveMark* duration?', () => {
  it('裸音名：单 child 的 note', () => {
    const items = pitchItems('C');
    expect(kindsOf(items)).toEqual(['note']);
    expect(childKinds(items[0])).toEqual(['pitchLetter']);
  });

  it('CDE：三个音名各自成 note，不互相吞并', () => {
    const items = pitchItems('CDE');
    expect(kindsOf(items)).toEqual(['note', 'note', 'note']);
  });

  it('^^C,2：accidental / octaveMark / duration 全都进同一个 note', () => {
    const items = pitchItems('^^C,2');
    expect(kindsOf(items)).toEqual(['note']);
    expect(childKinds(items[0])).toEqual(['accidental', 'pitchLetter', 'octaveMark', 'duration']);
  });

  it("_B''/2：多重八度记号与分数时值同样并入", () => {
    const items = pitchItems("_B''/2");
    expect(kindsOf(items)).toEqual(['note']);
    expect(childKinds(items[0])).toEqual(['accidental', 'pitchLetter', 'octaveMark', 'duration']);
  });

  it('^=C：连续两个 accidental 都并入同一个 note（零归一化，不判语义矛盾）', () => {
    const items = pitchItems('^=C');
    expect(kindsOf(items)).toEqual(['note']);
    expect(childKinds(items[0])).toEqual(['accidental', 'accidental', 'pitchLetter']);
  });
});

describe('tryNote —— 兄弟标记永不进 note（边界 A）', () => {
  it('C>D：brokenRhythm 是兄弟叶子', () => {
    expect(kindsOf(pitchItems('C>D'))).toEqual(['note', 'brokenRhythm', 'note']);
  });

  it('C-D：tie 是兄弟叶子', () => {
    expect(kindsOf(pitchItems('C-D'))).toEqual(['note', 'tie', 'note']);
  });

  it('(3CDE 与 (C)：tupletStart / slur 都是兄弟叶子', () => {
    expect(kindsOf(pitchItems('(3CDE'))).toEqual(['tupletStart', 'note', 'note', 'note']);
    expect(kindsOf(pitchItems('(C)'))).toEqual(['slurOpen', 'note', 'slurClose']);
  });

  it('!p!C 与 "Cm"C：装饰 / 和弦符号都是兄弟叶子', () => {
    expect(kindsOf(pitchItems('!p!C'))).toEqual(['decoration', 'note']);
    expect(kindsOf(pitchItems('"Cm"C'))).toEqual(['chordSymbol', 'note']);
  });
});

describe('tryNote —— 降级：accidental 后不紧跟音名，整段退回叶子', () => {
  it('`^ |`：accidental 单独落成通用叶子，whitespace / barline 各自为兄弟', () => {
    const items = pitchItems('^ |');
    expect(kindsOf(items)).toEqual(['accidental', 'whitespace', 'barline']);
  });

  it('`^^|`：两个 accidental 被同一个 token 整体切出，仍是单枚叶子', () => {
    expect(kindsOf(pitchItems('^^|'))).toEqual(['accidental', 'barline']);
  });

  it('`^_C`：中间没有非 accidental 阻断时照常组合（与上面两例形成对照）', () => {
    expect(kindsOf(pitchItems('^_C'))).toEqual(['note']);
  });
});

describe('tryNote —— 降级：孤立的 duration / octaveMark 不能独立起头', () => {
  it('`|2C`：barline 后的 2 是孤立 duration，落通用叶子；C 另起一个 note', () => {
    const items = pitchItems('|2C');
    expect(kindsOf(items)).toEqual(['barline', 'duration', 'note']);
  });

  it("`,C`：孤立 octaveMark 同样落通用叶子", () => {
    expect(kindsOf(pitchItems(",C"))).toEqual(['octaveMark', 'note']);
  });

  it('`C >`：whitespace 阻断组合，brokenRhythm 不被任何 note 吸收', () => {
    expect(kindsOf(pitchItems('C >'))).toEqual(['note', 'whitespace', 'brokenRhythm']);
  });
});

describe('tryRest —— pitch 形态 rest duration?', () => {
  it('z：单 child 的 rest', () => {
    const items = pitchItems('z');
    expect(kindsOf(items)).toEqual(['rest']);
    expect(childKinds(items[0])).toEqual(['rest']);
  });

  it('z2：时值并入 rest', () => {
    const items = pitchItems('z2');
    expect(childKinds(items[0])).toEqual(['rest', 'duration']);
  });

  it('z/：单斜杠在 pitch 模式是时值（§16.1），并入 rest', () => {
    const items = pitchItems('z/');
    expect(childKinds(items[0])).toEqual(['rest', 'duration']);
  });

  it('Z 与 @：大写休止与隐藏休止同样组合为 rest 节点', () => {
    expect(childKinds(pitchItems('Z4')[0])).toEqual(['rest', 'duration']);
    expect(childKinds(pitchItems('@2')[0])).toEqual(['hiddenRest', 'duration']);
  });

  it('zzz：三个休止各自成节点，不互相吞并', () => {
    expect(kindsOf(pitchItems('zzz'))).toEqual(['rest', 'rest', 'rest']);
  });
});

describe('tryRest —— tab 形态 rest tabDurSep duration?（§26.5 / §26.9）', () => {
  it('z*2：tabDurSep 与 duration 一并进 rest', () => {
    const items = tabItems('z*2');
    expect(kindsOf(items)).toEqual(['rest']);
    expect(childKinds(items[0])).toEqual(['rest', 'tabDurSep', 'duration']);
  });

  it('z/：TAB 里的 `/` 是时值分隔符，数值缺省，只并入分隔符', () => {
    const items = tabItems('z/');
    expect(childKinds(items[0])).toEqual(['rest', 'tabDurSep']);
  });

  it('z//a1：`//` 归前面的休止符，随后的 a1 另起一个 tabNote', () => {
    const items = tabItems('z//a1');
    expect(kindsOf(items)).toEqual(['rest', 'tabNote']);
    expect(childKinds(items[0])).toEqual(['rest', 'tabDurSep']);
  });
});
