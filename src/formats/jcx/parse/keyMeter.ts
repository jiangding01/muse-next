/**
 * Parse 层 —— `M:` / `Q:` / `K:` 三个字段的值解析（M1.6 方案 v1.1 §2、spec §8.4 / §8.6 / §8.7）。
 *
 * 三个函数都是**纯函数**：只把 raw 映射成 Domain 值对象，不接触 diagnostics bag。
 * 「解析成功与否」由返回值自身表达（数值字段缺省即未解析），调用方（`header.ts`）
 * 据此决定是否上报 info——这样解析规则可以脱离诊断上下文单测。
 *
 * 共同底线（方案 §0-1）：spec 标 UNVERIFIED 的形态一律**不解析**，只留 raw。
 * 具体地：`M:C` / `M:C|`（DOC-ONLY §8.4）、`M:none` 与复合拍号（UNVERIFIED）、
 * `Q:"Allegro" 1/4=120` 与 `Q:120`（UNVERIFIED §8.6）、`K:` 的 mode / clef /
 * 显式升降号列表（DOC-ONLY / UNVERIFIED §8.7）都只落在 raw 里。
 */

import type { KeySignature, Meter, Rational, Tempo } from '../../../domain';
import { fromParts } from '../../../domain';

/** spec §8.4 语料形态：`2/4` `3/4` `4/4` `6/8`，全部为 `<正整数>/<正整数>`。 */
const METER_PATTERN = /^(\d+)\/(\d+)$/;

/** spec §8.6 CONFIRMED 形态：`1/4=66`，即 `<单位拍分数>=<每分钟拍数>`。 */
const TEMPO_PATTERN = /^(\d+)\/(\d+)=(\d+)$/;

/** spec §8.7：只认首字母 A–G 与紧随其后的一个 `#` / `b`，其余（含空格后的 mode / clef）不看。 */
const KEY_PATTERN = /^([A-G])([#b]?)/;

/**
 * 解析 `M:` 的值。
 *
 * 形态不符（`C` / `C|` / `none` / 复合拍号 / 空值）时回 `{ kind: 'raw', raw }`，
 * 调用方发 `jcx.parse.meter.unparsed` info。`den === 0` 同样按未解析处理。
 */
export function parseMeter(raw: string): Meter {
  const match = METER_PATTERN.exec(raw);
  if (match === null) {
    return { kind: 'raw', raw };
  }
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den === 0) {
    return { kind: 'raw', raw };
  }
  return { kind: 'fraction', num, den, raw };
}

/** `M:` 是否给出了可用于 §8.5 缺省推断的数值拍号。 */
export function meterRatio(meter: Meter | undefined): number | undefined {
  if (meter === undefined || meter.kind !== 'fraction') {
    return undefined;
  }
  return meter.num / meter.den;
}

/**
 * 解析 `Q:` 的值。只认 spec §8.6 CONFIRMED 的 `<分数>=<整数>`；
 * 其余形态（引号文本、多段音长、已弃用的 `Q:120`）只回 `{ raw }`。
 */
export function parseTempo(raw: string): Tempo {
  const match = TEMPO_PATTERN.exec(raw);
  if (match === null) {
    return { raw };
  }
  const bpm = Number(match[3]);
  if (!Number.isSafeInteger(bpm)) {
    return { raw };
  }
  const beat = safeRational(Number(match[1]), Number(match[2]));
  if (beat === undefined) {
    return { raw };
  }
  return { beat, bpm, raw };
}

/**
 * 解析 `K:` 的值。
 *
 * `alter` 语义：`0` 表示「读到了音名且其后没有升降记号」，不是「未解析」——
 * 未解析时 `tonic` 与 `alter` 一起缺省。mode / clef / 行内 `%` 文本（语料
 * `K:G % 1 sharps`，§5.6 确认 `%` 在字段值中是字面量）全部留在 raw，不发诊断：
 * spec §8.7 明确要求「解析失败不报错」。
 */
export function parseKey(raw: string): KeySignature {
  const match = KEY_PATTERN.exec(raw);
  if (match === null) {
    return { raw };
  }
  const accidental = match[2] ?? '';
  const alter = accidental === '#' ? 1 : accidental === 'b' ? -1 : 0;
  return { tonic: match[1] ?? '', alter, raw };
}

/** `fromParts` 对 0 分母 / 越界抛异常；parse 层禁止新增可达异常面，故在此吞掉。 */
function safeRational(num: number, den: number): Rational | undefined {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den === 0) {
    return undefined;
  }
  return fromParts(num, den);
}
