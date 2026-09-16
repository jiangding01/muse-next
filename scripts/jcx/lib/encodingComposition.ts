/**
 * JCX 多编码往返（M1.8 T3，方案 v1.1 §0a 第 4/6 条、§4 T3、§5 第 7 条）。
 *
 * 只对**检测到 `encoding === 'gb18030'`** 的语料文件计算，分母是 GB18030
 * 文件数（不并入 `roundtripInvariants.ts` 那 5 项 11/11 全语料指标）：
 *
 *   原始字节（GB18030）
 *     → `loadJcx` 得 `loadedOriginal`
 *     → `serializeJcx(loadedOriginal, {mode:'preserve', encoding:'utf-8'})` 得 UTF-8 中间态字节
 *     → `loadJcx(utf8Bytes)` 得 `loadedUtf8`（应检测为 `'utf-8'`）
 *     → `serializeJcx(loadedUtf8, {mode:'preserve', encoding:'gb18030'})` 得 GB18030 字节
 *     → 必须与原始字节逐字节相等（`bytesRoundtrip`）。
 *
 * 中间 UTF-8 态额外断言三项（均为观测 + 失败条件，见下）：
 *
 *   - `utf8DetectedAsUtf8`：`loadedUtf8.ast.encoding === 'utf-8'`。
 *   - `utf8BomMatchesOriginal`：**不**与 `loadedOriginal.ast.hasBom` 比较——
 *     `decodeJcx.ts` 的 GB18030 分支恒定 `hasBom: false`（`DecodedJcx.hasBom`
 *     文档明确「目前仅 UTF-8 BOM 可能为 true」），若拿它当预期值，遇到文本首
 *     字符恰为 U+FEFF 的 GB18030 文件就会把「UTF-8 中间态正确检测到 BOM」误判
 *     成 `stage=bom` 失败。真正的预期值是**原始文本首字符是否为 U+FEFF**
 *     （`printAst(loadedOriginal.ast)` 还原出的全文本首字符，与
 *     `encodeUtf8`/`encodeGb18030` 都只原样编码文本、不凭空增删 BOM 的实现
 *     一致），`utf8BomMatchesOriginal` 断言 `loadedUtf8.ast.hasBom === expectedBom`。
 *   - `utf8ProjectionEqual`：`projectScore(loadedOriginal.score)` 与
 *     `projectScore(loadedUtf8.score)` 用 `projectionEquals` 比较相等（L2 语义
 *     不因换编码而改变）。
 *
 * **先 rehearsal，后定门槛**（方案 §5 待拍板项 7）：本文件的四个字段全部只是
 * 观测值；是否把某个字段计入退出码由调用方（`checkCorpusFile.ts` push
 * failures 与否）决定，且需要先跑一遍语料看实测数字，不预先授权失败。
 *
 * **版权边界**：失败记录只允许是固定 code 字符串 + `stage=<...>` + 数字
 * 偏移量，不拼接原文片段或 diagnostic message。异常兜底只取 `error.name`。
 */

import { loadJcx, printAst } from '../../../src/formats/jcx';
import { projectScore, projectionEquals, serializeJcx } from '../../../src/formats/jcx/serialize';

/** §5.5：BOM 不剥离，文本首字符即 U+FEFF——与 `lexer/index.ts` 的同名常量同值。 */
const BOM_CHAR = '﻿';

export interface EncodingCompositionSummary {
  readonly utf8DetectedAsUtf8: boolean;
  readonly utf8BomMatchesOriginal: boolean;
  readonly utf8ProjectionEqual: boolean;
  readonly bytesRoundtrip: boolean;
}

export interface EncodingCompositionRunResult {
  readonly failures: readonly string[];
  /** `undefined` 仅当链路抛出未捕获异常。 */
  readonly summary: EncodingCompositionSummary | undefined;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((byte, index) => byte === b[index]);
}

/** 第一个不同字节的偏移量；两者前缀完全相同但长度不同时，返回较短者的长度。 */
function firstByteDiffOffset(a: Uint8Array, b: Uint8Array): number {
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit; index += 1) {
    if (a[index] !== b[index]) {
      return index;
    }
  }
  return limit;
}

/** 异常兜底：只取 `error.name`（如 `TypeError`），绝不取 `error.message`。 */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * 对一份已检测为 GB18030 的语料文件跑 GB18030 → UTF-8 → GB18030 三段往返。
 * 调用方需先判断 `loadJcx(originalBytes).ast.encoding === 'gb18030'` 再调用
 * 本函数——本函数不做编码判别，只做往返本身（与 `runRoundtripChecks` 的分工
 * 一致：判别在 `checkCorpusFile.ts`，检查逻辑在 `lib/*Invariants.ts`）。
 * 本函数内部会自行 `loadJcx(originalBytes)` 一次，因此不接受调用方已经算好
 * 的 `ast`（避免形参未使用/职责重叠）。
 */
export function runEncodingCompositionCheck(
  originalBytes: Uint8Array,
): EncodingCompositionRunResult {
  try {
    const loadedOriginal = loadJcx(originalBytes);

    const utf8Result = serializeJcx(loadedOriginal, { mode: 'preserve', encoding: 'utf-8' });
    const loadedUtf8 = loadJcx(utf8Result.bytes);

    const utf8DetectedAsUtf8 = loadedUtf8.ast.encoding === 'utf-8';
    // 预期值是「原始文本首字符是否为 U+FEFF」，不是 `loadedOriginal.ast.hasBom`
    // ——GB18030 检测分支恒定 `hasBom: false`，用它当预期值会把「UTF-8 中间态
    // 正确检测到 BOM」误判为失败（见文件头注释）。
    const expectedBom = printAst(loadedOriginal.ast).startsWith(BOM_CHAR);
    const utf8BomMatchesOriginal = loadedUtf8.ast.hasBom === expectedBom;

    const originalProjection = projectScore(loadedOriginal.score);
    const utf8Projection = projectScore(loadedUtf8.score);
    const utf8ProjectionEqual = projectionEquals(originalProjection, utf8Projection);

    const gb18030Result = serializeJcx(loadedUtf8, { mode: 'preserve', encoding: 'gb18030' });
    const bytesRoundtrip = bytesEqual(gb18030Result.bytes, originalBytes);

    const failures: string[] = [];
    if (!utf8DetectedAsUtf8) {
      failures.push('jcx.corpus.encoding-composition stage=utf8-detect');
    }
    if (!utf8BomMatchesOriginal) {
      failures.push('jcx.corpus.encoding-composition stage=bom');
    }
    if (!utf8ProjectionEqual) {
      failures.push('jcx.corpus.encoding-composition stage=projection');
    }
    if (!bytesRoundtrip) {
      const offset = firstByteDiffOffset(gb18030Result.bytes, originalBytes);
      failures.push(`jcx.corpus.encoding-composition stage=bytes offset=${String(offset)}`);
    }

    return {
      failures,
      summary: {
        utf8DetectedAsUtf8,
        utf8BomMatchesOriginal,
        utf8ProjectionEqual,
        bytesRoundtrip,
      },
    };
  } catch (error) {
    return {
      failures: [`jcx.corpus.encoding-composition-uncaught code=${errorCode(error)}`],
      summary: undefined,
    };
  }
}
