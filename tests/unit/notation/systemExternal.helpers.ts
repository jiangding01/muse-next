/**
 * M2.5 T5 —— 测试侧把 T4 `composeSystemGeometry` 的产物整理成某个声部的 external 输入（**只在测试里**；
 * 生产编排与层纵向几何归 T8，用户裁决 N-a / 额外裁决 1）。
 *
 * - `measures`：该声部所在 group 的全部公共 measure（含其它声部与 absent 项，由 layout 自己按 participation 取）；
 * - `systems`：该 group 的全部行，按固定步长堆叠出合成的 y / height（T8 之前没有真实层高）；
 * - `relabel`：把 T4 的全局 systemIndex 改写成任意整数（模拟「不从 0 起」「稀疏」），geometry 与 system 同步改写；
 * - `reverse`：把 `systems` 倒序给出（layout 必须按 index 升序返回，不依赖输入顺序）；
 * - `originX`：行谱 box 的 `origin.x`（模拟页边距 / 缩进；节点、stave、弦线都必须加上它）；
 * - `flipY`：y 随 index **递减**（数组最后一项不是最低的行谱，用来杀「取最后一项」的宽高实现）。
 *
 * Staff 的 external 另有必填 `topInsets`（T9b.S，用户裁决 M3）：T8 之前的测试一律经 `withZeroTopInsets` 显式给 0。
 */
import type { VoiceId } from '../../../src/domain';
import type { System } from '../../../src/notation/layout/primitives';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import type { RenderScore, RenderVoice } from '../../../src/notation/model/types';
import { composeSystemGeometry } from '../../../src/notation/system/composeSystem';
import type { ComposedSystemGeometry } from '../../../src/notation/system/composeSystem';
import type { PackingPolicy, SystemMeasureGeometry } from '../../../src/notation/system/contracts';
import { matrixScoreFrom } from './renderMatrix.helpers';

export const externalMeasurer = createDeterministicTextMeasurer();
export const SYSTEM_STEP = 300;
export const SYSTEM_HEIGHT = 120;

export interface ExternalInput {
  readonly measures: readonly SystemMeasureGeometry[];
  readonly systems: readonly System[];
}

export interface ExternalOptions {
  readonly relabel?: (systemIndex: number) => number;
  readonly reverse?: boolean;
  readonly originX?: number;
  readonly flipY?: boolean;
}

export const screen = (availableWidth: number): PackingPolicy => ({ kind: 'screen', availableWidth });

/** `[V:n]` 声明 + 正文；多于一个声部时第一个声部带 `bracket=N`（同一 group）。 */
export function scoreOf(bodies: readonly (readonly [string, string])[], header = 'M:4/4\nL:1/8', bracket = true): ReturnType<typeof matrixScoreFrom> {
  const decl = bodies.map(([style], i) => `V:${String(i + 1)}${bracket && i === 0 && bodies.length > 1 ? ` bracket=${String(bodies.length)}` : ''} style=${style}`);
  const lines = bodies.map(([, body], i) => `[V:${String(i + 1)}]${body}`);
  return matrixScoreFrom(['X:1', header, ...decl, 'K:C', ...lines, ''].join('\n'));
}

export function voiceAt(render: RenderScore, index: number): RenderVoice {
  const voice = render.voices[index];
  if (voice === undefined) throw new Error(`no voice ${String(index)}`);
  return voice;
}

export function composed(render: RenderScore, policy: PackingPolicy = screen(960)): ComposedSystemGeometry {
  return composeSystemGeometry(render, externalMeasurer, policy);
}

/** 某声部的 external 输入：它所在 group 的全部行。 */
export function externalFor(out: ComposedSystemGeometry, voiceId: VoiceId, options: ExternalOptions = {}): ExternalInput {
  const relabel = options.relabel ?? ((index: number) => index);
  const lines = out.lines.filter((line) => line.measures.some((m) => m.participation.some((p) => p.voiceId === voiceId)));
  const measures = lines.flatMap((line) => line.measures.map((m) => ({ ...m, systemIndex: relabel(m.systemIndex) })));
  const systems = lines.map((line, i): System => {
    const index = relabel(line.systemIndex);
    const y = (options.flipY === true ? lines.length - 1 - i : index) * SYSTEM_STEP;
    return { index, box: { origin: { x: options.originX ?? 0, y }, width: line.width, height: SYSTEM_HEIGHT } };
  });
  return { measures, systems: options.reverse === true ? [...systems].reverse() : systems };
}

/** Staff external 输入：每一行显式 0 内缩（T9b.S 裁决 M3：字段必填，legacy 测试不得靠缺席回退）。 */
export function withZeroTopInsets(input: ExternalInput): ExternalInput & { readonly topInsets: ReadonlyMap<number, number> } {
  return { ...input, topInsets: new Map(input.systems.map((system) => [system.index, 0])) };
}
