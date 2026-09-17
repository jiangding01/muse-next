/**
 * Renderer 应用状态（M1.6 T10b）。
 *
 * 迁移要点：此前的 `parseJcx` scaffold 已删除，改为走格式层统一入口
 * `loadJcx`（`src/formats/jcx`），状态里保存的是正式 Domain 的 `Score`
 * 与整条管线合并后的 `diagnostics`。
 *
 * 两条行为变更：
 * 1. **不再要求 `%MUSE2` magic header**——spec §7.2 明确它是可选的，缺失
 *    时旧 scaffold 会抛错，属于 scaffold 自造的约束。
 * 2. **解析失败不再抛异常**——`loadJcx` 对字符串输入永不抛（见其 JSDoc 的
 *    异常契约），无法结构化的内容一律以 diagnostic 呈现，因此本 store 不再
 *    需要 `error: string | null`，也永远有一个可渲染的 `Score`。
 *
 * Electron 边界（HANDOFF §24）：只从 `src/formats/jcx` 与 `src/domain` 导入，
 * 不碰 `node:` / `electron`；文件读取仍然经 `window.museDesktop` IPC。
 */

import { create } from 'zustand';

import type { DomainIndex, Score } from '../../domain';
import type { JcxDiagnostic } from '../../formats/jcx';
import { loadJcx } from '../../formats/jcx';
import { SCORE_VIEW_METRICS } from '../../notation/layout/metrics';

const demoSource = `%MUSE2
T: Muse Next Demo
C: Clean-room TypeScript scaffold
M: 4/4
L: 1/8
Q: 1/4=96
K: G
%%showfinger yes
%%gchord G=1;3(3),2(2),0,0,0,3(4)
%%gchord C=1;X,3(3),2(2),0,1(1),0
%%gchord D=1;X,X,0,2(1),3(3),2(2)
V:1 name="Guitar" style=tab play=1 instrument=24 volumn=64
V:2 name="Melody" style=jianpu play=1 instrument=0 volumn=64
[V:1]
"G"fxcx/bx/fx/ax/bx/cx/ | "C"excx/bx/ex/ax/bx/cx/ | "D"dxcx/bx/dx/ax/bx/cx/ |
[V:2]
G2 A2 B2 d2 | c2 B2 A2 G2 |
`;

/**
 * 一次 `loadJcx()` 的产物快照。
 *
 * `index` 是 M2 新增的一项（方案 v1.1.1 §2.4.1，P1-1）：`loadJcx` 一直都返回它，
 * 此前被直接丢弃，于是渲染层做 tie/slur/tuplet 反查时只能就地重建一份索引——多一次
 * O(n) 遍历是小事，**与 parse 层索引口径可能不一致才是真问题**。现在它与 `score`
 * 在**同一次 `parse()` 里一起落库**，两者永远同源，渲染入口
 * `buildRenderScore({ score, index })` 的 `index` 因此必填而非可选。
 *
 * 消费方（T5 的 `ScoreView`）用 `useMemo` 记忆化渲染结果时，**依赖数组要写全
 * `[score, index]`**（P2-F）：只写 `[score]` 会在 `index` 被换掉而 `score` 引用未变
 * 时用到陈旧索引。
 *
 * `diagnostics` 仍然只装 lex/parse 阶段的事实——渲染层自己的 `RenderDiagnostic`
 * **不混入这个数组**（§4.2），它随 `RenderScore` 走。
 */
interface ParsedSource {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly diagnostics: readonly JcxDiagnostic[];
}

function parse(source: string): ParsedSource {
  const { score, index, diagnostics } = loadJcx(source);
  return { score, index, diagnostics };
}

interface MuseAppState extends ParsedSource {
  filePath: string | null;
  source: string;
  encoding: 'utf8' | 'gb18030' | null;
  /** 谱面缩放比例（T6.4，D6：只影响 renderer 层像素换算，不改任何 layout 数值）。 */
  zoom: number;
  openScore(): Promise<void>;
  setSource(source: string): void;
  reparse(): void;
  /** 设置缩放比例，clamp 到 `SCORE_VIEW_METRICS.zoomMin/zoomMax`。 */
  setZoom(zoom: number): void;
}

/** 非有限值（NaN / Infinity）不进 store：`Math.min/max` 会透传 NaN，下游会算出 `NaNpx`。 */
function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(SCORE_VIEW_METRICS.zoomMax, Math.max(SCORE_VIEW_METRICS.zoomMin, zoom));
}

export const useMuseAppStore = create<MuseAppState>((set, get) => ({
  filePath: null,
  source: demoSource,
  encoding: 'utf8',
  zoom: 1,
  ...parse(demoSource),

  async openScore() {
    const result = await window.museDesktop.openScore();
    if (result.canceled || result.content === undefined) return;

    set({
      filePath: result.path ?? null,
      source: result.content,
      encoding: result.encoding ?? null,
      ...parse(result.content),
    });
  },

  setSource(source) {
    set({ source });
  },

  reparse() {
    set(parse(get().source));
  },

  setZoom(zoom) {
    set({ zoom: clampZoom(zoom) });
  },
}));
