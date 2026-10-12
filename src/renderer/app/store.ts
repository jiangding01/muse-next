/**
 * Renderer 应用状态（M3 T1c-2 起：T1c Preflight r2 §6.1；用户裁决 Q2 / Q8）。
 *
 * - **唯一会话真源**是 T0 的 `DocumentSession`（`session`）；本模块不复制、不改写会话合同，不维护第二套文档状态。
 * - `score / index / diagnostics` 是为兼容 ScoreView 等既有组件保留的派生字段，恒取自**同一个** `session.parsed.load`；
 *   写入会话与派生字段的只有 `commitSession`（单次 `set()`），初始化时由同一个投影函数生成。
 * - `capabilityTrust`：demo 恒为 `none`；明确激活成功后为 `trusted`；观察到吊销信号后为 `unverified`（只降级，不升级）。
 *   它是适配层事实，不进入 `DocumentSession`，也不是授权证明——授权始终由 main 校验 capability 与 documentId。
 * - `open` 只是 Open 状态机的展示视图（阶段与提示），事务本身在 `editor/openController.ts`。
 * - `zoom` 等纯 UI 状态独立于会话，不参与 dirty。
 * - 格式层只经 renderer-safe parse façade（`src/formats/jcxParse.ts`）。
 */

import { create } from 'zustand';

import type { DomainIndex, Score } from '../../domain';
import type { JcxDiagnostic, LoadResult } from '../../formats/jcxParse';
import type { DocumentSession } from '../../editor/session/types';
import { SCORE_VIEW_METRICS } from '../../notation/layout/metrics';
import { createDemoSession } from './editor/sessionFactory';
import type { CapabilityTrust, OpenNotice, OpenPhase } from './editor/openTransaction';

export interface OpenView {
  readonly phase: OpenPhase;
  readonly notice: OpenNotice | null;
}

/** 由会话的解析快照派生、兼容既有组件的三个字段。 */
interface DerivedDocument {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly diagnostics: readonly JcxDiagnostic[];
}

interface MuseAppState extends DerivedDocument {
  readonly session: DocumentSession;
  readonly capabilityTrust: CapabilityTrust;
  readonly open: OpenView;
  /** 谱面缩放比例（T6.4，D6：只影响 renderer 层像素换算，不改任何 layout 数值）。 */
  readonly zoom: number;
  /** 设置缩放比例，clamp 到 `SCORE_VIEW_METRICS.zoomMin/zoomMax`。 */
  setZoom(zoom: number): void;
}

/** 会话的解析快照；会话总是在解析之后才建立，快照缺失说明不变量被破坏。 */
export function sessionLoad(session: DocumentSession): LoadResult {
  if (session.parsed === null) throw new Error('store: session has no parsed snapshot');
  return session.parsed.load;
}

function derive(session: DocumentSession): DerivedDocument {
  const load = sessionLoad(session);
  return { score: load.score, index: load.index, diagnostics: load.diagnostics };
}

/** 非有限值（NaN / Infinity）不进 store：`Math.min/max` 会透传 NaN，下游会算出 `NaNpx`。 */
function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(SCORE_VIEW_METRICS.zoomMax, Math.max(SCORE_VIEW_METRICS.zoomMin, zoom));
}

const IDLE_VIEW: OpenView = { phase: 'idle', notice: null };

export const useMuseAppStore = create<MuseAppState>((set) => {
  const session = createDemoSession();
  return {
    session,
    capabilityTrust: 'none',
    ...derive(session),
    open: IDLE_VIEW,
    zoom: 1,
    setZoom(zoom) {
      set({ zoom: clampZoom(zoom) });
    },
  };
});

/** 提交一个已激活的会话：会话、授权状态与三个派生字段在同一次 `set()` 中替换。 */
export function commitSession(session: DocumentSession, capabilityTrust: CapabilityTrust): void {
  const derived = derive(session);
  useMuseAppStore.setState({ session, capabilityTrust, ...derived });
}

/** 观察到吊销信号：有文件的会话降为 unverified；demo（none）与已降级的会话不变。 */
export function downgradeCapabilityTrust(): void {
  useMuseAppStore.setState((state) => (state.capabilityTrust === 'trusted' ? { capabilityTrust: 'unverified' } : state));
}

export function publishOpenView(view: OpenView): void {
  useMuseAppStore.setState({ open: view });
}

/** 一致性检查（测试与诊断）：派生字段必须是当前会话解析快照中的同一批对象。 */
export function storeConsistencyProblems(state: Pick<MuseAppState, 'session' | 'score' | 'index' | 'diagnostics' | 'capabilityTrust'>): string[] {
  const problems: string[] = [];
  const { parsed } = state.session;
  if (parsed === null) return ['session has no parsed snapshot'];
  if (parsed.documentId !== state.session.documentId) problems.push('parsed snapshot belongs to another document');
  if (parsed.sourceVersion !== state.session.sourceVersion) problems.push('parsed snapshot is stale');
  if (state.score !== parsed.load.score) problems.push('score is not session.parsed.load.score');
  if (state.index !== parsed.load.index) problems.push('index is not session.parsed.load.index');
  if (state.diagnostics !== parsed.load.diagnostics) problems.push('diagnostics is not session.parsed.load.diagnostics');
  if ((state.session.file === null) !== (state.capabilityTrust === 'none')) problems.push('capability trust does not match the file reference');
  return problems;
}
