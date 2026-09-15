/**
 * Parse 层 —— 歌词 `w:` 对齐（M1.6 T8；spec §24，方案 v1.1 §2 / §3 / §5 T8）。
 *
 * 职责边界：
 * - 只消费 T5（`segments.ts`）已经归属好的 `lyric` 段落单元（voiceId + `w:` fieldLine +
 *   目标 bodyLine）与 T6（`scan.ts`）产出的事件流，不重新扫描 AST 之外的源码字符；
 * - 音节切分与对齐规则来自 spec §24.2「CONFIRMED BY DOCUMENTATION」的五条 help 语义：
 *   1) 与上一行音符逐音节对应；2) 跳过装饰音（grace 不占歌词音节）；3) tie 两个音符各算
 *   一个可唱事件；4) 同一行可有多条 `w:`（多段歌词，`verseIndex` 递增）；5) 英文以空格
 *   断字、中文以每字为间隔。
 * - `*`（跳过）与 `~`（合并两段为一个音节）是 spec §24.3 定义的对齐符号；`-`/`_`/`|`
 *   spec 未把它们列为歌词符号（DOC-ONLY / UNVERIFIED），一律当普通字符保留，不做切分。
 *
 * 「可唱事件」定义（spec §24.2 点 1/2，方案 §5 T8）：该 `w:` 行绑定的目标（独立正文行，
 * 或 `[V:x] CDE` 这种 inline 字段的同行尾随正文，见 `segments.ts` 的判别联合 `LyricTarget`）
 * 所产生的事件中，`kind` 为 `note`/`chord`/`tabNote`/`tabGroup` 的子序列——`grace` 显式
 * 跳过（点 2 CONFIRMED BY DOCUMENTATION）；`rest` 不是「音符」，排除，但这条是实现裁决而
 * 非 spec 明文（`INFERRED`：语料 94 行歌词未见 rest 占位的反例，help 未明说，见 spec
 * §24.2「休止符」条目），遇到时发一次性 info 而不是静默；`barline`/`decoration`/
 * `chordSymbol`/`unknown` 同理不算「音符」，静默排除（这几类连「可能是」的疑问都没有，
 * 不需要专门的诊断）。tie 两端音符本就是两个独立事件（scan 阶段已如此建模），天然满足
 * 点 3。
 *
 * 诊断一览（全部 `jcx.parse.*`）：
 * | code | severity | 触发 |
 * | --- | --- | --- |
 * | `jcx.parse.lyrics.aligned-by-documentation` | info | 每文档首次成功把音节绑定到事件时（§24.2） |
 * | `jcx.parse.lyrics.doc-only-separator` | info | 每文档首次出现 `~` 合并符（§24.3 DOC-ONLY/UNVERIFIED） |
 * | `jcx.parse.lyrics.unverified-separator` | info | 每文档首次音节文本含 `-`/`_`/`\|`（§24.3 UNVERIFIED） |
 * | `jcx.parse.lyrics.overflow` | warning | 每条 `w:` 行首次音节数超过可唱事件数时（§24.2） |
 * | `jcx.parse.lyrics.rest-excluded` | info | 每文档首次遇到目标行里含 rest 时（§24.2 INFERRED，非 spec 明文） |
 */

import type { JcxFieldLineNode } from '../../ast';
import { parseAstPath } from '../../ast';
import type { LyricLine, LyricSyllable, MusicEvent, NoteRef, VoiceId } from '../../../../domain';
import type { ParseContext } from '../header';
import { reportParse } from '../diagnostics';
import { originOf } from '../origin';
import type { VoiceSegment } from './segments';
import type { ScanByVoice } from './scan';

/**
 * `event.origin`（`SourceRef`，不透明字符串）是否为 `ancestorPath` 的后代路径。
 * 用 `ast/astPath.ts` 导出的 `parseAstPath` 把两侧都解析成结构化的
 * `{ line, indices }` 再比较（同一行号 + `ancestor.indices` 是 `candidate.indices`
 * 的真前缀），而不是裸字符串 `startsWith`——避免 `L1` 误判成 `L10` 的前缀这类
 * 只看字符不看结构的错误。`SourceRef` 在类型层是不透明字符串，不满足 `AstPath`
 * 的模板字面量类型，所以不能直接调用要求 `AstPath` 入参的 `isDescendantPath`，
 * 这里改用同一模块导出的解析函数自行比较结构，不重新扫描源码、不用 `as`。
 */
function isDescendantOrigin(ancestorPath: string, origin: string): boolean {
  const ancestor = parseAstPath(ancestorPath);
  const candidate = parseAstPath(origin);
  if (ancestor === null || candidate === null) {
    return false;
  }
  if (ancestor.kind !== 'line' || candidate.kind !== 'line' || ancestor.line !== candidate.line) {
    return false;
  }
  if (candidate.indices.length <= ancestor.indices.length) {
    return false;
  }
  return ancestor.indices.every((value, index) => candidate.indices[index] === value);
}

/** spec §24.2：可唱事件只数 note/chord/tabNote/tabGroup；grace/rest/barline/decoration/chordSymbol/unknown 排除。 */
function isSingableEvent(event: MusicEvent): boolean {
  return (
    event.kind === 'note' ||
    event.kind === 'chord' ||
    event.kind === 'tabNote' ||
    event.kind === 'tabGroup'
  );
}

/** `一-鿿` 覆盖语料实际出现的汉字；扩展区块语料零样本，不预先铺开。 */
function isCjkIdeograph(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x4e00 && code <= 0x9fff;
}

type AtomKind = 'cjk' | 'star' | 'glue' | 'run';

/** 原文里的最小切分单位：一个汉字 / 一个 `*` / 一个 `~`（待第二遍消费）/ 一段连续西文。 */
interface Atom {
  readonly kind: AtomKind;
  readonly start: number;
  readonly end: number;
}

/**
 * 第一遍扫描：把 `w:` 的 fieldValue 原文切成 atom 序列。
 * 空白只作分隔，不产出 atom（spec §24.2 点 5：英文以空格断字）；汉字逐字独立成 atom
 * （中文以每字为间隔）；`*`/`~` 各自独立成 atom，交给第二遍处理。
 */
function scanAtoms(raw: string): readonly Atom[] {
  const atoms: Atom[] = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i] ?? '';
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '*') {
      atoms.push({ kind: 'star', start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === '~') {
      atoms.push({ kind: 'glue', start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (isCjkIdeograph(ch)) {
      atoms.push({ kind: 'cjk', start: i, end: i + 1 });
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < raw.length) {
      const next = raw[j] ?? '';
      if (/\s/.test(next) || next === '*' || next === '~' || isCjkIdeograph(next)) {
        break;
      }
      j += 1;
    }
    atoms.push({ kind: 'run', start: i, end: j });
    i = j;
  }
  return atoms;
}

interface SyllableSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: 'text' | 'skip' | 'merge';
}

/**
 * 第二遍：把 atom 序列折叠成音节 span。
 * `*` → skip；`cjk`/`run` 单独就是一个 text 音节，若其后紧邻（原文无缝衔接，跨空白不算）
 * 一个 `~` 再紧邻下一个 `cjk`/`run`，则把这条链吸收成一个 merge 音节（spec §24.3：`~`
 * 连接两段对应同一个音符；链式 `a~b~c` 継续吸收，全部并入同一个音节）。孤立的 `~`
 * （前后没有可吸收的相邻音节，例如行首/行尾）退化为普通文本音节，不抛异常。
 */
function foldSyllables(atoms: readonly Atom[]): readonly SyllableSpan[] {
  const spans: SyllableSpan[] = [];
  let i = 0;
  while (i < atoms.length) {
    const atom = atoms[i];
    if (atom === undefined) {
      break;
    }
    if (atom.kind === 'star') {
      spans.push({ start: atom.start, end: atom.end, kind: 'skip' });
      i += 1;
      continue;
    }
    if (atom.kind === 'glue') {
      spans.push({ start: atom.start, end: atom.end, kind: 'text' });
      i += 1;
      continue;
    }
    let start = atom.start;
    let end = atom.end;
    let kind: 'text' | 'merge' = 'text';
    let next = i + 1;
    for (;;) {
      const glue = atoms[next];
      const after = atoms[next + 1];
      if (
        glue === undefined ||
        after === undefined ||
        glue.kind !== 'glue' ||
        glue.start !== end ||
        (after.kind !== 'cjk' && after.kind !== 'run') ||
        after.start !== glue.end
      ) {
        break;
      }
      end = after.end;
      kind = 'merge';
      next += 2;
    }
    spans.push({ start, end, kind });
    i = next;
  }
  return spans;
}

/** `w:` 行的 fieldValue 叶子 raw；缺失时为空串（不影响归零音节数的对齐结果）。 */
function fieldValueRaw(node: JcxFieldLineNode): string {
  for (const child of node.children) {
    if (child.token.kind === 'fieldValue') {
      return child.raw;
    }
  }
  return '';
}

function reportSeparatorDiagnostics(
  raw: string,
  node: JcxFieldLineNode,
  ctx: ParseContext,
  kind: 'text' | 'skip' | 'merge',
): void {
  if (kind === 'merge') {
    ctx.once.reportOnce(
      'lyrics.doc-only-separator',
      'jcx.parse.lyrics.doc-only-separator',
      'info',
      '歌词 ~ 把相邻两段文本合并对应同一个音符，精确语义仅 1 个语料样本（spec §24.3 DOC-ONLY/UNVERIFIED），按 help 语义合并为一个音节，不改写原文形态',
      node.span,
      originOf(node),
    );
  }
  if (raw.includes('-') || raw.includes('_') || raw.includes('|')) {
    ctx.once.reportOnce(
      'lyrics.unverified-separator',
      'jcx.parse.lyrics.unverified-separator',
      'info',
      '歌词音节中的 -/_/| 未被 help 或 faq 列为歌词切分符号（spec §24.3 DOC-ONLY / UNVERIFIED），按普通字符原样保留，不做切分语义',
      node.span,
      originOf(node),
    );
  }
}

/** 把一条 `w:` 行折成 `LyricSyllable[]`，并按需要对齐到 `singable` 中的可唱事件。 */
function buildSyllables(
  node: JcxFieldLineNode,
  singable: readonly MusicEvent[],
  ctx: ParseContext,
): readonly LyricSyllable[] {
  const raw = fieldValueRaw(node);
  const origin = originOf(node);
  const spans = foldSyllables(scanAtoms(raw));

  let overflowReported = false;
  const syllables: LyricSyllable[] = [];

  spans.forEach((span, index) => {
    const text = raw.slice(span.start, span.end);
    reportSeparatorDiagnostics(text, node, ctx, span.kind);

    const event = singable[index];
    if (event === undefined) {
      if (!overflowReported) {
        overflowReported = true;
        reportParse(
          ctx.bag,
          'jcx.parse.lyrics.overflow',
          'warning',
          `w: 行音节数超过目标行的可唱事件数，第 ${index + 1} 个及之后的音节不再绑定音符（spec §24.2 CONFIRMED BY DOCUMENTATION）`,
          node.span,
          origin,
        );
      }
      syllables.push({ text, kind: span.kind, origin, offsetInLine: span.start });
      return;
    }

    ctx.once.reportOnce(
      'lyrics.aligned-by-documentation',
      'jcx.parse.lyrics.aligned-by-documentation',
      'info',
      '歌词与音符逐音节对齐的规则来自 help 文档而非语料验证（spec §24.2 CONFIRMED BY DOCUMENTATION）',
      node.span,
      origin,
    );

    if (span.kind === 'skip') {
      syllables.push({ text, kind: 'skip', origin, offsetInLine: span.start });
      return;
    }
    const target: NoteRef = { eventId: event.id };
    syllables.push({ text, kind: span.kind, target, origin, offsetInLine: span.start });
  });

  return syllables;
}

/**
 * 对齐全部 `w:` 行，按声部分组返回 `LyricLine[]`（保持段落原文顺序）。
 *
 * 同一目标 bodyLine 被连续多条 `w:` 行绑定时，`verseIndex` 按出现顺序递增（spec §24.2
 * 点 4）；没有目标 bodyLine（该 `w:` 行之前没有任何正文行）时无法对齐，`verseIndex` 固定
 * 为 0——spec 未覆盖这种退化输入，不臆造「多段」语义。
 */
export function alignLyrics(
  segments: readonly VoiceSegment[],
  scan: ScanByVoice,
  ctx: ParseContext,
): ReadonlyMap<VoiceId, readonly LyricLine[]> {
  const byVoice = new Map<VoiceId, LyricLine[]>();
  const verseIndexByTarget = new Map<string, number>();

  for (const segment of segments) {
    const { unit } = segment;
    if (unit.kind !== 'lyric') {
      continue;
    }
    const events = scan.get(segment.voiceId)?.events ?? [];
    const target = unit.target;
    const targetEvents = target === undefined ? [] : events.filter((event) => isDescendantOrigin(target.line.path, event.origin));
    const singable = targetEvents.filter(isSingableEvent);

    if (targetEvents.some((event) => event.kind === 'rest')) {
      ctx.once.reportOnce(
        'lyrics.rest-excluded',
        'jcx.parse.lyrics.rest-excluded',
        'info',
        '休止符不占用歌词音节位（spec §24.2 INFERRED：语料 94 行歌词未见 rest 占位的反例，help 未明说，非 spec 明文裁决）',
        unit.node.span,
        originOf(unit.node),
      );
    }

    const verseKey = target === undefined ? `u:${originOf(unit.node)}` : target.line.path;
    const verseIndex = verseIndexByTarget.get(verseKey) ?? 0;
    verseIndexByTarget.set(verseKey, verseIndex + 1);

    const lines = byVoice.get(segment.voiceId) ?? [];
    byVoice.set(segment.voiceId, lines);
    lines.push({ verseIndex, syllables: buildSyllables(unit.node, singable, ctx) });
  }

  return byVoice;
}
