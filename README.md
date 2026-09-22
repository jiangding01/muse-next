# Muse Next

TypeScript-first、clean-room 重建的 Muse Pro 2.70 乐谱编辑器。

## 1. 项目简介

**Muse Pro 2.70** 是一款早年的 Windows 原生（VC6/MFC）乐谱编辑软件，已停止维护，
只能在旧版 Windows 或兼容层下运行。Muse Next 的目标是用现代 TypeScript /
Electron / React 技术栈重建其核心能力，优先顺序是：

1. 恢复对其私有乐谱文件格式 `.jcx` 的**读写**能力（不丢失语义、不臆造未验证行为）；
2. 在此之上恢复**谱面渲染**（和弦图、简谱、吉他 TAB、五线谱）；
3. 再恢复**编辑**与**播放**能力。

旧程序本身被当作行为/规格参考，不做逐函数翻译（clean-room：不移植其可执行代码、
字体、内置乐谱等受版权保护的资源）。

**当前阶段**：`.jcx` 格式的解码、词法、无损 AST、Domain 归一化、序列化
（preserve / canonical 两种模式）与 round-trip 兼容性护栏均已完成并通过三平台 CI
（M0–M1.8，见 §5「路线图」）；谱面渲染（M2）T0–T9 已全部完成并封板（2026-09-22）——
和弦图（Chord）、简谱（Jianpu）、吉他 TAB、五线谱（Staff，经 VexFlow adapter）
四种记谱均可渲染，支持缩放与渲染诊断面板，并有覆盖四种记谱的契约测试矩阵
（见 §5「路线图」）。

## 2. 核心发现与设计原则

逆向分析确认：**`.jcx` 不是二进制格式，而是一种以 [ABC notation](https://abcnotation.com/)
为基础、叠加 Muse 私有扩展（声部 `style`、`%%gchord` 和弦图、吉他 TAB 记谱、简谱标注
等）的纯文本乐谱格式**。这个发现决定了整个架构方向：不用现成的 ABC 解析库
（`.jcx` 的私有扩展超出 ABC 标准），也不把制谱引擎（如 VexFlow）当作内部数据模型。

以下原则在项目中被反复验证有效，视为**不可回退的架构约束**：

- **单向管线**：`Raw Source（字节/文本）→ Lossless AST → Normalized Domain → 应用层
  （渲染/编辑/播放）`。任何一层都不得跳过下一层直接依赖再下一层（例如渲染器不得直接
  解析 JCX 文本或操作 AST）。
- **Scanner 不演变为 Parser**：早期用于语料发现的逐行扫描器职责固定在「分类 + 统计」，
  真正的语法结构化交给词法器/AST/Parser，避免扫描脚本无限膨胀成一个隐性的、未经测试
  设计的解析器。
- **不自动吞掉 Unknown**：遇到无法识别的行/token/指令，必须显式归类为「未知」并保留
  原文，而不是静默丢弃或猜测语义；这是无损往返的前提。
- **UNVERIFIED 语义不进 Domain**：`docs/JCX_SPEC.md` 中标记为 `UNVERIFIED`（尚无语料
  /文档证据支持）的行为，不会被编码进 Domain 模型的强类型字段，避免把未经验证的猜测
  固化成看似权威的类型契约。
- **证据优先级**：本项目所有格式结论按下列顺序取信，后者只在前者缺失时补充——
  ① 真实语料（本地 `.jcx` 样本，见 §7）> ② 原版 Muse Pro help/faq 文档 > ③ ABC
  notation 2.1 标准 > ④ 逆向推断（INFERRED）> ⑤ 早期脚手架代码留下的行为（仅作历史
  参考，不作为证据）。

## 3. 架构与目录

管线概览：

```text
bytes (UTF-8 / GB18030)
   ↓ decodeJcx
Muse 源文本
   ↓ lexJcx
token 流（pitch-mode / tab-mode 双模式）
   ↓ buildAst
无损 AST（printAst 可逐字节还原解码后的源文本）
   ↓ parseJcxDocument
Domain Score（Voice / MusicEvent / Relation，归一化 + 诊断）
   ↓ serializeJcx(mode: 'preserve' | 'canonical')
序列化文本 + 字节（preserve 逐字节还原原文；canonical 输出标准形态）
```

`loadJcx` 把 `lexJcx → buildAst → parseJcxDocument` 串成一次调用；`serializeJcx`
是反方向的入口。往返验证额外用到 `projectScore`（把 `Score` 摊平成可比较的语义投影，
供 round-trip 断言与语料回归使用）。

目录职责与依赖边界（`←` 表示允许依赖的方向；箭头之外的依赖由测试守卫拦截）：

```text
src/
├── domain/                       Score/Voice/MusicEvent/Relation 权威模型
│                                 铁律：不得 import formats/ · renderer/ · main/ ·
│                                 preload/ · notation/ · node: · electron
│                                 （由 tests/unit/domain/architecture.test.ts 守卫）
├── formats/jcx/                  .jcx ⇄ Domain 的双向转换，唯一对外入口见 §4
│   ├── encoding/                 decodeJcx / encodeJcx（UTF-8, GB18030, BOM）
│   ├── lexer/                    token 化 + 诊断，pitch-mode / tab-mode 双模式
│   ├── ast/                      无损 AST（buildAst / printAst）
│   ├── parse/                    AST → Domain 归一化（parseJcxDocument）
│   └── serialize/                Domain → 文本（preserve / canonical）
│       └── projection/           L2 语义投影 + round-trip 比较工具
│                                 preserve 分支只依赖 AST，canonical 分支只依赖
│                                 Domain，两条分支单向不交叉
│                                 （由 tests/unit/jcx/serialize/architecture.test.ts
│                                 与 canonical.boundary*.test.ts 守卫）
├── notation/chord/                SVG 和弦图渲染（当前唯一已实现的渲染子系统）
├── main/ · preload/ · renderer/   Electron 主进程 / 类型化能力桥 / React 桌面 UI
└── shared/                        IPC 契约
```

`src/formats/jcx/index.ts` 明确声明：应用层（渲染器/编辑器/未来的序列化调用方）应从
该文件导入，`lexer/`、`ast/`、`parse/` 等子目录的导出仍然存在，但只服务于内部实现与
单元测试，不构成对外契约。

## 4. 公开 API

以下均从 `src/formats/jcx/index.ts` 导出，示例均为自造文本，不含真实语料内容。

**读取（bytes/文本 → Domain）**

> 以下示例假定文件位于仓库根目录；`tsconfig.json` 未配置 `baseUrl`/`paths`，
> 项目也未发布 package exports，请按实际文件位置调整相对路径。

```ts
import { loadJcx } from './src/formats/jcx';

const source = 'M:4/4\nK:C\nCDEF|GABc|\n';
const result = loadJcx(source); // 也接受 Uint8Array（走 decodeJcx 自动探测编码）

result.score;       // Score：header、voices、诊断已归一化的事实
result.diagnostics; // 合并了 lex / ast / parse 三层的诊断
result.lex;         // 词法层结果（token、检测到的编码）
result.ast;         // 无损 AST（result.ast 配合 printAst 可还原源文本）
```

**写回（preserve 模式：逐字节还原原文，适合编辑已有文件）**

```ts
import { loadJcx, serializeJcx } from './src/formats/jcx';

const loaded = loadJcx(source);
const preserved = serializeJcx(loaded, { mode: 'preserve' });
// preserved.text / preserved.bytes 与原始输入逐字节一致（byte-identical）
// 可选项：encoding（显式转码目标）、onUnencodable（'error' | 'replace'）
```

**写回（canonical 模式：输出 Muse Next 标准形态，适合新建文件）**

```ts
import { serializeJcx } from './src/formats/jcx';

const canonical = serializeJcx(loaded.score, {
  mode: 'canonical',
  magicHeader: true, // 默认 true：输出 %MUSE2；恒 UTF-8 / 无 BOM / LF / 末尾换行
});
```

**Round-trip 验证（内部/测试用工具，非应用层稳定契约）**

`projectScore` 定义在 `src/formats/jcx/serialize`（未从顶层 `formats/jcx` 索引重新
导出），用于把两次解析结果摊平成可比较的语义投影：

```ts
import { loadJcx } from './src/formats/jcx';
import { projectScore, projectionEquals } from './src/formats/jcx/serialize';

const before = projectScore(loadJcx(source).score);
const roundTripped = loadJcx(serializeJcx(loadJcx(source).score, { mode: 'canonical' }).text);
const after = projectScore(roundTripped.score);

projectionEquals(before, after); // true 表示语义往返无损
```

## 5. 路线图

已完成（M0–M1.8，逐条勾选证据见 `HANDOFF.md` §30 / §55–§60）：

| 里程碑 | 产出 |
|---|---|
| M0 | Electron + React + TypeScript 脚手架 |
| M1.1 | 本地语料 Scanner v0.2（逐行分类 + 编码探测） |
| M1.2 | 语料发现与首轮分析 |
| M1.3 | `docs/JCX_SPEC.md` v0.1（格式规格 + evidence level） |
| M1.4 | 词法器 / Tokenizer |
| M1.5 | 无损 JCX AST |
| M1.6 | Parser / Domain Model |
| M1.7 | Serializer（preserve / canonical） |
| M1.8 | Round-trip 兼容性护栏（fixture 矩阵 + closure + CI 看板） |

已完成（2026-09-22 封板）：

- **M2 — Notation Rendering**：从 `src/domain/` 的 `Score` 出发画谱面，**不**从
  JCX 文本或 AST 直接画，四种记谱 Chord / Jianpu / TAB / Staff 均已可渲染（Chord
  借鉴既有 SVG 实现，Jianpu 是与主流制谱软件的核心差异能力）。VexFlow 只作为
  Staff 的 adapter，依赖方向固定为 `Domain Model → Adapter → VexFlow` 单向，
  `src/renderer/integrations/vexflow/**` 是全仓唯一允许 import VexFlow 的目录，
  `JCX Parser → VexFlow objects` 未被短路。渲染层有覆盖四种记谱的 C1/C2/C3 契约
  测试矩阵（详见 `HANDOFF.md` §30.1「M2 进行中状态」），已于 2026-09-22 经三平台 CI 全绿封板。
  全仓测试规模（`npm test`）：74 个测试文件 / 5642 个用例全部通过。

下一阶段：

- **M3 — Editor Core**：选区/光标模型、命令架构、撤销重做、源码 ↔ 可视化选区同步。
  开工前先完成 M3 前的 UI 设计（功能清单 + 设计要求）。
- **M4 及以后 — Playback / Import-Export / Layout**：播放、MIDI 导入导出、页面布局
  与打包分发。以 `HANDOFF.md` §61 的规划为准，本文档不重复展开、不提前承诺细节。

## 6. 开发与验证

**环境要求**：Node.js ≥ 22.12（见 `package.json` `engines`；CI 固定使用 Node 24）。

**安装**：

```bash
npm ci
```

仓库根目录的 `.npmrc` 固定 `registry=https://registry.npmjs.org/`（公共 npm 源），
提交前请确认锁文件不引入内部/私有源地址。

**命令**：

| 命令 | 作用 | 是否需要本地语料 |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit` 严格类型检查 | 否 |
| `npm test` | `vitest run` 全量单元测试 | 否 |
| `npm run jcx:corpus-test` | 对本地 legacy `.jcx` 语料跑 Lexer / AST / Parse / Round-trip 四级回归，另含 GB18030 encoding composition 检查 | 是（语料缺失时打印跳过提示并以 exit 0 结束，CI 上直接跳过） |
| `npm run jcx:fixture-report` | 对 `tests/fixtures/jcx/**` 跑同一套 fixture 矩阵检查，输出显式分母的六项指标 | 否（不含真实语料内容） |
| `npm run jcx:scan` | 本地语料发现扫描器，生成 `docs/generated/` 下的统计报告 | 是 |
| `npm run dev` | 启动 Electron + Vite 开发环境 | 否 |
| `npm run make` | 打包本地可分发产物 | 否 |

**CI**：`.github/workflows/ci.yml` 在 `macOS-latest` / `windows-latest` /
`ubuntu-latest` 三平台矩阵上依次跑 `npm ci` → `npm run typecheck` → `npm test` →
`npm run jcx:fixture-report`；最后一步在 GitHub Actions 环境下会把 fixture 矩阵的
Markdown 表格追加到该次 run 的 Step Summary，便于直接在 CI 页面查看六项指标而不必
下载日志。语料相关命令不在 CI 中运行（语料目录被 `.gitignore` 排除）。

## 7. 质量护栏

**Fixture 矩阵**（`tests/fixtures/jcx/**`，不含真实语料，`npm run jcx:fixture-report`
可复现）对每个 fixture 检查六项，判定逻辑单一来源于
`tests/unit/jcx/serialize/fixtureMatrix.ts`：

- **L1 parse**：原始输入 `loadJcx` 不产生 error 级诊断。
- **L2 semantic**：`project(parse(x))` 与 `project(parse(canonical(x)))` 语义投影
  相等。
- **L3 preserve byte-identical**：`preserve` 输出与原始字节逐字节相等。
- **idempotent（观测项）**：`canonical(parse(canonical(x))) === canonical(x)`。
- **closure（零豁免）**：把 canonical 输出当作二级 fixture，再验证不动点 / L2 / L3
  / reparse 四项在其上同样成立。
- **reparse-clean**：原始输入无 error 级诊断的 fixture，其 canonical 输出重新解析
  后同样不得出现 error 级诊断。

**语料失败条件**（`npm run jcx:corpus-test`，分母见括号）：byte-identical / semantic
/ reparse-clean / closure 四项必须 100%（分母 = 语料文件总数，当前 11）；encoding
composition（GB18030 → UTF-8 → GB18030）必须 100%（分母 = 语料中 GB18030 编码文件数，
当前 10）；line-identical 与 idempotent 只观测、不作为失败条件。

**Pinned known limitation 机制**：极少数 fixture 因触及已知限制而无法满足 L2 语义
相等，会被 `L2_KNOWN_LIMITATION`（`fixtureMatrix.ts` 唯一定义处）显式登记豁免并单独
计入分子分母，而不是从矩阵中静默剔除——报告会同时打印「豁免了几条」与「意外失败了
几条」，两者含义不同，不得混淆。

**四条已知限制**（详见 `HANDOFF.md` §30.1「四条已知限制」）：

1. 未闭合括号上下文（chord/grace/TAB 的 `[`/`{`）后紧跟小节线时，事件分类在往返后
   发生漂移（文本仍一致）。
2. `TabGroupEvent.stroke` 的 `V`/`U` 前缀在 Domain 中没有对应事实字段，无法写回。
3. 组级时值后缀（如 `[CEG]2`）的写回形态与源文本不同（往返一致，排版不同）。
4. `w:` 歌词行绑定到零事件声部时，canonical 会丢弃整条歌词行（Domain 语义级、不可
   逆，非排版丢失）。

## 8. 文档导航

| 文档 | 用途 |
|---|---|
| [`HANDOFF.md`](HANDOFF.md) | 面向接手 Agent 的完整交接文档：逆向结论、逐里程碑实际状态、DoD 证据、下一步任务 |
| [`CHANGELOG.md`](CHANGELOG.md) | 按里程碑归纳的产品/架构/兼容性变化 |
| [`docs/JCX_SPEC.md`](docs/JCX_SPEC.md) | `.jcx` 格式规格，逐条结论标注 evidence level |
| [`docs/TECHNICAL_PLAN.md`](docs/TECHNICAL_PLAN.md) | 早期技术方案与架构原则（现状对照见文中说明） |
| [`docs/VALIDATION.md`](docs/VALIDATION.md) | 兼容性验证记录 |
| [`NOTICE.md`](NOTICE.md) | 版权、语料与字体策略 |

## 9. 版权、语料与字体策略

Muse Next 是基于观察到的文件格式、公开文档与 clean-room 分析的独立重实现（见
`NOTICE.md`）。仓库刻意不包含原程序可执行文件、内置乐谱、专有字体（包括原版
`MAESTRO.TTF`）、图标或其他二进制资源。真实 legacy `.jcx` 语料仅保存在本地、被
`.gitignore` 排除，不进入版本库，也不会被发布；仓库内引用这些语料时只使用
`corpus#NN` 编号或聚合统计数字，不出现文件名、标题、歌词或本地路径。新增兼容性
fixture 时优先使用自造的合成样本。

## 10. 贡献约定

- 每一轮改动后确保 `npm run typecheck && npx vitest run` 全绿再继续下一步。
- 单个源文件建议不超过 350 行。
- 不使用 `class`（可读性偏好）；优先具名导出（`export { xxx }`），避免默认导出
  （Electron/Node 侧脚本除外）。
- 修改 `docs/JCX_SPEC.md` 时，每条新增/修改的结论必须标注 evidence level；标记为
  `UNVERIFIED` 的结论不得被编码进 `src/domain/` 的强类型字段。
