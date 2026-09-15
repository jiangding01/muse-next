/**
 * JCX Serializer —— 统一出口（M1.7 方案 v1.1 §1）。
 *
 * `serializeJcx` 按 `options.mode` 分派到 preserve（T2）或 canonical（T3-T5，
 * 公开 API 由 T6 在 L2 round-trip 全绿后接线）。两个重载对应方案 §1 的签名表：
 * preserve 收 AST / `LoadResult`，canonical 收 `Score`——本文件是唯一同时
 * 引用两条分支类型的地方，`preserve.ts` 与 `canonical/*.ts` 各自维持单向
 * import 边界（架构守卫钉死）。
 */

import type { JcxAstDocument } from '../ast';
import type { LoadResult } from '../loadJcx';
import type { Score } from '../../../domain';
import { serializeCanonical } from './canonical';
import { serializePreserve } from './preserve';
import type { CanonicalOptions, PreserveOptions, SerializeResult } from './types';

export type {
  JcxUnencodableStrategy,
  PreserveOptions,
  CanonicalOptions,
  SerializeResult,
} from './types';

/**
 * L2 语义投影：把 `Score` 摊成可比较的纯数据，用于 round-trip 断言与语料统计。
 * 不是序列化本身的一部分，但与 canonical 的归一化规则（directive `trimStart`）
 * 一一对应，故与序列化同处一个模块，避免两边规则各写一份。
 */
export type { ProjectedScore } from './projection';
export { firstProjectionDifference, projectScore, projectionEquals } from './projection';

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

  // canonical（Score → text）：T3/T4/T5 落地 header / `%%` 指令 / text block /
  // `V:` 声明 / body / relation / 歌词 `w:` 行，T6 的 L2 round-trip 矩阵
  // （`tests/unit/jcx/serialize/roundtrip.test.ts`：全 fixture 投影相等 + 幂等）
  // 验收通过后在此接线。输入判别同样不用 `as`：`Score` 独有 `voices`。
  //
  // 返回的 `CanonicalResult` 比 `SerializeResult` 多一个 `bodyLines`（canonical
  // 内部给歌词插行用的行 → 事件区间映射）。公开签名仍声明为 `SerializeResult`，
  // 多出来的字段不进入公开类型契约，调用方不该依赖它。
  if ('voices' in input) {
    return serializeCanonical(input, options);
  }
  throw new Error('jcx serializeJcx: canonical mode 收到了非法输入（不是 Score）');
}
