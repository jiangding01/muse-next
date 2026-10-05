/**
 * notation/staff —— 五线谱行首的调号 / 拍号判定与行首预留宽度（M2 T7.2；M2.5 T4 从 `layoutStaff.ts`
 * 原样移出，用户裁决 O-a）。
 *
 * 移出的原因只有依赖方向：T4 的 `system/measureDemand.ts` 需要 Staff 的行首预留来做 group 级 packing，
 * 而 T4 不得 import 任何 voice layout 入口（用户裁决 K-a，`layoutStaff` 要到 T5 才由 composer 消费）。
 * 函数体逐字未改，`layoutStaff` 改为从这里 import，Staff 默认路径输出逐字段不变。
 */

import type { KeySignature, Meter } from '../../domain';
import { keyHasExtraText } from '../layout/keySpelling';
import { STAFF_METRICS } from '../layout/metrics';
import type { StaffKeySignature, StaffTimeSignature } from './staffTypes';

/**
 * 调号：只有 `tonic` 存在且 `raw` 里**没有规范拼写以外的文本**时才画（见
 * `layout/keySpelling.ts`）。不画时**不发新诊断**——`keyAbsent` / `keyUnresolved` /
 * `keyModeUnrecognized` 已由 `scoreHeader.ts` 在文档级表达（§4.2）；T7.4 把 staff
 * 并进那边的 consumer 谓词。
 */
export function staffKeySignature(key: KeySignature | undefined): StaffKeySignature | undefined {
  if (key === undefined || key.tonic === undefined || keyHasExtraText(key)) return undefined;
  return key.alter === undefined ? { tonic: key.tonic } : { tonic: key.tonic, alter: key.alter };
}

/**
 * 拍号：只认 `fraction` 分支。`raw`（`C` / `C|` / 复合拍号）与缺席一律省略字段
 * ——**不换算成 4/4**；`meterRaw` 诊断由 `scoreHeader.ts` 在文档级发一次，本层不重发。
 * 也**不做任何满拍 / tick 校验**（P1-3：`Meter` 不参与任何列宽计算）。
 */
export function staffTimeSignature(meter: Meter | undefined): StaffTimeSignature | undefined {
  if (meter === undefined || meter.kind !== 'fraction') return undefined;
  return { numerator: meter.num, denominator: meter.den };
}

/** 行首要留的水平空间：谱号 + 调号（按保守上限估个数）+ 拍号，按实际是否存在累加。 */
export function staffLineHeaderReserveOf(
  key: StaffKeySignature | undefined,
  time: StaffTimeSignature | undefined,
): number {
  const reserve = STAFF_METRICS.headerReserve;
  const keyWidth = key === undefined
    ? 0
    : reserve.keySignatureWidthPerAccidental * reserve.keySignatureAccidentalReserve;
  return reserve.clefWidth + keyWidth + (time === undefined ? 0 : reserve.timeSignatureWidth);
}

/** 一份文档的 Staff 行首预留：只取决于文档级 `K:` / `M:`（同一文档的所有 Staff 声部相同）。 */
export function staffLineHeaderReserve(score: { readonly key?: KeySignature; readonly meter?: Meter }): number {
  return staffLineHeaderReserveOf(staffKeySignature(score.key), staffTimeSignature(score.meter));
}
