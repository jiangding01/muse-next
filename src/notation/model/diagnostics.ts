/**
 * notation/model —— 渲染层诊断通道（M2 方案 v1.1.1 §4.2）。
 *
 * 层次归属（硬规则，守卫测试钉死）：
 * - `RenderDiagnostic` **只属于 notation/render 层**：不回写 `Score`、不转换成
 *   `JcxDiagnostic`、不混入 store 里的 `diagnostics` 数组。
 * - 反向同样禁止：不得把 `JcxDiagnostic` 重新包装成 `RenderDiagnostic`；同一件事
 *   只由一层报告一次（例如悬空 strokePrefix 已由 lexer 报过，渲染层不重复报）。
 * - code 一律 `muse.render.*` 前缀，**绝不与 `jcx.*` 混用**。
 * - 类型（`RenderDiagnostic` / `Anchor` / code / level）住在 `types.ts`，本文件只放
 *   **构造与收集**，依赖方向单向 `diagnostics.ts → types.ts`，无循环。
 * - **渲染层永不产生 error 级**：`loadJcx` 保证永远有一个可渲染的 `Score`，渲染层
 *   同样保证永远画得出一页谱，最坏情况是一页全是未知占位块。
 *
 * **T1 hygiene 的唯一变更**：`RENDER_DIAGNOSTIC_CODES` 收编了
 * `relationEndpointMissing`——它在 T1 实现期曾临时定义在 `relations.ts` 局部，
 * 违反「code 常量表是唯一来源」。本次把它并回表内，`relations.ts` 改为引用本表。
 * 除此之外本文件相对 T0 没有任何改动（类型形状、构造函数、id 派生规则全部照旧）。
 */

import type { RenderDiagnostic, RenderDiagnosticCode } from './types';
import { anchorKey } from './types';

/** 构造诊断的入参：`id` 由 `collectRenderDiagnostics` 确定性派生，调用方不自造。 */
export type RenderDiagnosticDraft = Omit<RenderDiagnostic, 'id'>;

/**
 * T0 就位的 code 常量表（后续任务按需追加，**唯一来源**）。
 * 每条都对应方案里一处明确写死的语义，不允许实现层临时拼字符串。
 */
export const RENDER_DIAGNOSTIC_CODES = {
  /**
   * `duration` 无法表示为 `base × {1, 3/2, 7/4}`（如 `1/3`、`5/16`）：
   * 不画任何时值装饰，宽度按字面 `duration` 排布（§2.6.1）。
   */
  durationUnrepresentable: 'muse.render.duration.unrepresentable',
  /** `L:` 不可知导致 `duration` 缺失：固定宽 fallback + 所在 measure 退等距（§2.6.1 / R4）。 */
  durationUnresolved: 'muse.render.duration.unresolved',
  /** tuplet 实际时值关系未建模，成员按字面时值排布；挂在关系上，不挂成员（§2.6.1，P1-C）。 */
  tupletTimingNotModeled: 'muse.render.tuplet.timing-not-modeled',
  /** `style` 缺席——作者没写（§3.0）。 */
  voiceStyleAbsent: 'muse.render.voice.style-absent',
  /** `style` 是我们不认识的值——与「没写」是两个不同事实，**不得合并**（§3.0）。 */
  voiceStyleUnknown: 'muse.render.voice.style-unknown',
  /**
   * 关系的某个端点（`from` / `to` / `member` 任一）在传入的 `DomainIndex` 里指不到
   * 有效目标：事件查不到，或事件在但 `memberIndex` 对它无效。
   *
   * **只用于 index / Domain 不变量被破坏的情形**，不用于 parse 层如实记录的恢复状态
   * （`tie.unresolved` / `slur.unclosed` / `tuplet.incomplete` 是正常的源文本事实，
   * 不是错误，不发这条）。成因由 `relations.ts` 的 `DanglingReason` 区分。
   */
  relationEndpointMissing: 'muse.render.relation.endpoint-missing',
} as const satisfies Record<string, RenderDiagnosticCode>;

/** 纯构造：给定 draft 与序号，得到最终诊断。`ordinal` 只参与 id，不参与语义。 */
export function renderDiagnostic(draft: RenderDiagnosticDraft, ordinal: number): RenderDiagnostic {
  const id = `${anchorKey(draft.anchor)}|${draft.code}#${String(ordinal)}`;
  return draft.sourceRef === undefined
    ? { id, code: draft.code, level: draft.level, message: draft.message, anchor: draft.anchor }
    : {
        id,
        code: draft.code,
        level: draft.level,
        message: draft.message,
        anchor: draft.anchor,
        sourceRef: draft.sourceRef,
      };
}

/**
 * 收集 helper：按给定顺序给每条 draft 派生稳定 id。
 *
 * 同一 `(anchor, code)` 出现多次是**允许的**（C2 是「至少一条」而不是「恰好一条」），
 * 序号按出现次序递增，因此同一输入序列必然得到同一批 id。
 */
export function collectRenderDiagnostics(
  drafts: readonly RenderDiagnosticDraft[],
): readonly RenderDiagnostic[] {
  const seen = new Map<string, number>();
  return drafts.map((draft) => {
    const key = `${anchorKey(draft.anchor)}|${draft.code}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return renderDiagnostic(draft, ordinal);
  });
}
