/**
 * notation/staff —— **单个事件 → 单个节点**的构造（M2 T7.2）。
 *
 * 十种 `MusicEvent.kind` 一个不少地穷尽 `switch`（`default` 分支的 `never` 赋值会在
 * Domain 新增事件类型时立刻编译报错）。契约与 jianpu / tab 侧完全一致：**C1** 每个
 * 事件恰好一个节点（`UnknownEvent` 也有可见占位）；**C2** 降级节点 `fallback: true`
 * 且至少关联一条诊断——其中 `durationUnresolved` / `durationUnrepresentable` 已由
 * `buildRenderScore` 在 event 级发出，本层只产占位不重复报告（§4.2）；**C3** 本层
 * 发出的诊断 `anchor` 指向该事件本身。
 *
 * **零 VexFlow 编码**：不出现 `c/4` / `q` / `#` / `b` 这类渲染器记号，音高与时值一律
 * 经 `staffPitch.ts` / `staffDurations.ts` 转成 renderer-neutral 语义值；转成渲染器
 * 编码是 T7.4 在 `src/renderer/integrations/vexflow/**` 里做的事。**不 import
 * `jianpu/**` / `tab/**` / `chord/**`**：与 `tabEventNodes.ts` 的 cursor → node → sink
 * 写法同构是**照抄结构**，不是共享代码。
 *
 * 结构上先算一个 `StaffNodePlan`（这个事件该画成什么）再拼几何字段：把「画什么」与
 * 「画在哪一列」分开，`staffSlotWidths.ts` 就能在没有几何的情况下问同一个问题（占位
 * 文本有多宽），两处不可能给出不同答案。本文件不含任何尺寸常量（P2-2 天然满足）。
 */

import type { MusicEvent, Note, Rational, Rest, TabNote, VoiceId } from '../../domain';
import { chordSymbolDisplayText } from '../layout/chordSymbolDisplay';
import { summarizeEvent } from '../layout/fallbackSummary';
import type { SpacedSlot } from '../layout/spacing';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../model/diagnostics';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { Anchor, RenderItem } from '../model/types';
import { toStaffDuration } from './staffDurations';
import { toStaffPitch } from './staffPitch';
import type {
  StaffBarlineForm,
  StaffDuration,
  StaffEventNode,
  StaffFallbackReason,
  StaffNotePitch,
} from './staffTypes';

/** 诊断草稿的收集口，与 tab 侧的 `DraftSink` 同构（各记谱各自声明，不跨目录共享）。 */
export type StaffDraftSink = (draft: RenderDiagnosticDraft) => void;
/** 一个已经定好归属的事件；**没有 x**——横向真源见 `StaffStaveSpec` 的说明。 */
export interface StaffCursor {
  readonly item: RenderItem;
  readonly slot: SpacedSlot;
  readonly measureIndex: number;
  readonly systemIndex: number;
}

/** 「这个事件该画成什么」——纯语义，不含任何几何。 */
export type StaffNodePlan =
  | { readonly kind: 'placeholder'; readonly reason: StaffFallbackReason; readonly text: string }
  | { readonly kind: 'note'; readonly pitches: readonly StaffNotePitch[]; readonly duration: StaffDuration }
  | { readonly kind: 'rest'; readonly variant: 'z' | 'Z' | '@'; readonly duration: StaffDuration }
  | { readonly kind: 'chordSymbol'; readonly text: string }
  | { readonly kind: 'barline'; readonly raw: string; readonly form: StaffBarlineForm };

/** 事件级 `Anchor`：节点与诊断共用同一个定义（§0d-1），不另设别名。 */
function eventAnchor(voiceId: VoiceId, item: RenderItem): Anchor {
  return { kind: 'event', voiceId, eventId: item.eventId };
}

function draftOf(
  code: RenderDiagnosticDraft['code'],
  level: 'info' | 'warning',
  message: string,
  anchor: Anchor,
  sourceRef: RenderDiagnosticDraft['sourceRef'],
): RenderDiagnosticDraft {
  return sourceRef === undefined
    ? { code, level, message, anchor }
    : { code, level, message, anchor, sourceRef };
}

/**
 * `BarlineEvent.raw` → 形态。**spec §18 的完整表逐条列出**（9 种），表外组合归
 * `unrecognized`（§18 末段：宽容识别）。TAB 侧只认其中 4 种，本层不照抄那份收窄
 * ——五线谱本来就要画双线 / 反复 / 虚线。
 */
export function classifyStaffBarline(raw: string): StaffBarlineForm {
  switch (raw) {
    case '|':
      return 'single';
    case '|]':
      return 'final';
    case '||':
      return 'double';
    case '[|':
      return 'start';
    case ':|':
      return 'repeatEnd';
    case '|:':
      return 'repeatStart';
    case '::':
      return 'repeatBoth';
    case '[:]':
      return 'dashed';
    case '[|]':
      return 'invisible';
    default:
      return 'unrecognized';
  }
}

/** 时值的两种去向：画得出符头，或降级成占位（附原因）。 */
type StaffTiming =
  | { readonly kind: 'ok'; readonly duration: StaffDuration }
  | { readonly kind: 'fallback'; readonly reason: StaffFallbackReason };

/**
 * **必须先判 `duration === undefined` 再调 `toStaffDuration`**：后者把「缺失」与「分解
 * 不成立」并进同一个 `unrepresentable`，事后无法区分（见 `staffDurations.ts` 的 ⚠️）。
 */
function timingOf(duration: Rational | undefined): StaffTiming {
  if (duration === undefined) return { kind: 'fallback', reason: 'durationUnresolved' };
  const resolved = toStaffDuration(duration);
  switch (resolved.kind) {
    case 'unrepresentable':
      return { kind: 'fallback', reason: 'durationUnrepresentable' };
    case 'beyondGlyphRange':
      return { kind: 'fallback', reason: 'durationBeyondGlyphRange' };
    default:
      return { kind: 'ok', duration: resolved.duration };
  }
}

function isNoteMember(member: Note | Rest): member is Note {
  return 'pitch' in member;
}
function isPitchGraceMember(member: Note | TabNote): member is Note {
  return 'pitch' in member;
}
/**
 * 一个音符成员 → 一项 `pitches`，**显式记下 Domain 原始成员下标**（单音恒 0；和弦块
 * 取 `members` 的原始下标，休止成员被剔除后下标仍指原位）。端点身份显式保存、adapter
 * 不重放筛选规则——与 `TabFretGlyph.memberIndex`（T6.3）同一条裁决。
 */
function pitchOf(member: Note, memberIndex: number): StaffNotePitch {
  return { memberIndex, pitch: toStaffPitch(member.pitch, member.accidental) };
}

/** 倚音占位文本：pitch 成员画小写音名 + 原始八度修饰；TAB 成员画 `<弦号>/<品位>`，**绝不把弦品猜成音高**（spec §26.10）。 */
function graceText(members: readonly (Note | TabNote)[]): string {
  return members
    .map((member) =>
      isPitchGraceMember(member)
        ? member.pitch.letter.toLowerCase() + (member.pitch.octaveRaw ?? '')
        : `${String(member.stringIndex)}/${String(member.fret)}`,
    )
    .join('');
}

/** 时值降级时的占位文本：事件摘要（音名 / 休止变体 / 成员摘要）+ 原始时值文本。 */
function timedPlaceholderText(event: MusicEvent, durationRaw: string | undefined): string {
  return summarizeEvent(event) + (durationRaw ?? '');
}
/** 「这个事件该画成什么」——**唯一来源**，`buildStaffNode` 与 `staffSlotWidths.ts` 共用；纯函数、不发诊断。 */
export function planStaffNode(event: MusicEvent): StaffNodePlan {
  switch (event.kind) {
    case 'note': {
      const timing = timingOf(event.note.duration);
      return timing.kind === 'fallback'
        ? { kind: 'placeholder', reason: timing.reason, text: timedPlaceholderText(event, event.note.durationRaw) }
        : { kind: 'note', pitches: [pitchOf(event.note, 0)], duration: timing.duration };
    }
    case 'chord': {
      const timing = timingOf(event.duration);
      if (timing.kind === 'fallback') {
        return { kind: 'placeholder', reason: timing.reason, text: timedPlaceholderText(event, undefined) };
      }
      // `flatMap` 而不是 `filter().map()`：后者拿不到**原始**下标（filter 之后下标
      // 已经重排），而下标正是 T7.4 把关系端点落到 keys 上的唯一依据。
      const pitches = event.members.flatMap((member, memberIndex) =>
        isNoteMember(member) ? [pitchOf(member, memberIndex)] : [],
      );
      // 成员全是休止（`[zz]`）：一个音头都画不出，但事件不能凭空消失（C1），
      // 也**不得**产出 `pitches: []` 的音符节点（T7.4 会拿它去喂一个空 keys 的音符）。
      return pitches.length === 0
        ? { kind: 'placeholder', reason: 'chordAllMembersRest', text: summarizeEvent(event) }
        : { kind: 'note', pitches, duration: timing.duration };
    }
    case 'rest': {
      const timing = timingOf(event.rest.duration);
      return timing.kind === 'fallback'
        ? { kind: 'placeholder', reason: timing.reason, text: timedPlaceholderText(event, event.rest.durationRaw) }
        : { kind: 'rest', variant: event.rest.variant, duration: timing.duration };
    }
    case 'grace':
      return { kind: 'placeholder', reason: 'grace', text: graceText(event.members) };
    case 'decoration':
      return {
        kind: 'placeholder',
        reason: 'decoration',
        text: event.decoration.form === 'simple' ? event.decoration.name : event.decoration.raw,
      };
    case 'unknown':
      return { kind: 'placeholder', reason: 'unknown', text: event.raw };
    case 'tabNote':
    case 'tabGroup':
      // 原样转述，不假装是任何一种记谱法（同 `fallbackSummary.ts` 的一贯做法）。
      return { kind: 'placeholder', reason: 'outOfScope', text: summarizeEvent(event) };
    case 'chordSymbol':
      return { kind: 'chordSymbol', text: chordSymbolDisplayText(event.symbol.raw) };
    case 'barline':
      return { kind: 'barline', raw: event.raw, form: classifyStaffBarline(event.raw) };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** 事件本身的事实型诊断（与 plan 无关：越界 / 倚音 / 装饰 / 未知 / 休止变体 / 表外小节线）。 */
function sinkEventFacts(event: MusicEvent, anchor: Anchor, ref: RenderItem['sourceRef'], sink: StaffDraftSink): void {
  switch (event.kind) {
    case 'tabNote':
    case 'tabGroup':
      sink(draftOf(CODES.staffEventOutOfScope, 'warning', `事件类型 ${event.kind} 是 TAB 专属事件，不属于五线谱渲染范围：画成可见占位，不把弦品猜成音高（spec §26.10：音高与弦品之间没有可逆映射）`, anchor, ref));
      return;
    case 'grace':
      // **逐个 grace event 一条**，不做声部级聚合：倚音出现在哪里是事件级事实。
      sink(draftOf(CODES.staffGraceNotModeled, 'info', '倚音未建模五线谱专属几何（小符头 / 斜杠 / 与主音的连接）：画成可见占位并如实标注，不按普通音符画出来假装支持', anchor, ref));
      return;
    case 'decoration':
      sink(draftOf(CODES.decorationPlaceholder, 'info', '装饰记号只画统一文本占位：M2 不做符号字形映射（spec §23 U27–U30）', anchor, ref));
      return;
    case 'unknown':
      sink(draftOf(CODES.eventUnknown, 'warning', '未知事件画成可见占位，不静默跳过（契约 C1：恰好一个可见节点）', anchor, ref));
      return;
    case 'rest': {
      // `Z` 与 `@` 各有各的 code：语义不同，合并会让后续拿到新语料时无法区分。
      const variant = event.rest.variant;
      const code = variant === 'Z' ? CODES.restMultiMeasureNotModeled
        : variant === '@' ? CODES.restInvisibleNotModeled : undefined;
      if (code !== undefined) {
        sink(draftOf(code, 'info', `休止 ${variant} 的语义 UNVERIFIED：按普通休止画并照常占位，既不画多小节休止也不隐藏`, anchor, ref));
      }
      return;
    }
    case 'barline':
      if (classifyStaffBarline(event.raw) === 'unrecognized') {
        sink(draftOf(CODES.barlineUnrecognized, 'info', `小节线 ${JSON.stringify(event.raw)} 不在 spec §18 已知形态表内：画普通单线，不推断反复语义`, anchor, ref));
      }
      return;
    default:
      return;
  }
}

/** 和弦块里的休止成员数（其余 kind 无成员概念，恒 0）。 */
function restMemberCountOf(event: MusicEvent): number {
  if (event.kind !== 'chord') return 0;
  return event.members.length - event.members.filter(isNoteMember).length;
}

/** plan 与音高相关的诊断：混合方向八度、和弦块里的休止成员、时值细过符头范围。 */
function sinkPlanDiagnostics(
  plan: StaffNodePlan,
  event: MusicEvent,
  anchor: Anchor,
  ref: RenderItem['sourceRef'],
  sink: StaffDraftSink,
): void {
  if (plan.kind === 'note' && plan.pitches.some((entry) => entry.pitch.mixedOctave)) {
    sink(draftOf(CODES.staffOctaveMixed, 'warning', "八度修饰同时含 `'` 与 `,`（spec §14.2 UNVERIFIED，不实现抵消）：只按字母大小写定基准八度，不把两个方向相加或相消", anchor, ref));
  }
  const restMembers = restMemberCountOf(event);
  if (restMembers > 0) {
    sink(draftOf(CODES.staffChordMemberRestNotModeled, 'info', `和弦块里有 ${String(restMembers)} 个休止成员：五线谱不单独建模「和弦块内的休止」，只画音符成员；成员全是休止时整块降级成可见占位`, anchor, ref));
  }
  if (plan.kind === 'placeholder' && plan.reason === 'durationBeyondGlyphRange') {
    sink(draftOf(CODES.staffDurationBeyondGlyphRange, 'warning', '时值细过本层的符头范围上限（128 分音符，见 staffDurations.ts 的产品决定）：画成可见占位，不四舍五入到最近的可画时值', anchor, ref));
  }
}

/**
 * 是否降级。占位恒算；另有三种「画得出但与作者所写不完全对应」：表外小节线、
 * `Z`/`@` 休止、含休止成员的和弦块——三者都各自发过诊断（C2）。
 */
function isFallback(plan: StaffNodePlan, event: MusicEvent): boolean {
  if (plan.kind === 'placeholder') return true;
  if (plan.kind === 'barline') return plan.form === 'unrecognized';
  if (plan.kind === 'rest') return plan.variant !== 'z';
  return restMemberCountOf(event) > 0;
}

/** 单个事件 → 单个节点（C1）。诊断一律经 `sink`，本函数不返回诊断。 */
export function buildStaffNode(
  cursor: StaffCursor,
  voiceId: VoiceId,
  sink: StaffDraftSink,
): StaffEventNode {
  const { item } = cursor;
  const event = item.event;
  const anchor = eventAnchor(voiceId, item);
  const plan = planStaffNode(event);

  sinkEventFacts(event, anchor, item.sourceRef, sink);
  sinkPlanDiagnostics(plan, event, anchor, item.sourceRef, sink);

  return {
    ...plan,
    anchor,
    sourceRef: item.sourceRef,
    slot: { slotIndex: cursor.slot.slot.index, width: cursor.slot.slot.width },
    measureIndex: cursor.measureIndex,
    systemIndex: cursor.systemIndex,
    fallback: isFallback(plan, event),
  };
}
