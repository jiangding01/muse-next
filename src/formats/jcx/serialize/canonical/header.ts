/**
 * canonical 序列化 —— header 区（M1.7 T3，方案 v1.1 §3 行序表 / §8 拍板 A·B·D·F）。
 *
 * 架构边界：`canonical/**` 只读 Domain，不得 import `ast` / `lexer`
 * （`tests/unit/jcx/serialize/architecture.test.ts` 钉死）。因此本文件不从
 * `../types` 取 `CanonicalOptions`，而是就地声明它的结构子集
 * `CanonicalHeaderOptions`——`CanonicalOptions` 结构上可直接传入，
 * 不需要任何断言。
 *
 * 行序（拍板 B：**固定 role order**，覆盖 spec §27.3「保持原顺序」那一行；
 * 原因是 Domain 不保存 header 字段的源行序，「原顺序」在 Domain → 文本方向
 * 上不是一个可获得的事实，spec 该行待 T7 回写）：
 *
 * ```
 * %MUSE2?  →  X:  →  T:*  →  C:*  →  I:*  →  M:  →  L:  →  Q:
 *          →  unknownFields*  →  K:
 * ```
 *
 * 几条容易踩的规则：
 * - 冒号后恒一个空格（spec §27.3 `T: xxx`），值两端空白去除（拍板 D），
 *   值内部一律原样（`K:G % 1 sharps` 的 `%` 及其后文本属于 raw 的一部分，
 *   不是注释，见 spec §8.7 与 fixture `inline-percent.jcx`）。
 * - `M:` / `Q:` / `K:` 一律写值对象的 `raw`（拍板 F：UNVERIFIED 有 raw 就原样）。
 *   `Meter` 判别联合的两个分支都带 `raw`，因此 `fraction` 分支也写 raw，
 *   **不**由 `num`/`den` 重新拼——`M:C` 与 `M:4/4` 走同一条路径。
 * - `L:` 是唯一由数值重建的字段：`unitLength` 本身就是「单位音长」这个事实
 *   （不是从某个事件的 Rational 反算出来的时值），写成 `num/den` 不违反
 *   §9 第 5 条「时值不得由 Rational 反算」。
 * - `ignoredFields` **本函数一概不输出**（用户 2026-09-15 裁决①）。它们是
 *   **body 区**出现的非法 header 字段（spec §8.13，key ∈ T/C/I/M/K/Q/X）：
 *   一旦写进 header 区，re-parse 会把它们当成正式 header 字段，`M:`/`K:`/`Q:`
 *   这些覆盖型字段还会反过来改写 Score 的语义——那不是「不恢复原位置」，
 *   是改变语义。它们由 **T4 在 body 区重放**（位置按拍板 F 不承诺还原原行）。
 */

import type { Rational, Score } from '../../../../domain';

/** `CanonicalOptions`（`../types`）的结构子集，见文件头注释。 */
export interface CanonicalHeaderOptions {
  readonly magicHeader?: boolean;
}

/** spec §27.3：canonical 一律输出 magic header（拍板 A，`magicHeader: false` 可关）。 */
const MAGIC_HEADER = '%MUSE2';

/** `K: value`——冒号后恒一个空格，值两端空白去除（拍板 D）。 */
function renderField(name: string, rawValue: string): string {
  return `${name}: ${rawValue.trim()}`;
}

/** `L:` 的值形态（spec §8.5）：`<num>/<den>`。 */
function formatUnitLength(unitLength: Rational): string {
  return `${String(unitLength.num)}/${String(unitLength.den)}`;
}

/**
 * 渲染 header 区（不含 `%%` 指令 / text block / `V:` 声明 / body）。
 *
 * 返回行数组而不是拼好的字符串：行是 canonical 组装的最小单位，
 * `canonical/index.ts` 负责用 LF 连接并补末尾换行（spec §27.3）。
 */
export function renderHeader(score: Score, options: CanonicalHeaderOptions = {}): string[] {
  const lines: string[] = [];

  if (options.magicHeader ?? true) {
    lines.push(MAGIC_HEADER);
  }
  if (score.refNumber !== undefined) {
    lines.push(renderField('X', String(score.refNumber)));
  }
  for (const title of score.titles) {
    lines.push(renderField('T', title));
  }
  for (const credit of score.credits) {
    lines.push(renderField('C', credit));
  }
  for (const note of score.notes) {
    lines.push(renderField('I', note));
  }
  if (score.meter !== undefined) {
    lines.push(renderField('M', score.meter.raw));
  }
  if (score.unitLength !== undefined) {
    lines.push(renderField('L', formatUnitLength(score.unitLength)));
  }
  if (score.tempo !== undefined) {
    lines.push(renderField('Q', score.tempo.raw));
  }

  // 未知 header 字段（spec §29.1）：原名原值写回，位置在 header 区尾、`K:` 之前
  // （`K:` 必须是 header 的最后一行，它是 header/body 的分界）。
  for (const unknown of score.unknownFields) {
    lines.push(renderField(unknown.name, unknown.rawValue));
  }

  if (score.key !== undefined) {
    lines.push(renderField('K', score.key.raw));
  }

  return lines;
}
