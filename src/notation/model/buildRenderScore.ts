/**
 * notation/model —— `RenderInput → RenderScore` 总装（M2 方案 v1.1.1 §2.4.1 / §2.6 / §3.0）。
 *
 * 纯函数、确定性：同一 `RenderInput` 必然得到逐字段相等的 `RenderScore`，
 * 诊断次序与 id 也完全一致（id 由 `collectRenderDiagnostics` 派生）。
 *
 * 四条硬约束：
 * - **保持 flat**（§2.6）：`items` 与 `voice.events` **一一对应、同序**，不切小节、
 *   不合并、不重排。measure / system / time-slot 一律在 `notation/layout/` 派生。
 * - **`UnknownEvent` 原位保留**（§4.1 A）：不过滤、不吞掉，它在 `items` 里占一项，
 *   由 layout 画成可见占位块。
 * - **UNVERIFIED 不进渲染行为**（R2 / §7-1）：`Z` 不被赋多小节语义、`@` 不被隐藏、
 *   混合方向八度不被抵消、tuplet 的 `p`/`q` 不推算 effective duration——本层只做
 *   「再组织」不做「再解释」，`event` 始终是 Domain 节点的同一引用。
 * - **只读 Domain**：不原地修改 `Score` / `Voice` / `MusicEvent`，`score` 原样带回。
 *
 * 诊断分层（§0d-3）：`duration` 缺失 / 不可表示 → **event 级**；每个 `Tuplet` 恰好一条
 * **relation 级** `tuplet.timing-not-modeled`（在 `relations.ts` 产出）；`style` 缺席 /
 * 未知 → **voice 级**，且**两者是不同 code，不得合并**（§3.0）。
 */

import type { MusicEvent, Rational, Voice } from '../../domain';
import { isKnownVoiceStyle } from '../../domain';
import type { RenderDiagnosticDraft } from './diagnostics';
import { RENDER_DIAGNOSTIC_CODES, collectRenderDiagnostics } from './diagnostics';
import { decomposeDuration } from './duration';
import { collectRelationDiagnostics } from './relations';
import type { RenderInput, RenderItem, RenderScore, RenderVoice } from './types';

/**
 * 「这个事件在记谱上应当带时值吗」——判据取自 Domain 的事件定义，不做推断：
 *
 * - `note` / `rest` / `tabNote`：时值在各自的值对象上（`duration` 可选，`L:` 不可知时缺失）；
 * - `chord`（组时值取首音，spec §14.4）/ `tabGroup`（组时值取末音，spec §26.8）：时值在事件上；
 * - `grace` **不占时值**（spec §21），`barline` / `decoration` / `chordSymbol` / `unknown`
 *   本就没有时值——它们缺 `duration` 不是降级，**不发任何 duration 诊断**。
 */
function timedDuration(
  event: MusicEvent,
): { readonly timed: false } | { readonly timed: true; readonly duration: Rational | undefined } {
  switch (event.kind) {
    case 'note':
      return { timed: true, duration: event.note.duration };
    case 'rest':
      return { timed: true, duration: event.rest.duration };
    case 'tabNote':
      return { timed: true, duration: event.note.duration };
    case 'chord':
    case 'tabGroup':
      return { timed: true, duration: event.duration };
    case 'grace':
    case 'barline':
    case 'decoration':
    case 'chordSymbol':
    case 'unknown':
      return { timed: false };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * 事件级 duration 诊断。
 *
 * level 取 `warning`（两条都是「画出来的东西与作者所写不完全对应」的降级）
 * ——**这是产品决定，不是格式事实**：spec 未规定渲染层的告警等级。
 */
function eventDiagnostics(voice: Voice, event: MusicEvent): readonly RenderDiagnosticDraft[] {
  const timing = timedDuration(event);
  if (!timing.timed) {
    return [];
  }

  const anchor = { kind: 'event', voiceId: voice.id, eventId: event.id } as const;

  // `L:` 不可知 → 只有 durationRaw，渲染走固定宽 fallback（§2.6.1 / R4）。
  // **不得反推音乐时值**，所以这里只报告事实，不去猜 durationRaw 可能是多少。
  if (timing.duration === undefined) {
    return [
      {
        code: RENDER_DIAGNOSTIC_CODES.durationUnresolved,
        level: 'warning',
        message: '该事件的 duration 不可知（L: 未能确定），按固定宽占位排布，不渲染时值装饰',
        anchor,
        sourceRef: event.origin,
      },
    ];
  }

  // 找不到 `base × {1, 3/2, 7/4}` 的精确表示（如 1/3、5/16）→ 不画时值装饰。
  // **不四舍五入到最近的 2 的幂**——那是在编造作者没写的时值（§2.6.1）。
  if (decomposeDuration(timing.duration).kind === 'unrepresentable') {
    const { num, den } = timing.duration;
    return [
      {
        code: RENDER_DIAGNOSTIC_CODES.durationUnrepresentable,
        level: 'warning',
        message: `时值 ${String(num)}/${String(den)} 无法表示为 base × {1, 3/2, 7/4}，不渲染时值装饰，宽度按字面 duration 排布`,
        anchor,
        sourceRef: event.origin,
      },
    ];
  }

  return [];
}

/**
 * 声部级 `style` 诊断（§3.0，D12 方案 B）。
 *
 * 缺席与未知**各发各的**：「作者没写」与「作者写了我们不认识的值」是不同事实，
 * 合并会让后续拿到新语料时无法区分。两者都走保守占位，**绝不静默默认成某种记谱法**。
 * 等级差异（缺席 info / 未知 warning）是**产品决定，不是格式事实**：spec §12.6.1 只
 * 规定缺省值 UNVERIFIED、由渲染层决定回退。
 */
function voiceStyleDiagnostics(voice: Voice): readonly RenderDiagnosticDraft[] {
  if (isKnownVoiceStyle(voice.style)) {
    return [];
  }

  const anchor = { kind: 'voice', voiceId: voice.id } as const;
  const origin = voice.origins[0];
  const draft: RenderDiagnosticDraft =
    voice.style === undefined
      ? {
          code: RENDER_DIAGNOSTIC_CODES.voiceStyleAbsent,
          level: 'info',
          message: '该声部未声明 style，按「风格未声明」保守占位呈现，不假定为任何一种记谱法',
          anchor,
        }
      : {
          code: RENDER_DIAGNOSTIC_CODES.voiceStyleUnknown,
          level: 'warning',
          message: `该声部的 style=${voice.style} 不是已知值（staff / jianpu / tab），按「风格未声明」保守占位呈现并显示原值`,
          anchor,
        };

  return [origin === undefined ? draft : { ...draft, sourceRef: origin }];
}

function buildItems(voice: Voice): readonly RenderItem[] {
  // 一一对应、同序：`items[i]` 就是 `voice.events[i]` 的再表示，不增不减不换位。
  return voice.events.map((event) => ({
    eventId: event.id,
    event,
    sourceRef: event.origin,
  }));
}

/**
 * 渲染层唯一入口（§2.4.1，P1-1）。
 *
 * `input.index` **必填且必须与 `input.score` 同源**（同一次 `loadJcx`）——本层
 * 不重建任何 Domain lookup，关系反查一律经 `relations.ts` 查传入的 index。
 */
export function buildRenderScore(input: RenderInput): RenderScore {
  const { score, index } = input;
  const drafts: RenderDiagnosticDraft[] = [];
  const voices: RenderVoice[] = [];

  for (const voice of score.voices) {
    // 次序固定（voice → events → relations），保证诊断 id 的确定性。
    drafts.push(...voiceStyleDiagnostics(voice));
    for (const event of voice.events) {
      drafts.push(...eventDiagnostics(voice, event));
    }
    drafts.push(...collectRelationDiagnostics(voice, index));

    voices.push({ voiceId: voice.id, voice, items: buildItems(voice) });
  }

  return { score, voices, diagnostics: collectRenderDiagnostics(drafts) };
}
