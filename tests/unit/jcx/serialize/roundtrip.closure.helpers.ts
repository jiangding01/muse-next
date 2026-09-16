/**
 * canonical document closure 矩阵的共用夹具（M1.8 T1，方案 v1.1 §4 T1 / §0a 第 2 条）。
 *
 * 与 `roundtrip.helpers.ts` 同规矩：这里只做「跑一趟闭包链路 / 算一处差异位置」
 * 这类无断言的机械操作，断言全部留在 `roundtrip.closure.test.ts`。
 */

import { loadJcx } from '../../../../src/formats/jcx';
import type { JcxDiagnostic } from '../../../../src/formats/jcx/lexer/diagnostics';
import { serializeJcx } from '../../../../src/formats/jcx/serialize';
import type { ProjectedScore } from '../../../../src/formats/jcx/serialize';
import { projectScore } from '../../../../src/formats/jcx/serialize';
import { fixtureBytes } from './roundtrip.helpers';

export interface ClosureTrip {
  /** `canonical(parse(原字节))` 的文本（闭包矩阵的被测文档）。 */
  readonly canon1Text: string;
  /** 同上的字节（canonical 恒 UTF-8 / 无 BOM / LF）。 */
  readonly canon1Bytes: Uint8Array;
  /** `canonical(parse(canon1))` 的文本——不动点断言的另一侧。 */
  readonly canon2Text: string;
  /** `project(parse(canon1))`。 */
  readonly projectionAfterCanon1: ProjectedScore;
  /** `project(parse(canon2))`。 */
  readonly projectionAfterCanon2: ProjectedScore;
  /** `preserve(loadJcx(canon1Bytes))` 的字节——L3 闭包断言的另一侧。 */
  readonly preserveOfCanon1Bytes: Uint8Array;
  /** `loadJcx(canon1Text).diagnostics`——闭包层 reparse clean 断言用。 */
  readonly reparsedDiagnostics: readonly JcxDiagnostic[];
}

/**
 * 跑完整条闭包链路：原字节 → canon1 → （重解析）→ canon2，外加 canon1 的
 * preserve 回写。一次算完不动点 / L2 / L3 / reparse clean 四项所需素材。
 */
export function closureTrip(name: string): ClosureTrip {
  const canon1 = serializeJcx(loadJcx(fixtureBytes(name)).score, { mode: 'canonical' });
  const reparsed1 = loadJcx(canon1.text);
  const canon2 = serializeJcx(reparsed1.score, { mode: 'canonical' });
  const reparsed2 = loadJcx(canon2.text);
  return {
    canon1Text: canon1.text,
    canon1Bytes: canon1.bytes,
    canon2Text: canon2.text,
    projectionAfterCanon1: projectScore(reparsed1.score),
    projectionAfterCanon2: projectScore(reparsed2.score),
    preserveOfCanon1Bytes: serializeJcx(loadJcx(canon1.bytes), { mode: 'preserve' }).bytes,
    reparsedDiagnostics: reparsed1.diagnostics,
  };
}

export interface ByteDifference {
  /** 第一处不同的字节偏移量（两侧长度不同且前缀相同时等于较短一侧的长度）。 */
  readonly offset: number;
  readonly leftLength: number;
  readonly rightLength: number;
  /** 差异点前后各 20 字节的十六进制（左侧）。 */
  readonly leftHex: string;
  /** 差异点前后各 20 字节的十六进制（右侧）。 */
  readonly rightHex: string;
}

const CONTEXT_BYTES = 20;

function hexWindow(bytes: Uint8Array, offset: number): string {
  const start = Math.max(0, offset - CONTEXT_BYTES);
  const end = Math.min(bytes.length, offset + CONTEXT_BYTES);
  return Array.from(bytes.slice(start, end))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 两段字节的第一处差异；完全相等时返回 `null`。
 *
 * 失败信息里只给偏移量与十六进制窗口，不给解码后的原文——闭包矩阵将来也会覆盖
 * 含中文歌词的 fixture，断言失败时不该把内容抖进 CI 日志。
 */
export function firstByteDifference(left: Uint8Array, right: Uint8Array): ByteDifference | null {
  const shared = Math.min(left.length, right.length);
  let offset = 0;
  while (offset < shared && left[offset] === right[offset]) {
    offset += 1;
  }
  if (offset === shared && left.length === right.length) {
    return null;
  }
  return {
    offset,
    leftLength: left.length,
    rightLength: right.length,
    leftHex: hexWindow(left, offset),
    rightHex: hexWindow(right, offset),
  };
}

/** 把文本按 UTF-8 编码后交给 `firstByteDifference`（不动点断言的失败信息用）。 */
export function firstTextByteDifference(left: string, right: string): ByteDifference | null {
  const encoder = new TextEncoder();
  return firstByteDifference(encoder.encode(left), encoder.encode(right));
}
