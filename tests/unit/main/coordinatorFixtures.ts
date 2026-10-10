/**
 * M3 T1b-1 协调器测试共用的构造器：伪造 T1a 管线的 `opened` / `failed` 结果，以及每步迁移后的一致性断言。
 */

import { expect } from 'vitest';

import type { OpenCapabilityRecord } from '../../../src/main/document/capabilities';
import type { OpenAtPathResult } from '../../../src/main/document/openDocument';
import { coordinatorInvariantViolations } from '../../../src/main/open/coordinatorInvariants';
import type { OpenCoordinatorState, OpenTicket } from '../../../src/main/open/openCoordinator';
import type { DocumentActivationTicket } from '../../../src/shared/activationContracts';

export interface Opened {
  readonly completion: Extract<OpenAtPathResult, { kind: 'opened' }>;
  readonly ticket: DocumentActivationTicket;
}

/** T1a 管线成功时的结果：pending 能力记录 + DecodedDocument（二者 token / documentId 一致）。 */
export function opened(ownerId: number, token: string, documentId: number): Opened {
  const capability: OpenCapabilityRecord = {
    token,
    ownerId,
    documentId,
    purpose: 'open',
    state: 'pending',
    realpath: `/real/${token}.jcx`,
    displayName: `${token}.jcx`,
    displayPath: `/shown/${token}.jcx`,
    writeEncoding: 'utf-8',
    byteBom: 'none',
    encodingRoundTrip: 'exact',
    lastKnownDiskFingerprint: '0'.repeat(64),
    identity: null,
  };
  return {
    completion: {
      kind: 'opened',
      capability,
      document: {
        documentId,
        source: 'X:1\n',
        writeEncoding: 'utf-8',
        byteBom: 'none',
        encodingRoundTrip: 'exact',
        file: { capability: { id: token }, displayName: capability.displayName, displayPath: capability.displayPath },
      },
    },
    ticket: { capabilityId: token, documentId },
  };
}

export const decodeFailure: OpenAtPathResult = {
  kind: 'failed',
  error: { code: 'decode-invalid-gb18030', message: 'The file is neither valid UTF-8 nor valid GB18030.' },
};

/** 每步迁移后调用：状态不变量成立。 */
export function expectConsistent(state: OpenCoordinatorState): void {
  expect(coordinatorInvariantViolations(state)).toEqual([]);
}

/** `beginOpen` 必须被接受；返回票据。 */
export function acceptedTicket(outcome: { readonly kind: string; readonly ticket?: OpenTicket }): OpenTicket {
  if (outcome.kind !== 'accepted' || outcome.ticket === undefined) throw new Error(`expected accepted, got ${outcome.kind}`);
  return outcome.ticket;
}

/** 某 owner 的 pending / active token 列表（直接读能力表，即单一事实来源）。 */
export function tokensOf(state: OpenCoordinatorState, ownerId: number, kind: 'pending' | 'active'): string[] {
  return [...state.table.values()].filter((r) => r.ownerId === ownerId && r.state === kind).map((r) => r.token);
}
