import { describe, expect, it } from 'vitest';
import { childKinds, kindsOf, pitchItems, tabItems } from './groupHelpers';
import type { JcxAstNode } from '../../../../src/formats/jcx/ast';

/**
 * M1.5 T4：括号组（chord `[…]` / grace `{…}` / tabGroup `[…]`）的逐条回归。
 *
 * 重点在三件事：编号约定（open=0、items 从 1、close=1+items.length）、
 * 未闭合时省略 `close` 而不是退回叶子、递归时对**祖先 close** 的恢复。
 */

/** 断言一个括号组的 open/close 形态与 items 结构。 */
function expectGroup(
  node: JcxAstNode | undefined,
  kind: 'chord' | 'grace' | 'tabGroup',
  itemKinds: readonly string[],
  closeKind: string | undefined,
): void {
  expect(node?.kind).toBe(kind);
  if (node === undefined || !('open' in node)) {
    throw new Error(`expected a bracket group, got ${String(node?.kind)}`);
  }
  expect(node.items.map((i) => i.kind)).toEqual(itemKinds);
  expect(node.close?.token.kind).toBe(closeKind);
  // 编号约定：open 恒 0，items 从 1 起，close 恒 1 + items.length。
  expect(node.open.path).toBe(`${node.path}.0`);
  node.items.forEach((item, offset) => {
    expect(item.path).toBe(`${node.path}.${1 + offset}`);
  });
  if (node.close !== undefined) {
    expect(node.close.path).toBe(`${node.path}.${1 + node.items.length}`);
  }
}

describe('tryOpenGroup —— chord [...]', () => {
  it('[CEG]：三个 note 在 items，open/close 在外壳', () => {
    const items = pitchItems('[CEG]');
    expect(kindsOf(items)).toEqual(['chord']);
    expectGroup(items[0], 'chord', ['note', 'note', 'note'], 'chordClose');
  });

  it('[]：空和弦块，items 为空，close 仍在', () => {
    const items = pitchItems('[]');
    expectGroup(items[0], 'chord', [], 'chordClose');
  });

  it('[CEG]2：后缀时值是兄弟通用叶子，chord 不加 duration 字段', () => {
    const items = pitchItems('[CEG]2');
    expect(kindsOf(items)).toEqual(['chord', 'duration']);
    expectGroup(items[0], 'chord', ['note', 'note', 'note'], 'chordClose');
  });

  it('[C E]：组内 whitespace 是兄弟叶子，不跨越组合', () => {
    expectGroup(pitchItems('[C E]')[0], 'chord', ['note', 'whitespace', 'note'], 'chordClose');
  });
});

describe('tryOpenGroup —— grace {...}', () => {
  it('{c}：内容递归组合为 note', () => {
    expectGroup(pitchItems('{c}')[0], 'grace', ['note'], 'graceClose');
  });

  it('{@cd}：`{@` 整体是一个 graceOpen token（§21 后倚音）', () => {
    const items = pitchItems('{@cd}');
    expect(kindsOf(items)).toEqual(['grace']);
    expectGroup(items[0], 'grace', ['note', 'note'], 'graceClose');
    expect(childKinds(items[0])).toEqual(['graceOpen', 'note', 'note', 'graceClose']);
  });
});

describe('tryOpenGroup —— 未闭合：构造节点并省略 close', () => {
  it('[CEG：chord 未闭合，close 缺失，原文零丢失', () => {
    const items = pitchItems('[CEG');
    expect(kindsOf(items)).toEqual(['chord']);
    expectGroup(items[0], 'chord', ['note', 'note', 'note'], undefined);
  });

  it('{G：grace 未闭合', () => {
    const items = pitchItems('{G');
    expectGroup(items[0], 'grace', ['note'], undefined);
  });

  it('[：空且未闭合，items 为空、close 缺失（span 退回 open 自身）', () => {
    const items = pitchItems('[');
    expectGroup(items[0], 'chord', [], undefined);
  });

  it('[ax/：tabGroup 未闭合', () => {
    const items = tabItems('[ax/');
    expectGroup(items[0], 'tabGroup', ['tabNote'], undefined);
  });
});

describe('tryOpenGroup —— 多余的闭括号是通用叶子，不发 diagnostic', () => {
  it('`]`：单独的 chordClose 落通用叶子', () => {
    expect(kindsOf(pitchItems(']'))).toEqual(['chordClose']);
  });

  it('`}`：单独的 graceClose 落通用叶子', () => {
    expect(kindsOf(pitchItems('}'))).toEqual(['graceClose']);
  });

  it('`C]]`：连续多余闭括号各自成叶子', () => {
    expect(kindsOf(pitchItems('C]]'))).toEqual(['note', 'chordClose', 'chordClose']);
  });

  it('`]`（TAB）：tabGroupClose 同样落通用叶子', () => {
    expect(kindsOf(tabItems(']'))).toEqual(['tabGroupClose']);
  });
});

describe('tryOpenGroup —— 递归 recovery：内层不吞掉祖先的 close', () => {
  it('[a{b]：grace 未闭合，`]` 归外层 chord', () => {
    const items = pitchItems('[a{b]');
    expect(kindsOf(items)).toEqual(['chord']);
    expectGroup(items[0], 'chord', ['note', 'grace'], 'chordClose');
    const chord = items[0];
    if (chord === undefined || !('open' in chord)) throw new Error('expected chord');
    expectGroup(chord.items[1], 'grace', ['note'], undefined);
  });

  it('{a[b}：chord 未闭合，`}` 归外层 grace（对称形态）', () => {
    const items = pitchItems('{a[b}');
    expectGroup(items[0], 'grace', ['note', 'chord'], 'graceClose');
    const grace = items[0];
    if (grace === undefined || !('open' in grace)) throw new Error('expected grace');
    expectGroup(grace.items[1], 'chord', ['note'], undefined);
  });

  it('[a{b：两层都未闭合，两层都构造节点', () => {
    const items = pitchItems('[a{b');
    expectGroup(items[0], 'chord', ['note', 'grace'], undefined);
  });
});

describe('tryOpenGroup —— TAB 嵌套', () => {
  it('{[a]}：grace 内嵌 tabGroup，两层都闭合', () => {
    const items = tabItems('{[a]}');
    expect(kindsOf(items)).toEqual(['grace']);
    expectGroup(items[0], 'grace', ['tabGroup'], 'graceClose');
    const grace = items[0];
    if (grace === undefined || !('open' in grace)) throw new Error('expected grace');
    expectGroup(grace.items[0], 'tabGroup', ['tabNote'], 'tabGroupClose');
  });

  it('{[a1}：内层 tabGroup 未闭合，`}` 归 grace', () => {
    const items = tabItems('{[a1}');
    expectGroup(items[0], 'grace', ['tabGroup'], 'graceClose');
    const grace = items[0];
    if (grace === undefined || !('open' in grace)) throw new Error('expected grace');
    expectGroup(grace.items[0], 'tabGroup', ['tabNote'], undefined);
  });
});
