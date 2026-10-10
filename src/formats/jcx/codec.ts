/**
 * JCX codec 入口（`docs/M3_EDITOR_CORE_PLAN.md` §11.1，M3 T1a）。
 *
 * - **main 专用**：只供 `src/main/**` 的 File Codec Boundary 使用；`src/renderer/**` 与 `src/editor/**` 禁止 import
 *   （renderer / editor 的格式层入口只有 parse façade `src/formats/jcxParse.ts`）。
 * - 只做 re-export，不新增任何编码 / 解码算法，不修改 `encoding/**`、`serialize/**` 等既有冻结文件。
 */

export { decodeJcx } from './encoding/decodeJcx';
export type { JcxEncodingError } from './encoding/decodeJcx';
export type { DecodedJcx, JcxEncoding } from './encoding/types';
export { encodeJcx } from './serialize/encodeJcx';
export type { EncodeJcxOptions, EncodeJcxResult } from './serialize/encodeJcx';
