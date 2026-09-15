/**
 * Parse 层 —— `%%` 指令与 text block 归集（M1.6 T9；spec §10、§11，方案 v1.1 §1.4 / §2）。
 *
 * 职责边界：
 * - 遍历 `ast.lines`，只消费 `directiveLine` 与 `textBlock` 两种顶层节点；
 *   `%%begintext` / `%%endtext` 本身在 AST 里不是独立的 `directiveLine`
 *   （见 `ast/nodes.ts` 的 `JcxTextBlockBoundaryLineNode` 注释），它们被折进
 *   `textBlock` 节点的 `begin`/`end`，因此天然不会被当成指令重复收集；
 * - **所有** `directiveLine`（含 gchord、showfinger）都进 `directives`，且
 *   `rawValue` 是 AST `directiveValue` token 的原始 raw——**不 trim、不改**
 *   （用户 2026-09-15 追加约束③）。它是「事实」层，序列化回写只认它
 *   （`domain/score.ts` `RawDirective` 注释）；值的语义解析一律对**副本**
 *   trim，不污染存入 `directives` 的原文；
 * - `gchord` 解析成功时额外产出 `chordShapes`（派生层，见 `gchord.ts`）；
 *   malformed 时该 directive 依旧永久保留在 `directives`，只是不生成
 *   `GuitarChord`；多条解析成功的 gchord（含同名）按文档顺序全部 push 进
 *   `chordShapes`，不按 name 去重或覆盖（约束⑤）；
 * - `showfinger`：只有**后一个成功解析的值**才覆盖**前一个成功解析的值**；
 *   中间夹杂的 malformed 值只发 warning，既不清空已生效的 `showFinger`，
 *   也不触发 `overridden`（约束②，见 `applyShowfinger`）；
 * - `skip`/`indent`/§10.7 DOC-ONLY 清单及未知指令名：只进 `directives`，
 *   不解析值、不发 diagnostic（未知指令名已由 lexer 发 `jcx.directive.unknown`）。
 *
 * 诊断一览（全部 `jcx.parse.*`）：
 * | code | severity | 触发 |
 * | --- | --- | --- |
 * | `jcx.parse.gchord.malformed` | warning | `%%gchord` 值不满足 §10.1 语法（项数 ≠ 6 / capo 不在 1–20 / fret 不在 1–24 / finger 不在 1–4 / `X(1)` 等非法弦位） |
 * | `jcx.parse.showfinger.unparsed` | warning | `%%showfinger` 值不是 `1/yes/true/0/no/false`（不区分大小写），不改动既有 `showFinger` |
 * | `jcx.parse.directive.overridden` | info | 一条**成功解析**的 `%%showfinger` 覆盖了此前**成功解析**的值（malformed 不参与覆盖判定） |
 */

import type { JcxAstDocument, JcxDirectiveLineNode, JcxTextBlockNode, JcxTextLineNode } from '../ast';
import type { GuitarChord, RawDirective, TextBlock } from '../../../domain';
import type { ParseContext } from './header';
import { reportParse } from './diagnostics';
import { originOf } from './origin';
import { parseGChordValue } from './gchord';

export interface DirectivesNormalization {
  readonly directives: readonly RawDirective[];
  readonly chordShapes: readonly GuitarChord[];
  readonly showFinger?: boolean;
  readonly textBlocks: readonly TextBlock[];
}

/**
 * `directiveValue` 叶子的原始 raw，**不 trim**（约束③：`RawDirective.rawValue`
 * 必须是 AST 原始值）。该 token 词法上只在 `%%<name>` 之后原样切分，天然带着
 * 分隔用的前导空白（见 `lexer/lexLineKinds.ts` `lexDirectiveLine`），这是
 * 无损事实的一部分，不是待清理的噪音。
 */
function directiveValueOf(node: JcxDirectiveLineNode): string {
  for (const child of node.children) {
    if (child.token.kind === 'directiveValue') {
      return child.raw;
    }
  }
  return '';
}

/** `textLine` 的 raw 内容（禁止 trim，spec §11.3 第 1 条：前导空白是有效对齐信息）。 */
function textLineRaw(line: JcxTextLineNode): string {
  for (const child of line.children) {
    if (child.token.kind === 'textBlockContent') {
      return child.raw;
    }
  }
  return '';
}

function toTextBlock(node: JcxTextBlockNode): TextBlock {
  return {
    lines: node.lines.map(textLineRaw),
    closed: node.end !== undefined,
    origin: originOf(node),
  };
}

/**
 * `1|yes|true` → `true`；`0|no|false` → `false`（不区分大小写）；其余 `undefined`
 * （spec §10.2）。入参可以是未 trim 的原始 `rawValue`——语义解析在此对副本 trim，
 * 不影响调用方存入 `directives` 的原文。
 */
function parseShowFinger(raw: string): boolean | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'yes' || normalized === 'true') {
    return true;
  }
  if (normalized === '0' || normalized === 'no' || normalized === 'false') {
    return false;
  }
  return undefined;
}

interface DirectivesState {
  readonly directives: RawDirective[];
  readonly chordShapes: GuitarChord[];
  readonly textBlocks: TextBlock[];
  /** 最近一次**成功解析**的 showfinger 值；malformed 不改动它（约束②）。 */
  showFinger: boolean | undefined;
}

function applyGchord(state: DirectivesState, node: JcxDirectiveLineNode, rawValue: string, ctx: ParseContext): void {
  // 语义解析用副本 trim，`directives` 里的原文（rawValue）保持不变（约束③）。
  const chord = parseGChordValue(rawValue.trim(), originOf(node));
  if (chord === undefined) {
    reportParse(
      ctx.bag,
      'jcx.parse.gchord.malformed',
      'warning',
      `%%gchord 的值 ${JSON.stringify(rawValue.trim())} 不满足 spec §10.1 语法（<name>=<capo 1-20>;<六个弦位，fret 1-24，finger 1-4>），原文保留在 directives，不生成和弦图`,
      node.span,
      originOf(node),
    );
    return;
  }
  // 约束⑤：多条成功解析的 gchord（含同名）按文档顺序全部 push，不去重、不覆盖。
  state.chordShapes.push(chord);
}

function applyShowfinger(
  state: DirectivesState,
  node: JcxDirectiveLineNode,
  rawValue: string,
  ctx: ParseContext,
): void {
  const parsed = parseShowFinger(rawValue);
  if (parsed === undefined) {
    // malformed：只发 warning，既不清空已生效的 showFinger，也不算「覆盖」（约束②）。
    reportParse(
      ctx.bag,
      'jcx.parse.showfinger.unparsed',
      'warning',
      `%%showfinger 的值 ${JSON.stringify(rawValue.trim())} 不是 1/yes/true/0/no/false 之一（不区分大小写，spec §10.2），showFinger 保持不变`,
      node.span,
      originOf(node),
    );
    return;
  }

  if (state.showFinger !== undefined) {
    // 只有「成功值覆盖成功值」才发 overridden（约束②）；第一次设置值时 state.showFinger
    // 仍是 undefined，不满足此条件，不误报。
    reportParse(
      ctx.bag,
      'jcx.parse.directive.overridden',
      'info',
      '文档内多条 %%showfinger 均成功解析，按文档位置序由后者覆盖前者',
      node.span,
      originOf(node),
    );
  }
  state.showFinger = parsed;
}

/**
 * 归集全部 `%%` 指令与 text block。永不抛异常：任何值形态问题都降级为
 * raw 保留 + diagnostic（gchord malformed / showfinger unparsed）。
 */
export function collectDirectives(ast: JcxAstDocument, ctx: ParseContext): DirectivesNormalization {
  const state: DirectivesState = {
    directives: [],
    chordShapes: [],
    textBlocks: [],
    showFinger: undefined,
  };

  for (const line of ast.lines) {
    if (line.kind === 'textBlock') {
      state.textBlocks.push(toTextBlock(line));
      continue;
    }
    if (line.kind !== 'directiveLine') {
      continue;
    }

    const rawValue = directiveValueOf(line);
    // 事实层：无论名字是否已知、值是否可解析，原文（未 trim）永远进 directives。
    state.directives.push({ name: line.name, rawValue, origin: originOf(line) });

    if (line.name === 'gchord') {
      applyGchord(state, line, rawValue, ctx);
      continue;
    }
    if (line.name === 'showfinger') {
      applyShowfinger(state, line, rawValue, ctx);
      continue;
    }
    // skip / indent / §10.7 DOC-ONLY 清单 / 未知指令名：只进 directives，不解析值、不发诊断。
  }

  return {
    directives: state.directives,
    chordShapes: state.chordShapes,
    ...(state.showFinger === undefined ? {} : { showFinger: state.showFinger }),
    textBlocks: state.textBlocks,
  };
}
