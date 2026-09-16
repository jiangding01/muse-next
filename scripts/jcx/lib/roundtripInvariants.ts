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
 * **第五项指标 `reparseClean`（M1.8 T0）**：canonical 文本重新 `loadJcx` 之后，
 * `diagnostics` 中 severity === 'error' 的数量必须为 0——这是 §60 DoD
 * `reparse success` 此前从未被断言的一半（此前只取 `.score` 做投影，从不看
 * `reparsed.diagnostics`，理论上 canonical 可能输出「投影相等但重解析报
 * error」的文本而全绿）。warning 级只计数进 summary，不影响判定。
 *
 * **T1 新增指标 `closure`（M1.8 T1，在 T0 的 5 项之外）**：canonical 输出必须是
 * 一份闭合的合法 JCX 文档——`loadJcx(canon1.bytes)` 再 preserve 另存必须逐字节回到 canon1 的字节
 * （canonical 文本能原样进入 Lossless AST / preserve 路径），**且** canonical
 * 再跑一趟必须回到同一份文本（不动点）。语料是生产样本，闭包必须成立，因此这一项
 * 是失败条件（口径上算作「T0 的 5 项全语料指标 + T1 新增 closure」，不与 T3 的
 * GB18030 encoding composition 混分母）。注意它与上面的「幂等观测」语义不同：
 * 幂等只看 `canon2 === canon1` 的文本比较且只观测；closure 在此之上额外要求 preserve 闭包，且纳入退出码。
 *
 * 失败条件共四条（M1.8 T1 起）：byte-identical < 100%、semantic < 100%、
 * reparseClean < 100%、closure < 100%。line-identical 与幂等只汇报数字，不影响
 * 退出码。语料
 * 四项失败条件门槛恒为 100%——本文件不引入、也不允许调用方引入任何语料级
 * 豁免名单（豁免只存在于 fixture 级 `roundtrip.test.ts` 的 `unclosed-chord.jcx`
 * 一例，且只作用于原始输入本身无 error 级 diagnostic 的那一侧）。
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
  /** canonical 文本重解析后 diagnostics 中无 error 级（M1.8 T0，失败条件之一）。 */
  readonly reparseClean: boolean;
  /** canonical 文本重解析后 diagnostics 中 warning 级的数量（仅观测，不影响判定）。 */
  readonly reparseWarningCount: number;
  /**
   * canonical document closure（M1.8 T1，失败条件之一）：canonical 字节经
   * `loadJcx` → preserve 另存后逐字节回到原字节，**且** canonical 不动点成立。
   */
  readonly closure: boolean;
  /** closure 的 preserve 那一半是否成立（closure 失败时区分两半用，观测）。 */
  readonly canonicalPreserveClosure: boolean;
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
    const canonical = serializeJcx(parsedBefore.score, { mode: 'canonical' });
    const canonicalText = canonical.text;
    const reparsed = loadJcx(canonicalText);
    const after = projectScore(reparsed.score);
    const semanticDiffPath = firstProjectionDifference(before, after);
    const semanticEqual = semanticDiffPath === null;

    const canonicalTwice = serializeJcx(reparsed.score, { mode: 'canonical' }).text;
    const canonicalIdempotent = canonicalTwice === canonicalText;

    // closure 复用上面已经算好的 canon2 文本（不重复跑一趟 canonical），但判定口径
    // 比幂等观测更严：还要求 canonical 字节能原样走完 preserve 这条路。
    const canonicalPreserveClosure = bytesEqual(
      serializeJcx(loadJcx(canonical.bytes), { mode: 'preserve' }).bytes,
      canonical.bytes,
    );
    const closure = canonicalPreserveClosure && canonicalIdempotent;

    const reparseErrorDiagnostics = reparsed.diagnostics.filter((d) => d.severity === 'error');
    const reparseClean = reparseErrorDiagnostics.length === 0;
    const reparseWarningCount = reparsed.diagnostics.filter((d) => d.severity === 'warning').length;

    const failures: string[] = [];
    if (!byteIdentical) {
      failures.push('jcx.corpus.roundtrip-byte-identical');
    }
    if (!semanticEqual) {
      failures.push(`jcx.corpus.roundtrip-semantic path=${semanticDiffPath ?? '?'}`);
    }
    if (!reparseClean) {
      const codeCounts = new Map<string, number>();
      for (const diagnostic of reparseErrorDiagnostics) {
        codeCounts.set(diagnostic.code, (codeCounts.get(diagnostic.code) ?? 0) + 1);
      }
      const codeSummary = [...codeCounts.entries()]
        .map(([code, count]) => `code=${code} count=${count}`)
        .join(' ');
      failures.push(`jcx.corpus.reparse-error count=${reparseErrorDiagnostics.length} ${codeSummary}`);
    }

    if (!closure) {
      failures.push(
        `jcx.corpus.roundtrip-closure preserve=${canonicalPreserveClosure ? 'ok' : 'fail'} fixedPoint=${canonicalIdempotent ? 'ok' : 'fail'}`,
      );
    }

    return {
      failures,
      summary: {
        byteIdentical,
        lineIdentical,
        semanticEqual,
        semanticDiffPath,
        canonicalIdempotent,
        reparseClean,
        reparseWarningCount,
        closure,
        canonicalPreserveClosure,
      },
    };
  } catch (error) {
    return {
      failures: [`jcx.corpus.roundtrip-uncaught code=${errorCode(error)}`],
      summary: undefined,
    };
  }
}
