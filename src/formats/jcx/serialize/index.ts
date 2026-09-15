/**
 * JCX Serializer —— 统一出口（M1.7 方案 v1.1 §1）。
 *
 * `serializeJcx` 按 `options.mode` 分派到 preserve（T2，已实现）或 canonical
 * （T3-T5，未实现）。两个重载对应方案 §1 的签名表：preserve 收 AST /
 * `LoadResult`，canonical 收 `Score`——本文件是唯一同时引用两条分支类型的
 * 地方，`preserve.ts` 与（未来的）`canonical/*.ts` 各自维持单向 import 边界
 * （架构守卫钉死）。
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

  // canonical（Score → text）留给 T3-T5 实现；此处只是占位 stub，
  // 保证 `serializeJcx` 的重载签名此刻即可编译、被其他模块引用。
  throw new Error('canonical: not implemented (M1.7 T3-T5)');
}
