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

  // canonical（Score → text）：T3 只落地了 header / `%%` 指令 / text block /
  // `V:` 声明骨架，body（事件、relation、歌词、body 区 `L:`）要到 T4/T5 才有。
  // **公开 API 在此之前必须抛错，不能返回一个「合法但没有正文」的文件**——
  // 那是静默丢内容。`serializeCanonical`（`./canonical`）可以被单测直接调用，
  // 但不从本文件、也不从 `formats/jcx/index.ts` 导出。T5 完成 body + 歌词后，
  // 把这里换成 `if ('voices' in input) return serializeCanonical(input, options);`。
  throw new Error('canonical: unavailable until M1.7 T5 (body and lyrics not yet serialised)');
}
