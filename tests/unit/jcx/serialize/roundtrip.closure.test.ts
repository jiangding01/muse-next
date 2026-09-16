/**
 * canonical document closure 矩阵（M1.8 T1，方案 v1.1 §4 T1 / §0a 第 2 条）。
 *
 * `roundtrip.test.ts` 的矩阵回答的是「原始文档 → canonical 一趟」是否守规矩；
 * 本文件回答的是**canonical 输出自身是不是一份闭合的合法 JCX 文档**——把
 * `canon1 = canonical(parse(原字节))` 当成一份新的「二级 fixture」，让它再走一遍
 * 整张矩阵。四条断言（令 `canon2 = canonical(parse(canon1))`）：
 *
 * | 断言 | 内容 |
 * | --- | --- |
 * | 不动点 | `canon2 === canon1`（canonical 输出必须是 canonical 的不动点） |
 * | L2 相等 | `project(parse(canon1))` 与 `project(parse(canon2))` 投影相等 |
 * | L3 preserve 闭包 | `preserve(loadJcx(canon1.bytes)).bytes` 与 `canon1.bytes` 逐字节相等 |
 * | reparse clean | `loadJcx(canon1.text).diagnostics` 无 `error` 级 |
 *
 * ## 零豁免
 *
 * 本矩阵**不存在任何豁免名单**。`roundtrip.test.ts` 的 `L2_KNOWN_LIMITATION`
 * （`unclosed-chord.jcx`）只作用于「原始 → canonical #1」那一层：那一层的差异来自
 * 原文里的非法词法上下文，而 canon1 已经不再含有那个上下文。若某个 fixture 在这里
 * 失败，说明「canonical 输出是一份闭合文档」这条性质本身不成立，属于要上报裁决的
 * 事实，不得靠加豁免消掉（方案 §6 第 3 条）。
 *
 * L3 之所以必须适用：canonical 输出若不能原样进入 Lossless AST / preserve 路径，
 * 那么「canonical 文本可以当源文件用」这个前提就是假的，M2/M3 的重建链路会建在
 * 沙子上。
 *
 * ## 测试时长
 *
 * `npx vitest run tests/unit/jcx/serialize` 的 Duration（各跑 3 次取中位数，均为
 * warm run）：本文件加入前 536ms（771 用例），加入后 572ms（1140 用例），增量约
 * +36ms。同一台机器上三次采样的极差约 ±50ms，所以这个增量与噪声同量级——结论是
 * 「本矩阵对整体时长没有可测量的影响」，而不是一个精确数字。
 */

import { describe, expect, it } from 'vitest';

import { firstProjectionDifference } from '../../../../src/formats/jcx/serialize';
import {
  closureTrip,
  firstByteDifference,
  firstTextByteDifference,
} from './roundtrip.closure.helpers';
import { errorDiagnostics, fixtureNames } from './roundtrip.helpers';

/** 失败信息只含偏移量、长度与十六进制窗口，不含解码后的原文。 */
function describeByteDifference(difference: ReturnType<typeof firstByteDifference>): string {
  if (difference === null) {
    return 'no difference';
  }
  return [
    `offset=${String(difference.offset)}`,
    `len=${String(difference.leftLength)}/${String(difference.rightLength)}`,
    `left=${difference.leftHex}`,
    `right=${difference.rightHex}`,
  ].join(' ');
}

it('闭包矩阵的 fixture 集合非空（空集不得被当成全绿）', () => {
  expect(fixtureNames.length).toBeGreaterThan(0);
});

describe.each(fixtureNames)('canonical document closure: %s', (name) => {
  it('不动点：canonical(parse(canon1)) === canon1', () => {
    const trip = closureTrip(name);
    const difference = firstTextByteDifference(trip.canon1Text, trip.canon2Text);
    expect(describeByteDifference(difference)).toBe('no difference');
  });

  it('L2 闭包：project(parse(canon1)) === project(parse(canon2))', () => {
    const trip = closureTrip(name);
    // 先报路径（失败时一眼看到是哪个字段），再用 toEqual 出完整 diff。
    expect(
      firstProjectionDifference(trip.projectionAfterCanon1, trip.projectionAfterCanon2),
    ).toBeNull();
    expect(trip.projectionAfterCanon2).toEqual(trip.projectionAfterCanon1);
  });

  it('L3 闭包：preserve(loadJcx(canon1.bytes)).bytes === canon1.bytes', () => {
    const trip = closureTrip(name);
    const difference = firstByteDifference(trip.preserveOfCanon1Bytes, trip.canon1Bytes);
    expect(describeByteDifference(difference)).toBe('no difference');
  });

  it('reparse clean：loadJcx(canon1.text).diagnostics 无 error 级', () => {
    const trip = closureTrip(name);
    // 与 `roundtrip.test.ts` 的 clean 组同门槛，但闭包层对**全部** fixture 生效：
    // canon1 是 canonical 自己产出的文本，本身就应当是一份合法文档，原始输入是否
    // malformed 与它无关。
    expect(errorDiagnostics(trip.reparsedDiagnostics)).toEqual([]);
  });
});
