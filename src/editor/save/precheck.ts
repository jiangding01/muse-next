/**
 * 保存前的不可编码字符预检（`docs/M3_EDITOR_CORE_PLAN.md` §11.7，M3 T4 B1）。
 *
 * - 孤立 surrogate（不成对的高 / 低代理）不是合法的 Unicode 标量值，UTF-8 与 GB18030 都无法编码：
 *   UTF-8 路径的 `TextEncoder` 会静默替换为 U+FFFD，GB18030 路径会抛错（r0 探针 C2 / C3）。
 *   renderer 在发起保存前用本函数定位并报告；main 的同类扫描与自解码校验兜底（§11.5）。
 * - 纯函数：不依赖 DOM / Node；`src/editor` 以 ES2023 lib 编译（无 `isWellFormed`），这里按 UTF-16 码元手写扫描。
 * - 位置约定与 `encodeJcx` 的诊断一致：`line` 从 1 开始、只有 `\n` 换行（CRLF 的 `\r` 归属上一行；
 *   孤立 CR 在源码面板中显示为占位符，不另起一行）；`column` 从 0 开始，单位是 UTF-16 码元。
 */

export interface UnencodableCharacter {
  /** 孤立代理在 exact source 中的 UTF-16 偏移。 */
  readonly offset: number;
  readonly line: number;
  readonly column: number;
  /** 该码元的值（0xD800–0xDFFF）。 */
  readonly codeUnit: number;
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** 按出现顺序返回全部孤立 surrogate；没有时为空数组。 */
export function findUnencodableCharacters(source: string): UnencodableCharacter[] {
  const found: UnencodableCharacter[] = [];
  let line = 1;
  let lineStart = 0;
  for (let offset = 0; offset < source.length; offset += 1) {
    const unit = source.charCodeAt(offset);
    if (unit === 0x0a) {
      line += 1;
      lineStart = offset + 1;
      continue;
    }
    if (isHighSurrogate(unit)) {
      const next = offset + 1 < source.length ? source.charCodeAt(offset + 1) : -1;
      if (isLowSurrogate(next)) {
        offset += 1;
        continue;
      }
      found.push({ offset, line, column: offset - lineStart, codeUnit: unit });
      continue;
    }
    if (isLowSurrogate(unit)) found.push({ offset, line, column: offset - lineStart, codeUnit: unit });
  }
  return found;
}
