/**
 * canonical 序列化 —— relation 反写成 marker（M1.7 T4，方案 v1.1 §3 relation 行 / 决策 1、4）。
 *
 * Domain 把 `-` / `()` / `(3` / `-S-` / `>` 五类 marker 都消费成了 Relation，
 * canonical 必须把它们放回事件流里**原来那个位置**——位置不是存下来的，而是由
 * 关系的端点唯一决定的（`pairTies` / `pairSlurs` / `pairTuplets` /
 * `pairTabRelations` / `pairBrokenRhythm` 的配对算法是确定性的，把 marker 放回
 * 端点旁边，重新解析就会配回同一对端点）。
 *
 * **marker 叠加顺序**（多条 relation 落在同一个事件上时的确定性写法）：
 *
 * ```
 * [tuplet.raw][slur '(' …] 事件本体 [tie '-'][slur ')' …][分隔符]
 * 分隔符 = brokenRhythm.raw | TAB '-S-'/'-H-'/'-P-' | 单个空格
 * ```
 *
 * 组成员级 marker（`[C-E-]`、`[a1-S-a3]`、`{d8-S-}`）写在该成员之后、括号内，
 * 同一成员上 tie 在前、TAB 标记在后。
 *
 * 几条落位裁决：
 * - **tie 的整组折叠**：`[CEG]-` 在 Domain 里是 3 条成员级 tie（`pairTies` 的
 *   「组 → 任意」分支逐成员结算）。若某个组事件的 tie 恰好覆盖全部成员各一次、
 *   且状态与对端事件一致，就折叠回**事件级**的一个 `-`；否则逐成员写。
 *   不折叠地逐成员写会改变重解析结果：成员级 marker 各自用独立的 `used` 集合
 *   配对，`[CC]-[CC]` 这种同音重复的组会把两条 tie 都配到对端第 0 个成员。
 * - **TAB 标记的落位**：两端在同一个组内 → 写在前一个成员之后（`[a1-S-a3]`）；
 *   起点是组的**最后一个**成员而终点在组外 → 写在组尾（语料主形态 `{d8-S-}d10`，
 *   也是倚音组唯一可行的写法：`{…}` 不是 `-S-` 的合法事件级端点）；其余
 *   （起点是组内非末成员、终点在组外）写成**事件级**分隔符，即原文形态
 *   `[a1b2]-S-a3`，重解析会按同一套 `resolveSameString` 定回同一对成员。
 * - **成员数为 0 的 tuplet**（marker 写在声部末尾，之后没有可吸收的事件）没有
 *   可锚定的事件，按事实写回到 body 末尾（`trailing`），重解析仍得到一条
 *   `status:'incomplete'`、`members: []` 的 tuplet。
 */

import type { EventId, MusicEvent, Tie, Voice } from '../../../../domain';
import { noteRefKey } from '../../../../domain';
import { canonicalWarning } from './diagnostic';
import type { CanonicalDiagnostic } from './voice';

export interface RelationMarkers {
  /** 事件本体之前（tuplet raw + slur `(`）。 */
  readonly prefix: ReadonlyMap<EventId, string>;
  /** 事件本体之后（tie `-` + slur `)`）。 */
  readonly suffix: ReadonlyMap<EventId, string>;
  /** key 为 `noteRefKey(ref)`；写在该组成员之后、括号内。 */
  readonly memberSuffix: ReadonlyMap<string, string>;
  /** 该事件与其后一个事件之间的分隔符（替代空格）。 */
  readonly separatorAfter: ReadonlyMap<EventId, string>;
  /** 无处锚定、只能写在 body 末尾的 marker（成员数为 0 的 tuplet）。 */
  readonly trailing: readonly string[];
  readonly diagnostics: readonly CanonicalDiagnostic[];
}

const TAB_MARKERS: ReadonlyMap<string, string> = new Map([
  ['slide', '-S-'],
  ['hammer', '-H-'],
  ['pull', '-P-'],
]);

interface Builder {
  readonly prefix: Map<EventId, string>;
  readonly suffix: Map<EventId, string>;
  readonly memberSuffix: Map<string, string>;
  readonly separatorAfter: Map<EventId, string>;
  readonly trailing: string[];
  readonly diagnostics: CanonicalDiagnostic[];
}

function append<K>(map: Map<K, string>, key: K, text: string): void {
  map.set(key, `${map.get(key) ?? ''}${text}`);
}

/** chord / tabGroup / grace 的成员数；非组合事件返回 `undefined`。 */
function memberCountOf(event: MusicEvent | undefined): number | undefined {
  if (event === undefined) {
    return undefined;
  }
  switch (event.kind) {
    case 'chord':
    case 'tabGroup':
    case 'grace':
      return event.members.length;
    default:
      return undefined;
  }
}

/** tie 组恰好覆盖 `count` 个成员各一次，且状态 / 对端一致 → 可折叠成事件级 `-`。 */
function collapsible(ties: readonly Tie[], count: number): boolean {
  if (count === 0 || ties.length !== count) {
    return false;
  }
  const seen = new Set<number>();
  const first = ties[0];
  if (first === undefined) {
    return false;
  }
  const target = first.status === 'resolved' ? first.to.eventId : undefined;
  for (const tie of ties) {
    const index = tie.from.memberIndex;
    if (index === undefined || index < 0 || index >= count || seen.has(index)) {
      return false;
    }
    seen.add(index);
    if (tie.status !== first.status) {
      return false;
    }
    if (tie.status === 'resolved' && tie.to.eventId !== target) {
      return false;
    }
  }
  return true;
}

function buildTies(voice: Voice, events: ReadonlyMap<EventId, MusicEvent>, out: Builder): void {
  const byEvent = new Map<EventId, Tie[]>();
  for (const tie of voice.ties) {
    const bucket = byEvent.get(tie.from.eventId) ?? [];
    bucket.push(tie);
    byEvent.set(tie.from.eventId, bucket);
  }
  for (const [id, ties] of byEvent) {
    const count = memberCountOf(events.get(id));
    if (count !== undefined && collapsible(ties, count)) {
      append(out.suffix, id, '-');
      continue;
    }
    for (const tie of ties) {
      if (tie.from.memberIndex === undefined) {
        append(out.suffix, id, '-');
      } else {
        append(out.memberSuffix, noteRefKey(tie.from), '-');
      }
    }
  }
}

function buildSlurs(voice: Voice, out: Builder): void {
  for (const slur of voice.slurs) {
    append(out.prefix, slur.from, '(');
    if (slur.status === 'closed') {
      append(out.suffix, slur.to, ')');
    }
  }
}

function buildTuplets(voice: Voice, out: Builder): void {
  for (const tuplet of voice.tuplets) {
    const first = tuplet.members[0];
    if (first === undefined) {
      out.trailing.push(tuplet.raw);
      continue;
    }
    // 按 `voice.tuplets` 数组顺序**追加**（与 `buildSlurs` 一致）：两个 tuplet
    // 共享同一个首成员（`(3(3:2:3C …`）时，前插会把顺序写反，重解析得到的
    // `tuplets` 数组顺序与原 Domain 相反。tuplet 整体仍排在 slur `(` 之前，
    // 靠的是 `buildRelationMarkers` 里 `buildTuplets` 先于 `buildSlurs` 调用。
    append(out.prefix, first, tuplet.raw);
  }
}

function buildTabRelations(
  voice: Voice,
  events: ReadonlyMap<EventId, MusicEvent>,
  out: Builder,
): void {
  for (const relation of voice.tabRelations) {
    const marker = TAB_MARKERS.get(relation.kind);
    if (marker === undefined) {
      continue;
    }
    const { from, to } = relation;
    const count = memberCountOf(events.get(from.eventId));
    const sameGroup = from.eventId === to.eventId;
    const atGroupEnd = count !== undefined && from.memberIndex === count - 1;
    if (from.memberIndex !== undefined && (sameGroup || atGroupEnd)) {
      append(out.memberSuffix, noteRefKey(from), marker);
      continue;
    }
    if (from.memberIndex !== undefined && !atGroupEnd) {
      out.diagnostics.push(
        canonicalWarning(
          'jcx.serialize.tab-relation-member-position',
          `TAB 连接关系 ${relation.id} 的起点是组内第 ${String(from.memberIndex)} 个成员（不是末成员）` +
            `而终点在组外，canonical 只能写成事件级的 ${marker}，` +
            `重解析时由 spec §26.6 的同弦规则重新定位成员`,
          relation.origins[0],
        ),
      );
    }
    out.separatorAfter.set(from.eventId, marker);
  }
}

function buildBrokenRhythms(voice: Voice, out: Builder): void {
  for (const broken of voice.brokenRhythms) {
    out.separatorAfter.set(broken.from, broken.raw);
  }
}

/** 把一个声部的五类 relation 折算成「写在哪个位置的哪段文本」。 */
export function buildRelationMarkers(
  voice: Voice,
  events: ReadonlyMap<EventId, MusicEvent>,
): RelationMarkers {
  const out: Builder = {
    prefix: new Map(),
    suffix: new Map(),
    memberSuffix: new Map(),
    separatorAfter: new Map(),
    trailing: [],
    diagnostics: [],
  };
  buildTies(voice, events, out);
  // 顺序即写出顺序：tuplet 先于 slur `(`（`(3(CDE)`，见 `buildTuplets`）。
  buildTuplets(voice, out);
  buildSlurs(voice, out);
  buildTabRelations(voice, events, out);
  buildBrokenRhythms(voice, out);
  return out;
}
