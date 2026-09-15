/**
 * JCX Lossless AST —— 行级 builder（M1.5 T2）。
 *
 * 唯一职责：把 `lexJcx` 的行级 token 流（`JcxLexResult.lines`）结构化为
 * `JcxLineNode[]`。**只分组、不重扫**：本文件不解析任何字符，只读
 * `JcxLexLine.kind` / `.tokens` 并按顺序装箱。
 *
 * M1.5 T3 范围：magicHeaderLine / fieldLine / directiveLine / commentLine /
 * blankLine / rawLine / textBlock（textBlockBoundaryLine + textLine）以及
 * inlineFieldLine / bodyLine 的行级骨架，都在本文件组装；inlineFieldLine /
 * bodyLine 内部「正文 token → 节点」的规则在 `buildBodyLine.ts`（T3 把正文
 * token 扁平映射为叶子，note/chord/grace/tabNote/tabGroup 的组合留给 T4）。
 *
 * `raw`（lexer 行类别，§29.4 全角冒号等未知语法）**永久**映射为 `rawLine`——
 * 这不是待补全的占位，是该行本身就无法被结构化解析，见下方 `case 'raw'` 的
 * 独立分支与注释。
 */

import type { SourceSpan } from '../lexer/sourceSpan';
import type { JcxDirectiveNameToken, JcxFieldKeyToken, JcxLexLine, JcxToken } from '../lexer/token';
import type { JcxLexResult } from '../lexer';
import { childPath, linePath } from './astPath';
import { tokenLeaf } from './leaf';
import { buildBodyLineNode, buildInlineFieldLine } from './buildBodyLine';
import type {
  AstPath,
  JcxLineNode,
  JcxTextBlockBoundaryLineNode,
  JcxTextBlockNode,
  JcxTextLineNode,
  JcxTokenLeaf,
  JcxTokenLeafOf,
} from './nodes';

/** 一行拆出的「内容 token（不含 eol、不含 bom）」与该行的 `eol` 原文。 */
interface SplitLine {
  readonly tokens: readonly JcxToken[];
  readonly eol: string;
}

/**
 * 剥离行尾 `eol` token（取其 raw 作为节点的 `eol` 字段，token 本身不进 children —
 * 与 printAst 的约定一致：行节点打印时在 children 之后另行追加 `node.eol`）。
 *
 * 第 0 行且文档有 BOM 时，额外剥离开头的 `bom` token —— 它被提升到
 * `JcxAstDocument.bom`，**禁止双重 ownership**：不能既是 `document.bom` 又出现在
 * 第 0 行的 children 里，否则 `printAst` 会把 BOM 打印两遍。
 */
function splitLineTokens(line: JcxLexLine, stripLeadingBom: boolean): SplitLine {
  let tokens = line.tokens;
  if (stripLeadingBom && tokens.length > 0 && tokens[0]?.kind === 'bom') {
    tokens = tokens.slice(1);
  }
  const last = tokens[tokens.length - 1];
  if (last !== undefined && last.kind === 'eol') {
    return { tokens: tokens.slice(0, -1), eol: last.raw };
  }
  return { tokens, eol: '' };
}

function buildChildren(tokens: readonly JcxToken[], base: AstPath): JcxTokenLeaf[] {
  return tokens.map((token, index) => tokenLeaf(token, childPath(base, index)));
}

/**
 * 行节点的 `span`（不含 `eol`，与 T1 `printAst.test.ts` 的既有用法一致）：
 * 有内容 token 时取首尾 token 的 span；没有内容 token 时（如纯空 blank 行）
 * 退化为该行 `eol` 起点（若无 eol，等价于该行末尾）处的零宽 span。
 *
 * 注意：`span` 反映的是**物理行位置**，与节点的 `path`（见下方 textBlock 取舍）
 * 是两件不相关的事——`span` 永远照抄 `line.span` 推导，不受 path 编号方案影响。
 */
function contentSpan(children: readonly { readonly span: SourceSpan }[], line: JcxLexLine): SourceSpan {
  const first = children[0];
  const last = children[children.length - 1];
  if (first !== undefined && last !== undefined) {
    return { start: first.span.start, end: last.span.end };
  }
  const lastToken = line.tokens[line.tokens.length - 1];
  const point = lastToken !== undefined && lastToken.kind === 'eol' ? lastToken.span.start : line.span.end;
  return { start: point, end: point };
}

function buildTextBlockBoundaryLine(
  line: JcxLexLine,
  boundary: 'begin' | 'end',
  tokens: readonly JcxToken[],
  eol: string,
  path: AstPath,
): JcxTextBlockBoundaryLineNode {
  // §10.3/§10.4：lexDirectiveLine 对 begintext/endtext 行只会产出
  // whitespace? + textBlockBegin/textBlockEnd + directiveValue?，
  // 与本节点声明的窄化 children 类型天然一致。
  const children = buildChildren(tokens, path) as readonly JcxTokenLeafOf<
    'whitespace' | 'textBlockBegin' | 'textBlockEnd' | 'directiveValue'
  >[];
  return {
    kind: 'textBlockBoundaryLine',
    path,
    span: contentSpan(children, line),
    boundary,
    eol,
    children,
  };
}

/**
 * 累积中的 text block：已见到 `begin`，尚未（或永不）见到 `end`。
 *
 * path 取舍（用户追加约束，覆盖 T1 提交说明里未拍板的部分）：textBlock 内部
 * **不**用各自的物理 `line.index` 编 path，否则 `Lx`（x = begin 行下标）会同时
 * 被 textBlock 自身和 begin 行占用，产生路径碰撞。改为：textBlock 整体路径是
 * `Lx`（x = begin 行的物理下标），begin / 内容行 / end 依次用
 * `childPath(Lx, 0)`、`childPath(Lx, 1)`……`childPath(Lx, n)` 编号 —— begin 恒为
 * 0，end（若存在）恒是最后一个编号。物理行号只体现在各节点的 `span` 里，
 * 不体现在 path 里。
 */
interface PendingTextBlock {
  /** textBlock 与其内部子节点共享的 path 基座：`Lx`（x = begin 行的物理下标）。 */
  readonly basePath: AstPath;
  readonly begin: JcxTextBlockBoundaryLineNode;
  readonly lines: JcxTextLineNode[];
}

function closeTextBlock(pending: PendingTextBlock, end?: JcxTextBlockBoundaryLineNode): JcxTextBlockNode {
  const lastLine = pending.lines[pending.lines.length - 1];
  const tailSpan = end?.span ?? lastLine?.span ?? pending.begin.span;
  return {
    kind: 'textBlock',
    path: pending.basePath,
    span: { start: pending.begin.span.start, end: tailSpan.end },
    begin: pending.begin,
    lines: pending.lines,
    ...(end !== undefined ? { end } : {}),
  };
}

/**
 * 把 `lex.lines` 结构化为 `JcxLineNode[]`。
 *
 * textBlock 之外的行节点：path 用 `linePath(line.index)`，与物理行下标一一对应。
 * textBlock 内部的 path 编号方案见 `PendingTextBlock` 上的注释。
 */
export function buildLineNodes(lex: JcxLexResult): JcxLineNode[] {
  const result: JcxLineNode[] = [];
  let seenKField = false;
  let pending: PendingTextBlock | null = null;

  for (const line of lex.lines) {
    const stripLeadingBom = line.index === 0 && lex.hasBom;
    const { tokens, eol } = splitLineTokens(line, stripLeadingBom);

    switch (line.kind) {
      case 'magicHeader': {
        const path = linePath(line.index);
        const children = buildChildren(tokens, path);
        result.push({ kind: 'magicHeaderLine', path, span: contentSpan(children, line), eol, children });
        break;
      }

      case 'comment': {
        const path = linePath(line.index);
        const children = buildChildren(tokens, path);
        result.push({ kind: 'commentLine', path, span: contentSpan(children, line), eol, children });
        break;
      }

      case 'blank': {
        const path = linePath(line.index);
        const children = buildChildren(tokens, path);
        result.push({ kind: 'blankLine', path, span: contentSpan(children, line), eol, children });
        break;
      }

      case 'field': {
        const path = linePath(line.index);
        const children = buildChildren(tokens, path);
        const keyToken = tokens.find((t): t is JcxFieldKeyToken => t.kind === 'fieldKey');
        const key = keyToken?.key ?? '';
        // §6.2：header 区到第一个 `K:` 字段行为止（含该行）；此后的字段行都在 body。
        // 若全文没有 `K:`，header 区从未结束，所有字段行都留在 'header'。
        const region: 'header' | 'body' = seenKField ? 'body' : 'header';
        if (key === 'K') {
          seenKField = true;
        }
        result.push({ kind: 'fieldLine', path, span: contentSpan(children, line), key, region, eol, children });
        break;
      }

      case 'directive': {
        const path = linePath(line.index);
        const children = buildChildren(tokens, path);
        const nameToken = tokens.find((t): t is JcxDirectiveNameToken => t.kind === 'directiveName');
        const name = nameToken?.name ?? '';
        result.push({ kind: 'directiveLine', path, span: contentSpan(children, line), name, eol, children });
        break;
      }

      case 'textBlockBegin': {
        // 跨模块契约：lexer 保证文本块内部的任何行都被分类为 textBlockContent
        // （lexDocument.ts 中 inTextBlock 的分类优先级最高），因此 pending 非空时
        // 不可能再收到 textBlockBegin。buildAst 不为此增加异常面；若 lexer 的分类
        // 规则将来改动，需同步改这里（lossless 测试会因块内容丢失而失败）。
        const basePath = linePath(line.index);
        const begin = buildTextBlockBoundaryLine(line, 'begin', tokens, eol, childPath(basePath, 0));
        pending = { basePath, begin, lines: [] };
        break;
      }

      case 'textBlockContent': {
        if (pending === null) {
          // 理论上不会出现：lexer 只在 `ctx.inTextBlock` 为真时才产出
          // `textBlockContent`（见 lexDocument.ts 分类优先级第 1 条），
          // 即前面必然先见过 `textBlockBegin`。防御性兜底为 rawLine，避免丢行。
          const path = linePath(line.index);
          const children = buildChildren(tokens, path);
          result.push({ kind: 'rawLine', path, span: contentSpan(children, line), eol, children });
          break;
        }
        // begin 占用编号 0，内容行依次顺延（第 1 条内容行是 1，第 2 条是 2……）。
        const path = childPath(pending.basePath, pending.lines.length + 1);
        const children = buildChildren(tokens, path);
        pending.lines.push({ kind: 'textLine', path, span: contentSpan(children, line), eol, children });
        break;
      }

      case 'textBlockEnd': {
        if (pending === null) {
          // 孤立的 `%%endtext`（没有匹配的 `%%begintext`）：降级为 rawLine 保真，
          // 不去猜测配对——用户追加约束明确要求这种情况按 rawLine 处理。
          const path = linePath(line.index);
          const children = buildChildren(tokens, path);
          result.push({ kind: 'rawLine', path, span: contentSpan(children, line), eol, children });
          break;
        }
        // end 编号紧跟在最后一条内容行之后（begin=0，内容行 1..n，end=n+1）。
        const end = buildTextBlockBoundaryLine(
          line,
          'end',
          tokens,
          eol,
          childPath(pending.basePath, pending.lines.length + 1),
        );
        result.push(closeTextBlock(pending, end));
        pending = null;
        break;
      }

      case 'raw': {
        // §29.4：lexer 判定为「无法归类的整行」（如全角冒号字段行）。这是永久兜底，
        // 不是待补全的占位——该行本身就不构成任何已知语法，结构化解析没有意义，
        // 因此独立一个 case，且形态与 T4 之后都保持 rawLine 不变。
        const path = linePath(line.index);
        const children = buildChildren(tokens, path);
        result.push({ kind: 'rawLine', path, span: contentSpan(children, line), eol, children });
        break;
      }

      case 'inlineField': {
        const path = linePath(line.index);
        result.push(buildInlineFieldLine(line, tokens, eol, path));
        break;
      }

      case 'body': {
        const path = linePath(line.index);
        result.push(buildBodyLineNode(line, tokens, eol, path));
        break;
      }

      default:
        assertNeverLineKind(line.kind);
    }
  }

  if (pending !== null) {
    // §11.3 第 4 条：未闭合的 `%%begintext` 延伸到文件末尾，`end` 缺失。
    result.push(closeTextBlock(pending));
  }

  return result;
}

function assertNeverLineKind(kind: never): never {
  throw new Error(`buildLineNodes: unhandled line kind ${JSON.stringify(kind)}`);
}
