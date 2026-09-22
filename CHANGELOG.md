# Changelog

本文件记录 Muse Next 值得关注的产品 / 架构 / 兼容性变化（notable changes），按里程碑
归纳，不逐 commit 罗列。详细逆向证据、Definition of Done、fixture 路径与面向接手
Agent 的实施记录以 [`HANDOFF.md`](HANDOFF.md) 为准；`.jcx` 格式的语法结论与
evidence level 以 [`docs/JCX_SPEC.md`](docs/JCX_SPEC.md) 为准。

项目尚未打过版本 tag，因此变更暂时都记在 `Unreleased` 下；未来打 tag 发布时，会把
`Unreleased` 整理拆分为带日期的版本小节。

语料相关条目一律使用 `corpus#NN` 编号或纯数字统计，不出现真实语料文件名、标题或本地
路径，遵循 [`NOTICE.md`](NOTICE.md) 的边界。

## Unreleased

### Current milestone

M1.8「Round-trip Guardrails」已封板。**M2 — Notation Rendering T0–T9 已全部
完成**：渲染模型、SVG 基础设施、Chord 图、Jianpu 排布/换行/SVG、React 视图、
T5.2 real-world hardening、TAB 六线谱、Staff + VexFlow adapter、T8 render
matrix（C1/C2/C3 三条契约对四种记谱的用例矩阵）、T9 文档封板均已完成，**M2 已于 2026-09-22 封板**（seal 前 push 的 CI run
35700198783 三平台全绿）；下一步是 M3 前的 UI 设计（功能清单 + 设计要求）。四种记谱（Chord / Jianpu
/ TAB / Staff）均可渲染，支持缩放与诊断面板。现状、遗留债务与恢复位置见
`HANDOFF.md` §30.1「M2 进行中状态」。

### Added

- Legacy `.jcx` 语料发现扫描器：逐行分类、编码探测、生成统计报告（M0–M1.2）。
- `docs/JCX_SPEC.md` v0.1：`.jcx` 格式规格文档，每条结论标注 evidence level
  （CONFIRMED / CONFIRMED BY DOCUMENTATION / CONFIRMED BY CORPUS ONLY / INFERRED /
  UNVERIFIED），证据优先级为「语料 > 原版 help/faq > ABC 2.1 标准 > 逆向推断 >
  脚手架代码」（M1.3）。
- 无损 JCX 词法器 + AST：`decodeJcx`（UTF-8 优先、GB18030 回退）、逐行/正文双模式
  （pitch-mode / tab-mode）词法规则、`buildAst`/`printAst`（`printAst` 逐字节还原
  解码后的源文本）（M1.4–M1.5）。
- 类型化音乐 Domain 模型：`Score`/`Voice`/`MusicEvent`/`Relation`（延音线、连音线、
  连音符、TAB relation）、`Rational`、稳定化的 `EventId`/`VoiceId`/`RelationId`，以及
  从 AST 归一化到 Domain 的 parser 管线（`parseJcxDocument`，统一入口 `loadJcx`）
  （M1.6）。
- Preserve / canonical 两种模式的序列化器 `serializeJcx`：preserve 逐字节还原原文
  （保留原编码、字段顺序、别名、注释排版），canonical 输出 Muse Next 标准形态
  （恒 UTF-8、无 BOM、LF、统一字段格式）（M1.7）。
- Notation 渲染层 `src/notation/`（M2，进行中）：`buildRenderScore` 把 Domain
  `Score` 投影为纯渲染模型（`RenderDiagnostic` 只有 info/warning，不回写 Domain；
  `Anchor` 让 SVG 节点与 UI 高亮互指）；无 DOM 依赖的 `SvgNode` 树与序列化器；和弦图
  布局；简谱布局（C 固定映射 1、只识别 CONFIRMED 的四种小节线、按容器宽度换行、
  歌词按 system 归属、tie/slur 弧高随跨度并跨行切段、二全音符 `2/1` 画 7 条延音线且
  槽宽随之加宽、未知事件保守占位 + 诊断）；
  吉他六线谱 TAB 布局（第 1 弦最上、品位白底遮弦线、时值装饰在第 6 弦下方、`-S-/-H-/-P-`
  同弦关系线、单音级扫弦记号、和弦符号作为零宽标注不占时间槽、未知与越界事件可见占位）；
  五线谱 `notation/staff/**` renderer-neutral 布局（`StaffPitch {letter, octave}`、
  语义时值、Domain accidental，零 VexFlow 编码）+ `renderer/integrations/vexflow/**`
  （全仓唯一允许 import vexflow 的目录，入口 `vexflow/bravura`，VexFlow 5 真实渲染
  五线谱；clef 只读 `voice.clef ∈ {treble,bass,alto,tenor}`，缺席/未知回退 treble +
  诊断；`M:` raw 不画拍号也不做 tick 校验；调号只在 canonical spelling 与 raw 一致
  时画；不做 beam、不用 VexFlow `Tuplet`（自绘括号）、slur/lyrics 不画、grace 占位；
  9 条新诊断码 `muse.render.staff.*`）；Electron 渲染进程的 `ScoreView` / 渲染诊断
  面板 / 缩放控件（缩放只改像素换算与换行，不缩放 SVG）。
- Render matrix 契约测试（M2 T8）：`tests/unit/notation/render.matrix.test.ts` +
  `renderMatrix.helpers.ts`，1434 条用例对 Chord / Jianpu / TAB / Staff 四种记谱
  验证 C1（每个事件恰好一个可见节点）/ C2（降级节点必带 `fallback: true` 且至少
  一条诊断）/ C3（诊断 `anchor` 可解析、`anchorKey()` 稳定）三条契约，覆盖 102 个
  fixture × 两档宽度、25 个合成边界用例、dangling 端点定点用例与反空转哨兵；
  chord 采用文档级 C1′ 口径（`ChordLayout.anchor` 恒 document，对事件可见节点数
  恒为 0）。
- L2 语义投影 `projectScore` 及配套 round-trip 验证矩阵，用于比较「原始解析结果」与
  「canonical 输出重新解析后的结果」在语义层是否等价（M1.7）。
- Round-trip 兼容性护栏（M1.8）：
  - canonical 输出的 reparse 健康检查（无 error 级诊断的输入，其 canonical 输出
    重解析也不得出现 error 级诊断）。
  - canonical document closure 矩阵：把 canonical 输出当作二级 fixture 再跑一遍
    不动点 / L2 / L3 / reparse 四项检查，零豁免。
  - GB18030 → UTF-8 → GB18030 encoding composition 往返验证。
  - `tests/unit/jcx/serialize/fixtureMatrix.ts` 作为 fixture 六项检查（L1 parse /
    L2 semantic / L3 preserve / idempotent / reparse-clean / closure）与已知限制
    豁免名单的单一定义来源；`scripts/jcx/fixture-report.ts`
    （`npm run jcx:fixture-report`）复用同一逻辑，输出显式分母的指标，并在 CI 上
    追加到 `GITHUB_STEP_SUMMARY`。
  - CI（`.github/workflows/ci.yml`）在 macOS / Windows / Ubuntu 三平台矩阵的
    `npm test` 之后新增 fixture 矩阵报告步骤。

### Changed

- 2026-09-22 用 `git filter-repo` 重写了全部提交历史并 force push：早期 `package-lock.json` 中的内部 npm 源 URL 改写为 `registry.npmjs.org`，匿名化之前的真实语料文件名改写为 `corpus#NN`；HEAD 的文件树与重写前逐字节一致，但所有 commit SHA 已变化（本文档与 HANDOFF 中的 SHA 已按映射表同步更新；重写前的历史保留在维护者本地的私有镜像备份中）。

- 断行规划把「未闭合括号上下文之后恢复出的 barline token」也算作断行点，使 canonical
  输出第一趟即可达到不动点，缩小闭包矩阵需要迭代的场景面（M1.8）。
- Fixture 名称在文档/测试/报告脚本之间统一改用 `/` 分隔，不再受运行平台路径分隔符
  影响（M1.8）。
- 仓库内的语料引用一律匿名化为 `corpus#01`–`corpus#11` 编号或纯数字统计，真实文件名
  只保留在 git 忽略的本地映射表中；不改变任何 evidence level、统计数字、spec 结论或
  UNVERIFIED 判定（M1.7 收尾 hygiene）。
- 五线谱曾经是 `pending` 分支的占位声部，现改为真实渲染；`scoreHeader` 的消费方
  （调号解析等）现在也覆盖 staff 声部（M2 T7）。
- `src/renderer/integrations/vexflow/renderStaff.ts` 成为全仓唯一允许 import
  `vexflow` 的**目录**（此前 HANDOFF 曾误写「唯一文件」，本轮一并更正为「唯一目录」，
  含 `vexTickables.ts` / `vexRelations.ts` / `vexAnchors.ts` / `vexEncoding.ts` 等
  同目录下的多个模块）（M2 T7）。

### Fixed

- Windows CI 上 fixture 名称因使用反斜杠路径分隔符而与测试内固定名称不匹配，统一改为
  `/` 分隔后三平台一致通过（M1.8）。
- `N/` 时值词法误切分为多个 token 的问题，改为单一 token（M1.5）。
- `K:Eb` 被 scoreHeader 误判为 mode（大小调）而非纯调号的问题（M2 T7.2）。
- Staff 声部 SVG 不随 zoom 缩放：根因 VexFlow `SVGContext.resize()` 写 inline
  `width`/`height` 覆盖样式表，改为 resize 后写 `viewBox`、清 inline 尺寸、zoom
  宽度放到外层 section（M2 T7.5）。
- 同小节内 tie 视觉塌缩：端点解析本身正确，实测符头间距仅 4.7px 不足以画出可辨的弧，
  `STAFF_METRICS.minNoteSlotWidth` 由 16 调整为 40（M2 T7.5）。
- 五线谱行首（谱号/调号/拍号）预留空间此前会在每行左侧留下死区、同时压掉行首小节的
  音符区，改为预留空间归行首 stave 自己、非行首 stave 整体右移（M2 T7.2）。
- body `L:` 曾按 AST 行序全局推进、跨声部泄漏：`[V:1]` 段内的 `L:` 会连带改变
  `[V:2]` 的单位音长，只读探针证实 5 个语料文件（corpus#02/#03/#04/#10/#11）的
  简谱声部因此每小节时值 = 拍号 × 2.000；已按 spec §8.5 U06 裁决改为「body `L:`
  只作用于它所在的声部，不泄漏到其它声部」（U06 修复任务）。
- `TabGroupEvent.stroke`（作用于整个弦组的拨弦/扫弦前缀，`V[...]` / `U[...]`
  的 `V` / `U`，spec §26.4）此前只在单音 `TabNote.stroke` 上投影，组级前缀被
  parse 层当成悬空 marker 静默丢弃；改为在 `scan.ts` 顶层循环识别「顶层
  `strokePrefix` 紧邻其右边的 `tabGroup` 兄弟节点」这一 AST 事实并回填进
  `TabGroupEvent.stroke`，真悬空的前缀（不紧邻 `[` 或弦号）行为不变，仍发
  `jcx.tab.dangling-stroke-prefix` info。canonical 序列化早已写好
  `${event.stroke ?? ''}[...]` 的渲染规则，回填后自动生效；渲染层
  `tabStrokes.ts` 同样早已写好消费该字段的画法，回填后随之在 TAB 视图里画出
  组级记号。只读探针实测 11 个本地语料文件里 554 处 `tabGroup` 事件中 504 处
  被成功绑定为组级 stroke（与 spec §26.8 记载的 504 次 `[...]`/前缀共现计数
  一致），corpus#3/#4/#7/#9 各有命中（#11 有 21 个弦组但源文本无组级前缀）
  （M2.5 formats preflight）。

### Compatibility / Known limitations

Canonical 序列化目前有四条已知限制（详见 `HANDOFF.md` §30.1「四条已知限制」，逐条
给出触发条件与已固定的处理方式，此处不展开）：

1. 未闭合括号上下文（chord `[` / grace `{` / TAB `[`）后紧跟小节线时，事件分类在
   往返后发生漂移（文本仍然一致）。
2. ~~`TabGroupEvent.stroke` 的 `V`/`U` 前缀在 Domain 中没有对应事实字段，无法
   写回。~~ 已回填（见下方 Fixed，2026-09-22 M2.5 formats preflight）。
3. 组级时值后缀（如 `[CEG]2`）的写回形态与源文本不同（往返一致，但排版不同）。
4. `w:` 歌词行绑定到零事件声部时，canonical 序列化会丢弃整条歌词行并发出诊断
   （Domain 语义级、不可逆，非排版细节丢失）。

### Quality

以下数字为对应里程碑封板时的实测结果，最新封板数字以 `HANDOFF.md` §30.1 /
M1.8 实施记录为准；`README.md` 只维护使用入口与指标口径：

- Fixture 矩阵（`tests/fixtures/jcx/**`，不含真实语料）：102 个 fixture，
  L1/L3/幂等/closure/reparse-clean 均 102/102，L2 语义 101/102（1 条 pinned known
  limitation，0 条 unexpected）。
- 本地语料回归（`npm run jcx:corpus-test`，11 个文件，git 忽略、CI 上跳过）：
  byte-identical / semantic / reparse-clean / closure 均 11/11；encoding
  composition（GB18030 → UTF-8 → GB18030）10/10（分母为 11 个语料中的 10 个
  GB18030 文件）。
- 测试套件：47 个测试文件 / 3352 个用例全部通过；`npm run typecheck` 无错误。
- CI：GitHub Actions 在 macOS / Windows / Ubuntu 三平台矩阵上 typecheck / test /
  fixture 矩阵报告全部 success（run `35054230663`，commit `3042659`）。
