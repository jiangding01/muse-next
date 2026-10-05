/**
 * M2.5 T9c.P —— 简谱歌词 SVG 的 `text-anchor`（裁决 D2）。
 *
 * 合同：`lyricToSvg` 按 `aligned` **显式**写 anchor——有目标 `middle`（`text.x` 是目标中心），无目标 `start`
 * （`text.x` 是顺排左缘）；CSS 不再对 `.jianpu-lyric` 一刀切居中（由 `architecture.t9cp.test.ts` 守）。
 * 默认路径与 external 路径同一套 anchor 规则，`x` 原样等于 layout 的 `text.x`。
 */
import { describe, expect, it } from 'vitest';

import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import type { JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import { jianpuToSvg } from '../../../src/notation/jianpu/toSvg';
import type { SvgNode } from '../../../src/notation/svg/node';
import { matrixScoreFrom } from './renderMatrix.helpers';
import { compose, jianpuOf } from './system.composeLayout.helpers';
import { externalMeasurer as measurer } from './systemExternal.helpers';

/** 前两个音节有目标、后两个无目标（走行尾顺排）。 */
const ORPHAN = matrixScoreFrom(['X:1', 'M:4/4', 'L:1/4', 'V:1 style=jianpu', 'K:C', '[V:1]C D z2|', 'w: lang ki mo ra', ''].join('\n'));

/** 深度优先收集 class 以 `jianpu-lyric ` 开头的 `<text>`（不含 `jianpu-lyric-group` 容器）。 */
function lyricTexts(node: SvgNode): SvgNode[] {
  const own = node.tag === 'text' && String(node.attrs.class ?? '').startsWith('jianpu-lyric ') ? [node] : [];
  return [...own, ...(node.children ?? []).flatMap(lyricTexts)];
}

function defaultLayout(): JianpuLayout {
  const voice = ORPHAN.renderScore.voices[0];
  if (voice === undefined) throw new Error('no voice');
  return layoutJianpu(voice, { score: {}, index: ORPHAN.index, measurer, availableWidth: 960 });
}

describe('T9c.P —— 歌词 `<text>` 按 aligned 显式写 text-anchor', () => {
  it.each([
    ['默认路径', defaultLayout],
    ['external 路径', (): JianpuLayout => jianpuOf(compose(ORPHAN))],
  ] as const)('%s：aligned → middle，unaligned → start；x 原样等于 layout text.x', (_name, build) => {
    const layout = build();
    expect(layout.lyrics.map((l) => l.aligned)).toEqual([true, true, false, false]);
    const texts = lyricTexts(jianpuToSvg(layout));
    expect(texts.map((t) => [t.attrs.x, t.attrs['text-anchor']])).toEqual(
      layout.lyrics.map((l) => [l.text.x, l.aligned ? 'middle' : 'start']),
    );
  });
});
