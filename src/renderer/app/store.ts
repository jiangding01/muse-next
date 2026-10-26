/**
 * Renderer 应用状态（M3 T1c-2 起：T1c Preflight r2 §6.1；M3 T3a：T3 Preflight r3 §4）。
 *
 * - **唯一会话真源**是 T0 的 `DocumentSession`（`session`）；本模块不复制、不改写会话合同，不维护第二套文档状态。
 * - `history`（T2）与 `selection`（运行时选中）和会话成对存放，三者只经下面的原子写入函数在同一次 `set()` 中替换。
 * - `score / index / diagnostics` 是为兼容 ScoreView 等既有组件保留的派生字段，恒为 `session.parsed.load` 中的同一批对象；
 *   只在 `commitSession`（Open / demo）与 `publishParsedSession`（解析被接受）中重算。编辑与 undo / redo 不换快照，
 *   因此 `parsed.sourceVersion < sourceVersion`（stale）是合法状态：谱面继续显示最后一份快照（§8.2）。
 * - `capabilityTrust`：demo 恒为 `none`；明确激活成功后为 `trusted`；观察到吊销信号后为 `unverified`（只降级，不升级）。
 * - `open` 与 `editor` 只是展示视图（阶段与提示），不参与任何判断。
 * - `zoom` 等纯 UI 状态独立于会话，不参与 dirty。
 * - 格式层只经 renderer-safe parse façade（`src/formats/jcxParse.ts`）。
 */

import { create } from 'zustand';

import type { DomainIndex, Score } from '../../domain';
import type { JcxDiagnostic, LoadResult } from '../../formats/jcxParse';
import type { HistoryState } from '../../editor/history/types';
import type { EditorSelection } from '../../editor/selection/types';
import type { DocumentSession } from '../../editor/session/types';
import { SCORE_VIEW_METRICS } from '../../notation/layout/metrics';
import { initialEditorCore } from './editor/editorTransitions';
import type { EditorCore, EditorNotice } from './editor/editorTransitions';
import { createDemoSession } from './editor/sessionFactory';
import type { CapabilityTrust, OpenNotice, OpenPhase } from './editor/openTransaction';

export interface OpenView {
  readonly phase: OpenPhase;
  readonly notice: OpenNotice | null;
}

/** 编辑器的展示视图（T3a 中尚无界面呈现，状态栏在 T3b）。 */
export interface EditorView {
  readonly composing: boolean;
  readonly notice: EditorNotice | null;
}

/** 由会话的解析快照派生、兼容既有组件的三个字段。 */
interface DerivedDocument {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly diagnostics: readonly JcxDiagnostic[];
}

interface MuseAppState extends DerivedDocument {
  readonly session: DocumentSession;
  readonly history: HistoryState;
  readonly selection: EditorSelection;
  readonly capabilityTrust: CapabilityTrust;
  readonly open: OpenView;
  readonly editor: EditorView;
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
const IDLE_EDITOR: EditorView = { composing: false, notice: null };

export const useMuseAppStore = create<MuseAppState>((set) => {
  const core = initialEditorCore(createDemoSession());
  return {
    ...core,
    capabilityTrust: 'none',
    ...derive(core.session),
    open: IDLE_VIEW,
    editor: IDLE_EDITOR,
    zoom: 1,
    setZoom(zoom) {
      set({ zoom: clampZoom(zoom) });
    },
  };
});

/** 提交一个已激活的会话（Open / demo）：会话、空历史、空选中、授权状态、派生字段与编辑视图在同一次 `set()` 中替换。 */
export function commitSession(session: DocumentSession, capabilityTrust: CapabilityTrust): void {
  const derived = derive(session);
  const core = initialEditorCore(session);
  useMuseAppStore.setState({ session, history: core.history, selection: core.selection, capabilityTrust, ...derived, editor: IDLE_EDITOR });
}

export type StoreWriteRejection =
  | 'base-changed'
  | 'document-mismatch'
  | 'version-regressed'
  | 'not-derived-from-current'
  | 'snapshot-replaced'
  | 'history-unbound'
  | 'selection-not-current'
  | 'session-changed'
  | 'snapshot-not-current';

export type StoreWriteResult = { readonly ok: true } | { readonly ok: false; readonly reason: StoreWriteRejection };

const historyBound = (history: HistoryState, session: DocumentSession): boolean =>
  history.documentId === session.documentId && history.headVersion === session.sourceVersion && history.headSource === session.source;

/**
 * 写入前的检查。先是对编辑基线的 CAS（r3a 复核 M-1）：调用方计算所依据的会话、历史、选中必须**就是**当前 store 中的
 * 同一批对象，否则（基线已被别的写入取代，例如旧分支上再编辑得到的结果版本恰好 +1）一律拒绝。然后是绑定检查：同一文档；
 * 结果由基线一步得到——要么就是基线会话对象（无变化事务），要么版本恰好 +1（编辑、undo、redo 只加 1）；不换快照；
 * 历史与选中都属于新会话。
 */
function editorStepProblem(current: EditorCore, core: EditorCore, base: EditorCore): StoreWriteRejection | null {
  if (base.session !== current.session || base.history !== current.history || base.selection !== current.selection) return 'base-changed';
  return bindingProblem(current.session, core);
}

function bindingProblem(current: DocumentSession, core: EditorCore): StoreWriteRejection | null {
  if (core.session.documentId !== current.documentId) return 'document-mismatch';
  if (core.session.sourceVersion < current.sourceVersion) return 'version-regressed';
  if (core.session !== current && core.session.sourceVersion !== current.sourceVersion + 1) return 'not-derived-from-current';
  if (core.session.parsed !== current.parsed) return 'snapshot-replaced';
  if (!historyBound(core.history, core.session)) return 'history-unbound';
  if (core.selection.basisVersion !== core.session.sourceVersion) return 'selection-not-current';
  return null;
}

/**
 * 编辑、undo / redo、无变化事务的结果：会话、历史、选中在同一次 `set()` 中替换。派生字段不变（编辑不换快照），
 * 因此只订阅 `score / index` 的组件不重渲染。`base` 是调用方计算 `core` 时读取的状态（CAS 的期望值）。
 * 检查失败时不写入，由调用方按编辑器不变量错误处理。
 */
export function applyEditorStep(core: EditorCore, base: EditorCore): StoreWriteResult {
  const { session, history, selection } = useMuseAppStore.getState();
  const problem = editorStepProblem({ session, history, selection }, core, base);
  if (problem !== null) return { ok: false, reason: problem };
  useMuseAppStore.setState({ session: core.session, history: core.history, selection: core.selection });
  return { ok: true };
}

/** 除 `parsed` 外，两个会话的每个字段都是同一个值（引用相等）。 */
const sameExceptParsed = (a: DocumentSession, b: DocumentSession): boolean =>
  a.source === b.source &&
  a.sourceVersion === b.sourceVersion &&
  a.projection === b.projection &&
  a.saved === b.saved &&
  a.file === b.file &&
  a.writeEncoding === b.writeEncoding &&
  a.byteBom === b.byteBom &&
  a.protectedLeadingFeff === b.protectedLeadingFeff &&
  a.encodingRoundTrip === b.encodingRoundTrip &&
  a.fileOp === b.fileOp;

/**
 * 解析被接受（`acceptParsedSnapshot` 之后）：只换会话对象（新的 `parsed`）并重算派生字段。必须与当前会话是同一文档，
 * 除 `parsed` 外其余字段都与当前会话逐一相同（不会把调用方捕获的旧 `saved` / `file` 写回），且快照属于该版本；
 * 历史与选中不变（它们只以版本与 source 绑定）。
 */
export function publishParsedSession(session: DocumentSession): StoreWriteResult {
  const current = useMuseAppStore.getState().session;
  if (session.documentId !== current.documentId) return { ok: false, reason: 'document-mismatch' };
  if (!sameExceptParsed(session, current)) return { ok: false, reason: 'session-changed' };
  const { parsed } = session;
  if (parsed === null || parsed.documentId !== session.documentId || parsed.sourceVersion !== session.sourceVersion) {
    return { ok: false, reason: 'snapshot-not-current' };
  }
  useMuseAppStore.setState({ session, ...derive(session) });
  return { ok: true };
}

/**
 * 非编辑的选区变化：只替换选中与（结束合并组后的）历史。先做与 `applyEditorStep` 相同的三对象 CAS（M3 T3c，用户裁决 Q-C1(a)）：
 * 调用方计算所依据的会话、历史、选中必须就是当前 store 中的同一批对象，否则（基线已被其它写入取代）拒绝，旧选区不会覆盖较新的状态。
 */
export function setEditorSelection(core: EditorCore, base: EditorCore): StoreWriteResult {
  const { session: current, history, selection } = useMuseAppStore.getState();
  if (base.session !== current || base.history !== history || base.selection !== selection) return { ok: false, reason: 'base-changed' };
  if (core.session !== current) return { ok: false, reason: 'session-changed' };
  if (!historyBound(core.history, core.session)) return { ok: false, reason: 'history-unbound' };
  if (core.selection.basisVersion !== core.session.sourceVersion) return { ok: false, reason: 'selection-not-current' };
  useMuseAppStore.setState({ history: core.history, selection: core.selection });
  return { ok: true };
}

/** 编辑器展示视图（组字状态、轻提示）；不触碰会话。 */
export function publishEditorView(view: Partial<EditorView>): void {
  useMuseAppStore.setState((state) => ({ editor: { ...state.editor, ...view } }));
}

/** 观察到吊销信号：有文件的会话降为 unverified；demo（none）与已降级的会话不变。 */
export function downgradeCapabilityTrust(): void {
  useMuseAppStore.setState((state) => (state.capabilityTrust === 'trusted' ? { capabilityTrust: 'unverified' } : state));
}

export function publishOpenView(view: OpenView): void {
  useMuseAppStore.setState({ open: view });
}

type ConsistencyInput = Pick<MuseAppState, 'session' | 'history' | 'selection' | 'score' | 'index' | 'diagnostics' | 'capabilityTrust'>;

const T3_SELECTION_KINDS: ReadonlySet<EditorSelection['kind']> = new Set(['none', 'source']);

/**
 * 一致性检查（测试与诊断）。合法：`parsed.sourceVersion < sourceVersion`（stale，谱面保留旧快照）。
 * 错误：没有快照、快照属于别的文档或来自未来版本、派生字段不是快照中的同一批对象、历史与会话失去绑定、
 * 合并组状态自相矛盾、选中不属于当前版本或越界、T3 中出现 none / source 以外的选中、投影不是由当前 source 构建、
 * 授权状态与文件引用不符。
 */
export function storeConsistencyProblems(state: ConsistencyInput): string[] {
  const problems: string[] = [];
  const { session, history, selection } = state;
  const { parsed } = session;
  if (parsed === null) return ['session has no parsed snapshot'];
  if (parsed.documentId !== session.documentId) problems.push('parsed snapshot belongs to another document');
  if (parsed.sourceVersion > session.sourceVersion) problems.push('parsed snapshot is from a future version');
  if (state.score !== parsed.load.score) problems.push('score is not session.parsed.load.score');
  if (state.index !== parsed.load.index) problems.push('index is not session.parsed.load.index');
  if (state.diagnostics !== parsed.load.diagnostics) problems.push('diagnostics is not session.parsed.load.diagnostics');
  if (history.documentId !== session.documentId) problems.push('history belongs to another document');
  else if (!historyBound(history, session)) problems.push('history is out of sync with the session');
  if (history.open !== null && (history.redo !== null || history.undo === null)) problems.push('history coalescing group is inconsistent');
  if (selection.basisVersion !== session.sourceVersion) problems.push('selection is not on the current version');
  const fits = selection.ranges.every((range) => range.start >= 0 && range.start <= range.end && range.end <= session.source.length);
  if (!fits) problems.push('selection is out of range');
  if (!T3_SELECTION_KINDS.has(selection.kind)) problems.push('selection kind is not allowed in T3');
  if (session.projection.source !== session.source) problems.push('projection is not built from the session source');
  if ((session.file === null) !== (state.capabilityTrust === 'none')) problems.push('capability trust does not match the file reference');
  return problems;
}
