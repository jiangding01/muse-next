/**
 * renderer-safe parse façade（`docs/M3_EDITOR_CORE_PLAN.md` §11.1、§3.2 A10，T0 用户裁决）。
 *
 * - 位于 `src/formats/jcx/` 目录之外：renderer 的导入说明符不含 `formats/jcx/` 路径段，冻结守卫
 *   `tests/unit/notation/architecture.test.ts` 不修改、不放宽。
 * - **不**经 `src/formats/jcx/index.ts` 再导出任何东西（含类型），否则会把总入口的静态依赖（serializer、
 *   iconv-lite）带回来。
 * - `loadJcx` 是**同一个函数对象**，只把公开签名窄化为字符串入口：底层的 `Uint8Array` 重载会经 `decodeJcx`
 *   解码字节，而编码处理不在 UI 层（F14 / R3）。窄化不含任何包装逻辑；编译期即拒绝字节调用。
 *   内部值依赖链 `loadJcx → lexJcx → decodeJcx` 仍然存在（冻结的 parser / lexer 不改），T0 的安全合同是
 *   「公开 API 不暴露字节解码能力」，以及值依赖闭包不含 serializer / `encodeJcx` / iconv-lite / Node builtin /
 *   任何外部包（`tests/unit/editor/architecture.m3t0.test.ts` 钉死）。
 * - T0 只公开 `loadJcx`、`LoadResult`、`JcxDiagnostic`、`JcxEncoding`；AST 工具在 T6 按真实需要再增加，
 *   且必须重新通过闭包守卫。
 */

import type { JcxLexOptions } from './jcx/lexer';
import { loadJcx as loadJcxImpl } from './jcx/loadJcx';
import type { LoadResult } from './jcx/loadJcx';

export type { JcxEncoding } from './jcx/encoding/types';
export type { JcxDiagnostic } from './jcx/lexer/diagnostics';
export type { LoadResult } from './jcx/loadJcx';

/** 加载一个 JCX 文档（只接受已解码的字符串）。 */
export const loadJcx: (input: string, options?: JcxLexOptions) => LoadResult = loadJcxImpl;
