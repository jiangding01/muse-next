/**
 * 谱面视图（M2 方案 v1.1.1 §2.4.2 / §3.5 / §4 / §6 T5；M2.5 T9b 起按 system 渲染）。
 *
 * 数据入口：从 store 取 `{ score, index }` 组成 `RenderInput`（P1-1），`useMemo` 依赖数组写全 `[score, index]`
 * （P2-F：只写 `[score]` 会在 `index` 被换掉而 `score` 引用未变时用到陈旧索引）。
 *
 * **M2.5 T9b：一级分组从声部改为 system**。唯一的 layout 编排入口是
 * `composeScoreLayout(renderScore, index, MEASURER, { kind: 'screen', availableWidth })`（T8）；本组件不再直接调用
 * 任何声部 layout，也不调用 PageModel（screen 路径与分页无关，§Q6.4）。`systemRender.ts` 把 `ScoreLayout` 组装成
 * 逐字段映射的 `ScoreRender`（切片、chordSymbol 抑制、overlay、左侧留白、fallback 提示），`SystemView` 负责 DOM：
 * `.score-systems` > `section.score-system` × N，system 之间由容器 row-gap 恰好放一个 `systemGap`。
 * fallback 声部（未声明 / 未知 style）在 system 内只保留高 0 的层身份，可见的保守摘要列在 system 之外，
 * 每个声部一项（D12 方案 B；`buildRenderScore` 已在 voice 级发过 `voice.style-absent` / `voice.style-unknown`）。
 *
 * **诊断合并**：`scoreLayout.diagnostics`（T8 已含 renderScore / T1–T3 / T6 / 各声部 layout）→ 页眉 `diagnostics`；
 * 不再额外合并 `renderScore.diagnostics`（否则重复）；按 `id` 去重只是兜底。
 *
 * 谱面 ↔ `RenderDiagnostic` 互相高亮走同一个字符串状态 `selectedAnchorKey`（`anchorKey()`，与 `SvgNode` / 层 / 和弦
 * overlay 上统一携带的 `data-anchor-key` 同源）：点击谱面节点或诊断条目都只是把它设成同一个 key。**不做 textarea
 * 行级定位**（P2-9）。
 *
 * **可用宽度**（D7 + T6.4 zoom 接线，公式不变）：`ResizeObserver` 量 `.score-systems` 的 CSS 内容宽（该容器
 * `min-width: 0`，宽度只由外层决定，system 画布溢出不会反过来改变它），按 `computeAvailableWidthUnits`
 * 换算成 abstract unit；没有 `ResizeObserver`（测试 / SSR）时退回 `SCORE_VIEW_METRICS.defaultAvailableWidth`。
 */

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent, type RefObject,
} from 'react';

import { SCORE_VIEW_METRICS, SYSTEM_METRICS } from '../../../notation/layout/metrics';
import { layoutScoreHeader } from '../../../notation/layout/scoreHeader';
import { createDeterministicTextMeasurer, type TextMeasurer } from '../../../notation/layout/textMeasurer';
import { buildRenderScore } from '../../../notation/model/buildRenderScore';
import { anchorKey } from '../../../notation/model/types';
import { composeScoreLayout } from '../../../notation/system/composeLayout';
import { useMuseAppStore } from '../../app/store';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ScoreHeaderView } from './ScoreHeaderView';
import { SystemView } from './SystemView';
import {
  buildScoreRender, computeAvailableWidthUnits, cssPx, mergeScoreDiagnostics,
  type FallbackNotice, type ScoreRender,
} from './systemRender';

/** 生产与测试共用的确定性度量实现（§2.8：不接 DOM，避免布局随宿主字体漂移）。 */
const MEASURER: TextMeasurer = createDeterministicTextMeasurer();

/** fallback 声部的保守摘要（system 之外、每个声部一项；不参与任何 system 几何）。 */
function FallbackNoticeView({ notice }: { readonly notice: FallbackNotice }) {
  return (
    <section
      className="score-voice score-voice-fallback"
      data-voice-id={notice.voiceId}
      data-anchor-key={anchorKey({ kind: 'voice', voiceId: notice.voiceId })}
    >
      <p className="score-voice-fallback-label">{notice.label}</p>
      <p className="score-voice-fallback-summary">{notice.summary}</p>
    </section>
  );
}

/**
 * 点击时从事件目标向上找最近的 `[data-anchor-key]`；找不到就什么都不做（anchor 没有可视节点是允许的）。
 */
function nearestAnchorKey(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  const el = target.closest('[data-anchor-key]');
  return el?.getAttribute('data-anchor-key') ?? undefined;
}

/**
 * 高亮效果：遍历容器内全部 `[data-anchor-key]` 节点，逐个在 JS 里比较属性值（不把 key 拼进 CSS 选择器）。
 * 依赖 `[selectedAnchorKey, scoreRender, renderGeneration]`：`scoreRender` 变化说明 system DOM 整体换了一批；
 * `renderGeneration` 是五线谱 host 异步画完后的「重扫」信号（每个 staff 切片画完都会递增，只是信号，不携带语义）。
 */
function useAnchorHighlight(
  containerRef: RefObject<HTMLDivElement | null>,
  selectedAnchorKey: string | undefined,
  scoreRender: ScoreRender,
  renderGeneration: number,
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
  }, [selectedAnchorKey, scoreRender, renderGeneration]);
}

/** `.score-systems` 的真实 CSS 内容宽 → abstract unit（D7 + T6.4，公式不变）。 */
function useAvailableWidth(systemsRef: RefObject<HTMLDivElement | null>, zoom: number): number {
  const [cssWidth, setCssWidth] = useState<number | undefined>(undefined);
  useEffect(() => {
    const el = systemsRef.current;
    if (el === null || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) setCssWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => { observer.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- systemsRef 是稳定 ref，不参与依赖
  }, []);
  return cssWidth === undefined
    ? SCORE_VIEW_METRICS.defaultAvailableWidth
    : computeAvailableWidthUnits(cssWidth, SCORE_VIEW_METRICS.cssPixelsPerUnitAtZoom1, zoom);
}

export function ScoreView() {
  const score = useMuseAppStore((state) => state.score);
  const index = useMuseAppStore((state) => state.index);
  const zoom = useMuseAppStore((state) => state.zoom);

  // P1-1 / P2-F：RenderInput 的 index 只能来自 store（同一次 loadJcx），依赖数组写全。
  const renderScore = useMemo(() => buildRenderScore({ score, index }), [score, index]);
  const header = useMemo(() => layoutScoreHeader(score, MEASURER), [score]);

  const systemsRef = useRef<HTMLDivElement | null>(null);
  const availableWidth = useAvailableWidth(systemsRef, zoom);

  const scoreLayout = useMemo(
    () => composeScoreLayout(renderScore, index, MEASURER, { kind: 'screen', availableWidth }),
    [renderScore, index, availableWidth],
  );
  const scoreRender = useMemo(() => buildScoreRender(scoreLayout, renderScore, MEASURER), [scoreLayout, renderScore]);
  const diagnostics = useMemo(
    () => mergeScoreDiagnostics(scoreLayout.diagnostics, header.diagnostics),
    [scoreLayout, header],
  );

  const [selectedAnchorKey, setSelectedAnchorKey] = useState<string | undefined>(undefined);
  useEffect(() => {
    setSelectedAnchorKey(undefined);
  }, [score]);

  // 五线谱 DOM 是异步插进来的，需要额外的「重扫」信号；`useCallback` 保证 `onRendered` 引用稳定，不会把 effect 拖成死循环。
  const [renderGeneration, setRenderGeneration] = useState(0);
  const handleRendered = useCallback(() => {
    setRenderGeneration((generation) => generation + 1);
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  useAnchorHighlight(containerRef, selectedAnchorKey, scoreRender, renderGeneration);

  function handleContainerClick(event: ReactMouseEvent<HTMLDivElement>): void {
    const key = nearestAnchorKey(event.target);
    if (key !== undefined) setSelectedAnchorKey(key);
  }

  return (
    <div className="score-view" ref={containerRef} onClick={handleContainerClick}>
      <ScoreHeaderView header={header} />
      <div className="score-systems" ref={systemsRef} style={{ rowGap: cssPx(SYSTEM_METRICS.systemGap, zoom) }}>
        {scoreRender.systems.map((system) => (
          <SystemView key={system.index} system={system} zoom={zoom} onRendered={handleRendered} />
        ))}
      </div>
      {scoreRender.fallbackNotices.length === 0 ? null : (
        <div className="score-fallback-voices">
          {scoreRender.fallbackNotices.map((notice) => <FallbackNoticeView key={notice.voiceId} notice={notice} />)}
        </div>
      )}
      <DiagnosticsPanel
        diagnostics={diagnostics}
        selectedAnchorKey={selectedAnchorKey}
        onSelect={setSelectedAnchorKey}
      />
    </div>
  );
}
