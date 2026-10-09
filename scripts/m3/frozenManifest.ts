/**
 * M3 T0 冻结文件哈希清单生成器（`docs/M3_EDITOR_CORE_PLAN.md` §21.3，T0 用户裁决）。
 *
 * 用法（不新增 npm script）：
 *
 *   node --import tsx scripts/m3/frozenManifest.ts          # 只检查：重算并与已提交清单比对，输出统计
 *   node --import tsx scripts/m3/frozenManifest.ts --write  # 写入 tests/unit/editor/m3FrozenManifest.json
 *
 * **`--write` 只能在用户显式裁决之后运行**：清单锁的是「本阶段不允许改的既有冻结事实」，
 * 更新清单本身就是一次需要用户批准的冻结范围变更。
 *
 * 成员：只取基线提交 `BASELINE_COMMIT` 的 git 树中、落在已批准类别（C1–C9）里的文件；
 * M3 新增文件不会进入清单。哈希模式由 `git check-attr text` 得出（`unset` → `raw`），并与
 * `.gitattributes` 的已知规则 `tests/fixtures/jcx/**\/*.jcx -text` 交叉核对；清单逐项显式记录模式，
 * 校验测试不按扩展名猜模式。
 *
 * - `raw`：原始字节 SHA-256，不做任何换行处理（CRLF fixture、GB18030 / 非 UTF-8 fixture）。
 * - `norm`：字节级 CRLF → LF、孤立 CR → LF 之后的 SHA-256（不先做 UTF-8 解码）。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BASELINE_COMMIT = 'c04626010a7f8bda67ffac6e5c92ef68e2440235';
const MANIFEST_PATH = 'tests/unit/editor/m3FrozenManifest.json';

type HashMode = 'raw' | 'norm';

interface ManifestEntry {
  readonly path: string;
  readonly mode: HashMode;
  readonly sha256: string;
}

const NOTATION_COMPONENTS = ['SystemView.tsx', 'StaffSystemView.tsx', 'systemRender.ts', 'systemSlices.ts', 'SvgTree.tsx', 'ChordDiagram.tsx', 'ScoreHeaderView.tsx'];
const GUARDS = ['architecture.test.ts', 'architecture.t9a.test.ts', 'architecture.t9b.test.ts', 'architecture.t9bs.test.ts', 'architecture.t9c.test.ts', 'architecture.t9cp.test.ts'];

/** 已批准的 9 个类别：目录前缀（以 `/` 结尾）或精确路径。 */
const CATEGORIES: readonly (readonly [string, readonly string[]])[] = [
  ['C1 formats/jcx 核心', ['src/formats/jcx/']],
  ['C2 domain', ['src/domain/']],
  ['C3 notation', ['src/notation/']],
  ['C4 M2.5 renderer 集成', [...NOTATION_COMPONENTS.map((name) => `src/renderer/components/notation/${name}`), 'src/renderer/integrations/vexflow/']],
  ['C5 serializer 守卫与护栏', ['tests/unit/jcx/serialize/', 'tests/unit/jcx/lossless.test.ts']],
  ['C6 domain 测试', ['tests/unit/domain/']],
  ['C7 M2 / M2.5 架构守卫', GUARDS.map((name) => `tests/unit/notation/${name}`)],
  ['C8 其余行为测试与 fixture', ['tests/unit/jcx/', 'tests/unit/notation/', 'tests/unit/renderer/', 'tests/fixtures/']],
  ['C9 gate / golden 脚本与 .gitattributes', ['scripts/jcx/', 'scripts/notation/t5-default-golden.ts', 'scripts/notation/beam-regression-golden.ts', '.gitattributes']],
];

const RAW_RULE = /^tests\/fixtures\/jcx\/(?:.+\/)?[^/]+\.jcx$/;

const matches = (path: string, rule: string): boolean => (rule.endsWith('/') ? path.startsWith(rule) : path === rule);

/** 字节级换行规范化：CRLF → LF，孤立 CR → LF。不做任何文本解码。 */
function normalizeLineEndings(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === 0x0d) {
      out.push(0x0a);
      if (bytes[i + 1] === 0x0a) i += 1;
    } else if (byte !== undefined) {
      out.push(byte);
    }
  }
  return Uint8Array.from(out);
}

function hashFrozenBytes(bytes: Uint8Array, mode: HashMode): string {
  const input = mode === 'raw' ? bytes : normalizeLineEndings(bytes);
  return createHash('sha256').update(input).digest('hex');
}

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
}

function baselineFiles(): string[] {
  return git(['ls-tree', '-r', '--name-only', BASELINE_COMMIT]).split('\n').filter((line) => line !== '');
}

function textAttributes(paths: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of git(['check-attr', 'text', '--', ...paths]).split('\n')) {
    const [path, , value] = line.split(': ');
    if (path !== undefined && value !== undefined) result.set(path, value);
  }
  return result;
}

function buildEntries(): { entries: ManifestEntry[]; byCategory: Map<string, number> } {
  const files = baselineFiles();
  const byCategory = new Map<string, number>();
  const selected: string[] = [];
  for (const [name, rules] of CATEGORIES) {
    const hits = files.filter((path) => rules.some((rule) => matches(path, rule)) && !selected.includes(path));
    byCategory.set(name, hits.length);
    selected.push(...hits);
  }
  const attributes = textAttributes(selected);
  const entries = selected
    .map((path): ManifestEntry => {
      const mode: HashMode = attributes.get(path) === 'unset' ? 'raw' : 'norm';
      if ((mode === 'raw') !== RAW_RULE.test(path)) {
        throw new Error(`哈希模式与 .gitattributes 已知规则不一致：${path}（check-attr 得出 ${mode}）`);
      }
      return { path, mode, sha256: hashFrozenBytes(readFileSync(path), mode) };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, byCategory };
}

function assertBaselineWorktree(paths: readonly string[]): void {
  const dirty = git(['status', '--porcelain', '--', ...paths]).trim();
  const diff = git(['diff', '--name-only', BASELINE_COMMIT, '--', ...paths]).trim();
  if (dirty !== '' || diff !== '') {
    throw new Error(`冻结文件与基线 ${BASELINE_COMMIT} 不一致，拒绝生成：\n${dirty}\n${diff}`);
  }
}

function main(): void {
  const write = process.argv.includes('--write');
  const { entries, byCategory } = buildEntries();
  assertBaselineWorktree(entries.map((entry) => entry.path));
  for (const [name, count] of byCategory) console.log(`${name}: ${String(count)}`);
  const raw = entries.filter((entry) => entry.mode === 'raw').length;
  console.log(`total=${String(entries.length)} raw=${String(raw)} norm=${String(entries.length - raw)}`);
  const manifest = { schemaVersion: 1, baselineCommit: BASELINE_COMMIT, files: entries };
  const text = `${JSON.stringify(manifest, null, 1)}\n`;
  if (write) {
    mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
    writeFileSync(MANIFEST_PATH, text);
    console.log(`wrote ${MANIFEST_PATH}`);
    return;
  }
  let committed: unknown;
  try {
    committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    console.log(`${MANIFEST_PATH} 不存在或不是合法 JSON（只检查模式，未写入）`);
    process.exitCode = 1;
    return;
  }
  // 比较解析后的数据结构而不是文件文本：Windows autocrlf 检出的清单文件是 CRLF，文本比较会假失败。
  const same = JSON.stringify(committed) === JSON.stringify(manifest);
  console.log(same ? '已提交清单与重算结果一致' : '已提交清单与重算结果不一致');
  if (!same) process.exitCode = 1;
}

main();
