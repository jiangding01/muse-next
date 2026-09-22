/**
 * canonical 序列化 —— body 区（M1.7 T4，方案 v1.1 §3 / 决策 2、3 / §8 拍板 F）。
 *
 * 一个声部的 body = `[V:n]` 行 + 若干「事件行」，其间按事实插入 `L:` 行。事件文本见
 * `bodyEvents.ts`，relation marker 落位见 `bodyRelations.ts`，`ignoredFields` 重放见
 * `bodyFields.ts`；本文件只管**行**：在哪里断行、`L:` 插在哪里。
 *
 * ## 行边界（决策 2 + 2026-09-15 用户裁决①）
 *
 * Domain 不建模「源文本的行」，能恢复行边界的事实只有两条，优先级如下：
 *
 * 1. **`unitLengthChanges[].beforeEventId` 是强制断行点**（裁决①）：`L: raw`
 *    必须紧贴写在该事件之前、且该事件必须另起一行，否则 `L:` 会连带改写同一行里
 *    排在它前面的事件的单位音长——那是**改变语义**。这条优先级高于歌词行边界：
 *    真被迫切开一条 `w:` 覆盖的正文时发 `jcx.serialize.lyric-line-split` warning。
 * 2. **`LyricLine.bodyRange` 覆盖的事件区间独占一行**：`w:` 绑定「上一条正文行」，
 *    行切错了音节 target 就会漂移。多个 verse 共用同一 range，**先按 `first#last`
 *    去重再规划断行**（裁决④），一条正文只产生一条事件行。
 * 3. 其余区间在**小节线之后**断行（无歌词区间的默认规则）。
 *
 * `w:` 行本身由 T5 插入：本模块在每条事件行上带出它覆盖的区间（`CanonicalBodyLine.range`）
 * 与「哪条 `LyricBodyRange` 在此收尾」（`lyricRangeEnd`），T5 据此把 `w:` 放到行后。
 *
 * ## `L:` 重放（决策 3）
 *
 * `Voice.unitLengthChanges` 是 voice-local 的 effective transition，直接按 `raw` 重放
 * 即可。但 canonical 把各声部 body **顺序排开**（voice1 全部行 → voice2 全部行），而
 * 源文本里 `L:` 是**文档级**的：voice1 末尾生效的 `L:` 会漏到 voice2 开头。因此每个
 * 声部开头都要检查「上一个声部留下的生效值」与「本声部第一个事件应有的生效值」是否
 * 一致，不一致就补一行 `L:`（`incomingUnitLength` / `outgoingUnitLength` 为此在声部间
 * 传递）。描述头没有 `L:`（`headerUnitLength` 为 `undefined`）却需补写时无值可写，发
 * `jcx.serialize.unit-length-unrecoverable` warning。
 *
 * ## 已知限制（M1.7 T4 实测，T7 落 HANDOFF）
 *
 * 1. 深度畸形输入不保留词法扫描上下文：未闭合 `[` 里的 `|` 在原文里是
 *    `UnknownEvent`，canonical 原样写回后脱离了那个非法上下文，重解析成
 *    `barline`（文本一致，只是分类变；fixture `unclosed-chord.jcx`）。
 *    该 tokenKind 漂移**仍在**，`roundtrip.test.ts` 的 `L2_KNOWN_LIMITATION` 保留；
 *    被修掉的只是断行（`breaksLineAfter`），故 **canon1 起即为不动点**。
 * 2. ~~`TabGroupEvent.stroke` parse 层从不填充~~ **已回填（2026-09-22，M2.5
 *    formats preflight）**：紧邻 `tabGroup` 的 `strokePrefix`（`V[ax/bx/]` 的
 *    `V`）现由 `scanTab.ts` 的 `scanTopLevelItems` 绑进 `TabGroupEvent.stroke`，
 *    `bodyEvents.ts` 里 `${event.stroke ?? ''}[...]` 的写回规则随之生效；真悬空
 *    的 strokePrefix（不紧邻 `[` 或弦号）仍是 UNVERIFIED，不建模、不写回（§26.4）。
 * 3. 组级时值后缀 `[CEG]2` 的 `2` 被 parse 落成独立 `UnknownEvent`，
 *    canonical 因此输出 `[CEG] 2`（往返一致，但形态与源文本不同）。
 */

import type {
  EventId,
  LyricBodyRange,
  MusicEvent,
  Rational,
  UnitLengthChange,
  Voice,
} from '../../../../domain';
import { equals } from '../../../../domain';
import { renderEvent } from './bodyEvents';
import { buildRelationMarkers } from './bodyRelations';
import type { RelationMarkers } from './bodyRelations';
import { canonicalWarning } from './diagnostic';
import type { CanonicalDiagnostic } from './voice';
import { canonicalVoiceLabel } from './voice';

export interface CanonicalBodyLine {
  readonly text: string;
  /** 该行覆盖的事件区间；`[V:n]` / `L:` 等非事件行为 `null`。 */
  readonly range: LyricBodyRange | null;
  /** 在本行收尾的 `LyricLine.bodyRange`（T5 据此把 `w:` 放在本行之后）。 */
  readonly lyricRangeEnd: LyricBodyRange | null;
}

export interface CanonicalBodyInput {
  /** 描述头 `L:` 的值；声部开头需要补 `L:` 时写它。 */
  readonly headerUnitLength: Rational | undefined;
  /** 进入本声部时文档级生效的单位音长（上一个声部的 `outgoingUnitLength`）。 */
  readonly incomingUnitLength: Rational | undefined;
}

export interface CanonicalVoiceBody {
  readonly lines: readonly CanonicalBodyLine[];
  readonly outgoingUnitLength: Rational | undefined;
  readonly diagnostics: readonly CanonicalDiagnostic[];
}

function sameUnitLength(a: Rational | undefined, b: Rational | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return equals(a, b);
}

function plainLine(text: string): CanonicalBodyLine {
  return { text, range: null, lyricRangeEnd: null };
}

// ---------------------------------------------------------------------------
// 断行规划
// ---------------------------------------------------------------------------

interface Segment {
  readonly start: number;
  readonly end: number;
}

interface LinePlan {
  readonly segments: readonly Segment[];
  /** 事件下标 → 在该下标收尾的歌词范围。 */
  readonly rangeEndAt: ReadonlyMap<number, LyricBodyRange>;
  readonly diagnostics: readonly CanonicalDiagnostic[];
}

/** 去重后的歌词范围（裁决④）：同一条正文的多个 verse 只规划一次断行。 */
function collectRanges(
  voice: Voice,
  indexOf: ReadonlyMap<EventId, number>,
  diagnostics: CanonicalDiagnostic[],
): { readonly startAt: Map<number, number>; readonly endAt: Map<number, LyricBodyRange> } {
  const startAt = new Map<number, number>();
  const endAt = new Map<number, LyricBodyRange>();
  const seen = new Set<string>();
  for (const line of voice.lyricLines) {
    const range = line.bodyRange;
    if (range === null) {
      continue;
    }
    const key = `${range.firstEventId}#${range.lastEventId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const start = indexOf.get(range.firstEventId);
    const end = indexOf.get(range.lastEventId);
    if (start === undefined || end === undefined || end < start) {
      diagnostics.push(
        canonicalWarning(
          'jcx.serialize.lyric-range-unresolved',
          `声部 ${voice.id} 的歌词行 bodyRange（${range.firstEventId} … ${range.lastEventId}）` +
            `在事件流里定位不到或首尾颠倒，按无强制断行处理`,
        ),
      );
      continue;
    }
    if (!startAt.has(start)) {
      startAt.set(start, end);
    }
    if (!endAt.has(end)) {
      endAt.set(end, range);
    }
  }
  return { startAt, endAt };
}

/**
 * 该事件之后是否断行。`UnknownEvent(tokenKind:'barline')` 也算：它写出的 `|` 在输出
 * 文本里就是合法小节线，行规划不与之一致则 canon1 不是不动点（限制①）。
 * **M1.8 T1 approved exception**：M1.8 唯一获准的 `src/` 行为变更，作用域仅断行规划，
 * 不得扩展到事件文本 / relation / `L:` / parser / Domain / 其他 canonical 行为。
 */
function breaksLineAfter(event: MusicEvent | undefined): boolean {
  return event?.kind === 'barline' || (event?.kind === 'unknown' && event.tokenKind === 'barline');
}

function planLines(
  voice: Voice,
  indexOf: ReadonlyMap<EventId, number>,
  breakBefore: ReadonlySet<number>,
): LinePlan {
  const diagnostics: CanonicalDiagnostic[] = [];
  const { startAt, endAt } = collectRanges(voice, indexOf, diagnostics);
  const events = voice.events;
  const segments: Segment[] = [];

  let i = 0;
  while (i < events.length) {
    const forcedEnd = startAt.get(i);
    let end: number;
    if (forcedEnd === undefined) {
      end = i;
      // 小节线收尾；中途遇到强制断行点 / 歌词行起点 / 上一条歌词行的结尾则提前收。
      while (end < events.length - 1) {
        if (breaksLineAfter(events[end]) || endAt.has(end)) {
          break;
        }
        const next = end + 1;
        if (startAt.has(next) || breakBefore.has(next)) {
          break;
        }
        end = next;
      }
    } else {
      end = forcedEnd;
    }
    // 裁决①：`L:` 的断行点优先级最高，必要时把歌词行切开（并告警）。
    for (let cut = i + 1; cut <= end; cut += 1) {
      if (breakBefore.has(cut)) {
        if (forcedEnd !== undefined) {
          diagnostics.push(
            canonicalWarning(
              'jcx.serialize.lyric-line-split',
              `声部 ${voice.id} 的一条 w: 覆盖的正文里出现了 L: 变化点，` +
                `按裁决①优先保证 L: 紧贴生效事件断行，该正文被切成多行，音节对齐会漂移`,
            ),
          );
        }
        end = cut - 1;
        break;
      }
    }
    segments.push({ start: i, end });
    i = end + 1;
  }

  return { segments, rangeEndAt: endAt, diagnostics };
}

// ---------------------------------------------------------------------------
// 行文本
// ---------------------------------------------------------------------------

function renderSegment(
  events: readonly MusicEvent[],
  segment: Segment,
  markers: RelationMarkers,
): string {
  let text = '';
  let separator = '';
  for (let k = segment.start; k <= segment.end; k += 1) {
    const event = events[k];
    if (event === undefined) {
      continue;
    }
    text += separator;
    text += markers.prefix.get(event.id) ?? '';
    text += renderEvent(event, markers.memberSuffix);
    text += markers.suffix.get(event.id) ?? '';
    separator = markers.separatorAfter.get(event.id) ?? ' ';
  }
  // 关系的对端落到了下一行：marker 留在本行末尾（`C2>` / `a1-S-`），
  // 重解析按事件序配对，与行无关。
  const last = events[segment.end];
  if (last !== undefined && markers.separatorAfter.has(last.id)) {
    text += markers.separatorAfter.get(last.id) ?? '';
  }
  return text;
}

/** `L:` 的值形态（spec §8.5）；`unitLength` 本身就是单位音长事实，不是时值反算。 */
function formatUnitLength(unitLength: Rational): string {
  return `${String(unitLength.num)}/${String(unitLength.den)}`;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 渲染一个声部的 body（含 `[V:n]` 行与 `L:` 行，不含 `w:` 行）。
 *
 * 声部没有任何事件时返回空行数组（连 `[V:n]` 都不写）：没有正文的声部只有
 * `V:` 声明行，写一个空的 `[V:n]` 既没有事实依据，也会成为 `w:` 的绑定目标。
 */
export function renderVoiceBody(voice: Voice, input: CanonicalBodyInput): CanonicalVoiceBody {
  const diagnostics: CanonicalDiagnostic[] = [];
  const events = voice.events;
  if (events.length === 0) {
    return { lines: [], outgoingUnitLength: input.incomingUnitLength, diagnostics };
  }

  const indexOf = new Map<EventId, number>();
  const byId = new Map<EventId, MusicEvent>();
  events.forEach((event, index) => {
    indexOf.set(event.id, index);
    byId.set(event.id, event);
  });

  const markers = buildRelationMarkers(voice, byId);
  diagnostics.push(...markers.diagnostics);

  // 变化点 → 该处要重放的 `L:`（同一位置多条时按数组序）。
  const changesAt = new Map<number, UnitLengthChange[]>();
  for (const change of voice.unitLengthChanges) {
    const index = indexOf.get(change.beforeEventId);
    if (index === undefined) {
      diagnostics.push(
        canonicalWarning(
          'jcx.serialize.unit-length-unresolved',
          `声部 ${voice.id} 的 L: 变化点 ${change.beforeEventId} 在事件流里定位不到，未重放`,
          change.origin,
        ),
      );
      continue;
    }
    const bucket = changesAt.get(index) ?? [];
    bucket.push(change);
    changesAt.set(index, bucket);
  }

  const plan = planLines(voice, indexOf, new Set(changesAt.keys()));
  diagnostics.push(...plan.diagnostics);

  const lines: CanonicalBodyLine[] = [plainLine(`[V:${canonicalVoiceLabel(voice.id)}]`)];
  let current = input.incomingUnitLength;

  // 上一个声部留下的文档级 `L:` 与本声部开头应有的生效值不一致时补一行。
  if (!changesAt.has(0) && !sameUnitLength(current, input.headerUnitLength)) {
    if (input.headerUnitLength === undefined) {
      diagnostics.push(
        canonicalWarning(
          'jcx.serialize.unit-length-unrecoverable',
          `声部 ${voice.id} 的正文需要把单位音长复位到「描述头的值」，` +
            `但描述头没有 L:（Score.unitLength 缺省），canonical 无值可写，不猜`,
        ),
      );
    } else {
      lines.push(plainLine(`L: ${formatUnitLength(input.headerUnitLength)}`));
      current = input.headerUnitLength;
    }
  }

  for (const segment of plan.segments) {
    for (const change of changesAt.get(segment.start) ?? []) {
      lines.push(plainLine(`L: ${change.raw.trim()}`));
      current = change.unitLength;
    }
    const first = events[segment.start];
    const last = events[segment.end];
    const range: LyricBodyRange | null =
      first === undefined || last === undefined
        ? null
        : { firstEventId: first.id, lastEventId: last.id };
    lines.push({
      text: renderSegment(events, segment, markers),
      range,
      lyricRangeEnd: plan.rangeEndAt.get(segment.end) ?? null,
    });
  }

  // 成员数为 0 的 tuplet（marker 之后没有可吸收的事件）：确定性追加到 body 末尾，
  // 不静默丢 relation（裁决③）。
  if (markers.trailing.length > 0) {
    const tail = lines[lines.length - 1];
    const suffix = markers.trailing.join(' ');
    if (tail === undefined || tail.range === null) {
      lines.push(plainLine(suffix));
    } else {
      lines[lines.length - 1] = { ...tail, text: `${tail.text} ${suffix}` };
    }
  }

  return { lines, outgoingUnitLength: current, diagnostics };
}
