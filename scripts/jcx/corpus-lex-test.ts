/**
 * JCX Lexer + AST 语料回归（M1.4 方案 §6，M1.5 T6，HANDOFF §39.3，JCX_SPEC §30.3）。
 *
 * 用法：`npm run jcx:corpus-test`
 *
 * 对 `legacy-corpus/jcx/*.jcx` 逐文件读字节，四级断言由 `lib/checkCorpusFile.ts`
 * 的 `checkFile` 执行（本文件只做文件枚举、汇总打印与退出码）：
 *
 * **Lexer 级**（①–④）：无 uncaught error（含 `decodeJcx` 的 `JcxEncodingError`）、
 * diagnostics 中无 `error` 级、全文不变量（`flattenTokens` 的 raw 拼接 === 解码
 * 文本）、逐行不变量（§29.5）。
 *
 * **AST 级**（⑤–⑧，M1.5 T6，逻辑与 `tests/unit/jcx/ast/lossless.test.ts` 共用
 * `lib/astInvariants.ts`）：全文不变量 `printAst(buildAst(lex)) === decodedText`、
 * 逐节点不变量、path 唯一性、item 位置残留通用叶子清单（⑧ 仅观测）。
 *
 * **parse 级**（⑨–⑬，M1.6 T10a，逻辑在 `lib/parseInvariants.ts`，供本脚本与
 * `tests/unit/jcx/parse/invariants.test.ts` 共用）：`parseJcxDocument` 不抛异常、
 * 无 `error` 级 diagnostic、`index` 自洽、`events` kind 合法、M1.7 T0 事实字段
 * 的 `EventId` 引用自洽。parse 级汇总（voices/events/relations/lyricLines/
 * chordShapes/directives 计数、diagnostics 按 severity 计数）逐文件打印；
 * 结尾追加 diagnostic code 直方图与 `UnknownEvent.tokenKind` 去重清单——两者
 * 都是观测指标，不影响退出码。
 *
 * **round-trip 级**（第四级，M1.7 T7 + M1.8 T0，逻辑在
 * `lib/roundtripInvariants.ts`）：对每个文件计算 preserve byte-identical /
 * line-identical、canonical 语义 round-trip（L2 投影相等）、以及 canonical
 * 文本重解析后 diagnostics 无 error 级（`reparseClean`），外加 canonical 幂等
 * 与 reparse warning 计数观测。**失败条件三项**：byte-identical < 100%、
 * semantic < 100%、reparseClean < 100%；line-identical、幂等、reparse
 * warning 数只汇报数字，不影响退出码。
 *
 * 语料**不进 git**（HANDOFF §39.1 / §51），因此 CI 上目录必然缺失：
 * 目录不存在或没有 `.jcx` 时打印跳过并 `exit 0`，只有真正的断言失败才 `exit 1`。
 *
 * **版权边界**：本脚本只向 stdout 打印统计数字与结构信息，绝不把语料内容写入
 * 任何文件。**文件名同样不打印**——`main` 按枚举顺序给每个文件分配匿名编号
 * `#1`…`#N`（`FileReport.label`），逐文件表、失败输出、round-trip 汇总一律
 * 只用这个编号，真实文件名只在 `checkFile` 内部用于 `readFileSync` 定位，
 * 从不进入任何打印路径。末尾的 raw token 清单是唯一会回显语料片段的地方，
 * 已做三重限制：去重、上限 20 项、含非 ASCII 字符（即可能是歌词/标题）的
 * 一律脱敏为长度标记。
 */

import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFile, crashedFileReport, type FileReport } from './lib/checkCorpusFile';
import {
  printParseSection,
  printResidualLeafSection,
  printRoundtripSection,
} from './lib/printCorpusSummary';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const CORPUS_DIR = resolve(PROJECT_ROOT, 'legacy-corpus/jcx');

/** raw token 清单的输出上限（避免把整首歌的可疑片段抖出来）。 */
const RAW_SAMPLE_LIMIT = 20;
/** 单个 raw 片段的回显长度上限。 */
const RAW_SAMPLE_MAX_CHARS = 12;

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

  files.forEach((fileName, index) => {
    const label = `#${index + 1}`;
    try {
      reports.push(checkFile(CORPUS_DIR, fileName, label, rawSamples));
    } catch (error) {
      crashed += 1;
      const errorCode = error instanceof Error ? error.name : 'UnknownError';
      reports.push(crashedFileReport(label, errorCode));
    }
  });

  const nameWidth = Math.max(8, ...reports.map((r) => r.label.length));
  console.log('JCX corpus lex regression');
  console.log(`corpus: ${reports.length} file(s), anonymized as #1..#${reports.length}`);
  console.log('');
  console.log(
    `${pad('no.', nameWidth)}  ${pad('encoding', 8)}  ${pad('bom', 3)}  ${pad('lines', 6, true)}  ${pad('tokens', 7, true)}  ${pad('raw', 5, true)}  ${pad('err', 4, true)}  ${pad('warn', 5, true)}  ${pad('info', 5, true)}  status`,
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
      `${pad(report.label, nameWidth)}  ${pad(report.encoding, 8)}  ${pad(report.hasBom ? 'yes' : '-', 3)}  ${pad(report.lineCount, 6, true)}  ${pad(report.tokenCount, 7, true)}  ${pad(report.rawTokenCount, 5, true)}  ${pad(report.severityCounts.error, 4, true)}  ${pad(report.severityCounts.warning, 5, true)}  ${pad(report.severityCounts.info, 5, true)}  ${report.failures.length === 0 ? 'OK' : 'FAIL'}`,
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

  printResidualLeafSection(reports);
  printParseSection(reports, nameWidth);
  printRoundtripSection(reports, nameWidth);

  if (failedFiles > 0 || crashed > 0) {
    console.log('');
    console.log(`FAILED: ${failedFiles}/${reports.length} file(s) broke at least one assertion.`);
    process.exit(1);
  }

  console.log('');
  console.log(
    `PASSED: ${reports.length}/${reports.length} file(s), all lexer-level, AST-level, parse-level and round-trip-level assertions hold.`,
  );
}

main();
