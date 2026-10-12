/**
 * M3 T1c-2：renderer store（`src/renderer/app/store.ts`；用户裁决 Q8）。
 *
 * - 正例：demo 初始化与每次 `commitSession` 后，`score / index / diagnostics` 都是 `session.parsed.load` 中的同一批对象；
 *   授权状态与文件引用一致（demo 恒为 none）。
 * - 反例：用另一次解析的结果写派生字段、快照属于别的文档或已过期时，一致性检查器报错。
 * - 降级只从 trusted 到 unverified；纯 UI 状态（zoom、Open 视图）与会话互不影响。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcxParse';
import { createDemoSession, prepareCandidate } from '../../../src/renderer/app/editor/sessionFactory';
import { commitSession, downgradeCapabilityTrust, publishOpenView, storeConsistencyProblems, useMuseAppStore } from '../../../src/renderer/app/store';

function candidateSession(documentId = 5) {
  const result = prepareCandidate({
    documentId,
    source: 'X:1\nT:store\nK:G\nGABc|\n',
    writeEncoding: 'utf-8',
    byteBom: 'none',
    encodingRoundTrip: 'exact',
    file: { capability: { id: `cap-${String(documentId)}` }, displayName: 's.jcx', displayPath: '/s.jcx' },
  });
  if (!result.ok) throw new Error('prepare failed');
  return result.candidate.session;
}

afterEach(() => {
  commitSession(createDemoSession(), 'none');
  publishOpenView({ phase: 'idle', notice: null });
  useMuseAppStore.getState().setZoom(1);
});

describe('store —— demo 初始化', () => {
  it('初始状态：demo 会话、trust none、派生字段与解析快照同源', () => {
    const state = useMuseAppStore.getState();
    expect(state.session.documentId).toBe(0);
    expect(state.session.file).toBeNull();
    expect(state.capabilityTrust).toBe('none');
    expect(storeConsistencyProblems(state)).toEqual([]);
    expect(state.score).toBe(state.session.parsed?.load.score);
    expect(state.open).toEqual({ phase: 'idle', notice: null });
  });
});

describe('store —— commitSession', () => {
  it('一次 set 同时替换会话、授权与派生字段（订阅者只收到一次通知）', () => {
    const session = candidateSession();
    let notifications = 0;
    const unsubscribe = useMuseAppStore.subscribe(() => {
      notifications += 1;
    });
    commitSession(session, 'trusted');
    unsubscribe();
    const state = useMuseAppStore.getState();
    expect(notifications).toBe(1);
    expect(state.session).toBe(session);
    expect(state.capabilityTrust).toBe('trusted');
    expect(state.index).toBe(session.parsed?.load.index);
    expect(state.diagnostics).toBe(session.parsed?.load.diagnostics);
    expect(storeConsistencyProblems(state)).toEqual([]);
  });

  it('反例：派生字段来自另一次解析 / 快照属于别的文档 / 授权与文件不符时，一致性检查器报错', () => {
    const session = candidateSession();
    commitSession(session, 'trusted');
    const state = useMuseAppStore.getState();
    const other = loadJcx(session.source);
    expect(storeConsistencyProblems({ ...state, score: other.score })).toContain('score is not session.parsed.load.score');
    expect(storeConsistencyProblems({ ...state, index: other.index })).toContain('index is not session.parsed.load.index');
    expect(storeConsistencyProblems({ ...state, diagnostics: other.diagnostics })).toContain('diagnostics is not session.parsed.load.diagnostics');
    const parsed = session.parsed;
    if (parsed === null) throw new Error('no snapshot');
    expect(storeConsistencyProblems({ ...state, session: { ...session, parsed: { ...parsed, documentId: 99 } } })).toContain(
      'parsed snapshot belongs to another document',
    );
    expect(storeConsistencyProblems({ ...state, session: { ...session, sourceVersion: 2 } })).toContain('parsed snapshot is stale');
    expect(storeConsistencyProblems({ ...state, capabilityTrust: 'none' })).toContain('capability trust does not match the file reference');
    expect(storeConsistencyProblems({ ...state, session: createDemoSession() })).toContain('score is not session.parsed.load.score');
  });
});

describe('store —— 授权降级与纯 UI 状态', () => {
  it('降级只从 trusted 到 unverified；demo 的 none 与已降级的状态不变', () => {
    downgradeCapabilityTrust();
    expect(useMuseAppStore.getState().capabilityTrust).toBe('none');
    commitSession(candidateSession(), 'trusted');
    downgradeCapabilityTrust();
    expect(useMuseAppStore.getState().capabilityTrust).toBe('unverified');
    downgradeCapabilityTrust();
    expect(useMuseAppStore.getState().capabilityTrust).toBe('unverified');
  });

  it('降级与 Open 视图不改动会话与派生字段', () => {
    commitSession(candidateSession(), 'trusted');
    const before = useMuseAppStore.getState();
    downgradeCapabilityTrust();
    publishOpenView({ phase: 'activating', notice: { kind: 'busy' } });
    const after = useMuseAppStore.getState();
    expect([after.session, after.score, after.index, after.diagnostics]).toEqual([before.session, before.score, before.index, before.diagnostics]);
    expect(after.session).toBe(before.session);
  });

  it('zoom 与会话互不影响', () => {
    const session = useMuseAppStore.getState().session;
    useMuseAppStore.getState().setZoom(1.25);
    expect(useMuseAppStore.getState().session).toBe(session);
    commitSession(candidateSession(), 'trusted');
    expect(useMuseAppStore.getState().zoom).toBe(1.25);
  });
});
