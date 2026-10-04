/**
 * notation 架构守卫（M2 方案 v1.1.1 §2.1 禁止边 / §2.4.1 / §2.6 / §4.2 / §6 T0）。
 *
 * 它必须在 T0 就绿，并且**先于** T7 引入 `vexflow` 之前存在——守卫的价值在于「依赖
 * 进来的那一刻就红」，事后补的守卫只能证明现状，证明不了约束。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const NOTATION_DIR = join(import.meta.dirname, '../../../src/notation');
const MODEL_DIR = join(NOTATION_DIR, 'model');

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

  it('src/notation/** 下零 .tsx 文件（T3 已迁出 ChordDiagram.tsx，无剩余例外）', () => {
    const tsxFiles = files.filter((file) => file.endsWith('.tsx'));
    expect(tsxFiles).toEqual([]);
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
    expect(bad).toEqual([]);
  });

  /**
   * P1-4：`vexflow` 单列一条用例，**无 whitelist**。守卫的是**依赖边**——静态 import、
   * type-only import、`export … from`、动态 `import()`、`require()` 五种语法全覆盖
   * （见 `collectSpecifiers`）；提到 vexflow 的注释不算依赖，不参与判定。
   * 唯一允许目录 `src/renderer/integrations/vexflow/**`（T7）。
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

/** 四个记谱目录（M2.5 T0 起提到模块级，供 §Q7.4 守卫 3 断言它没有被改动）。 */
const SIBLINGS: readonly string[] = ['staff', 'jianpu', 'tab', 'chord'];

/**
 * 记谱目录之间互不依赖（M2 §2.7）。四种记谱各有各的几何模型，互不继承、互不转换：
 * 结构上的相似（切段、cursor → node → sink）一律**照抄**，不共享代码——共享一旦开始，
 * 「简谱的弧」和「五线谱的连音线」就会被迫用同一组字段，而它们连坐标系都不一样。
 *
 * T7.3 追加：把 `staff/**` 也纳入这条双向守卫（`staff` ↮ `jianpu` / `tab` / `chord`）。
 * 沿用本文件的 `collectSpecifiers`，五种 import 语法全覆盖。
 */
describe('notation 架构守卫 —— 记谱目录互不 import（§2.7）', () => {
  /** `../jianpu`、`../jianpu/jianpuArcs`、`./../tab/tabGlyphs` 都算命中；`./x` 不算。 */
  function crossNotationHits(source: string, self: string): string[] {
    const others = SIBLINGS.filter((name) => name !== self);
    return collectSpecifiers(source).filter((spec) =>
      others.some((name) => new RegExp(`(^|/)${name}(/|$)`).test(spec)),
    );
  }

  const notationDirFiles = SIBLINGS.flatMap((name) =>
    files
      .filter((file) => rel(file).startsWith(`${name}/`))
      .map((file) => ({ file, self: name })),
  );

  it('四个记谱目录都扫到了文件（守卫没有扫空目录）', () => {
    for (const name of SIBLINGS) {
      expect(notationDirFiles.filter((entry) => entry.self === name).length).toBeGreaterThan(0);
    }
  });

  it.each(notationDirFiles.map((entry) => [rel(entry.file), entry.file, entry.self] as const))(
    '%s 不 import 其它记谱目录',
    (_label, file, self) => {
      expect(crossNotationHits(readFileSync(file, 'utf8'), self)).toEqual([]);
    },
  );

  it('反例：探针 `import { x } from "../jianpu/jianpuArcs"` 在 staff 下确实会被命中', () => {
    const probe = "import { buildArcSegments } from '../jianpu/jianpuArcs';";
    expect(crossNotationHits(probe, 'staff')).toEqual(['../jianpu/jianpuArcs']);
    expect(crossNotationHits(probe, 'jianpu')).toEqual([]);
    expect(crossNotationHits("import { staffPitch } from '../staff/staffPitch';", 'tab')).toEqual([
      '../staff/staffPitch',
    ]);
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

/**
 * renderer 架构守卫 —— **反方向**（M2 方案 v1.1.1 §2.1 / §4.2 P2-9，T5 修订补）。
 *
 * `src/notation/**` 单向依赖 Domain、不回到 AST 的规则已经被上面几段钉住；但
 * `src/renderer/**` 同样不该绕过 notation 层直接解析 `AstPath`、直接 import
 * `formats/jcx` 的内部子模块（`parse`/`ast`/`lexer`/`serialize`——公共入口只有
 * `src/formats/jcx` 一个），也不该在组件里就地声明「Domain → 展示文本」的摘要函数
 * （`summarizeEvent`/`summarizePitch` 这类：T5 一度被直接写进 `ScoreView.tsx`，
 * 后移到 `notation/layout/fallbackSummary.ts` 作为可单测的纯函数，见该文件与
 * `fallbackSummary.test.ts` 的 P1-4 记录——这条守卫防止它又悄悄长回组件里）。
 *
 * **不禁止**的东西（避免误伤）：renderer import `domain`（Anchor/VoiceId/EventId 等
 * identity 本来就要在 renderer 里用于 `data-*` 属性与点击匹配）、import
 * `notation/**` 的公开导出、import `formats/jcx` 本身。
 */
describe('renderer 架构守卫 —— 反方向：不回到 AST / parse 内部，不声明 Domain→presentation 摘要函数', () => {
  const RENDERER_DIR = join(import.meta.dirname, '../../../src/renderer');
  const rendererFiles = collectFiles(RENDERER_DIR);

  /** 只放行 `formats/jcx` 这一个包入口；任何更深的子路径都当作内部实现细节。 */
  const FORMATS_JCX_SUBPATH_RE = /formats\/jcx\/./;

  const FORBIDDEN_PRESENTATION_HELPER_RE =
    /\b(?:function|const)\s+(?:summarizeEvent|summarizePitch|eventTo\w+|pitchTo\w+|restTo\w+)\b/;

  it('至少扫到 renderer 的一些文件（守卫没有扫空目录）', () => {
    expect(rendererFiles.length).toBeGreaterThan(0);
  });

  it.each(rendererFiles)('%s 不 import formats/jcx 内部子模块（只允许包入口 src/formats/jcx）', (file) => {
    const specs = collectSpecifiers(readFileSync(file, 'utf8'));
    const bad = specs.filter((spec) => FORMATS_JCX_SUBPATH_RE.test(spec));
    expect(bad).toEqual([]);
  });

  it.each(rendererFiles)('%s 不出现 AstPath 的解析', (file) => {
    const source = stripComments(readFileSync(file, 'utf8'));
    expect(/\bAstPath\b/.test(source)).toBe(false);
    expect(/\bparseAstPath\b|\bastPathSegments\b/.test(source)).toBe(false);
  });

  it.each(rendererFiles)('%s 不声明 summarizeEvent/summarizePitch 之类的 Domain→presentation 摘要函数', (file) => {
    const source = stripComments(readFileSync(file, 'utf8'));
    expect(FORBIDDEN_PRESENTATION_HELPER_RE.test(source)).toBe(false);
  });

  it('正例：当前 renderer/** 零命中三条禁止边', () => {
    for (const file of rendererFiles) {
      const source = readFileSync(file, 'utf8');
      const specs = collectSpecifiers(source);
      expect(specs.some((spec) => FORMATS_JCX_SUBPATH_RE.test(spec))).toBe(false);
      expect(FORBIDDEN_PRESENTATION_HELPER_RE.test(stripComments(source))).toBe(false);
    }
  });

  it('反例：探针字符串 `function summarizeEvent(...)` 确实会被规则命中（证明规则不是形同虚设）', () => {
    const probe = 'export function summarizeEvent(event: MusicEvent): string { return event.kind; }';
    expect(FORBIDDEN_PRESENTATION_HELPER_RE.test(probe)).toBe(true);
    const probeConst = 'const pitchToLabel = (p: Pitch) => p.letter;';
    expect(FORBIDDEN_PRESENTATION_HELPER_RE.test(probeConst)).toBe(true);
    const probeImportPath = "import { parseDirectives } from '../../formats/jcx/parse/directives';";
    expect(FORMATS_JCX_SUBPATH_RE.test(probeImportPath)).toBe(true);
  });
});

/**
 * 全仓 vexflow 守卫（T7.0，M2 方案 v1.1.1 §2.1 补充）。
 *
 * 上面 notation 层的用例只管 `src/notation/**` 零 vexflow；但 vexflow 是 T7 才引入的
 * 新依赖，真正需要钉住的是**全仓**——`src/main/**`、`src/preload/**`、
 * `src/renderer/components/**` 等任何目录都不该有一条 vexflow 依赖边，唯一允许目录是
 * `src/renderer/integrations/vexflow/**`（T7 后续小节落地）。该目录当前可能还不存在，
 * 守卫在「没有任何文件 import vexflow」时也必须通过——这是先立守卫、后写实现的顺序。
 */
describe('全仓 vexflow 守卫 —— vexflow 依赖边只能出现在 renderer/integrations/vexflow/**（T7.0）', () => {
  const SRC_DIR = join(import.meta.dirname, '../../../src');
  const VEXFLOW_ALLOWED_DIR = join(SRC_DIR, 'renderer', 'integrations', 'vexflow');
  const srcFiles = collectFiles(SRC_DIR);

  function relSrc(file: string): string {
    return relative(SRC_DIR, file).split(sep).join('/');
  }

  /**
   * 守的是**对 `vexflow` 这个 npm 包的依赖边**，所以只看 bare specifier
   * （`'vexflow'` / `'vexflow/bravura'`）。相对路径（`./` / `../`）永远指向仓库内的
   * 文件，够不到这个包——T7.4 的 `StaffVoiceView.tsx` import 的是
   * `'../../integrations/vexflow/renderStaff'`，那是 adapter 的**入口函数**，正是这条
   * 守卫希望出现的样子（组件只认识一个本地函数，认不得 VexFlow 的任何 API）。
   * 把它当成依赖边会让守卫反过来禁止 adapter 被使用，那就没有意义了。
   *
   * 这不放宽任何约束：`src/notation/**` 走相对路径绕进 `renderer/integrations/vexflow/`
   * 仍然被上面的 §2.1「不 import renderer/」那条用例挡住。
   */
  function importsVexflowPackage(file: string): boolean {
    return collectSpecifiers(readFileSync(file, 'utf8'))
      .filter((spec) => !spec.startsWith('.'))
      .some((spec) => /^vexflow(\/|$)/.test(spec));
  }

  it('至少扫到 src/** 的一些文件（守卫没有扫空目录）', () => {
    expect(srcFiles.length).toBeGreaterThan(0);
  });

  it('src/** 里任何 vexflow 依赖边只允许出现在 src/renderer/integrations/vexflow/**', () => {
    const offenders = srcFiles.filter(
      (file) => importsVexflowPackage(file) && !(file + sep).startsWith(VEXFLOW_ALLOWED_DIR + sep),
    );
    expect(offenders.map(relSrc)).toEqual([]);
  });

  it('src/renderer/components/** 没有 vexflow 依赖边', () => {
    const COMPONENTS_DIR = join(SRC_DIR, 'renderer', 'components');
    const componentFiles = collectFiles(COMPONENTS_DIR);
    const offenders = componentFiles.filter(importsVexflowPackage);
    expect(offenders.map(relSrc)).toEqual([]);
  });

  /** 反例：证明「只看 bare specifier」没有把守卫变成形同虚设。 */
  it('反例：bare `vexflow` / `vexflow/bravura` 依旧被判为依赖边，相对路径不被误判', () => {
    const bare = (source: string): boolean =>
      collectSpecifiers(source)
        .filter((spec) => !spec.startsWith('.'))
        .some((spec) => /^vexflow(\/|$)/.test(spec));
    expect(bare("import { Stave } from 'vexflow';")).toBe(true);
    expect(bare("import VexFlow from 'vexflow/bravura';")).toBe(true);
    expect(bare("export * from 'vexflow';")).toBe(true);
    expect(bare("const V = await import('vexflow/core');")).toBe(true);
    expect(bare("import { renderStaff } from '../../integrations/vexflow/renderStaff';")).toBe(false);
  });

  it('adapter 目录确实存在且确实 import 了 vexflow 包（守卫不是在对着空目录绿）', () => {
    const adapterFiles = collectFiles(VEXFLOW_ALLOWED_DIR);
    expect(adapterFiles.length).toBeGreaterThan(0);
    expect(adapterFiles.some(importsVexflowPackage)).toBe(true);
  });
});

/**
 * M2.5 System Layout 依赖方向守卫（`docs/M2.5_SYSTEM_LAYOUT_PLAN.md` v1.0 §B.2 / §Q7.4，
 * T0 只立 negative guards 1/2/3/5；守卫 6 = 上面全部既有守卫，扫描范围已自动覆盖
 * `system/**`）。守卫 4（`composeSystem.ts` 确实 import 三个 voice layout 与
 * `chord/layoutChord`）是 positive guard，T4 文件存在后再加，否则 T0 必红。
 *
 * 判定按**解析后的绝对路径**做，不按 specifier 文本做：`../layout/metrics/system`
 * 是 metrics 文件，不是 `notation/system/` 目录，文本正则会误伤。
 */
describe('M2.5 架构守卫 —— system/ 依赖方向（§B.2 / §Q7.4）', () => {
  const SYSTEM_DIR = join(NOTATION_DIR, 'system');
  const CONTRACTS_FILE = join(SYSTEM_DIR, 'contracts.ts');
  const PAGE_MODEL_FILE = join(SYSTEM_DIR, 'pageModel.ts');

  /** contracts 的精确白名单（T0 裁决 A：只增加 `../model/types`，不放开整个 `model/**`）。 */
  const CONTRACTS_ALLOWED: readonly string[] = ['../../domain', '../layout/primitives', '../model/types'];

  /** 去掉 `.ts`/`.tsx`/`.js` 后缀，得到可与目标比较的绝对路径。 */
  function resolveSpec(fromFile: string, spec: string): string | undefined {
    if (!spec.startsWith('.')) return undefined;
    return join(dirname(fromFile), spec).replace(/\.(?:ts|tsx|js)$/, '');
  }

  function isInside(target: string, dir: string): boolean {
    return target === dir || target.startsWith(dir + sep);
  }

  /**
   * 顶层 `import … from` / `export … from` 语句（去注释后按行首锚定，`[^;]` 限定在单条
   * 语句内，避免 `export interface …` 一路吞到后面的 `from`）。`kind` 区分三种形态：
   * `import type`（唯一允许）、值 import（含 `import { type X }`——`verbatimModuleSyntax`
   * 下它会留下一条运行期 `import {}`）、re-export（叶子层不转出任何东西，`export type`
   * 也不放行）。
   */
  function moduleStatements(
    source: string,
  ): { readonly kind: 'type-import' | 'value-import' | 're-export'; readonly spec: string }[] {
    const re = /^\s*(import|export)\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]/gm;
    return [...stripComments(source).matchAll(re)].map((m) => ({
      kind: m[1] === 'export' ? 're-export' : /^\s+type\b/.test(m[2] ?? '') ? 'type-import' : 'value-import',
      spec: m[3] ?? '',
    }));
  }

  /** 守卫 1：contracts 是叶子——只 type-only import 白名单里的三条精确路径。 */
  function contractsLeafViolations(source: string): string[] {
    const statements = moduleStatements(source);
    const specs = collectSpecifiers(stripComments(source));
    const notAllowed = specs.filter((spec) => !CONTRACTS_ALLOWED.includes(spec));
    const badStatements = statements.filter((s) => s.kind !== 'type-import').map((s) => `${s.kind}:${s.spec}`);
    // bare / 动态 import / require 不是 `… from` 语句，会让两者计数不等。
    const extra = specs.length === statements.length ? [] : ['non-static-import'];
    return [...notAllowed, ...badStatements, ...extra];
  }

  /** 守卫 2：记谱目录若 import `notation/system/`，只能是 `system/contracts`。 */
  function systemImportViolations(file: string, source: string): string[] {
    const contracts = CONTRACTS_FILE.replace(/\.ts$/, '');
    return collectSpecifiers(stripComments(source)).filter((spec) => {
      const target = resolveSpec(file, spec);
      return target !== undefined && isInside(target, SYSTEM_DIR) && target !== contracts;
    });
  }

  /** 守卫 5：pageModel 零 screen 概念，且不认识 voice layout / composer。 */
  function pageModelViolations(file: string, source: string): string[] {
    const words = [...stripComments(source).matchAll(/availableWidth|zoom|ResizeObserver|scoreView|SCORE_VIEW/gi)]
      .map((m) => m[0]);
    const forbiddenDirs = SIBLINGS.map((name) => join(NOTATION_DIR, name));
    const composer = join(SYSTEM_DIR, 'composeSystem');
    const imports = collectSpecifiers(stripComments(source)).filter((spec) => {
      const target = resolveSpec(file, spec);
      return target !== undefined && (target === composer || forbiddenDirs.some((dir) => isInside(target, dir)));
    });
    return [...words, ...imports];
  }

  it('守卫 1：system/contracts.ts 存在，且只 type-only import domain / layout/primitives / model/types', () => {
    expect(existsSync(CONTRACTS_FILE)).toBe(true);
    expect(contractsLeafViolations(readFileSync(CONTRACTS_FILE, 'utf8'))).toEqual([]);
  });

  it('守卫 1 反例：值 import、inline type、re-export、model/** 其它文件、voice layout、动态/bare import 都会被命中', () => {
    expect(contractsLeafViolations("import { Anchor } from '../model/types';")).toEqual([
      'value-import:../model/types',
    ]);
    expect(contractsLeafViolations("import { type Anchor } from '../model/types';")).toEqual([
      'value-import:../model/types',
    ]);
    expect(contractsLeafViolations("export { Anchor } from '../model/types';")).toEqual(['re-export:../model/types']);
    expect(contractsLeafViolations("export type { Anchor } from '../model/types';")).toEqual([
      're-export:../model/types',
    ]);
    expect(contractsLeafViolations("import '../model/types';")).toEqual(['non-static-import']);
    expect(contractsLeafViolations("import type { RenderDiagnosticDraft } from '../model/diagnostics';")).toEqual([
      '../model/diagnostics',
    ]);
    expect(contractsLeafViolations("import type { JianpuLayout } from '../jianpu/layoutJianpu';")).toEqual([
      '../jianpu/layoutJianpu',
    ]);
    expect(contractsLeafViolations("const m = await import('../model/types');")).toEqual(['non-static-import']);
    expect(contractsLeafViolations("import type { Box } from '../layout/primitives';")).toEqual([]);
    expect(contractsLeafViolations("import type {\n  Rational,\n  VoiceId,\n} from '../../domain';")).toEqual([]);
    expect(
      contractsLeafViolations("/* import { X } from '../jianpu/x'; */\n// import { Y } from '../tab/y';\n"),
    ).toEqual([]);
  });

  const voiceDirFiles = files.filter((file) => SIBLINGS.some((name) => rel(file).startsWith(`${name}/`)));

  it.each(voiceDirFiles.map((file) => [rel(file), file] as const))(
    '守卫 2：%s 对 system/ 的 import 只允许 system/contracts',
    (_label, file) => {
      expect(systemImportViolations(file, readFileSync(file, 'utf8'))).toEqual([]);
    },
  );

  it('守卫 2 反例：composeSystem / justify 被命中；contracts、metrics/system、注释不被误判', () => {
    const probeFile = join(NOTATION_DIR, 'tab', 'probe.ts');
    expect(systemImportViolations(probeFile, "import { composeSystem } from '../system/composeSystem';")).toEqual([
      '../system/composeSystem',
    ]);
    expect(systemImportViolations(probeFile, "import { justify } from '../system/justify';")).toEqual([
      '../system/justify',
    ]);
    expect(systemImportViolations(probeFile, "import type { ScoreSystemLayout } from '../system/contracts';")).toEqual([]);
    expect(systemImportViolations(probeFile, "import { SYSTEM_METRICS } from '../layout/metrics/system';")).toEqual([]);
    expect(systemImportViolations(probeFile, "/* import { c } from '../system/composeSystem'; */")).toEqual([]);
    expect(systemImportViolations(probeFile, "// import { c } from '../system/composeSystem';")).toEqual([]);
  });

  it('守卫 3：SIBLINGS 仍是四个记谱目录，system/ 不在其中', () => {
    expect(SIBLINGS).toEqual(['staff', 'jianpu', 'tab', 'chord']);
    expect(SIBLINGS).not.toContain('system');
  });

  it('守卫 5：system/pageModel.ts（存在时）零 screen 概念，且不 import voice layout / composeSystem', () => {
    // T0 时该文件尚不存在：用例照样绿，matcher 的有效性由下面的反例证明。
    // **到期提醒**：T9a 落地 `system/pageModel.ts` 时，把这里改成
    // `expect(existsSync(PAGE_MODEL_FILE)).toBe(true)`，防止改名 / 挪目录后守卫空跑。
    const sources = existsSync(PAGE_MODEL_FILE) ? [readFileSync(PAGE_MODEL_FILE, 'utf8')] : [];
    for (const source of sources) {
      expect(pageModelViolations(PAGE_MODEL_FILE, source)).toEqual([]);
    }
  });

  it('守卫 5 反例：screen 字样、voice layout、composeSystem 都会被命中；注释与干净源码不被误判', () => {
    const hit = (source: string): string[] => pageModelViolations(PAGE_MODEL_FILE, source);
    expect(hit('const w = policy.availableWidth;')).toEqual(['availableWidth']);
    expect(hit('const z = SCORE_VIEW_METRICS.zoomMax;')).toEqual(['SCORE_VIEW', 'zoom']);
    expect(hit('new ResizeObserver(cb);')).toEqual(['ResizeObserver']);
    expect(hit("import { layoutTab } from '../tab/layoutTab';")).toEqual(['../tab/layoutTab']);
    expect(hit("import { composeSystem } from './composeSystem';")).toEqual(['./composeSystem']);
    expect(hit('// 本文件不认识 zoom / availableWidth\nexport const ok = 1;')).toEqual([]);
    expect(hit("/* import { X } from '../jianpu/x'; */")).toEqual([]);
    expect(hit("// import { X } from '../jianpu/x';")).toEqual([]);
    expect(hit("import type { PageComposedSystemLayout } from './contracts';")).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // T3.5（用户裁决 Q1-a）：literal timing 原语下沉到 `layout/`，`system/` 只做 re-export 转接。
  // ---------------------------------------------------------------------------

  const LAYOUT_DIR = join(NOTATION_DIR, 'layout');
  const ONSETS_FILE = join(LAYOUT_DIR, 'measureOnsets.ts');

  /** 守卫 6：`layout/**` 对所有记谱开放，因此它绝不反向 import `system/**`（否则记谱目录经它绕回 system）。 */
  function layoutToSystemViolations(file: string, source: string): string[] {
    return collectSpecifiers(stripComments(source)).filter((spec) => {
      const target = resolveSpec(file, spec);
      return target !== undefined && isInside(target, SYSTEM_DIR);
    });
  }

  /** 守卫 7：从 Domain 值导入 `add`（Rational 加法）的文件——literal onset 累计只允许一处。 */
  function importsRationalAdd(source: string): boolean {
    const re = /^\s*import\s*\{([^}]*)\}\s*from\s*['"](?:\.\.\/)+domain(?:\/rational)?['"]/gm;
    return [...stripComments(source).matchAll(re)].some((m) => /(^|[\s,])add(\s|,|$)/.test(m[1] ?? ''));
  }

  const layoutFiles = files.filter((file) => isInside(file, LAYOUT_DIR));

  it('守卫 6：layout/** 不 import system/**', () => {
    expect(layoutFiles.length).toBeGreaterThan(0);
    const bad = layoutFiles.flatMap((file) =>
      layoutToSystemViolations(file, readFileSync(file, 'utf8')).map((spec) => `${rel(file)} → ${spec}`),
    );
    expect(bad).toEqual([]);
  });

  it('守卫 6 反例：system 下任何文件都被命中；注释与 layout 内部引用不被误判', () => {
    const probeFile = join(LAYOUT_DIR, 'probe.ts');
    expect(layoutToSystemViolations(probeFile, "import { x } from '../system/measureFeatures';")).toEqual([
      '../system/measureFeatures',
    ]);
    expect(layoutToSystemViolations(probeFile, "import type { S } from '../system/contracts';")).toEqual([
      '../system/contracts',
    ]);
    expect(layoutToSystemViolations(probeFile, "import { eventTiming } from './eventTiming';")).toEqual([]);
    expect(layoutToSystemViolations(probeFile, "// import { x } from '../system/timeline';")).toEqual([]);
  });

  it('守卫 7：src/notation/** 里只有 layout/measureOnsets.ts 从 Domain 值导入 Rational `add`（唯一 literal onset 累计）', () => {
    expect(existsSync(ONSETS_FILE)).toBe(true);
    const importers = files.filter((file) => importsRationalAdd(readFileSync(file, 'utf8'))).map(rel);
    expect(importers).toEqual(['layout/measureOnsets.ts']);
  });

  /** 守卫 7 补强（独立 review LOW-4）：命名空间导入 Domain（`import * as D` → `D.add`）会绕过具名检查。 */
  function importsDomainNamespace(source: string): boolean {
    return /^\s*import\s+(?:type\s+)?\*\s+as\s+\w+\s+from\s*['"](?:\.\.\/)+domain(?:\/\w+)?['"]/m.test(stripComments(source));
  }

  it('守卫 7 补强：src/notation/** 不以命名空间形式导入 Domain（否则 `D.add` 可绕过唯一累计检查）', () => {
    expect(files.filter((file) => importsDomainNamespace(readFileSync(file, 'utf8'))).map(rel)).toEqual([]);
    expect(importsDomainNamespace("import * as D from '../../domain';")).toBe(true);
    expect(importsDomainNamespace("import * as R from '../../domain/rational';")).toBe(true);
    expect(importsDomainNamespace("// import * as D from '../../domain';")).toBe(false);
    expect(importsDomainNamespace("import * as svg from '../svg/node';")).toBe(false);
  });

  it('守卫 7 反例：单行 / 多行 / 别名位置的 add 都被识别；adder、注释、type 导入不被误判', () => {
    expect(importsRationalAdd("import { ZERO, add } from '../../domain';")).toBe(true);
    expect(importsRationalAdd("import {\n  add,\n  cmp,\n} from '../../../domain';")).toBe(true);
    expect(importsRationalAdd("import { add } from '../../domain/rational';")).toBe(true);
    expect(importsRationalAdd("import { adder } from '../../domain';")).toBe(false);
    expect(importsRationalAdd("// import { add } from '../../domain';")).toBe(false);
    expect(importsRationalAdd("import { cmp } from '../../domain';")).toBe(false);
  });
});
