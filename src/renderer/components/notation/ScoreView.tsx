/**
 * 谱面视图（M2 方案 v1.1.1 §2.4.2 / §3.5 / §4 / §6 T5）。
 *
 * 数据入口：从 store 取 `{ score, index }` 组成 `RenderInput`（P1-1），
 * `useMemo` 依赖数组写全 `[score, index]`（P2-F：只写 `[score]` 会在 `index` 被换掉
 * 而 `score` 引用未变时用到陈旧索引）。
 *
 * 每个声部按 `voice.style` 分派（`isKnownVoiceStyle` 判定）：
 * - `jianpu` → `layoutJianpu` + `jianpuToSvg` + `<SvgTree>`；
 * - `tab` / `staff` → 本任务只显示「该记谱类型待 T6/T7」的保守占位，**不是错误**，
 *   也**不产生新诊断**——阶段状态，不是渲染问题；
 * - 缺席 / 未知 → D12 方案 B 的保守占位（事件的文本化摘要，摘要函数在
 *   `notation/layout/fallbackSummary.ts`——本文件只消费字符串，不解释 `MusicEvent`
 *   的分支，那是需要单测覆盖的纯函数逻辑，不该藏在组件里），**不再造第二条诊断**：
 *   `buildRenderScore` 已经在 voice 级发过 `voice.style-absent` / `voice.style-unknown`。
 *
 * 诊断合并顺序固定：`renderScore.diagnostics` → 头部 `diagnostics` → 按声部顺序追加
 * 各 `JianpuLayout.diagnostics`（tab/staff/fallback 占位不追加）；**按 `id` 去重只是
 * 兜底**（正确性证明在各 producer 自己的测试里：`layoutScoreHeader` 的 key/meter
 * 诊断已按「是否存在 jianpu 消费者」门控，不依赖这里的去重来避免重复，见该文件）。
 *
 * 谱面 ↔ `RenderDiagnostic` 互相高亮走同一个字符串状态 `selectedAnchorKey`
 * （`notation/model/types.ts` 的 `anchorKey()`，与 `SvgNode`/voice 分组上统一携带的
 * `data-anchor-key` 同源）：点击谱面节点或诊断条目都只是把它设成同一个 key，
 * 两侧各自按这个 key 高亮，互不知道对方的存在；`score` 变化时单独重置选中状态，
 * 与 DOM class 同步的副作用（依赖 `[selectedAnchorKey, voiceRenders]`）分开。
 * **不做 textarea 行级定位**（P2-9）：`SourceRef` 是 `AstPath` 字符串，行级定位需要
 * 解析回 AST，留给 M3。
 *
 * **可用宽度**（D7 按容器宽度换行）：`voicesRef` 用 `ResizeObserver` 取
 * `.score-voices` 的真实 CSS 宽度，除以产品常量
 * `SCORE_VIEW_METRICS.cssPixelsPerUnitAtZoom1` 换算成 abstract unit 传给
 * `availableWidth`；没有 `ResizeObserver`（测试 / SSR）时退回
 * `SCORE_VIEW_METRICS.defaultAvailableWidth`。
 */

import {
  useEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent, type RefObject,
} from 'react';

import type { DomainIndex, KnownVoiceStyle, Score } from '../../../domain';
import { isKnownVoiceStyle, type VoiceId } from '../../../domain';
import { jianpuToSvg } from '../../../notation/jianpu/toSvg';
import { layoutJianpu, type JianpuContext } from '../../../notation/jianpu/layoutJianpu';
import { summarizeEvents } from '../../../notation/layout/fallbackSummary';
import { SCORE_VIEW_METRICS } from '../../../notation/layout/metrics';
import { layoutScoreHeader } from '../../../notation/layout/scoreHeader';
import { createDeterministicTextMeasurer, type TextMeasurer } from '../../../notation/layout/textMeasurer';
import { buildRenderScore } from '../../../notation/model/buildRenderScore';
import { anchorKey, type RenderDiagnostic, type RenderVoice } from '../../../notation/model/types';
import type { SvgNode } from '../../../notation/svg/node';
import { useMuseAppStore } from '../../app/store';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ScoreHeaderView } from './ScoreHeaderView';
import { SvgTree } from './SvgTree';

/** 生产与测试共用的确定性度量实现（§2.8：不接 DOM，避免布局随宿主字体漂移）。 */
const MEASURER: TextMeasurer = createDeterministicTextMeasurer();

type PendingStyle = Exclude<KnownVoiceStyle, 'jianpu'>;

const PENDING_STYLE_LABEL: Record<PendingStyle, string> = {
  tab: 'TAB 六线谱渲染待 T6',
  staff: '五线谱渲染待 T7',
};

type VoiceRender =
  | { readonly kind: 'jianpu'; readonly voiceId: VoiceId; readonly node: SvgNode; readonly diagnostics: readonly RenderDiagnostic[] }
  | { readonly kind: 'pending'; readonly voiceId: VoiceId; readonly style: PendingStyle }
  | { readonly kind: 'fallback'; readonly voiceId: VoiceId; readonly label: string; readonly summary: string };

interface VoiceRenderContext {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly measurer: TextMeasurer;
  readonly availableWidth: number;
}

function buildVoiceRender(voice: RenderVoice, ctx: VoiceRenderContext): VoiceRender {
  const style = voice.voice.style;
  if (isKnownVoiceStyle(style)) {
    if (style === 'jianpu') {
      const jianpuCtx: JianpuContext = {
        score: {
          ...(ctx.score.key === undefined ? {} : { key: ctx.score.key }),
          ...(ctx.score.meter === undefined ? {} : { meter: ctx.score.meter }),
        },
        index: ctx.index,
        measurer: ctx.measurer,
        availableWidth: ctx.availableWidth,
      };
      const layout = layoutJianpu(voice, jianpuCtx);
      return { kind: 'jianpu', voiceId: voice.voiceId, node: jianpuToSvg(layout), diagnostics: layout.diagnostics };
    }
    return { kind: 'pending', voiceId: voice.voiceId, style };
  }

  const label = style === undefined ? '风格未声明' : `未知风格 style=${style}`;
  const summary = summarizeEvents(voice.items.map((item) => item.event));
  return { kind: 'fallback', voiceId: voice.voiceId, label, summary };
}

function voiceAnchorKey(voiceId: VoiceId): string {
  return anchorKey({ kind: 'voice', voiceId });
}

/** 三种声部渲染结果的外层都携带同一个 voice 级 `data-anchor-key`（P1-3）。 */
function VoiceRenderView({ render }: { readonly render: VoiceRender }) {
  const anchor = voiceAnchorKey(render.voiceId);
  if (render.kind === 'jianpu') {
    return (
      <section className="score-voice score-voice-jianpu" data-voice-id={render.voiceId} data-anchor-key={anchor}>
        <SvgTree node={render.node} />
      </section>
    );
  }
  if (render.kind === 'pending') {
    return (
      <section className="score-voice score-voice-pending" data-voice-id={render.voiceId} data-anchor-key={anchor}>
        <p className="score-voice-pending-label">{PENDING_STYLE_LABEL[render.style]}</p>
      </section>
    );
  }
  return (
    <section className="score-voice score-voice-fallback" data-voice-id={render.voiceId} data-anchor-key={anchor}>
      <p className="score-voice-fallback-label">{render.label}</p>
      <p className="score-voice-fallback-summary">{render.summary}</p>
    </section>
  );
}

/**
 * 点击时从事件目标向上找最近的 `[data-anchor-key]`；找不到就什么都不做——
 * anchor 没有对应可视节点是允许的（例如尚未渲染的 tab/staff 占位），诊断仍可点选，
 * 这条路径只负责「谱面 → 诊断」方向，不 throw。
 */
function nearestAnchorKey(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const el = target.closest('[data-anchor-key]');
  return el?.getAttribute('data-anchor-key') ?? undefined;
}

/**
 * 高亮效果：遍历容器内全部 `[data-anchor-key]` 节点，逐个在 JS 里比较属性值，
 * **不把 anchor key 拼进 CSS 选择器字符串**（`EventId` 含 `:`，拼选择器容易出错）。
 * 依赖只写 `[selectedAnchorKey, voiceRenders]`：`containerRef` 是稳定的 ref 对象，
 * 列进依赖数组没有意义；`voiceRenders` 变化说明谱面 DOM 可能整体换了一批节点，
 * 需要重新扫描而不是依赖 `selectedAnchorKey` 恰好也变化。
 */
function useAnchorHighlight(
  containerRef: RefObject<HTMLDivElement | null>,
  selectedAnchorKey: string | undefined,
  voiceRenders: readonly VoiceRender[],
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const nodes = container.querySelectorAll('[data-anchor-key]');
    nodes.forEach((node) => {
      const match = selectedAnchorKey !== undefined && node.getAttribute('data-anchor-key') === selectedAnchorKey;
      node.classList.toggle('render-anchor-highlighted', match);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- containerRef 是稳定 ref，不参与依赖
  }, [selectedAnchorKey, voiceRenders]);
}

/** `.score-voices` 的真实 CSS 宽度 → abstract unit（D7 + 文件头「可用宽度」说明）。 */
function useAvailableWidth(voicesRef: RefObject<HTMLDivElement | null>): number {
  const [cssWidth, setCssWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const el = voicesRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setCssWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => { observer.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- voicesRef 是稳定 ref，不参与依赖
  }, []);
  return cssWidth === undefined
    ? SCORE_VIEW_METRICS.defaultAvailableWidth
    : cssWidth / SCORE_VIEW_METRICS.cssPixelsPerUnitAtZoom1;
}

/** 按 `id` 去重、保留首次出现的顺序——合并各层诊断后的**兜底**，不是正确性来源（见文件头）。 */
function dedupeById(diagnostics: readonly RenderDiagnostic[]): readonly RenderDiagnostic[] {
  const seen = new Set<string>();
  const result: RenderDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (seen.has(diagnostic.id)) continue;
    seen.add(diagnostic.id);
    result.push(diagnostic);
  }
  return result;
}

export function ScoreView() {
  const score = useMuseAppStore((state) => state.score);
  const index = useMuseAppStore((state) => state.index);

  // P1-1 / P2-F：RenderInput 的 index 只能来自 store（同一次 loadJcx），依赖数组写全。
  const renderScore = useMemo(() => buildRenderScore({ score, index }), [score, index]);
  const header = useMemo(() => layoutScoreHeader(score, MEASURER), [score]);

  const voicesRef = useRef<HTMLDivElement | null>(null);
  const availableWidth = useAvailableWidth(voicesRef);

  const voiceRenders = useMemo(
    () =>
      renderScore.voices.map((voice) =>
        buildVoiceRender(voice, { score, index, measurer: MEASURER, availableWidth }),
      ),
    [renderScore, score, index, availableWidth],
  );

  const diagnostics = useMemo(
    () =>
      dedupeById([
        ...renderScore.diagnostics,
        ...header.diagnostics,
        ...voiceRenders.flatMap((render) => (render.kind === 'jianpu' ? render.diagnostics : [])),
      ]),
    [renderScore, header, voiceRenders],
  );

  const [selectedAnchorKey, setSelectedAnchorKey] = useState<string | undefined>(undefined);
  useEffect(() => {
    setSelectedAnchorKey(undefined);
  }, [score]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  useAnchorHighlight(containerRef, selectedAnchorKey, voiceRenders);

  function handleContainerClick(event: ReactMouseEvent<HTMLDivElement>): void {
    const key = nearestAnchorKey(event.target);
    if (key !== undefined) setSelectedAnchorKey(key);
  }

  return (
    <div className="score-view" ref={containerRef} onClick={handleContainerClick}>
      <ScoreHeaderView header={header} />
      <div className="score-voices" ref={voicesRef}>
        {voiceRenders.map((render) => <VoiceRenderView key={render.voiceId} render={render} />)}
      </div>
      <DiagnosticsPanel
        diagnostics={diagnostics}
        selectedAnchorKey={selectedAnchorKey}
        onSelect={setSelectedAnchorKey}
      />
    </div>
  );
}
