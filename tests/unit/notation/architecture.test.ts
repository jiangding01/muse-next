/**
 * notation 架构守卫（M2 方案 v1.1.1 §2.1 禁止边 / §2.4.1 / §2.6 / §4.2 / §6 T0）。
 *
 * 它必须在 T0 就绿，并且**先于** T7 引入 `vexflow` 之前存在——守卫的价值在于「依赖
 * 进来的那一刻就红」，事后补的守卫只能证明现状，证明不了约束。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const NOTATION_DIR = join(import.meta.dirname, '../../../src/notation');
const MODEL_DIR = join(NOTATION_DIR, 'model');

/**
 * T3 迁出前的**唯一**已知例外：`ChordDiagram.tsx` 是 React 组件，T3 会把它迁到
 * `src/renderer/components/notation/`。**T3 完成后连同这份名单一起删除。**
 *
 * 注意：它当前实际上**并不需要**豁免——`jsx: "react-jsx"` 下 JSX 不需要显式
 * `import React`，该文件只 import 了 `type { GuitarChord }`。名单在这里是为了让
 * 「为什么 notation 下还躺着一个 .tsx」这件事有据可查，而不是为了放宽规则：下面
 * 「例外名单不得扩张」一条用例把它钉死在一项，`vexflow` 一条则完全没有名单。
 */
const REACT_EXCEPTIONS: readonly string[] = ['chord/ChordDiagram.tsx'];

/** §2.1 禁止边（`vexflow` 单列，见下）。 */
const FORBIDDEN_IMPORTS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: 'formats/', re: /(^|\/)formats(\/|$)/ },
  { label: 'renderer/', re: /(^|\/)renderer(\/|$)/ },
  { label: 'main/', re: /(^|\/)main(\/|$)/ },
  { label: 'preload/', re: /(^|\/)preload(\/|$)/ },
  { label: 'node:', re: /^node:/ },
  { label: 'electron', re: /^electron$/ },
  // P2-9：SourceRef 只透传不解释，notation 层不得回到 AST。
  { label: 'ast', re: /(^|\/)ast(\/|$)/ },
];

const REACT_IMPORTS: readonly RegExp[] = [/^react$/, /^react-dom(\/|$)/, /^react\//];

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 覆盖 `import x from 'm'`、`import type {...} from 'm'`、`export ... from 'm'`、
 * `import('m')`、`require('m')`。
 */
function collectSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const statik = /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const bare = /\bimport\s*['"]([^'"]+)['"]/g;
  const dynamic = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const required = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const re of [statik, bare, dynamic, required]) {
    let m = re.exec(source);
    while (m !== null) {
      if (m[1] !== undefined) specs.push(m[1]);
      m = re.exec(source);
    }
  }
  return specs;
}

/** 去掉注释，避免注释里的示例代码/说明文字被当成实现命中。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function rel(file: string): string {
  return relative(NOTATION_DIR, file).split(sep).join('/');
}

const files = collectFiles(NOTATION_DIR);
const modelFiles = collectFiles(MODEL_DIR);

describe('notation 架构守卫 —— 扫描范围', () => {
  it('至少扫到 T0 的三个 model 文件', () => {
    expect(modelFiles.length).toBeGreaterThanOrEqual(3);
    expect(files.length).toBeGreaterThanOrEqual(modelFiles.length);
  });

  it('例外名单不得扩张：只有 T3 待迁出的 ChordDiagram.tsx', () => {
    expect(REACT_EXCEPTIONS).toEqual(['chord/ChordDiagram.tsx']);
  });
});

describe('notation 架构守卫 —— 依赖方向（§2.1）', () => {
  it.each(files)('%s 不 import formats / renderer / main / preload / node: / electron / ast', (file) => {
    const specs = collectSpecifiers(readFileSync(file, 'utf8'));
    const bad = specs.filter((spec) => FORBIDDEN_IMPORTS.some(({ re }) => re.test(spec)));
    expect(bad).toEqual([]);
  });

  it.each(files)('%s 不 import react / react-dom（含 type-only 与动态 import）', (file) => {
    const specs = collectSpecifiers(readFileSync(file, 'utf8'));
    const bad = specs.filter((spec) => REACT_IMPORTS.some((re) => re.test(spec)));
    if (REACT_EXCEPTIONS.includes(rel(file))) {
      return; // T3 迁出后删除本分支与名单。
    }
    expect(bad).toEqual([]);
  });

  /**
   * P1-4：`vexflow` 单列一条用例，**无 whitelist**。守卫的是**依赖边**——静态 import、
   * type-only import、`export … from`、动态 `import()`、`require()` 五种语法全覆盖
   * （见 `collectSpecifiers`）；提到 vexflow 的注释不算依赖，不参与判定。
   * 唯一允许 import 它的文件是 `src/renderer/integrations/vexflow/renderStaff.ts`（T7）。
   */
  it('src/notation/** 零 vexflow 依赖边，且没有任何放行名单', () => {
    const offenders = files.filter((file) =>
      collectSpecifiers(readFileSync(file, 'utf8')).some((spec) =>
        /(^|\/)vexflow(\/|$)/.test(spec),
      ),
    );
    expect(offenders.map(rel)).toEqual([]);
  });
});

describe('notation 架构守卫 —— model 内无 import 循环', () => {
  /**
   * 循环在类型层不报错（type-only import 被擦除），但它会让「谁依赖谁」失去方向，
   * 下一步加一个值导出就变成真的运行期循环。model 目录的依赖方向必须是单向的
   * （当前：`diagnostics.ts → types.ts`）。
   */
  function relativeDeps(file: string): string[] {
    return collectSpecifiers(readFileSync(file, 'utf8'))
      .filter((spec) => spec.startsWith('./'))
      .map((spec) => join(MODEL_DIR, `${spec.slice(2)}.ts`));
  }

  it('model 目录的 import 图是无环的', () => {
    const graph = new Map<string, readonly string[]>(
      modelFiles.map((file) => [file, relativeDeps(file)]),
    );
    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycles: string[] = [];

    function walk(node: string, trail: readonly string[]): void {
      if (done.has(node)) return;
      if (visiting.has(node)) {
        cycles.push([...trail, node].map(rel).join(' → '));
        return;
      }
      visiting.add(node);
      for (const next of graph.get(node) ?? []) {
        walk(next, [...trail, node]);
      }
      visiting.delete(node);
      done.add(node);
    }

    for (const file of modelFiles) {
      walk(file, []);
    }
    expect(cycles).toEqual([]);
  });
});

describe('notation 架构守卫 —— model 保持 flat（§2.6）', () => {
  // Domain 是 flat 事件流；measure / system / time-slot 一律在 notation/layout/ 派生。
  const FORBIDDEN_MODEL_EXPORTS = ['Measure', 'System', 'TimeSlot'];

  it.each(modelFiles)('%s 不导出 Measure / System / TimeSlot', (file) => {
    const source = stripComments(readFileSync(file, 'utf8'));
    const bad = FORBIDDEN_MODEL_EXPORTS.filter((name) =>
      new RegExp(
        `export\\s+(?:type\\s+)?(?:interface|type|const|function|enum)?\\s*\\b${name}\\b|export\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}`,
      ).test(source),
    );
    expect(bad).toEqual([]);
  });
});

describe('notation 架构守卫 —— 诊断分层（§4.2）', () => {
  it.each(files)('%s 不 import JcxDiagnostic', (file) => {
    const source = readFileSync(file, 'utf8');
    expect(/\bJcxDiagnostic\b/.test(stripComments(source))).toBe(false);
  });

  it.each(files)('%s 没有 jcx. 前缀的 code 字面量', (file) => {
    const source = stripComments(readFileSync(file, 'utf8'));
    const literals = [...source.matchAll(/['"`]([^'"`\n]*)['"`]/g)].map((m) => m[1] ?? '');
    expect(literals.filter((value) => value.startsWith('jcx.'))).toEqual([]);
  });
});

describe('notation 架构守卫 —— 不自建 Domain lookup（§2.4.1，P2-G）', () => {
  /**
   * 精确化（P2-G）：禁止的是**重建** `EventId → MusicEvent` / `RelationId → Relation`
   * 这两种 Domain lookup，即自己**声明**一份 `xxxById` / `buildXxxIndex`。
   *
   * **明确允许**：
   * - 读取入参 `input.index.eventById` / `index.relationById`（成员访问，不匹配下面的声明模式）；
   * - 布局自己的位置索引，如 `Map<EventId, Point>`、`Map<VoiceId, System[]>`
   *   ——它们索引的是**布局产物**而不是 Domain 事实。
   * v1.1 曾用的「`new Map()` + 以 `.id` 为键」宽正则会误伤后者，已弃用。
   */
  const REBUILD_PATTERNS: readonly RegExp[] = [
    /\b(?:function|const|let|var|class)\s+\w*(?:ById|ByPath)\b/,
    /\b(?:function|const|let|var|class)\s+build\w*Index\b/,
    /\b\w*(?:ById|ByPath)\s*[:=]\s*new\s+Map\b/,
  ];

  it.each(files)('%s 未声明 eventById / relationById / byPath / buildIndex 之类的重建', (file) => {
    const source = stripComments(readFileSync(file, 'utf8'));
    const hits = REBUILD_PATTERNS.filter((re) => re.test(source)).map((re) => re.source);
    expect(hits).toEqual([]);
  });

  it('允许布局用途的位置索引：`Map<EventId, Point>` 不被上面的模式命中', () => {
    const sample = 'const xByEvent = new Map<EventId, Point>();\nconst cached = index.eventById.get(id);';
    expect(REBUILD_PATTERNS.some((re) => re.test(sample))).toBe(false);
  });
});

describe('notation 架构守卫 —— 不解析 AstPath（P2-9）', () => {
  it.each(files)('%s 不出现 AstPath 的解析', (file) => {
    const source = stripComments(readFileSync(file, 'utf8'));
    expect(/\bAstPath\b/.test(source)).toBe(false);
    expect(/\bparseAstPath\b|\bastPathSegments\b/.test(source)).toBe(false);
  });
});
