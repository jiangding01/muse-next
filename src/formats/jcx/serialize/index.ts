/**
 * JCX Serializer —— 统一出口（M1.7 方案 v1.1 §1）。
 *
 * `serializeJcx` 按 `options.mode` 分派到 preserve（T2，已实现）或 canonical
 * （T3-T5 已实现，公开 API 接线延后到 T6）。两个重载对应方案 §1 的签名表：
 * preserve 收 AST / `LoadResult`，canonical 收 `Score`——本文件是唯一同时
 * 引用两条分支类型的地方，`preserve.ts` 与 `canonical/*.ts` 各自维持单向
 * import 边界（架构守卫钉死）。
 */

import type { JcxAstDocument } from '../ast';
import type { LoadResult } from '../loadJcx';
import type { Score } from '../../../domain';
import { serializePreserve } from './preserve';
import type { CanonicalOptions, PreserveOptions, SerializeResult } from './types';

export type {
  JcxUnencodableStrategy,
  PreserveOptions,
  CanonicalOptions,
  SerializeResult,
} from './types';

export function serializeJcx(
  input: JcxAstDocument | LoadResult,
  options: PreserveOptions,
): SerializeResult;
export function serializeJcx(input: Score, options: CanonicalOptions): SerializeResult;
export function serializeJcx(
  input: JcxAstDocument | LoadResult | Score,
  options: PreserveOptions | CanonicalOptions,
): SerializeResult {
  if (options.mode === 'preserve') {
    // 重载已在调用点保证 preserve 只会收到 AST / LoadResult；这里用属性
    // 存在性收窄（`LoadResult` 独有 `ast`，`JcxAstDocument` 独有 `lines`，
    // `Score` 都没有），不用 `as`。
    if ('ast' in input) {
      return serializePreserve(input, options);
    }
    if ('lines' in input) {
      return serializePreserve(input, options);
    }
    throw new Error('jcx serializeJcx: preserve mode 收到了非法输入（既非 AST 也非 LoadResult）');
  }

  // canonical（Score → text）：T3/T4/T5 已经把 header / `%%` 指令 / text
  // block / `V:` 声明 / body / relation / 歌词 `w:` 行全部落地，`./canonical`
  // 的 `serializeCanonical` 可以被单测直接调用。**公开 API 在此仍必须抛错**：
  // T6 的 L2 round-trip（完整投影相等，含 relation/歌词/引用归一化）还没有
  // 通过验收，此刻放开公开入口等于向下游承诺一个未经验证的往返契约——那是
  // 比「没有正文」更隐蔽的一种静默失败。`serializeCanonical` 不从本文件、
  // 也不从 `formats/jcx/index.ts` 导出。T6 验收后把这里换成
  // `if ('voices' in input) return serializeCanonical(input, options);`。
  throw new Error('canonical: unavailable until M1.7 T6 (L2 round-trip not yet verified)');
}
