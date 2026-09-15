/**
 * JCX round-trip 语料回归 —— 第四级：preserve/canonical 往返（M1.7 T7，
 * 方案 v1.1 §6/§7 T7）。
 *
 * 与 `tests/unit/jcx/serialize/roundtrip.test.ts`（fixture 级矩阵）同规则，
 * 对每个语料文件计算三项指标：
 *
 *   - **byte-identical**：`serializeJcx(ast, {mode:'preserve'}).bytes` 与原始
 *     字节逐字节相等（Level 3）。
 *   - **line-identical**：preserve 文本与原始文本逐行相等，**含行终止符**
 *     （不用会把 CRLF/LF/CR 都拍平成同一种的切分方式——`\r\n` 与 `\n` 的行必须
 *     被判定为不同行）；byte 相等时必然相等，只在 byte 失败时提供更细的诊断
 *     粒度，本身不是独立的失败条件。
 *   - **semantic**：`projectScore(parse(x))` 与
 *     `projectScore(parse(canonical(parse(x))))` 是否相等（Level 2）；不等时
 *     只记录 `firstProjectionDifference` 的**字段路径**，绝不记录值或原文
 *     （版权边界，方案 §9 第 6 条）。
 *
 * 另观测 canonical 幂等（`canonical(parse(canonical(x))) === canonical(x)`）
 * 是否成立，计数但不作为失败条件——语料可能命中 `canonical/body.ts` 文件头
 * 「已知限制①」那类「从第二趟起才稳定」的情形（fixture 级矩阵已有先例）。
 *
 * 失败条件只有两条（方案 T7 要求）：byte-identical < 100%、semantic < 100%。
 * line-identical 与幂等只汇报数字，不影响退出码。语料 semantic 门槛恒为
 * 100%——本文件不引入、也不允许调用方引入任何语料级豁免名单（豁免只存在于
 * fixture 级 `roundtrip.test.ts` 的 `unclosed-chord.jcx` 一例）。
 *
 * **失败记录的内容边界**（版权边界，方案 §9 第 6 条）：`failures` 里的每条
 * 记录只允许是固定 code 字符串、`firstProjectionDifference` 返回的字段路径、
 * 或数字计数三者之一，绝不拼接原文片段、诊断 message 文本或任何调用方传入的
 * 自由文本——异常兜底分支同样只记录 `error.name`（构造函数名，如
 * `TypeError`），不记录 `error.message`（可能被上游异常塞进不可预期的内容）。
 *
 * 本文件不 console、不 throw 到调用方之外——parse/serialize 抛出的异常在这里
 * 兜底，转成 `failures` 里的一条记录，与 `parseInvariants.ts` 的
 * `runParseChecks` 同风格。
 */

import type { JcxAstDocument } from '../../../src/formats/jcx/ast';
import { loadJcx } from '../../../src/formats/jcx';
import { parseJcxDocument } from '../../../src/formats/jcx/parse';
import {
  firstProjectionDifference,
  projectScore,
  serializeJcx,
} from '../../../src/formats/jcx/serialize';

export interface RoundtripSummary {
  readonly byteIdentical: boolean;
  readonly lineIdentical: boolean;
  readonly semanticEqual: boolean;
  /** 语义不等时的第一处差异路径；相等或未计算时为 `null`。 */
  readonly semanticDiffPath: string | null;
  readonly canonicalIdempotent: boolean;
}

export interface RoundtripRunResult {
  /** byte-identical / semantic 失败时的记录；空数组表示两项都通过。 */
  readonly failures: readonly string[];
  /** `undefined` 仅当 parse/serialize 链路抛出未捕获异常。 */
  readonly summary: RoundtripSummary | undefined;
}

/**
 * 按「行 + 行终止符」切分，终止符本身保留在切出的片段里，因此 CRLF/LF/CR
 * 三种终止符、以及「文件末尾有无终止符」都会体现为不同的片段值，不会被
 * 拍平掉。最后一个片段是末尾没有终止符的残余内容（可能是空字符串，当原文以
 * 终止符结尾时）。
 */
function splitLinesWithEol(text: string): readonly string[] {
  const lines: string[] = [];
  const eol = /\r\n|\r|\n/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = eol.exec(text)) !== null) {
    lines.push(text.slice(cursor, match.index + match[0].length));
    cursor = match.index + match[0].length;
  }
  lines.push(text.slice(cursor));
  return lines;
}

function linesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((line, index) => line === b[index]);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((byte, index) => byte === b[index]);
}

/** 异常兜底：只取 `error.name`（如 `TypeError`），绝不取 `error.message`。 */
function errorCode(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

/**
 * 对一份 AST 跑完整的第四级检查：preserve byte/line-identical +
 * canonical semantic round-trip + 幂等观测。
 */
export function runRoundtripChecks(
  ast: JcxAstDocument,
  originalBytes: Uint8Array,
  originalText: string,
): RoundtripRunResult {
  try {
    const preserved = serializeJcx(ast, { mode: 'preserve' });
    const byteIdentical = bytesEqual(preserved.bytes, originalBytes);
    const lineIdentical = linesEqual(
      splitLinesWithEol(preserved.text),
      splitLinesWithEol(originalText),
    );

    const parsedBefore = parseJcxDocument(ast);
    const before = projectScore(parsedBefore.score);
    const canonicalText = serializeJcx(parsedBefore.score, { mode: 'canonical' }).text;
    const reparsed = loadJcx(canonicalText);
    const after = projectScore(reparsed.score);
    const semanticDiffPath = firstProjectionDifference(before, after);
    const semanticEqual = semanticDiffPath === null;

    const canonicalTwice = serializeJcx(reparsed.score, { mode: 'canonical' }).text;
    const canonicalIdempotent = canonicalTwice === canonicalText;

    const failures: string[] = [];
    if (!byteIdentical) {
      failures.push('jcx.corpus.roundtrip-byte-identical');
    }
    if (!semanticEqual) {
      failures.push(`jcx.corpus.roundtrip-semantic path=${semanticDiffPath ?? '?'}`);
    }

    return {
      failures,
      summary: {
        byteIdentical,
        lineIdentical,
        semanticEqual,
        semanticDiffPath,
        canonicalIdempotent,
      },
    };
  } catch (error) {
    return {
      failures: [`jcx.corpus.roundtrip-uncaught code=${errorCode(error)}`],
      summary: undefined,
    };
  }
}
