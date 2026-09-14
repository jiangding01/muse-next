import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";

import path from "node:path";

import {
  analyzeBodyFeatures,
  classifyLine,
  normalizeUnknownPattern,
  parseVoiceDefinition,
} from "./lib/classifyLine";

import { decodeJcx } from "./lib/decodeJcx";

import type {
  JcxCorpusReport,
  JcxFileReport,
  JcxCorpusSummary,
  UnknownLine,
  UnknownPatternSummary,
} from "./lib/types";

const PROJECT_ROOT = process.cwd();

const CORPUS_DIR = path.join(PROJECT_ROOT, "legacy-corpus", "jcx");

const OUTPUT_DIR = path.join(PROJECT_ROOT, "docs", "generated");

const JSON_OUTPUT = path.join(OUTPUT_DIR, "jcx-corpus-report.json");

const MARKDOWN_OUTPUT = path.join(OUTPUT_DIR, "jcx-corpus-report.md");

async function main(): Promise<void> {
  console.log("JCX Corpus Scanner");

  console.log(`Corpus: ${relative(CORPUS_DIR)}`);

  const files = await discoverJcxFiles(CORPUS_DIR);

  if (files.length === 0) {
    throw new Error(
      [
        "No .jcx files found.",
        "",
        `Expected files under:`,
        relative(CORPUS_DIR),
      ].join("\n"),
    );
  }

  console.log(`Found ${files.length} JCX files.`);

  const reports: JcxFileReport[] = [];

  for (const file of files) {
    const report = await scanFile(file);

    reports.push(report);

    console.log(
      [
        "  ✓",
        report.file,
        `(${report.encoding},`,
        `${report.lines} lines)`,
      ].join(" "),
    );
  }

  const summary = buildSummary(reports);

  const report: JcxCorpusReport = {
    version: 1,

    generatedAt: new Date().toISOString(),

    corpusDirectory: relative(CORPUS_DIR),

    summary,

    files: reports,
  };

  await mkdir(OUTPUT_DIR, {
    recursive: true,
  });

  await writeFile(JSON_OUTPUT, JSON.stringify(report, null, 2), "utf8");

  await writeFile(MARKDOWN_OUTPUT, renderMarkdown(report), "utf8");

  printSummary(report);

  console.log("");
  console.log(`JSON: ${relative(JSON_OUTPUT)}`);

  console.log(`Markdown: ${relative(MARKDOWN_OUTPUT)}`);
}

async function discoverJcxFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });

  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jcx"),
    )
    .map((entry) => path.join(directory, entry.name))
    .sort((a, b) => a.localeCompare(b, "en"));
}

async function scanFile(filePath: string): Promise<JcxFileReport> {
  const fileStat = await stat(filePath);

  const buffer = await readFile(filePath);

  const decoded = decodeJcx(buffer);

  const lines = decoded.text.split(/\r\n|\n|\r/);

  const report: JcxFileReport = {
    file: path.basename(filePath),

    bytes: fileStat.size,

    encoding: decoded.encoding,

    lines: lines.length,

    magicHeaders: {},

    headers: {},

    inlineFields: {},

    directives: {},

    voiceStyles: {},

    bodyFeatures: {},

    textBlockLines: 0,

    voices: [],

    unknownLines: [],
  };

  /**
   * Some JCX directives are stateful.
   *
   * %%begintext
   * arbitrary literal text
   * %%endtext
   */
  let blockMode: null | "text" = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";

    const lineNumber = index + 1;

    const classified = classifyLine(raw);

    /**
     * Everything inside %%begintext / %%endtext is literal
     * text. It must not be classified as musical notation.
     */
    if (blockMode === "text") {
      const isEndText =
        classified.kind === "directive" &&
        classified.directiveName?.toLowerCase() === "endtext";

      if (isEndText) {
        increment(report.directives, "endtext");

        blockMode = null;

        continue;
      }

      report.textBlockLines += 1;

      continue;
    }

    switch (classified.kind) {
      case "blank":
      case "comment": {
        break;
      }

      case "magic": {
        increment(report.magicHeaders, classified.trimmed);

        break;
      }

      case "header": {
        const key = classified.headerKey ?? "";

        increment(report.headers, key);

        if (key.toLowerCase() === "v") {
          const voice = parseVoiceDefinition(
            lineNumber,
            classified.headerValue ?? "",
            raw,
          );

          report.voices.push(voice);

          if (voice.style) {
            increment(report.voiceStyles, voice.style);
          }
        }

        break;
      }

      case "inline-field": {
        const key = classified.inlineFieldKey ?? "";

        increment(report.inlineFields, key);

        break;
      }

      case "directive": {
        const name = (classified.directiveName ?? "").toLowerCase();

        increment(report.directives, name);

        if (name === "begintext") {
          blockMode = "text";
        }

        break;
      }

      /**
       * Currently text lines are handled by the state machine
       * above. Keep this branch because JcxLineKind includes
       * "text" and the switch should remain exhaustive.
       */
      case "text": {
        report.textBlockLines += 1;

        break;
      }

      case "body": {
        const features = analyzeBodyFeatures(classified.trimmed);

        for (const feature of features) {
          increment(report.bodyFeatures, feature);
        }

        break;
      }

      case "unknown": {
        const unknown: UnknownLine = {
          file: report.file,

          lineNumber,

          raw,

          pattern: normalizeUnknownPattern(raw),
        };

        report.unknownLines.push(unknown);

        break;
      }

      default: {
        assertNever(classified.kind);
      }
    }
  }

  return report;
}

function buildSummary(files: JcxFileReport[]): JcxCorpusSummary {
  const summary: JcxCorpusSummary = {
    fileCount: files.length,

    totalBytes: 0,

    totalLines: 0,

    encodings: {},

    magicHeaders: {},

    headers: {},

    inlineFields: {},

    directives: {},

    voiceStyles: {},

    bodyFeatures: {},

    textBlockLines: 0,

    unknownLineCount: 0,

    unknownPatterns: [],
  };

  const unknownLines: UnknownLine[] = [];

  for (const file of files) {
    summary.totalBytes += file.bytes;

    summary.totalLines += file.lines;

    increment(summary.encodings, file.encoding);

    mergeCounts(summary.magicHeaders, file.magicHeaders);

    mergeCounts(summary.headers, file.headers);

    mergeCounts(summary.inlineFields, file.inlineFields);

    mergeCounts(summary.directives, file.directives);

    mergeCounts(summary.voiceStyles, file.voiceStyles);

    mergeCounts(summary.bodyFeatures, file.bodyFeatures);

    summary.textBlockLines += file.textBlockLines;

    summary.unknownLineCount += file.unknownLines.length;

    unknownLines.push(...file.unknownLines);
  }

  summary.unknownPatterns = buildUnknownPatterns(unknownLines);

  return summary;
}

function buildUnknownPatterns(lines: UnknownLine[]): UnknownPatternSummary[] {
  const grouped = new Map<string, UnknownPatternSummary>();

  for (const line of lines) {
    const existing = grouped.get(line.pattern);

    if (existing) {
      existing.count += 1;

      if (existing.examples.length < 5) {
        existing.examples.push({
          file: line.file,

          lineNumber: line.lineNumber,

          raw: line.raw,
        });
      }

      continue;
    }

    grouped.set(line.pattern, {
      pattern: line.pattern,

      count: 1,

      examples: [
        {
          file: line.file,

          lineNumber: line.lineNumber,

          raw: line.raw,
        },
      ],
    });
  }

  return Array.from(grouped.values()).sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }

    return a.pattern.localeCompare(b.pattern);
  });
}

function renderMarkdown(report: JcxCorpusReport): string {
  const { summary } = report;

  const out: string[] = [];

  out.push("# JCX Corpus Report");

  out.push("");

  out.push("> Generated automatically by `npm run jcx:scan`.");

  out.push("");

  out.push(`Generated: \`${report.generatedAt}\``);

  out.push("");

  out.push(`Corpus: \`${report.corpusDirectory}\``);

  out.push("");

  out.push("## Summary");

  out.push("");

  out.push("| Metric | Value |");

  out.push("| --- | ---: |");

  out.push(`| Files | ${summary.fileCount} |`);

  out.push(`| Total bytes | ${summary.totalBytes} |`);

  out.push(`| Total lines | ${summary.totalLines} |`);

  out.push(`| Text block lines | ${summary.textBlockLines} |`);

  out.push(`| Unknown lines | ${summary.unknownLineCount} |`);

  out.push(`| Unknown patterns | ${summary.unknownPatterns.length} |`);

  out.push("");

  renderCountSection(out, "Encodings", summary.encodings);

  renderCountSection(out, "Magic Headers", summary.magicHeaders);

  renderCountSection(out, "Headers", summary.headers);

  renderCountSection(out, "Inline Fields", summary.inlineFields);

  renderCountSection(out, "Directives", summary.directives);

  renderCountSection(out, "Voice Styles", summary.voiceStyles);

  renderCountSection(out, "Body Syntax Features", summary.bodyFeatures);

  out.push("## Files");

  out.push("");

  out.push("| File | Encoding | Bytes | Lines | Voices | Unknown |");

  out.push("| --- | --- | ---: | ---: | ---: | ---: |");

  for (const file of report.files) {
    out.push(
      [
        "|",
        mdEscape(file.file),
        "|",
        file.encoding,
        "|",
        String(file.bytes),
        "|",
        String(file.lines),
        "|",
        String(file.voices.length),
        "|",
        String(file.unknownLines.length),
        "|",
      ].join(" "),
    );
  }

  out.push("");

  out.push("## Voice Discovery");

  out.push("");

  for (const file of report.files) {
    if (file.voices.length === 0) {
      continue;
    }

    out.push(`### ${file.file}`);

    out.push("");

    out.push("| Line | ID | Style | Attributes |");

    out.push("| ---: | --- | --- | --- |");

    for (const voice of file.voices) {
      out.push(
        [
          "|",
          String(voice.lineNumber),
          "|",
          mdEscape(voice.id ?? ""),
          "|",
          mdEscape(voice.style ?? ""),
          "|",
          mdEscape(formatAttributes(voice.attributes)),
          "|",
        ].join(" "),
      );
    }

    out.push("");
  }

  out.push("## Unknown Patterns");

  out.push("");

  if (summary.unknownPatterns.length === 0) {
    out.push("No unknown lines found.");

    out.push("");
  } else {
    summary.unknownPatterns.forEach((pattern, index) => {
      out.push(`### ${index + 1}. ${inlineCode(pattern.pattern)}`);

      out.push("");

      out.push(`Occurrences: **${pattern.count}**`);

      out.push("");

      out.push("Examples:");

      out.push("");

      for (const example of pattern.examples) {
        out.push(`- \`${example.file}:${example.lineNumber}\``);

        out.push("");

        out.push("```text");

        out.push(example.raw);

        out.push("```");

        out.push("");
      }
    });
  }

  out.push("## Per-file Details");

  out.push("");

  for (const file of report.files) {
    out.push(`### ${file.file}`);

    out.push("");

    out.push(`Encoding: \`${file.encoding}\``);

    out.push("");

    renderCompactCounts(out, "Headers", file.headers);

    renderCompactCounts(out, "Inline fields", file.inlineFields);

    if (file.textBlockLines > 0) {
      out.push(`Text block lines: **${file.textBlockLines}**`);

      out.push("");
    }

    renderCompactCounts(out, "Directives", file.directives);

    renderCompactCounts(out, "Voice styles", file.voiceStyles);

    renderCompactCounts(out, "Body features", file.bodyFeatures);

    if (file.unknownLines.length > 0) {
      out.push(`Unknown lines: **${file.unknownLines.length}**`);

      out.push("");
    }
  }

  return out.join("\n") + "\n";
}

function renderCountSection(
  out: string[],
  title: string,
  values: Record<string, number>,
): void {
  out.push(`## ${title}`);

  out.push("");

  const entries = sortedCountEntries(values);

  if (entries.length === 0) {
    out.push("_None discovered._");

    out.push("");

    return;
  }

  out.push("| Name | Count |");

  out.push("| --- | ---: |");

  for (const [name, count] of entries) {
    out.push(`| ${mdEscape(name)} | ${count} |`);
  }

  out.push("");
}

function renderCompactCounts(
  out: string[],
  title: string,
  values: Record<string, number>,
): void {
  const entries = sortedCountEntries(values);

  if (entries.length === 0) {
    return;
  }

  out.push(`**${title}**`);

  out.push("");

  out.push(entries.map(([key, count]) => `\`${key}\` × ${count}`).join(", "));

  out.push("");
}

function sortedCountEntries(
  values: Record<string, number>,
): Array<[string, number]> {
  return Object.entries(values).sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }

    return a[0].localeCompare(b[0]);
  });
}

function increment(
  target: Record<string, number>,
  key: string,
  amount = 1,
): void {
  if (key.length === 0) {
    return;
  }

  target[key] = (target[key] ?? 0) + amount;
}

function mergeCounts(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [key, value] of Object.entries(source)) {
    increment(target, key, value);
  }
}

function formatAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

function mdEscape(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function inlineCode(value: string): string {
  const escaped = value.replace(/`/g, "\\`");

  return `\`${escaped}\``;
}

function relative(filePath: string): string {
  return path.relative(PROJECT_ROOT, filePath).split(path.sep).join("/");
}

function printSummary(report: JcxCorpusReport): void {
  const { summary } = report;

  console.log("");
  console.log("Corpus summary");

  console.log("------------------------------");

  console.log(`Files:            ${summary.fileCount}`);

  console.log(`Lines:            ${summary.totalLines}`);

  console.log(`Bytes:            ${summary.totalBytes}`);

  console.log(
    `Headers:          ${Object.keys(summary.headers).length} unique`,
  );

  console.log(
    `Inline fields:    ${Object.keys(summary.inlineFields).length} unique`,
  );

  console.log(`Text block lines: ${summary.textBlockLines}`);

  console.log(
    `Directives:       ${Object.keys(summary.directives).length} unique`,
  );

  console.log(
    `Voice styles:     ${Object.keys(summary.voiceStyles).length} unique`,
  );

  console.log(
    `Body features:    ${Object.keys(summary.bodyFeatures).length} discovered`,
  );

  console.log(`Unknown lines:    ${summary.unknownLineCount}`);

  console.log(`Unknown patterns: ${summary.unknownPatterns.length}`);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

main().catch((error: unknown) => {
  console.error("");
  console.error("JCX corpus scan failed.");

  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(error);
  }

  process.exitCode = 1;
});
