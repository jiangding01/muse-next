/**
 * canonical 序列化 —— body 区的 `ignoredFields` 重放（M1.7 T4，
 * 拍板 F + 2026-09-15 用户裁决②）。
 *
 * `IgnoredField` 只有 `name` / `rawValue` / `origin`，**没有事件位置**，按拍板 F
 * 「没有 factual position 就不猜」，统一写在 body 区开头（第一个 `[V:n]` 之前）。
 * 不按 `origin`（AstPath 字符串）去比对声部——那是读 AST 语义，canonical 不做。
 *
 * 写回形态必须保证 re-parse 仍是 `IgnoredField`：
 * - `name ∈ T C I M K Q X`（`parse/header.ts` 的 `BODY_IGNORED_KEYS`）→ 写
 *   body 区字段行 `N: value`；
 * - 其余名字（`[K:...]` 之外的 inline field，尤其 `L` / `w`）→ 写
 *   **inline field** `[name:value]`：写成字段行会被提升为 unitLength / 歌词等
 *   正式语义，那是造语义。
 * - 值含 `]` 时 inline 语法无法无损表达（grammar 无 escape），原样输出 +
 *   `jcx.serialize.ignored-field-unencodable` warning，不猜 escape；
 * - 值含换行时**整条字段不输出**（两种写法都是单行语法，塞进去会凭空多出一行
 *   正文，比丢掉更糟），发 `jcx.serialize.ignored-field-dropped` warning
 *   告知它被丢弃——裁决②禁止猜 escape，所以不转义。
 */

import type { IgnoredField } from '../../../../domain';
import { canonicalWarning } from './diagnostic';
import type { CanonicalDiagnostic } from './voice';

/** 与 `parse/header.ts` 的 `BODY_IGNORED_KEYS` 同集合（spec §8.13）。 */
const BODY_FIELD_KEYS: readonly string[] = ['T', 'C', 'I', 'M', 'K', 'Q', 'X'];

export interface IgnoredFieldsRender {
  readonly lines: readonly string[];
  readonly diagnostics: readonly CanonicalDiagnostic[];
}

/** body 区开头重放 `ignoredFields`（见文件头「ignoredFields」一节）。 */
export function renderIgnoredFields(fields: readonly IgnoredField[]): IgnoredFieldsRender {
  const lines: string[] = [];
  const diagnostics: CanonicalDiagnostic[] = [];

  for (const field of fields) {
    const value = field.rawValue.trim();
    if (/[\r\n]/.test(value)) {
      diagnostics.push(
        canonicalWarning(
          'jcx.serialize.ignored-field-dropped',
          `ignoredField ${field.name} 的值含换行，字段行与 inline field 都是单行语法，` +
            `转义机制不存在（不猜），该字段**未写入** canonical 文本`,
          field.origin,
        ),
      );
      continue;
    }
    if (BODY_FIELD_KEYS.includes(field.name)) {
      lines.push(`${field.name}: ${value}`);
      continue;
    }
    if (value.includes(']')) {
      diagnostics.push(
        canonicalWarning(
          'jcx.serialize.ignored-field-unencodable',
          `内联字段 [${field.name}:…] 的值含 ']' 或换行，JCX 的 inline field 语法没有转义机制，` +
            `canonical 原样输出该值，重新解析时会被截断`,
          field.origin,
        ),
      );
    }
    lines.push(`[${field.name}:${value}]`);
  }

  return { lines, diagnostics };
}
