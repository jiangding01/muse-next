/**
 * JCX Lexer —— 正文词法模式分发（M1.4 方案 §3 / §13.2）。
 *
 * 单独成文件是为了**避免循环 import**：`lexBodyCommon` 被两个模式词法器依赖，
 * 分发函数若放在 common 里会形成 common → pitch/tab → common 的环。
 *
 * 本文件只做分发，不含任何词法规则；模式如何确定（`V:` 预扫描 + `[V:n]` 状态机）
 * 是 T7 `lexModes.ts` 的职责。
 */

import type { SourcePosition } from './sourceSpan';
import type { DiagnosticBag } from './diagnostics';
import type { JcxToken } from './token';
import { lexBodyPitch } from './lexBodyPitch';
import { lexBodyTab } from './lexBodyTab';

/** §13.2：两种 body 词法模式。 */
export type JcxBodyMode = 'pitch' | 'tab';

/**
 * 按当前生效的 voice style 选择正文词法器。
 *
 * `style` 为 `tab` → 模式 B；`staff` / `jianpu` / 缺省 / 未知 → 模式 A（§12.6.1 / §12.6.5）。
 * 该映射由调用方完成，本函数只接收已判定好的 mode。
 */
export function lexBody(
  text: string,
  base: SourcePosition,
  bag: DiagnosticBag,
  mode: JcxBodyMode,
): JcxToken[] {
  return mode === 'tab'
    ? lexBodyTab(text, base, bag)
    : lexBodyPitch(text, base, bag);
}
