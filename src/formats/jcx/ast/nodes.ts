/**
 * JCX Lossless AST —— 节点总表（M1.5 T1）。
 *
 * 定位（HANDOFF §36.1 / §53、JCX_SPEC §6.5）：本层**只对 M1.4 的 token 流做结构化
 * 分组**，不重新扫描字符、不做任何归一化。核心不变量：
 *
 * ```text
 * printAst(buildAst(lexJcx(source))) === source
 * ```
 *
 * 因此：
 * - AST 的第一公民是「行」而不是「字段」（§6.5），行顺序即原文顺序；
 * - 叶子节点存 `raw`（原文片段），组合节点**不存 raw**，其原文由 children 拼接得到——
 *   避免同一份原文出现两个副本导致的不一致；
 * - 每个节点都带 `span`，服务 HANDOFF §45 的 source ↔ visual 双向定位。
 *
 * 本阶段刻意**不做**的事（M1.5 已拍板边界，M1.6 之后再说）：
 * - `V:` 字段不切属性，只保留 lexer 给的 `fieldValue` token；
 * - tuplet / slur / tie 只做标记节点，不配对、不建树；
 * - `brokenRhythm` / `tie` / `slurOpen` / `slurClose` / `tupletStart` 都是 note 的**兄弟**节点，
 *   不并入 note；
 * - 不预留任何增量 / previousAst 接口。
 */

import type { SourceSpan } from '../lexer/sourceSpan';
import type { JcxToken, JcxTokenKind } from '../lexer/token';
import type { JcxDiagnostic } from '../lexer/diagnostics';
import type { JcxEncoding } from '../encoding/types';

/**
 * 节点在单次 AST 快照中的路径式 id，形如 `L12`、`L12.3`、`L12.3.1`。
 *
 * **稳定性承诺仅限「同一次快照内唯一且确定」**：同一份 `JcxLexResult` 重复 `buildAst`
 * 必得到同一批 path。**不承诺跨编辑稳定**——插入 / 删除一行会让其后所有 path 整体平移，
 * 因此禁止把 AstPath 持久化到文件、undo 栈或跨文档引用里。需要跨编辑稳定的 identity，
 * 由 M1.6 之后的 Domain 层另行分配。
 */
export type AstPath = `L${string}`;

export interface JcxAstNodeBase {
  readonly path: AstPath;
  readonly span: SourceSpan;
}

/** 携带原文的叶子共同形态：`raw` 恒等于 `token.raw`，是无损拼接的唯一来源。 */
interface JcxLeafBase<K extends string> extends JcxAstNodeBase {
  readonly kind: K;
  readonly token: JcxToken;
  readonly raw: string;
}

/**
 * 通用 token 叶子，按承载的 token kind 参数化。
 *
 * 组合节点（note / chord / fieldLine 等）的 children 一律用它，避免为每种 token kind
 * 再造一个节点类型；`K` 收窄时可在类型层挡住「把 `tie` 塞进 `note.children`」这类
 * 违反边界 A 的构造（M1.5 已拍板：note 只合并 accidental/pitchLetter/octaveMark/duration）。
 *
 * 节点的 `kind` 恒为 `'token'`，因此 `switch (node.kind)` 的收窄不受影响。
 */
export interface JcxTokenLeafOf<K extends JcxTokenKind> extends JcxAstNodeBase {
  readonly kind: 'token';
  readonly token: JcxToken & { readonly kind: K };
  readonly raw: string;
}

/** 不限 token kind 的通用叶子。 */
export type JcxTokenLeaf = JcxTokenLeafOf<JcxTokenKind>;

/** 正文中「一个 token 即一个语法单位」的叶子节点 kind（§18–§25）。 */
export type JcxBodyLeafKind =
  | 'barline'
  | 'repeatEnding'
  /** §19.2 之外的 `"..."` 和弦符号；本阶段是叶子，不解析和弦文本。 */
  | 'chordSymbol'
  /** §23：simple / complex 两形态统一为 decoration，形态差异看 `token.kind`。 */
  | 'decoration'
  /** §20：`(3` 之类的三连音头，仅标记，不配对；与 token kind 同名。 */
  | 'tupletStart'
  | 'slurOpen'
  | 'slurClose'
  | 'tie'
  | 'brokenRhythm'
  /** §26.6：`-S-` / `-H-` / `-P-`。 */
  | 'tabRelation'
  /** §26.4：悬空（未紧跟弦号 / 弦组）的拨弦前缀。 */
  | 'strokePrefix'
  | 'whitespace'
  /** 词法未能归类的片段（§29.3），原样保留。 */
  | 'rawToken';

export type JcxBodyLeafNode = { [K in JcxBodyLeafKind]: JcxLeafBase<K> }[JcxBodyLeafKind];

interface JcxCompositeBase<K extends string> extends JcxAstNodeBase {
  readonly kind: K;
}

/** §14.3：accidental* pitchLetter octaveMark* duration?。**仅此四类 token 进 note**（边界 A）。 */
export interface JcxNoteNode extends JcxCompositeBase<'note'> {
  readonly children: readonly JcxTokenLeafOf<
    'accidental' | 'pitchLetter' | 'octaveMark' | 'duration'
  >[];
}

/** §15：`z` / `Z` / `@` + 可选时值。 */
export interface JcxRestNode extends JcxCompositeBase<'rest'> {
  readonly children: readonly JcxTokenLeafOf<'rest' | 'hiddenRest' | 'duration'>[];
}

/** §14.4：`[...]` 和弦块；`close` 缺失表示未闭合（原样保留，不补）。 */
export interface JcxChordNode extends JcxCompositeBase<'chord'> {
  readonly open: JcxTokenLeaf;
  readonly items: readonly JcxBodyNode[];
  readonly close?: JcxTokenLeaf;
}

/** §21：`{...}` 装饰音组。 */
export interface JcxGraceNode extends JcxCompositeBase<'grace'> {
  readonly open: JcxTokenLeaf;
  readonly items: readonly JcxBodyNode[];
  readonly close?: JcxTokenLeaf;
}

/** §26：strokePrefix? stringLetter fret? tabDurSep? duration?。 */
export interface JcxTabNoteNode extends JcxCompositeBase<'tabNote'> {
  readonly children: readonly JcxTokenLeafOf<
    'strokePrefix' | 'stringLetter' | 'fret' | 'tabDurSep' | 'duration'
  >[];
}

/** §26：TAB 的 `[...]` 弦组。 */
export interface JcxTabGroupNode extends JcxCompositeBase<'tabGroup'> {
  readonly open: JcxTokenLeaf;
  readonly items: readonly JcxBodyNode[];
  readonly close?: JcxTokenLeaf;
}

export type JcxBodyNode =
  | JcxNoteNode
  | JcxRestNode
  | JcxChordNode
  | JcxGraceNode
  | JcxTabNoteNode
  | JcxTabGroupNode
  | JcxBodyLeafNode;

/** 行节点共同形态。`eol` 为 `''` 表示该行没有换行符（文件末行，§5.2）。 */
interface JcxLineBase<K extends string> extends JcxAstNodeBase {
  readonly kind: K;
  readonly eol: string;
}

/** §7：`%MUSE<ver>`。 */
export interface JcxMagicHeaderLineNode extends JcxLineBase<'magicHeaderLine'> {
  readonly children: readonly JcxTokenLeaf[];
}

/**
 * §8.0：`K: value` 形态的信息字段行。
 *
 * children 依次是 whitespace? / fieldKey / fieldColon / fieldValue（可缺）/ whitespace?。
 * **不切属性**：`V:` 的属性解析属于 M1.6，本阶段只保留整段 `fieldValue` token。
 */
export interface JcxFieldLineNode extends JcxLineBase<'fieldLine'> {
  readonly key: string;
  readonly children: readonly JcxTokenLeaf[];
  /** §6.2：位于 header 还是 body（`K:` 之后）。由 T2 的 build 过程填写。 */
  readonly region: 'header' | 'body';
}

/** §10：`%%name value`（含 `%%begintext` / `%%endtext` 本身）。 */
export interface JcxDirectiveLineNode extends JcxLineBase<'directiveLine'> {
  readonly name: string;
  readonly children: readonly JcxTokenLeaf[];
}

/** §5.6：`%` 注释行；注释内容含行尾空白，原样保留。 */
export interface JcxCommentLineNode extends JcxLineBase<'commentLine'> {
  readonly children: readonly JcxTokenLeaf[];
}

/** §5.4：空行或纯空白行。 */
export interface JcxBlankLineNode extends JcxLineBase<'blankLine'> {
  readonly children: readonly JcxTokenLeaf[];
}

/**
 * §9.1：以 `[V:1]` 这类内联字段开头的行。
 *
 * `children` 是内联字段本身的 token（含方括号），`trailing` 是同一行内联字段之后的正文。
 */
export interface JcxInlineFieldLineNode extends JcxLineBase<'inlineFieldLine'> {
  readonly key: string;
  readonly children: readonly JcxTokenLeaf[];
  readonly trailing: readonly JcxBodyNode[];
}

/** §13：正文行；`mode` 是 §13.2 模式状态机判定的实际词法模式。 */
export interface JcxBodyLineNode extends JcxLineBase<'bodyLine'> {
  readonly mode: 'pitch' | 'tab';
  readonly items: readonly JcxBodyNode[];
}

/** §29.4：无法归类的整行（如全角冒号字段行），原样保留。 */
export interface JcxRawLineNode extends JcxLineBase<'rawLine'> {
  readonly children: readonly JcxTokenLeaf[];
}

/**
 * §10.3 / §10.4：`%%begintext` / `%%endtext` 行。
 *
 * **不复用 `directiveLine`**：lexer 对这两行切的是 `whitespace? + textBlockBegin/textBlockEnd
 * + directiveValue?`，根本没有 `directivePrefix` / `directiveName` token（见
 * `lexer/lexLineKinds.ts` 的 `lexDirectiveLine`），套 `directiveLine` 会逼出一个不存在的
 * `name` 字段，误导后续实现。故单列一个只带 `boundary` 的行节点。
 */
export interface JcxTextBlockBoundaryLineNode extends JcxLineBase<'textBlockBoundaryLine'> {
  readonly boundary: 'begin' | 'end';
  readonly children: readonly JcxTokenLeafOf<
    'whitespace' | 'textBlockBegin' | 'textBlockEnd' | 'directiveValue'
  >[];
}

/** §11.3：text block 内容行，禁止 trim，前导空白是有效信息。 */
export interface JcxTextLineNode extends JcxLineBase<'textLine'> {
  readonly children: readonly JcxTokenLeaf[];
}

/**
 * §11.4：`%%begintext` … `%%endtext` 整块。
 *
 * **取舍**：textBlock 是「行的分组」而不是一行，故它自身**没有 `eol`** ——
 * 换行符分别属于 `begin` / `lines` / `end`。`end` 缺失表示未闭合（§11.3 第 4 条），
 * 此时块延伸到文件末尾。
 */
export interface JcxTextBlockNode extends JcxAstNodeBase {
  readonly kind: 'textBlock';
  readonly begin: JcxTextBlockBoundaryLineNode;
  readonly lines: readonly JcxTextLineNode[];
  readonly end?: JcxTextBlockBoundaryLineNode;
}

export type JcxLineNode =
  | JcxMagicHeaderLineNode
  | JcxFieldLineNode
  | JcxDirectiveLineNode
  | JcxCommentLineNode
  | JcxBlankLineNode
  | JcxInlineFieldLineNode
  | JcxBodyLineNode
  | JcxRawLineNode
  | JcxTextBlockNode;

export type JcxAstNode =
  | JcxLineNode
  | JcxTextBlockBoundaryLineNode
  | JcxTextLineNode
  | JcxBodyNode
  | JcxTokenLeaf;

/** §6.5：文档根。`bom` 存在时即文本首字符 U+FEFF 的叶子（BOM 不剥离，§5.5）。 */
export interface JcxAstDocument {
  readonly encoding: JcxEncoding;
  readonly hasBom: boolean;
  readonly bom?: JcxTokenLeaf;
  readonly hasTrailingNewline: boolean;
  readonly lines: readonly JcxLineNode[];
  readonly diagnostics: readonly JcxDiagnostic[];
}

const BODY_LEAF_KINDS: ReadonlySet<string> = new Set<JcxBodyLeafKind>([
  'barline',
  'repeatEnding',
  'chordSymbol',
  'decoration',
  'tupletStart',
  'slurOpen',
  'slurClose',
  'tie',
  'brokenRhythm',
  'tabRelation',
  'strokePrefix',
  'whitespace',
  'rawToken',
]);

/** 叶子 = 自带 `raw` 的节点（通用 token 叶子 + 正文单 token 叶子）。 */
export function isLeaf(node: JcxAstNode): node is JcxTokenLeaf | JcxBodyLeafNode {
  return node.kind === 'token' || BODY_LEAF_KINDS.has(node.kind);
}

export function isTokenLeaf(node: JcxAstNode): node is JcxTokenLeaf {
  return node.kind === 'token';
}

/** textBlock 也是行节点，但它没有自己的 `eol`（换行归 begin/lines/end）。 */
export function isTextBlock(node: JcxAstNode): node is JcxTextBlockNode {
  return node.kind === 'textBlock';
}
