/**
 * JCX 语料回归 —— 单文件四级检查（M1.4 §6 / M1.5 T6 / M1.6 T10a / M1.7 T7）。
 *
 * 从 `scripts/jcx/corpus-lex-test.ts` 抽出 `checkFile` 与它的 `FileReport`，
 * 避免主脚本超过 §0 固定审查项的 350 行上限。四级断言的编号与含义见主脚本
 * 文件头注释（① – ⑬ 的 Lexer/AST/parse 级 + round-trip 级），此处不重复。
 *
 * **匿名边界**（版权边界，方案 §9 第 6 条）：`FileReport` 不保存真实文件名——
 * 调用方（`corpus-lex-test.ts` 的 `main`）按枚举顺序生成 `#1`…`#N` 的匿名
 * `label`，`checkFile` 只用真实文件名读盘，从不把它写回返回值。`failures`
 * 里的每条记录同理只允许是固定 code 字符串、`AstPath`/投影字段路径、或数字
 * 计数三者之一，不拼接原文片段或诊断 message 文本。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeJcx } from '../../../src/formats/jcx/encoding/decodeJcx';
import { lexJcx } from '../../../src/formats/jcx/lexer';
import { flattenTokens, rawOf } from '../../../src/formats/jcx/lexer/token';
import type { JcxSeverity } from '../../../src/formats/jcx/lexer/diagnostics';
import { buildAst, printAst } from '../../../src/formats/jcx/ast';
import {
  checkLineTextInvariant,
  collectAstPaths,
  collectResidualItemLeaves,
  findDuplicatePaths,
} from './astInvariants';
import { runParseChecks, type ParseSummary } from './parseInvariants';
import { runRoundtripChecks, type RoundtripSummary } from './roundtripInvariants';

export interface FileReport {
  /** 匿名编号（如 `#3`），不是真实文件名——见文件头「匿名边界」。 */
  readonly label: string;
  readonly encoding: string;
  readonly hasBom: boolean;
  readonly lineCount: number;
  readonly tokenCount: number;
  readonly rawTokenCount: number;
  readonly severityCounts: Readonly<Record<JcxSeverity, number>>;
  readonly failures: readonly string[];
  /** AST 级断言（⑤–⑦）是否全部通过；⑧ 不是断言，不影响这个字段。 */
  readonly astOk: boolean;
  /** 本文件在 item 位置残留的通用叶子 token kind（未去重，供全局汇总）。 */
  readonly residualItemLeafKinds: readonly string[];
  /** parse 级断言（⑨–⑬）是否全部通过。 */
  readonly parseOk: boolean;
  /** `undefined` 仅当 `parseJcxDocument` 抛出异常（⑨ 失败）。 */
  readonly parseSummary: ParseSummary | undefined;
  /** 本文件全部 `UnknownEvent.tokenKind`（未去重，供全局汇总）。 */
  readonly unknownEventTokenKinds: readonly string[];
  /** 本文件全部 parse-level diagnostic 的 `code`（未去重，供全局汇总）。 */
  readonly diagnosticCodes: readonly string[];
  /** `undefined` 仅当 round-trip 链路抛出未捕获异常。 */
  readonly roundtripSummary: RoundtripSummary | undefined;
}

/**
 * 崩溃兜底用的空 `FileReport`，供主脚本 `catch` 分支复用同一形状。
 * `errorCode` 只允许是 `error.name`（如 `TypeError`），不接受 `error.message`。
 */
export function crashedFileReport(label: string, errorCode: string): FileReport {
  return {
    label,
    encoding: '-',
    hasBom: false,
    lineCount: 0,
    tokenCount: 0,
    rawTokenCount: 0,
    severityCounts: { error: 0, warning: 0, info: 0 },
    failures: [`jcx.corpus.uncaught code=${errorCode}`],
    astOk: false,
    residualItemLeafKinds: [],
    parseOk: false,
    parseSummary: undefined,
    unknownEventTokenKinds: [],
    diagnosticCodes: [],
    roundtripSummary: undefined,
  };
}

export function checkFile(
  corpusDir: string,
  fileName: string,
  label: string,
  rawSamples: Map<string, number>,
): FileReport {
  const failures: string[] = [];
  const bytes = new Uint8Array(readFileSync(resolve(corpusDir, fileName)));

  // ① 无 uncaught error。
  const text = decodeJcx(bytes).text;
  const result = lexJcx(bytes);

  const severityCounts: Record<JcxSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of result.diagnostics) {
    severityCounts[diagnostic.severity] += 1;
  }

  // ② 无 error 级 diagnostic：只记录 diagnostic code + count，不带描述文本。
  if (severityCounts.error > 0) {
    const codes = [
      ...new Set(
        result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
      ),
    ];
    failures.push(`jcx.corpus.lexer-error-diagnostics count=${severityCounts.error} codes=${codes.join(',')}`);
  }

  // ③ 全文不变量。
  const tokens = flattenTokens([...result.lines]);
  if (rawOf(tokens) !== text) {
    failures.push('jcx.corpus.lexer-full-text-invariant');
  }

  // ④ 逐行不变量（§29.5）+ 每个 token 的 span 自洽。
  let lineInvariantBroken = false;
  for (const line of result.lines) {
    const expected = text.slice(line.span.start.offset, line.span.end.offset);
    if (rawOf(line.tokens) !== expected) {
      lineInvariantBroken = true;
      break;
    }
  }
  if (lineInvariantBroken) {
    failures.push('jcx.corpus.lexer-line-invariant');
  }

  let rawTokenCount = 0;
  for (const token of tokens) {
    if (token.kind === 'raw') {
      rawTokenCount += 1;
      rawSamples.set(token.raw, (rawSamples.get(token.raw) ?? 0) + 1);
    }
  }

  // ⑤–⑦ AST 级断言（M1.5 T6）。
  const astFailuresBefore = failures.length;
  const ast = buildAst(result);

  // ⑤ 全文不变量。
  if (printAst(ast) !== text) {
    failures.push('jcx.corpus.ast-full-text-invariant');
  }

  // ⑥ 逐节点不变量：沿用 lossless.test.ts 的逻辑（scripts/jcx/lib/astInvariants.ts）。
  const lineTextMismatches = checkLineTextInvariant(ast.lines, text, result.lines, result.hasBom);
  if (lineTextMismatches.length > 0) {
    failures.push(
      `jcx.corpus.ast-line-text-invariant count=${lineTextMismatches.length} path=${lineTextMismatches[0]?.path ?? '?'}`,
    );
  }

  // ⑦ path 唯一性，递归到全部叶子。
  const paths = collectAstPaths(ast);
  const duplicatePaths = findDuplicatePaths(paths);
  if (duplicatePaths.length > 0) {
    failures.push(`jcx.corpus.ast-path-uniqueness count=${duplicatePaths.length}`);
  }

  const astOk = failures.length === astFailuresBefore;

  // ⑧ item 位置残留的通用叶子 token kind（仅观测，不影响 astOk / failures）。
  const residualItemLeafKinds = collectResidualItemLeaves(ast);

  // ⑨–⑬ parse 级断言（M1.6 T10a + M1.7 T0）：⑨ try/catch + ⑩–⑬ + 汇总，逻辑见
  // `lib/parseInvariants.ts` 的 `runParseChecks`（与 fixture 级测试共用）。
  const parseRun = runParseChecks(ast);
  failures.push(...parseRun.failures);
  const parseOk = parseRun.failures.length === 0;
  const parseSummary = parseRun.summary;
  const unknownEventTokenKinds = parseRun.unknownEventTokenKinds;
  const diagnosticCodes = parseRun.diagnosticCodes;

  // 第四级——round-trip 断言（M1.7 T7）：逻辑见 `lib/roundtripInvariants.ts`
  // 的 `runRoundtripChecks`（与 fixture 级 `roundtrip.test.ts` 同规则）。
  const roundtripRun = runRoundtripChecks(ast, bytes, text);
  failures.push(...roundtripRun.failures);
  const roundtripSummary = roundtripRun.summary;

  return {
    label,
    encoding: result.encoding,
    hasBom: result.hasBom,
    lineCount: result.lines.length,
    tokenCount: tokens.length,
    rawTokenCount,
    severityCounts,
    failures,
    astOk,
    residualItemLeafKinds,
    parseOk,
    parseSummary,
    unknownEventTokenKinds,
    diagnosticCodes,
    roundtripSummary,
  };
}
