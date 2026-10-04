/**
 * M2.5 T3.5 —— raw / 缺席 `M:` 的强回归门（用户裁决 Q14-a）的**共享计算**。
 *
 * 同一份代码被两处使用：
 * - `scripts/notation/beam-regression-golden.ts`：在 `35f7ad9`（T3.5 之前）的独立 worktree 里运行，
 *   生成 `tests/fixtures/golden/t35-raw-absent.sha256.json`；**生成器不是测试，测试永不改写 expected**；
 * - `beams.regression.test.ts`：在当前代码上重算，与 golden 逐项比对。
 *
 * 规范化（normalized compare，唯二允许的变化，其余逐字段严格相等）：
 * 1. 去掉 layout 顶层新增的 `beams` 字段（它的取值由测试另行断言为 `[]`）；
 * 2. TAB 扫弦记号文本按 §Q8.4 / Q12 映射 `V → ↓`、`U → ↑`（layout 的 `strokes[].text.text` 与 SVG 的
 *    `tab-stroke-text` 文本节点两处，映射对已是箭头的文本是幂等的）。
 * 对象键按字典序稳定序列化，字段新增的位置不影响 hash。覆盖：全部 fixture × 三种 `M:` 变体
 * （`M:C`、`M:C|`、删除 `M:`）× 两档宽度 × 每个 TAB / 简谱声部的 layout（含 slots / 宽高 / 诊断）+ SVG。
 */
import { createHash } from 'node:crypto';

import type { RenderVoice } from '../../../src/notation/model/types';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import { jianpuToSvg } from '../../../src/notation/jianpu/toSvg';
import { serializeSvg } from '../../../src/notation/svg/serializeSvg';
import { layoutTab } from '../../../src/notation/tab/layoutTab';
import { tabToSvg } from '../../../src/notation/tab/toSvg';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import { matrixScoreFrom } from './renderMatrix.helpers';

export const REGRESSION_VARIANTS: readonly { readonly id: string; readonly line: string | undefined }[] = [
  { id: 'raw-C', line: 'M:C' },
  { id: 'raw-C|', line: 'M:C|' },
  { id: 'absent', line: undefined },
];

export const REGRESSION_WIDTHS: readonly number[] = [960, 16];

export type BeamsField = 'absent' | 'empty' | 'non-empty';

export interface RegressionEntry {
  /** `<fixture>|<variant>|<width>|<voiceId>|<tab|jianpu>` */
  readonly key: string;
  readonly hash: string;
  readonly beamsField: BeamsField;
  /** 该 TAB 声部是否含 V/U（或已映射的箭头）扫弦——证明映射规范化确实被走到。 */
  readonly strokeVU: boolean;
}

const ARROWS: Readonly<Record<string, string>> = { V: '↓', U: '↑' };
const toArrows = (text: string): string => text.replace(/[VU]/g, (ch) => ARROWS[ch] ?? ch);

/** 把每一行以 `M:` 开头的行替换为 `line`（`undefined` = 删除）；没有 `M:` 行时插在 `X:` 行之后。 */
export function withMeterLine(bytes: Uint8Array, line: string | undefined): Uint8Array {
  const text = Buffer.from(bytes).toString('latin1');
  const lines = text.split('\n');
  const isMeter = (l: string): boolean => l.startsWith('M:');
  const replaced = lines.flatMap((l) => {
    if (!isMeter(l)) return [l];
    if (line === undefined) return [];
    return [`${line}${l.endsWith('\r') ? '\r' : ''}`];
  });
  if (line !== undefined && !lines.some(isMeter)) {
    const xIndex = replaced.findIndex((l) => l.startsWith('X:'));
    replaced.splice(xIndex < 0 ? 0 : xIndex + 1, 0, line);
  }
  return new Uint8Array(Buffer.from(replaced.join('\n'), 'latin1'));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** 顶层去 `beams`；TAB `strokes[].text.text` 做 V/U 映射。 */
function normalizeLayout(
  layout: object,
  notation: 'tab' | 'jianpu',
): { readonly value: unknown; readonly beamsField: BeamsField; readonly strokeVU: boolean } {
  const entries = Object.entries(layout);
  const beams = entries.find(([k]) => k === 'beams')?.[1];
  const beamsField: BeamsField = beams === undefined ? 'absent' : Array.isArray(beams) && beams.length === 0 ? 'empty' : 'non-empty';
  const rest = Object.fromEntries(entries.filter(([k]) => k !== 'beams'));
  let strokeVU = false;
  if (notation === 'tab' && Array.isArray(rest.strokes)) {
    rest.strokes = rest.strokes.map((stroke: unknown) => {
      if (stroke === null || typeof stroke !== 'object' || !('text' in stroke)) return stroke;
      const glyph: unknown = stroke.text;
      if (glyph === null || typeof glyph !== 'object' || !('text' in glyph) || typeof glyph.text !== 'string') return stroke;
      if (/[VU↓↑]/.test(glyph.text)) strokeVU = true;
      return { ...stroke, text: { ...glyph, text: toArrows(glyph.text) } };
    });
  }
  return { value: sortKeys(rest), beamsField, strokeVU };
}

function normalizeSvg(svg: string): string {
  return svg.replace(/(<text\b[^>]*class="tab-stroke-text"[^>]*>)([^<]*)(<\/text>)/g, (_m, open: string, body: string, close: string) => `${open}${toArrows(body)}${close}`);
}

function hashOf(value: unknown, svg: string): string {
  return createHash('sha256').update(JSON.stringify(value)).update('\n').update(svg).digest('hex');
}

function entriesFor(name: string, variant: (typeof REGRESSION_VARIANTS)[number], width: number): RegressionEntry[] {
  const measurer = createDeterministicTextMeasurer();
  const matrix = matrixScoreFrom(withMeterLine(fixtureBytes(name), variant.line));
  const { score, index } = matrix;
  const out: RegressionEntry[] = [];
  const push = (voice: RenderVoice, notation: 'tab' | 'jianpu', layout: object, svg: string): void => {
    const normalized = normalizeLayout(layout, notation);
    out.push({
      key: `${name}|${variant.id}|${String(width)}|${voice.voiceId}|${notation}`,
      hash: hashOf(normalized.value, normalizeSvg(svg)),
      beamsField: normalized.beamsField,
      strokeVU: normalized.strokeVU,
    });
  };
  for (const voice of matrix.renderScore.voices) {
    if (voice.voice.style === 'tab') {
      const meter = score.meter === undefined ? {} : { meter: score.meter };
      const layout = layoutTab(voice, { index, measurer, availableWidth: width, ...meter });
      push(voice, 'tab', layout, serializeSvg(tabToSvg(layout)));
    } else if (voice.voice.style === 'jianpu') {
      const head = {
        ...(score.key === undefined ? {} : { key: score.key }),
        ...(score.meter === undefined ? {} : { meter: score.meter }),
      };
      const layout = layoutJianpu(voice, { score: head, index, measurer, availableWidth: width });
      push(voice, 'jianpu', layout, serializeSvg(jianpuToSvg(layout)));
    }
  }
  return out;
}

/** 全部条目，按 key 排序（确定性）。 */
export function regressionEntries(): readonly RegressionEntry[] {
  return fixtureNames
    .flatMap((name) => REGRESSION_VARIANTS.flatMap((variant) => REGRESSION_WIDTHS.flatMap((width) => entriesFor(name, variant, width))))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
