/**
 * notation/system —— `Score.voices → SystemGroup[]`：声部的**视觉分组**
 * （`docs/M2.5_SYSTEM_LAYOUT_PLAN.md` v1.0 §Q1，T1 + 用户 2026-10-04 裁决）。
 *
 * 只回答「谁和谁画在同一个 system 里」，**不碰** measure identity、timing、renderer：
 * `bracket=N` 只证明视觉分组，不证明节奏同步（Brief §2.7.2）。
 *
 * 规则（逐声部按文档顺序扫描，纯函数、确定性）：
 * - `bracket=N`（N ≥ 2）→ 从当前声部起 N 层成一个 `bracket` group；N 超过剩余声部数时截断
 *   并发 `group-span-overflow`，截断后只剩本声部则按单声部 group 处理；
 * - `bracket=1` → 单声部 group，不发诊断（无可连接对象，Q1.2 的 `n <= 1`）；
 * - `bracket` 不是安全整数（防御：`loadJcx` 保证安全整数，只有手工构造的 Voice 会出现
 *   1.5 / NaN / Infinity）或 N ≤ 0 → 单声部 group + `group-declaration-ignored`；只有安全整数
 *   N ≥ 2 才进入跨度 / 越界判定，保证不因非法下标丢声部；
 * - `brace` / `staves` → 本版不实现连接形态，**不吞并后续声部**，每个声明发一条
 *   `connector-not-modeled`。**优先级固定 bracket > brace > staves，不做 fallback**：
 *   `bracket` 无效时也不回退去执行 `brace`；
 * - 被前一 group 覆盖的声部：其 `bracket` 发 `group-declaration-ignored`、`brace` /
 *   `staves` 发 `connector-not-modeled`，**只发诊断，绝不影响 group 结果**（不重叠、不重分）；
 * - 其余声部 → 单声部 group（`connector: 'none'`，`evidence: 'singleton'`，F-7 不合并）。
 *
 * group 顺序与层序 = `Score.voices` 文档顺序（§Q1.3，不按记谱种类重排）。诊断一律挂该
 * 声部的 voice anchor，按文档顺序积累后**只收集一次**，id 顺序由文档顺序决定。
 */

import type { Voice } from '../../domain';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import { RENDER_DIAGNOSTIC_CODES as CODES, collectRenderDiagnostics } from '../model/diagnostics';
import type { RenderDiagnostic, RenderDiagnosticCode, RenderDiagnosticLevel } from '../model/types';
import type { SystemGroup } from './contracts';

/** `groupVoices` 的产物：覆盖全部声部、无重叠、无遗漏的 group 序列 + 渲染层诊断。 */
export interface VoiceGrouping {
  readonly groups: readonly SystemGroup[];
  readonly diagnostics: readonly RenderDiagnostic[];
}

type Sink = (draft: RenderDiagnosticDraft) => void;

/** 挂在声部上的诊断；`origins` 为空（调用方可传任意 `Voice`）时省略 `sourceRef`。 */
function voiceDraft(
  voice: Voice,
  code: RenderDiagnosticCode,
  level: RenderDiagnosticLevel,
  message: string,
): RenderDiagnosticDraft {
  const draft: RenderDiagnosticDraft = { code, level, message, anchor: { kind: 'voice', voiceId: voice.id } };
  const origin = voice.origins[0];
  return origin === undefined ? draft : { ...draft, sourceRef: origin };
}

/** `brace` / `staves` 的声明本版都不渲染：每个声明各一条 info。 */
function reportUnmodeledConnectors(voice: Voice, sink: Sink): void {
  if (voice.brace !== undefined) {
    sink(voiceDraft(voice, CODES.systemConnectorNotModeled, 'info',
      `brace=${String(voice.brace)} 的花括号连接本版不渲染，该声明不参与分组`));
  }
  if (voice.staves !== undefined) {
    sink(voiceDraft(voice, CODES.systemConnectorNotModeled, 'info',
      `staves=${String(voice.staves)} 的竖线连接本版不渲染，该声明不参与分组`));
  }
}

/**
 * 声明声部的 `bracket` 跨度（≥ 1，含本声部）。`remaining` = 从本声部起的剩余声部数（≥ 1）。
 * 只对 `bracket` 自身发诊断；`brace` / `staves` 由调用方另行报告。
 */
function bracketSpan(voice: Voice, remaining: number, sink: Sink): number {
  const n = voice.bracket;
  if (n === undefined || n === 1) {
    return 1;
  }
  if (!Number.isSafeInteger(n) || n <= 0) {
    sink(voiceDraft(voice, CODES.systemGroupDeclarationIgnored, 'info',
      `bracket=${String(n)} 的分组范围无法形成有效 system group，本版忽略该声明并按单声部系统处理`));
    return 1;
  }
  if (n > remaining) {
    const tail = remaining === 1 ? '仅剩本声部，按单声部系统处理' : `已截断为 ${String(remaining)} 层`;
    sink(voiceDraft(voice, CODES.systemGroupSpanOverflow, 'warning',
      `bracket=${String(n)} 超过从本声部起的剩余声部数 ${String(remaining)}，${tail}`));
    return remaining;
  }
  return n;
}

/** 被前一 group 覆盖的声部：其连接声明只产诊断，不参与分组。 */
function reportCoveredDeclarations(voice: Voice, sink: Sink): void {
  if (voice.bracket !== undefined) {
    sink(voiceDraft(voice, CODES.systemGroupDeclarationIgnored, 'info',
      `bracket=${String(voice.bracket)} 声明位于已由前一声明覆盖的 system group 内；为避免重叠分组，本版忽略该声明`));
  }
  reportUnmodeledConnectors(voice, sink);
}

/** `Score.voices`（文档顺序）→ 视觉分组。不修改入参，`voiceIds` 引用原 id。 */
export function groupVoices(voices: readonly Voice[]): VoiceGrouping {
  const groups: SystemGroup[] = [];
  const drafts: RenderDiagnosticDraft[] = [];
  const sink: Sink = (draft) => {
    drafts.push(draft);
  };

  let start = 0;
  while (start < voices.length) {
    const head = voices[start];
    if (head === undefined) {
      break;
    }
    const span = bracketSpan(head, voices.length - start, sink);
    reportUnmodeledConnectors(head, sink);
    const covered = voices.slice(start, start + span);
    for (const inner of covered.slice(1)) {
      reportCoveredDeclarations(inner, sink);
    }
    groups.push(
      span >= 2
        ? { index: groups.length, voiceIds: covered.map((v) => v.id), connector: 'bracket', evidence: 'declared' }
        : { index: groups.length, voiceIds: [head.id], connector: 'none', evidence: 'singleton' },
    );
    start += span;
  }

  return { groups, diagnostics: collectRenderDiagnostics(drafts) };
}
