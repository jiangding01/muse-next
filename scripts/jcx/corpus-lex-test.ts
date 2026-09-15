/**
 * JCX Lexer + AST 语料回归（M1.4 方案 §6，M1.5 T6，HANDOFF §39.3，JCX_SPEC §30.3）。
 *
 * 用法：`npm run jcx:corpus-test`
 *
 * 对 `legacy-corpus/jcx/*.jcx` 逐文件读字节 → `lexJcx`，Lexer 级断言四条：
 *
 *   ① 无 uncaught error（含 `decodeJcx` 的 `JcxEncodingError`）
 *   ② diagnostics 中无 `error` 级（§30.3；Lexer 阶段本就不应产出 error）
 *   ③ 全文不变量：`flattenTokens` 的 raw 拼接 === 解码文本
 *   ④ 逐行不变量（§29.5）：每行 token 的 raw 拼接 === 该行 span 覆盖的文本
 *
 * 在此之上追加 AST 级断言（M1.5 T6，逻辑与 `tests/unit/jcx/ast/lossless.test.ts`
 * 共用 `scripts/jcx/lib/astInvariants.ts`，不重写第二份）：
 *
 *   ⑤ 全文不变量：`printAst(buildAst(lex)) === decodedText`
 *   ⑥ 逐节点不变量：每个行节点 / textBlock 的 printNode 等于其覆盖的物理行原文拼接
 *   ⑦ path 唯一性：document.bom、每一行、textBlock 内部子行、body 组合节点
 *      （chord/grace/tabGroup 的 open/items/close、note/rest/tabNote 的 children）
 *      向下直到全部叶子，path 互不相同
 *   ⑧ **item 位置**残留的通用叶子（`kind === 'token'`，只统计出现在
 *      `bodyLine.items` / `inlineFieldLine.trailing` / chord-grace-tabGroup
 *      的 `items`（含嵌套）里的通用叶子；note/rest/tabNote 的 children、
 *      括号组的 open/close、字段行外壳 children 不算——它们是专用叶子或已被
 *      组合节点消费，不是「没被组合」）的 token kind 去重清单与计数——
 *      **仅观测，不作为失败条件**：它是「正文里还有多少个位置没被结构化组合」
 *      的现状快照，Lossless AST 允许通用叶子永久存在（T4 已拍板），不是待
 *      修复的缺陷。
 *
 * 语料**不进 git**（HANDOFF §39.1 / §51），因此 CI 上目录必然缺失：
 * 目录不存在或没有 `.jcx` 时打印跳过并 `exit 0`，只有真正的断言失败才 `exit 1`。
 *
 * **版权边界**：本脚本只向 stdout 打印统计数字与结构信息，绝不把语料内容写入
 * 任何文件。末尾的 raw token 清单是唯一会回显语料片段的地方，已做三重限制：
 * 去重、上限 20 项、含非 ASCII 字符（即可能是歌词/标题）的一律脱敏为长度标记。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeJcx } from '../../src/formats/jcx/encoding/decodeJcx';
import { lexJcx } from '../../src/formats/jcx/lexer';
import { flattenTokens, rawOf } from '../../src/formats/jcx/lexer/token';
import type { JcxSeverity } from '../../src/formats/jcx/lexer/diagnostics';
import { buildAst, printAst } from '../../src/formats/jcx/ast';
import {
  checkLineTextInvariant,
  collectAstPaths,
  collectResidualItemLeaves,
  findDuplicatePaths,
} from './lib/astInvariants';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const CORPUS_DIR = resolve(PROJECT_ROOT, 'legacy-corpus/jcx');

/** raw token 清单的输出上限（避免把整首歌的可疑片段抖出来）。 */
const RAW_SAMPLE_LIMIT = 20;
/** 单个 raw 片段的回显长度上限。 */
const RAW_SAMPLE_MAX_CHARS = 12;

interface FileReport {
  readonly name: string;
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
}

function listCorpusFiles(): string[] {
  let entries: string[];
  try {
    if (!statSync(CORPUS_DIR).isDirectory()) {
      return [];
    }
    entries = readdirSync(CORPUS_DIR);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith('.jcx')).sort();
}

/**
 * 脱敏回显一个 raw 片段。
 *
 * 纯 ASCII 且短 → 原样（这类片段是语法符号，才是我们要人工判断的对象）。
 * 含非 ASCII → 只报长度（可能是歌词、标题、声部名，不得回显）。
 */
function redact(raw: string): string {
  if (/[^ -~]/.test(raw)) {
    return `<non-ascii len=${raw.length}>`;
  }
  return raw.length > RAW_SAMPLE_MAX_CHARS
    ? `${JSON.stringify(raw.slice(0, RAW_SAMPLE_MAX_CHARS))}…`
    : JSON.stringify(raw);
}

function checkFile(name: string, rawSamples: Map<string, number>): FileReport {
  const failures: string[] = [];
  const bytes = new Uint8Array(readFileSync(resolve(CORPUS_DIR, name)));

  // ① 无 uncaught error。
  const text = decodeJcx(bytes).text;
  const result = lexJcx(bytes);

  const severityCounts: Record<JcxSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of result.diagnostics) {
    severityCounts[diagnostic.severity] += 1;
  }

  // ② 无 error 级 diagnostic。
  if (severityCounts.error > 0) {
    const codes = [
      ...new Set(
        result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code),
      ),
    ];
    failures.push(`${severityCounts.error} error-level diagnostic(s): ${codes.join(', ')}`);
  }

  // ③ 全文不变量。
  const tokens = flattenTokens([...result.lines]);
  if (rawOf(tokens) !== text) {
    failures.push('full-text invariant broken: concat(token.raw) !== decoded text');
  }

  // ④ 逐行不变量（§29.5）+ 每个 token 的 span 自洽。
  for (const line of result.lines) {
    const expected = text.slice(line.span.start.offset, line.span.end.offset);
    if (rawOf(line.tokens) !== expected) {
      failures.push(`line invariant broken at line ${line.span.start.line}`);
      break;
    }
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
    failures.push('AST full-text invariant broken: printAst(buildAst(lex)) !== decoded text');
  }

  // ⑥ 逐节点不变量：沿用 lossless.test.ts 的逻辑（scripts/jcx/lib/astInvariants.ts）。
  const lineTextMismatches = checkLineTextInvariant(ast.lines, text, result.lines, result.hasBom);
  if (lineTextMismatches.length > 0) {
    failures.push(
      `AST line-text invariant broken at ${lineTextMismatches.length} node(s), first path ${lineTextMismatches[0]?.path}`,
    );
  }

  // ⑦ path 唯一性，递归到全部叶子。
  const paths = collectAstPaths(ast);
  const duplicatePaths = findDuplicatePaths(paths);
  if (duplicatePaths.length > 0) {
    failures.push(`AST path uniqueness broken: ${duplicatePaths.length} duplicate path(s)`);
  }

  const astOk = failures.length === astFailuresBefore;

  // ⑧ item 位置残留的通用叶子 token kind（仅观测，不影响 astOk / failures）。
  const residualItemLeafKinds = collectResidualItemLeaves(ast);

  return {
    name,
    encoding: result.encoding,
    hasBom: result.hasBom,
    lineCount: result.lines.length,
    tokenCount: tokens.length,
    rawTokenCount,
    severityCounts,
    failures,
    astOk,
    residualItemLeafKinds,
  };
}

function pad(value: string | number, width: number, left = false): string {
  const text = String(value);
  return left ? text.padStart(width) : text.padEnd(width);
}

function main(): void {
  const files = listCorpusFiles();
  if (files.length === 0) {
    console.log(`[skip] no .jcx corpus under ${CORPUS_DIR} — corpus is git-ignored by design.`);
    process.exit(0);
  }

  const rawSamples = new Map<string, number>();
  const reports: FileReport[] = [];
  let crashed = 0;

  for (const name of files) {
    try {
      reports.push(checkFile(name, rawSamples));
    } catch (error) {
      crashed += 1;
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      reports.push({
        name,
        encoding: '-',
        hasBom: false,
        lineCount: 0,
        tokenCount: 0,
        rawTokenCount: 0,
        severityCounts: { error: 0, warning: 0, info: 0 },
        failures: [`uncaught ${message}`],
        astOk: false,
        residualItemLeafKinds: [],
      });
    }
  }

  const nameWidth = Math.max(8, ...reports.map((r) => r.name.length));
  console.log('JCX corpus lex regression');
  console.log(`corpus: ${CORPUS_DIR}`);
  console.log('');
  console.log(
    `${pad('file', nameWidth)}  ${pad('encoding', 8)}  ${pad('bom', 3)}  ${pad('lines', 6, true)}  ${pad('tokens', 7, true)}  ${pad('raw', 5, true)}  ${pad('err', 4, true)}  ${pad('warn', 5, true)}  ${pad('info', 5, true)}  status`,
  );
  console.log('-'.repeat(nameWidth + 62));

  const totals = { lines: 0, tokens: 0, raw: 0, error: 0, warning: 0, info: 0 };
  let failedFiles = 0;

  for (const report of reports) {
    totals.lines += report.lineCount;
    totals.tokens += report.tokenCount;
    totals.raw += report.rawTokenCount;
    totals.error += report.severityCounts.error;
    totals.warning += report.severityCounts.warning;
    totals.info += report.severityCounts.info;
    if (report.failures.length > 0) {
      failedFiles += 1;
    }

    console.log(
      `${pad(report.name, nameWidth)}  ${pad(report.encoding, 8)}  ${pad(report.hasBom ? 'yes' : '-', 3)}  ${pad(report.lineCount, 6, true)}  ${pad(report.tokenCount, 7, true)}  ${pad(report.rawTokenCount, 5, true)}  ${pad(report.severityCounts.error, 4, true)}  ${pad(report.severityCounts.warning, 5, true)}  ${pad(report.severityCounts.info, 5, true)}  ${report.failures.length === 0 ? 'OK' : 'FAIL'}`,
    );
    for (const failure of report.failures) {
      console.log(`${' '.repeat(nameWidth + 2)}  ! ${failure}`);
    }
  }

  console.log('-'.repeat(nameWidth + 62));
  console.log(
    `${pad(`TOTAL (${reports.length} files)`, nameWidth)}  ${pad('', 8)}  ${pad('', 3)}  ${pad(totals.lines, 6, true)}  ${pad(totals.tokens, 7, true)}  ${pad(totals.raw, 5, true)}  ${pad(totals.error, 4, true)}  ${pad(totals.warning, 5, true)}  ${pad(totals.info, 5, true)}  ${failedFiles === 0 ? 'OK' : `${failedFiles} FAIL`}`,
  );

  console.log('');
  const distinct = [...rawSamples.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  console.log(
    `raw tokens: ${totals.raw} total, ${distinct.length} distinct (showing top ${Math.min(distinct.length, RAW_SAMPLE_LIMIT)}; non-ASCII redacted)`,
  );
  for (const [raw, count] of distinct.slice(0, RAW_SAMPLE_LIMIT)) {
    console.log(`  ${pad(count, 4, true)} x  ${redact(raw)}`);
  }
  if (distinct.length > RAW_SAMPLE_LIMIT) {
    console.log(`  … ${distinct.length - RAW_SAMPLE_LIMIT} more distinct raw token(s) not shown`);
  }

  // AST 级汇总（M1.5 T6，断言 ⑤–⑦）。
  const astOkFiles = reports.filter((r) => r.astOk).length;
  console.log('');
  console.log(
    `AST level: printAst full-text + line-text + path-uniqueness — ${astOkFiles}/${reports.length} file(s) OK`,
  );

  // ⑧ item 位置残留的通用叶子清单（观测，不影响退出码）。见
  // scripts/jcx/lib/astInvariants.ts 的 collectResidualItemLeaves 口径注释：
  // 只统计 bodyLine.items / inlineFieldLine.trailing / chord-grace-tabGroup
  // 的 items（含嵌套），不算 note/rest/tabNote 内部 children、括号组
  // open/close、字段行外壳 children。
  const residualLeafCounts = new Map<string, number>();
  for (const report of reports) {
    for (const kind of report.residualItemLeafKinds) {
      residualLeafCounts.set(kind, (residualLeafCounts.get(kind) ?? 0) + 1);
    }
  }
  const residualLeafTotal = [...residualLeafCounts.values()].reduce((a, b) => a + b, 0);
  const residualLeafDistinct = [...residualLeafCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  console.log(
    `residual item-position leaves (kind === 'token' inside items/trailing): ${residualLeafTotal} total, ${residualLeafDistinct.length} distinct token kind(s) — observational only, not a failure condition`,
  );
  for (const [kind, count] of residualLeafDistinct) {
    console.log(`  ${pad(count, 4, true)} x  ${kind}`);
  }

  if (failedFiles > 0 || crashed > 0) {
    console.log('');
    console.log(`FAILED: ${failedFiles}/${reports.length} file(s) broke at least one assertion.`);
    process.exit(1);
  }

  console.log('');
  console.log(
    `PASSED: ${reports.length}/${reports.length} file(s), all lexer-level and AST-level assertions hold.`,
  );
}

main();
