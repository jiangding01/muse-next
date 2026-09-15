/**
 * AST 单测公共构造器（非测试文件，vitest 不收集）。
 *
 * 按源顺序消费原文并分配 span，使手工构造的节点与真实 lexer 输出形状一致。
 */
import { createPositionTracker } from '../../../../src/formats/jcx/lexer/sourceSpan';
import type { SourceSpan } from '../../../../src/formats/jcx/lexer/sourceSpan';
import type { JcxToken } from '../../../../src/formats/jcx/lexer/token';
import { childPath, linePath } from '../../../../src/formats/jcx/ast';
import { bodyLeaf, tokenLeaf } from '../../../../src/formats/jcx/ast/leaf';
import type {
  AstPath,
  JcxAstDocument,
  JcxAstNode,
  JcxBodyLeafKind,
  JcxBodyLeafNode,
  JcxLineNode,
  JcxTokenLeafOf,
} from '../../../../src/formats/jcx/ast';

/** 分配式 Omit：`JcxToken` 是判别联合，直接 `Omit` 会丢掉 `key` / `letter` 等附属字段。 */
export type TokenSeed = JcxToken extends infer T ? (T extends JcxToken ? Omit<T, 'span'> : never) : never;

/**
 * 按源顺序消费原文的构造器：每调用一次就前进相应长度，
 * 保证手工构造的节点 span 与真实 lexer 一致。
 *
 * `leaf` 按 seed 的 token kind 参数化返回类型，因此「把 `tie` 塞进 `note.children`」
 * 这类违反边界 A 的构造能在类型层被挡下。
 */
export const reader = (source: string) => {
  const tracker = createPositionTracker(source);
  let counter = 0;

  const take = (raw: string): SourceSpan => {
    const start = tracker.current();
    const end = tracker.advance(raw.length);
    return { start, end };
  };

  const path = (): AstPath => childPath(linePath(0), counter++);

  return {
    /** 通用 token 叶子：`raw` 与 `span` 均直接取自 token，不另造副本。 */
    leaf<S extends TokenSeed>(seed: S): JcxTokenLeafOf<S['kind']> {
      const span = take(seed.raw);
      const token = { ...seed, span } as JcxToken & { readonly kind: S['kind'] };
      return tokenLeaf<S['kind']>(token, path());
    },
    /** 正文单 token 叶子。 */
    bodyLeaf<K extends JcxBodyLeafKind>(kind: K, seed: TokenSeed): JcxBodyLeafNode {
      const span = take(seed.raw);
      const token = { ...seed, span } as JcxToken;
      return bodyLeaf(kind, token, path());
    },
  };
};

export const spanning = (nodes: readonly JcxAstNode[]): SourceSpan => {
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error('spanning() needs at least one node');
  }
  return { start: first.span.start, end: last.span.end };
};

export const doc = (lines: readonly JcxLineNode[], extra?: Partial<JcxAstDocument>): JcxAstDocument => ({
  encoding: 'utf-8',
  hasBom: false,
  hasTrailingNewline: true,
  lines,
  diagnostics: [],
  ...extra,
});

