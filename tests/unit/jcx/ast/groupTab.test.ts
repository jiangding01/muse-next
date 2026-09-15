import { describe, expect, it } from 'vitest';
import { childKinds, kindsOf, tabItems } from './groupHelpers';

/**
 * M1.5 T4：`tabNote` 组合与 `strokePrefix` 吸收判定的逐条回归（§26）。
 *
 * 判定只看**下一个 token 的 kind**，不看模式、不回溯；lexer 已保证
 * `fret` 只在紧跟 `stringLetter` 时产出、`tabDurSep` 与 `duration` 成对切出。
 */

describe('tryTabNote —— stringLetter fret? tabDurSep? duration?', () => {
  it('a：裸弦号即一个 tabNote', () => {
    const items = tabItems('a');
    expect(kindsOf(items)).toEqual(['tabNote']);
    expect(childKinds(items[0])).toEqual(['stringLetter']);
  });

  it('c10：多位品位整体一个 fret，不拆成 1 + 0', () => {
    const items = tabItems('c10');
    expect(kindsOf(items)).toEqual(['tabNote']);
    expect(childKinds(items[0])).toEqual(['stringLetter', 'fret']);
  });

  it('a1*2：时值分隔符与数值并入同一个 tabNote', () => {
    expect(childKinds(tabItems('a1*2')[0])).toEqual([
      'stringLetter',
      'fret',
      'tabDurSep',
      'duration',
    ]);
  });

  it('ax//：`x` 品位与缺省数值的 `//`', () => {
    expect(childKinds(tabItems('ax//')[0])).toEqual(['stringLetter', 'fret', 'tabDurSep']);
  });

  it('a1b2：两个 tabNote 相邻，互不吞并', () => {
    const items = tabItems('a1b2');
    expect(kindsOf(items)).toEqual(['tabNote', 'tabNote']);
    expect(childKinds(items[1])).toEqual(['stringLetter', 'fret']);
  });
});

describe('tryTabNote —— strokePrefix 吸收：下一个是 stringLetter', () => {
  it('Va1：V 被吸收进 tabNote', () => {
    const items = tabItems('Va1');
    expect(kindsOf(items)).toEqual(['tabNote']);
    expect(childKinds(items[0])).toEqual(['strokePrefix', 'stringLetter', 'fret']);
  });

  it("'a2*4：加重前缀同样被吸收，后续时值不受影响", () => {
    expect(childKinds(tabItems("'a2*4")[0])).toEqual([
      'strokePrefix',
      'stringLetter',
      'fret',
      'tabDurSep',
      'duration',
    ]);
  });
});

describe('tryTabNote —— strokePrefix 不吸收：下一个是 tabGroupOpen', () => {
  it('V[ax/bx/]：V 作独立叶子，弦组是它的兄弟', () => {
    const items = tabItems('V[ax/bx/]');
    expect(kindsOf(items)).toEqual(['strokePrefix', 'tabGroup']);
    const group = items[1];
    expect(group?.kind === 'tabGroup' && group.items.map((i) => i.kind)).toEqual([
      'tabNote',
      'tabNote',
    ]);
  });

  it('B[ab]：下琶音同样不进任何 tabNote', () => {
    expect(kindsOf(tabItems('B[ab]'))).toEqual(['strokePrefix', 'tabGroup']);
  });
});

describe('tryTabNote —— strokePrefix 悬空：作独立叶子，AST 不重复报诊断', () => {
  it('`S |`：后面是空白 → 悬空，落 strokePrefix 叶子', () => {
    expect(kindsOf(tabItems('S |'))).toEqual(['strokePrefix', 'whitespace', 'barline']);
  });

  it('`T`：行尾悬空同样落叶子', () => {
    expect(kindsOf(tabItems('T'))).toEqual(['strokePrefix']);
  });

  it('悬空前缀的 info 由 lexer 发出，AST 层零自产 diagnostic', () => {
    // `tabItems` 已断言原文还原；这里只确认 AST 没有把 diagnostic 数量改变的机会——
    // buildAst 透传 lexer 的 diagnostics 列表（引用相等）已由 lossless.test.ts 覆盖，
    // 本例只做结构层面的确认：悬空前缀没有被静默吞掉。
    const items = tabItems('S a1');
    expect(kindsOf(items)).toEqual(['strokePrefix', 'whitespace', 'tabNote']);
  });
});

describe('tryTabNote —— 与共享构造的边界', () => {
  it('a1-S-b2：tabRelation 是兄弟叶子，不进任何一侧的 tabNote', () => {
    expect(kindsOf(tabItems('a1-S-b2'))).toEqual(['tabNote', 'tabRelation', 'tabNote']);
  });

  it('a1-b2：TAB 里的单个 `-` 是 tie 兄弟叶子', () => {
    expect(kindsOf(tabItems('a1-b2'))).toEqual(['tabNote', 'tie', 'tabNote']);
  });

  it('|a1|：小节线不被吸收', () => {
    expect(kindsOf(tabItems('|a1|'))).toEqual(['barline', 'tabNote', 'barline']);
  });
});
