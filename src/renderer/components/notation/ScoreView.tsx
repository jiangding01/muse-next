/**
 * 谱面视图（M2 方案 v1.1.1 §2.4.2 / §3.5 / §4 / §6 T5；tab 分支 + zoom 接线 T6.4）。
 *
 * 数据入口：从 store 取 `{ score, index }` 组成 `RenderInput`（P1-1），
 * `useMemo` 依赖数组写全 `[score, index]`（P2-F：只写 `[score]` 会在 `index` 被换掉
 * 而 `score` 引用未变时用到陈旧索引）。
 *
 * 每个声部按 `voice.style` 分派（`buildVoiceRender`，见 `./voiceRender.ts`）：
 * - `jianpu` → `layoutJianpu` + `jianpuToSvg`；
 * - `tab` → `layoutTab` + `tabToSvg`（T6.4 新增，与 jianpu 分支同构）；
 * - `staff` → `layoutStaff` + `StaffVoiceView`（T7.4）：与前两种**不同构**——SVG 由
 *   VexFlow 在 `renderer/integrations/vexflow/**` 里直接画进 DOM，不经过 `SvgNode` 树，
 *   而且绘制是**异步的**（要先 `await document.fonts.ready`）。异步这一点带来一个
 *   真实后果：高亮 effect 必须能在 adapter 插完节点之后**再扫一次**，见
 *   `renderGeneration`；
 * - 缺席 / 未知 → D12 方案 B 的保守占位（事件的文本化摘要，摘要函数在
 *   `notation/layout/fallbackSummary.ts`——本文件只消费字符串，不解释 `MusicEvent`
 *   的分支，那是需要单测覆盖的纯函数逻辑，不该藏在组件里），**不再造第二条诊断**：
 *   `buildRenderScore` 已经在 voice 级发过 `voice.style-absent` / `voice.style-unknown`。
 *
 * 诊断合并顺序固定：`renderScore.diagnostics` → 头部 `diagnostics` → 按声部顺序追加
 * 各 jianpu/tab `Layout.diagnostics`（staff/fallback 占位不追加）；**按 `id` 去重只是
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
 * **可用宽度**（D7 按容器宽度换行 + T6.4 zoom 接线）：`voicesRef` 用 `ResizeObserver`
 * 取 `.score-voices` 的真实 CSS 宽度，按 `computeAvailableWidthUnits`（见
 * `./voiceRender.ts`）换算成 abstract unit 传给 `availableWidth`——除数是
 * `cssPixelsPerUnitAtZoom1 × zoom`，zoom 越大换行越早、越小换行越晚（注释见该函数）；
 * 没有 `ResizeObserver`（测试 / SSR）时退回 `SCORE_VIEW_METRICS.defaultAvailableWidth`
 * （不受 zoom 影响：这是没量到真实宽度时的固定兜底，不是「按 zoom 换算後」的值）。
 * jianpu 与 tab 两种记谱共用同一个 `availableWidth`（T5 留给 T6 的 zoom 接线，两种
 * 记谱一致）。
 */

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type MouseEvent as ReactMouseEvent, type RefObject,
} from 'react';

import type { VoiceId } from '../../../domain';
import { SCORE_VIEW_METRICS } from '../../../notation/layout/metrics';
import { layoutScoreHeader } from '../../../notation/layout/scoreHeader';
import { createDeterministicTextMeasurer, type TextMeasurer } from '../../../notation/layout/textMeasurer';
import { buildRenderScore } from '../../../notation/model/buildRenderScore';
import { anchorKey, type RenderDiagnostic } from '../../../notation/model/types';
import { useMuseAppStore } from '../../app/store';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { ScoreHeaderView } from './ScoreHeaderView';
import { StaffVoiceView } from './StaffVoiceView';
import { SvgTree } from './SvgTree';
import { buildVoiceRender, computeAvailableWidthUnits, type VoiceRender } from './voiceRender';

/** 生产与测试共用的确定性度量实现（§2.8：不接 DOM，避免布局随宿主字体漂移）。 */
const MEASURER: TextMeasurer = createDeterministicTextMeasurer();

function voiceAnchorKey(voiceId: VoiceId): string {
  return anchorKey({ kind: 'voice', voiceId });
}

/** `layout.width`（abstract unit）→ 画布 CSS 宽度：`cssPixelsPerUnitAtZoom1 × zoom`（T6.4）。 */
function canvasWidthPx(layoutWidth: number, zoom: number): string {
  return `${String(layoutWidth * SCORE_VIEW_METRICS.cssPixelsPerUnitAtZoom1 * zoom)}px`;
}

/** 四种声部渲染结果的外层都携带同一个 voice 级 `data-anchor-key`（P1-3）。 */
function VoiceRenderView({ render, zoom, onRendered }: {
  readonly render: VoiceRender;
  readonly zoom: number;
  readonly onRendered: () => void;
}) {
  const anchor = voiceAnchorKey(render.voiceId);
  if (render.kind === 'jianpu') {
    return (
      <section className="score-voice score-voice-jianpu" data-voice-id={render.voiceId} data-anchor-key={anchor}>
        {/* 谱面按固定比例绘制：容器变窄靠 system 换行（D7），不靠 SVG 等比缩放（否则字号随窗口变化）；
            zoom 只改这个 CSS 宽度（外层像素换算），不改 SvgTree 里任何 layout 数值（D6）。 */}
        <div className="jianpu-canvas" style={{ width: canvasWidthPx(render.width, zoom) }}>
          <SvgTree node={render.node} />
        </div>
      </section>
    );
  }
  if (render.kind === 'tab') {
    return (
      <section className="score-voice score-voice-tab" data-voice-id={render.voiceId} data-anchor-key={anchor}>
        <div className="tab-canvas" style={{ width: canvasWidthPx(render.width, zoom) }}>
          <SvgTree node={render.node} />
        </div>
      </section>
    );
  }
  if (render.kind === 'staff') {
    // 外层 `<section>`（含 voice 锚与 zoom 宽度）在 `StaffVoiceView` 内部，与前两种
    // 记谱写法不同：内层 host div 必须由 VexFlow 独占，不能有 React 管的兄弟节点。
    return <StaffVoiceView render={render} zoom={zoom} onRendered={onRendered} />;
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
 *
 * **`renderGeneration`（T7.4 新增）**：五线谱的 DOM 节点是 adapter 在
 * `document.fonts.ready` 之后**异步**插进来的——effect 跑完时它们还不存在，只靠
 * `[selectedAnchorKey, voiceRenders]` 这两个依赖，首次绘制以及 zoom / 换行导致的重绘
 * 都会漏掉高亮。`StaffVoiceView.onRendered` 每画完一次就把这个计数 +1，effect 因此
 * 重新扫一遍容器。它只是一个「DOM 可能变了」的信号，不携带任何语义。
 */
function useAnchorHighlight(
  containerRef: RefObject<HTMLDivElement | null>,
  selectedAnchorKey: string | undefined,
  voiceRenders: readonly VoiceRender[],
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
  }, [selectedAnchorKey, voiceRenders, renderGeneration]);
}

/** `.score-voices` 的真实 CSS 宽度 → abstract unit（D7 + 文件头「可用宽度」说明，T6.4 纳入 zoom）。 */
function useAvailableWidth(voicesRef: RefObject<HTMLDivElement | null>, zoom: number): number {
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
    : computeAvailableWidthUnits(cssWidth, SCORE_VIEW_METRICS.cssPixelsPerUnitAtZoom1, zoom);
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
  const zoom = useMuseAppStore((state) => state.zoom);

  // P1-1 / P2-F：RenderInput 的 index 只能来自 store（同一次 loadJcx），依赖数组写全。
  const renderScore = useMemo(() => buildRenderScore({ score, index }), [score, index]);
  const header = useMemo(() => layoutScoreHeader(score, MEASURER), [score]);

  const voicesRef = useRef<HTMLDivElement | null>(null);
  const availableWidth = useAvailableWidth(voicesRef, zoom);

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
        ...voiceRenders.flatMap((render) =>
          render.kind === 'jianpu' || render.kind === 'tab' || render.kind === 'staff'
            ? render.diagnostics
            : [],
        ),
      ]),
    [renderScore, header, voiceRenders],
  );

  const [selectedAnchorKey, setSelectedAnchorKey] = useState<string | undefined>(undefined);
  useEffect(() => {
    setSelectedAnchorKey(undefined);
  }, [score]);

  // 见 `useAnchorHighlight` 的 JSDoc：staff 的 DOM 是异步插进来的，需要一个额外的
  // 「重扫」信号。`useCallback` 保证 `onRendered` 引用稳定，不会把 effect 拖成死循环。
  const [renderGeneration, setRenderGeneration] = useState(0);
  const handleRendered = useCallback(() => {
    setRenderGeneration((generation) => generation + 1);
  }, []);

  const containerRef = useRef<HTMLDivElement | null>(null);
  useAnchorHighlight(containerRef, selectedAnchorKey, voiceRenders, renderGeneration);

  function handleContainerClick(event: ReactMouseEvent<HTMLDivElement>): void {
    const key = nearestAnchorKey(event.target);
    if (key !== undefined) setSelectedAnchorKey(key);
  }

  return (
    <div className="score-view" ref={containerRef} onClick={handleContainerClick}>
      <ScoreHeaderView header={header} />
      <div className="score-voices" ref={voicesRef}>
        {voiceRenders.map((render) => (
          <VoiceRenderView key={render.voiceId} render={render} zoom={zoom} onRendered={handleRendered} />
        ))}
      </div>
      <DiagnosticsPanel
        diagnostics={diagnostics}
        selectedAnchorKey={selectedAnchorKey}
        onSelect={setSelectedAnchorKey}
      />
    </div>
  );
}
