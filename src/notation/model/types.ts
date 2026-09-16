/**
 * notation/model —— 渲染中立模型的**最小骨架**（M2 方案 v1.1.1 §2.2 / §2.4.1 / §2.6 / §2.7）。
 *
 * 三条硬约束（守卫测试 `tests/unit/notation/architecture.test.ts` 钉死）：
 * - **仍是 flat**：Domain 的 `Voice.events` 是扁平事件流，本层不引入 `Measure` /
 *   `System` / `TimeSlot`——它们一律在 `notation/layout/` 派生（§2.6）。
 * - **不设万能 LayoutModel**：本文件只放 `RenderInput` 与 `RenderScore` 这类跨记谱
 *   语义完全一致的稳定类型；四种记谱各自的几何模型互不继承（§2.7）。
 * - **index 只能由入口传入**：本层不得重建 `EventId → MusicEvent` /
 *   `RelationId → Relation` 这两种 Domain lookup（§2.4.1）。
 *
 * `buildRenderScore(input: RenderInput): RenderScore` 由 T1 实现，本文件只定义契约。
 */

import type {
  DomainIndex,
  EventId,
  MusicEvent,
  RelationId,
  Score,
  SourceRef,
  Voice,
  VoiceId,
} from '../../domain';

/**
 * 指向渲染产物的哪里——**判别联合，不是「字段可选」**（§4.2，P1-B）。
 *
 * 它属于 render identity / reference，`RenderDiagnostic` 与 layout node **共享同一个
 * 定义**，因此住在 `types.ts` 而不是 `diagnostics.ts`。
 *
 * 可选字段形态（`{ voiceId?, eventId?, relationId? }`）允许
 * `{ voiceId: undefined, eventId: 'e1' }` 这种自相矛盾的值存在，正是
 * `src/domain/relation.ts` 文件头论证过、并在 Domain 层拒绝掉的形态。
 * 判别联合让契约 C3「无悬空 anchor」真正可判定：每个 `kind` 分支要查什么是确定的。
 *
 * **C3 的逐分支解析目标**（四个分支都要真的查到东西，没有「恒成立」的分支）：
 * - `document` → 解析到**渲染文档根**（本骨架里即 `RenderScore` 自身）；根不存在就是失败；
 * - `voice`    → 该 `voiceId` 在 `RenderScore.voices` 中存在；
 * - `event`    → 该声部下存在对应该 `eventId` 的 layout node；
 * - `relation` → 该关系已被渲染（画出了括号 / 连线等可见产物）。
 *
 * `sourceRef` **不进 `Anchor`**：`Anchor` 回答「指向谱面的哪里」，`sourceRef` 回答
 * 「来自源文件的哪里」，两者维度不同。
 */
export type Anchor =
  /** 不属于任何声部的锚点：`key.absent`、未闭合 text block、`meter` 为 raw 等。 */
  | { readonly kind: 'document' }
  | { readonly kind: 'voice'; readonly voiceId: VoiceId }
  | { readonly kind: 'event'; readonly voiceId: VoiceId; readonly eventId: EventId }
  | { readonly kind: 'relation'; readonly voiceId: VoiceId; readonly relationId: RelationId };

/** `Anchor` 的确定性字符串形式；用于派生诊断 id 与测试比对，不参与语义判定。 */
export function anchorKey(anchor: Anchor): string {
  switch (anchor.kind) {
    case 'document':
      return 'document';
    case 'voice':
      return `voice:${anchor.voiceId}`;
    case 'event':
      return `event:${anchor.voiceId}/${anchor.eventId}`;
    case 'relation':
      return `relation:${anchor.voiceId}/${anchor.relationId}`;
    default: {
      const exhaustive: never = anchor;
      return exhaustive;
    }
  }
}

/** 渲染层只有 info / warning 两级：`loadJcx` 保证永远有可渲染的 `Score`，渲染层保证永远画得出一页谱，故**不产生 error 级**（§4.2）。 */
export type RenderDiagnosticLevel = 'info' | 'warning';

/** 形如 `muse.render.<area>.<problem>`；模板字面量类型在编译期挡住 `jcx.` 前缀。 */
export type RenderDiagnosticCode = `muse.render.${string}`;

export interface RenderDiagnostic {
  readonly id: string;
  readonly code: RenderDiagnosticCode;
  readonly level: RenderDiagnosticLevel;
  readonly message: string;
  readonly anchor: Anchor;
  /** 回源锚点，留在 diagnostic 自身（§4.2）；纯透传，不解析 `AstPath`。 */
  readonly sourceRef?: SourceRef;
}

/**
 * 渲染层唯一入口参数（§2.4.1，P1-1）。
 *
 * `index` **必填**：可选会立刻退化成「没传就自己建一个」，等于没有约束。
 * 它与 `score` 必须来自同一次 `loadJcx()`，由调用方（store / `ScoreView`）保证同源。
 */
export interface RenderInput {
  readonly score: Score;
  readonly index: DomainIndex;
}

/**
 * 一个事件在渲染层的最小再表示：原事件 + 回源锚点。
 *
 * 只做「再组织」不做「再解释」：`event` 是 Domain 节点的**同一引用**，渲染层永不原地修改它。
 */
export interface RenderItem {
  readonly eventId: EventId;
  readonly event: MusicEvent;
  /** 回源锚点，纯透传；notation 层**不解析** `AstPath`（§2.1 禁止边，P2-9）。 */
  readonly sourceRef: SourceRef;
}

/** 一个声部的扁平渲染项序列——**没有 measure**，切分是 layout 层的事（§2.6）。 */
export interface RenderVoice {
  readonly voiceId: VoiceId;
  readonly voice: Voice;
  readonly items: readonly RenderItem[];
}

/**
 * `buildRenderScore(input: RenderInput): RenderScore` 的产出。
 *
 * **T0 拍板的固定契约，T1 只填逻辑不改形状**：入口返回的就是这一个对象，
 * 诊断作为 `diagnostics` 字段随行，**不返回 `{ score, diagnostics }` 二元组**。
 * `score` 原样保留（同一引用），供头部布局（§3.5）与「Domain 未被修改」的引用相等断言使用。
 */
export interface RenderScore {
  readonly score: Score;
  readonly voices: readonly RenderVoice[];
  /**
   * 渲染层自有诊断（§4.2）。**不回写 Domain、不转成 `JcxDiagnostic`、
   * 不混入 store 的 `diagnostics` 数组**——那是 lex/parse 阶段的事实。
   */
  readonly diagnostics: readonly RenderDiagnostic[];
}
