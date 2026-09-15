/**
 * Parse 层 —— marker 配对总入口（M1.6 T7；方案 v1.1 §3 的配对算法表）。
 *
 * 输入是 T6 的 `ScanResult`（**只读**，本模块不改它），输出是四类 relation 与
 * 「broken rhythm 改写后」的事件数组。硬约束（方案 §0）：
 * - 只消费 `ScanMarker`，**绝不重扫 AST**；
 * - marker 不进 `Voice.events`（T6 已保证），本层把它们全部消费掉；
 * - `status` 只记录 parse-recovery fact；tuplet 不派生时值缩放。
 *
 * 诊断一览（全部 `jcx.parse.*`）：
 * | code | severity | 触发 |
 * | --- | --- | --- |
 * | `jcx.parse.tie.unresolved` | warning | `-` 找不到同族 / 同音高的对端（含跨族） |
 * | `jcx.parse.tie.pitch-mismatch` | info | 单音 ↔ 单音两端音高不同（legacy 容错，仍建 tie） |
 * | `jcx.parse.slur.unclosed` | warning | `(` 到声部结束未闭合，或端点缺失 |
 * | `jcx.parse.slur.unopened` | warning | 孤立 `)` |
 * | `jcx.parse.slur.member-anchor` | info（每文档一次） | 组内部出现 `(` / `)` |
 * | `jcx.parse.tuplet.incomplete` | warning | 吸收到的成员少于 `r` |
 * | `jcx.parse.tuplet.q-zero` | info（每文档一次） | `(p:0:r`（U25 UNVERIFIED） |
 * | `jcx.parse.tuplet.unparsed` | warning | 形态不符 §20（lexer 保证下不可达） |
 * | `jcx.parse.tab-relation.unresolved` | warning | `-S-`/`-H-`/`-P-` 缺一侧 |
 * | `jcx.parse.broken-rhythm.unresolved` | warning | `>`/`<` 缺一侧或缺时值 |
 * | `jcx.parse.broken-rhythm.left-unobserved` | info（每文档一次） | 出现 `<`（语料 0 次） |
 * | `jcx.parse.marker.unhandled` | warning | 审计兜底：有 marker 没被任何配对器消费 |
 *
 * 悬空 `strokePrefix`（§26.4）不建关系也**不重复发诊断**：lexer 已发过
 * `jcx.tab.dangling-stroke-prefix`（含 span），本层只做消费登记。
 */

import type { MusicEvent, Slur, TabRelation, Tie, Tuplet, VoiceId } from '../../../../domain';
import type { ParseContext } from '../header';
import type { PairState } from './pairShared';
import { consume, report } from './pairShared';
import { applyBrokenRhythm } from './pairBrokenRhythm';
import type { OpenSlur } from './pairSlurs';
import { closeSlur, flushOpenSlurs, openSlur } from './pairSlurs';
import { pairTabRelation } from './pairTabRelations';
import { pairTie } from './pairTies';
import { pairTuplet } from './pairTuplets';
import type { ScanMarker } from './scanLeaf';
import type { ScanResult } from './scan';

export interface PairingResult {
  readonly ties: readonly Tie[];
  readonly slurs: readonly Slur[];
  readonly tuplets: readonly Tuplet[];
  readonly tabRelations: readonly TabRelation[];
  /** broken rhythm 改写后的事件数组；未改写时逐个对象与输入相同。 */
  readonly events: readonly MusicEvent[];
  /** 审计用：没有被任何配对器消费的 marker，正常恒为空。 */
  readonly unhandled: readonly ScanMarker[];
}

function dispatch(state: PairState, marker: ScanMarker, stack: OpenSlur[]): void {
  switch (marker.kind) {
    case 'tie':
      pairTie(state, marker);
      return;
    case 'slurOpen':
      openSlur(state, marker, stack);
      return;
    case 'slurClose':
      closeSlur(state, marker, stack);
      return;
    case 'tupletStart':
      pairTuplet(state, marker);
      return;
    case 'tabRelation':
      pairTabRelation(state, marker);
      return;
    case 'brokenRhythm':
      applyBrokenRhythm(state, marker);
      return;
    case 'strokePrefix':
      // §26.4：悬空拨弦前缀不构成关系；lexer 已就地发过 info，本层不重复。
      consume(state, marker);
      return;
  }
}

/**
 * 消费单个声部的全部 marker。
 *
 * marker 列表本身就是源文本顺序（T6 保证：顶层 marker 遇到即推入，组内 marker 在组事件
 * 推入后立刻落账），slur 栈直接按这个顺序处理即可。
 */
export function pairMarkers(scan: ScanResult, voiceId: VoiceId, ctx: ParseContext): PairingResult {
  const state: PairState = {
    voiceId,
    events: [...scan.events],
    ctx,
    counters: new Map<string, number>(),
    consumed: new Set(),
    ties: [],
    slurs: [],
    tuplets: [],
    tabRelations: [],
  };
  const stack: OpenSlur[] = [];

  for (const marker of scan.markers) {
    dispatch(state, marker, stack);
  }
  flushOpenSlurs(state, stack);

  const unhandled = scan.markers.filter((marker) => !state.consumed.has(marker.origin));
  for (const marker of unhandled) {
    // 审计兜底：永不抛异常（方案 §0-6「不新增可达异常面」），只降级成一条 warning。
    report(
      state,
      'jcx.parse.marker.unhandled',
      'warning',
      `marker ${JSON.stringify(marker.raw)}（${marker.kind}）没有被任何配对器消费，已忽略`,
      marker,
    );
  }

  return {
    ties: state.ties,
    slurs: state.slurs,
    tuplets: state.tuplets,
    tabRelations: state.tabRelations,
    events: state.events,
    unhandled,
  };
}
