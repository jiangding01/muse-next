/**
 * M2.5 T8 —— `system/composeLayout.ts` 测试共用的合成 fixture 与取数 helper（只在测试里）。
 */
import type { JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import { layoutStaff } from '../../../src/notation/staff/layoutStaff';
import { composeScoreLayout } from '../../../src/notation/system/composeLayout';
import type { ScoreLayout, VoiceLayoutEntry } from '../../../src/notation/system/composeLayout';
import type { PackingPolicy, ScoreSystemLayout } from '../../../src/notation/system/contracts';
import { matrixScoreFrom } from './renderMatrix.helpers';
import { externalMeasurer, screen } from './systemExternal.helpers';

export type Source = ReturnType<typeof matrixScoreFrom>;

const G = 'G=1;3(3),2(2),0,0,0,3(4)';
const BAR8 = 'C D E F G A B c|';
export const TAB_BAR = 'a0 a1 a2 a3 a4 a5 a6 a7|';
/** 一个 4/4 小节，前四个 1/32 需要额外深度（`requiredSystemDepth` > TAB 基础高）。 */
export const TAB_DEEP_BAR = 'a0/4 a1/4 a2/4 a3/4 a0 a1 a2 a3 a4 a5 a6|';

/** 一个 bracket group（jianpu + 未知 style + tab）+ 一个 singleton staff group；首音挂和弦，TAB 第二小节有 1/32。 */
export const main = matrixScoreFrom([
  '%MUSE2', `%%gchord ${G}`, 'X:1', 'M:4/4', 'L:1/8',
  'V:1 bracket=3 style=jianpu', 'V:2 style=foo', 'V:3 style=tab', 'V:4 style=staff', 'K:C',
  `[V:1]"G"${BAR8}${BAR8}${BAR8}`, 'w: la li lo lu le', 'w: ka ki ko',
  `[V:2]${BAR8}`,
  `[V:3]"Am"${TAB_BAR}${TAB_DEEP_BAR}`,
  `[V:4]${BAR8}`, '',
].join('\n'));

/** 同一 bracket group 的若干 TAB 声部（`G` 有图形，其余和弦只画名）。 */
export function tabScoreOf(bodies: readonly string[]): Source {
  const bracket = bodies.length > 1 ? ` bracket=${String(bodies.length)}` : '';
  const decl = bodies.map((_, i) => `V:${String(i + 1)}${i === 0 ? bracket : ''} style=tab`);
  const lines = bodies.map((body, i) => `[V:${String(i + 1)}]${body}`);
  return matrixScoreFrom(['%MUSE2', `%%gchord ${G}`, 'X:1', 'M:4/4', 'L:1/8', ...decl, 'K:C', ...lines, ''].join('\n'));
}

export function compose(source: Source, policy: PackingPolicy = screen(960)): ScoreLayout {
  return composeScoreLayout(source.renderScore, source.index, externalMeasurer, policy);
}

export function entryOf(layout: ScoreLayout, notation: VoiceLayoutEntry['notation']): VoiceLayoutEntry {
  const entry = layout.voiceLayouts.find((e) => e.notation === notation);
  if (entry === undefined) throw new Error(`no ${notation}`);
  return entry;
}

export function jianpuOf(layout: ScoreLayout): JianpuLayout {
  const entry = entryOf(layout, 'jianpu');
  if (entry.notation !== 'jianpu') throw new Error('not jianpu');
  return entry.layout;
}

export function systemAt(layout: ScoreLayout, index: number): ScoreSystemLayout {
  const system = layout.composed.systems.find((s) => s.index === index);
  if (system === undefined) throw new Error(`no system ${String(index)}`);
  return system;
}

/** 某声部（按 renderScore 下标）在某 system 上的层高。 */
export function layerHeight(layout: ScoreLayout, systemIndex: number, source: Source, voiceIndex: number): number | undefined {
  const voiceId = source.renderScore.voices[voiceIndex]?.voiceId;
  return systemAt(layout, systemIndex).layers.find((l) => l.voiceId === voiceId)?.height;
}

/** 简谱 / TAB 节点 x；Staff 节点的 x 由渲染期 formatter 排（tier 1），以 stave x 代表。 */
export function xsOf(layout: VoiceLayoutEntry['layout'] | ReturnType<typeof layoutStaff>): number[] {
  return 'staves' in layout ? layout.staves.map((stave) => stave.x) : layout.nodes.map((node) => node.x);
}
