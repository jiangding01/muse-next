# Compatibility validation log

> **验证总览**：本文件按时间倒序记录关键 validation milestone；历史数字是当时的快照，不代表当前覆盖规模。
> 当前的验证体系分两类：
>
> - **GitHub CI**（`.github/workflows/ci.yml`，macOS / Windows / Ubuntu 三平台，Node 24）实际只运行
>   `npm ci` → `npm run typecheck` → `npm test` → `npm run jcx:fixture-report`（合成 fixture 矩阵，
>   不含真实语料）。
> - **本地 final validation evidence**（不在 CI 中运行）：`npm run jcx:corpus-test`（11 份本地真实语料，
>   语料目录被 `.gitignore` 排除）、真实语料的 production-pipeline probe、Electron 冒烟测试。
>
> 早期 M0 的一次性人工烟雾测试与早期脚手架 `parseJcx()` 已在 M1.4–M1.8 被自动化分级回归取代（见文末历史记录）。

## 2026-10-06 — M2.5 T9c final validation（Stage A）

> 本记录是 Stage A 的本地 final validation 证据（validation base `42fb4df`）。**Stage A seal verification 已完成**：包含本记录的文档同步提交
> docs `9a1fd5d7407b399e92946ce533f709fb9d804345` 的 GitHub CI run 37452773013 attempt 1 completed / success，macOS / Windows / Ubuntu
> 三个 job 均 success（`npm ci` / `npm run typecheck` / `npm test` / `npm run jcx:fixture-report` 均实际执行）。以上是 Stage A 的证据；
> Stage B final seal 提交自身的 CI 不在本文件中记录。

在 `42fb4df`（T9c.P code `1e7fb1c` + docs `42fb4df` 之后的 HEAD，工作区干净）上重新实际运行，**不沿用** T9c.P
之前或 T9c.P 自身报告中的数字；被 T9c.P 打断的那次 Stage A 不作为本次证据。

**自动化 gate（本地运行，原始退出码均为 0）**

| 项 | 结果 |
|---|---|
| `npm run -s typecheck` | 通过 |
| `npm test` | 108 个测试文件 / 7163 个用例全部通过 |
| `npm run -s jcx:fixture-report` | 105/105 fixture：L1 105/105；L2 104/105 + pinned known limitation 1/105（`unclosed-chord.jcx`）、unexpected 0；L3 105/105；idempotent 105/105；closure 105/105；reparse-clean 105/105 |
| `npm run -s jcx:corpus-test` | 11/11 语料：lexer / AST / parse / round-trip（byte-identical、semantic、reparse-clean、closure 均 11/11）全部通过；GB18030 encoding composition 10/10 |
| T3–T9c 关键基线（`tests/unit/notation/` 下 12 个文件：`system.timeline.test.ts`、`system.timeline.brokenRhythm.test.ts`、`beams.regression.test.ts`、`system.compose.test.ts`、`t5.defaultRegression.test.ts`、`system.chordOverlay.test.ts`、`system.composeLayout.test.ts`、`system.composeLayout.lyrics.test.ts`、`system.composeLayout.staff.test.ts`、`system.verticalLayout.test.ts`、`system.pageModel.test.ts`、`staff.verticalDemand.test.ts`） | 12 个文件 / 483 个用例 |
| render matrix（`tests/unit/notation/render.matrix.test.ts`） | 1215 个用例 |
| architecture（`tests/unit/notation/` 下 `architecture.test.ts`、`architecture.t9a.test.ts`、`architecture.t9b.test.ts`、`architecture.t9bs.test.ts`、`architecture.t9c.test.ts`、`architecture.t9cp.test.ts`） | 6 个文件 / 702 个用例 |
| T5 默认路径 golden | 945/945 键集合一致、漂移 0（golden 仍是 T5 `ed4ea88` 生成的版本，未更新） |

**真实语料 production-pipeline probe**（11 份语料 × screen 960 / screen 300 / page target（默认 PageSpec content width））：每份语料走
`loadJcx → buildRenderScore → composeSystemGeometry → composeScoreLayout`，screen 再走 `buildScoreRender`，page 再走
`pageModel`。断言 system index 唯一递增、box / 层 / measure 全部有限、层序与 group 声部顺序一致、fallback 层高 0、Staff
层高 ≥ 基础高且 topInset 合法、和弦 overlay anchor 不重复、J4 `leftOffset ≥ 0` 且所有 system 的音乐 x = 0 对齐、
**T9c.P 歌词可达性**（每个简谱歌词 `leftGutter + lyricLeft ≥ 0`，有目标 `x − 宽/2`、无目标 `x`；只验证 screen renderer
可达性，不把歌词墨迹解释为 `ScoreSystemLayout.box` 合同）、PageModel 保序 / 无空页 / 容量 / 分页边界最大装填、诊断码全部
在注册表内（49 个）且级别只有 info / warning：**0 违例**。分支覆盖（真实语料，零样本记为 evidence gap）：结构冲突、小节数
不一致、错位锁存（desync）、和弦 overlay、和弦图碰撞降级、Staff、Staff 动态加高、fallback、多声部 group 均有样本；
同名 gchord 歧义、和弦符号冲突、多个 bracket group、connector 未建模、Staff topInset > 0、歌词实际决定 gutter 均为 0 样本。
真实语料的歌词在两种 screen 宽度下都没有决定 gutter（gutter 由和弦决定）；歌词决定 gutter 的情形由合成单测与 Electron
冒烟覆盖。

**确定性**：同一进程内对每次 production call 连续调用两次并逐字段比较；另用两个独立进程分别生成 319 项逐字段哈希
（诊断 id / 顺序、systems、box、measures、layers、和弦 overlay、Staff 几何、voice layout、ScoreRender、leftGutter /
leftOffset、PageModel），差异 0。

**PageModel**：真实语料 page target 共 34 页、overflow 0（当前证据，不是 golden）；首页页眉 11 次、续页页眉 23 次容量正确，
23 个分页边界全部为最大装填；9 个零高 system 正常分页，含加高 Staff 的页 1 个。合成 PageSpec：exact-fit（首页恰好容纳
2 个 system）、超高 system 各自独占一页且首页非空、overflow 诊断 12 条均锚到首层声部。单元测试覆盖首页 / 续页页眉、gap
只出现一次、零高 system、超高 system、overflow 诊断锚点。**PageModel 只是分页数据模型；Print Preview / 打印界面属于 M5，
尚未实现。**

**Electron final smoke（本地 dev 渲染进程，合成谱 + 默认示例）：25 项全部通过，console 0 error。** 覆盖：默认示例（Guitar TAB + Melody 简谱）；和弦图、只有名字的和弦、
和弦图碰撞降级为只画名；简谱 + TAB 共享 system；Staff 多 system 与极高 / 极低音动态加高（层高 272 / 96 / 158 / 262u，按
真实字形墨迹测量全部在层框内）；fallback 单独成 system 并在下方提示；缩放 50% / 100% / 150% / 300%；窄 → 宽 → 窄（每档
容器宽度连续多帧稳定，system 数往返一致，无反馈环）；左伸和弦与行首 34 字符长歌词在 `scrollLeft = 0` 时都可完整访问（300% +
760px 视口下歌词左端位于可滚动区域内 129px）；有目标歌词 `middle`、无目标歌词 `start`，anchor 误差 0；音乐 x = 0 跨
system 偏差 0；事件 / 关系 / 和弦 overlay / fallback 提示 / 诊断 → 谱面高亮均正确，Staff 重绘后高亮恢复；system 间距恰好
一次 `systemGap × zoom`；console 0 error。已知且不修：极长有目标歌词与相邻歌词会轻微重叠（renderer / engraving polish）。

**T9c.P 回归证据**：上述 gate 中的 `t5.defaultRegression`（945 零漂移）、`system.composeLayout.lyrics`、
`jianpu.lyricAnchor`、`jianpu.external`（同行与跨 system 弧线端点）、`systemRender.lyricGutter`、`architecture.t9cp`
全部通过；probe 与 Electron 冒烟的歌词可达性检查 0 违例。

## 2026-09-22 — M2 T8 render matrix：C1/C2/C3 契约的自动化矩阵回归

`tests/unit/notation/render.matrix.test.ts` + `renderMatrix.helpers.ts`
（后者文件头是契约定义与矩阵覆盖表的唯一权威出处）对 Chord / Jianpu / TAB /
Staff 四种记谱验证三条契约：C1 每个 `RenderItem` 在该声部布局里恰好一个可见
节点；C2 每个 `fallback: true` 节点至少一条诊断指向它；C3 每条渲染诊断的
`anchor` 可经 `DomainIndex` 解析、`anchorKey()` 稳定。

**用例构成（1434 条）**：102 个 fixture × 两档 `availableWidth`（wide 100000
不换行 / narrow 16 逼出多行谱）× C1/C2/C3；fixture × D12（style 缺席/未知）；
fixture × chord 的 C1′ 口径；25 个合成边界用例 × 四种记谱 × 两档宽度 × 三条
契约；dangling 端点定点用例 9 条；反空转哨兵 3 条（每种记谱 fallback 节点数
> 0：jianpu 30 / tab 148 / staff 42；诊断种类数 > 10：staff 12 / tab 6 /
jianpu 7；窄宽度下跨行 tie 确实产生 > 1 个 system）；跨行拆段 1 条；确定性
（同输入两次布局结果相同）4 条；诊断码来源 1 条。

**chord 的 C1′ 口径**：`Score.chordShapes` 是文档级对象，`ChordLayout.anchor`
恒为 `{ kind: 'document' }`，与声部事件之间没有映射（D11 默认关闭）；断言
改为「每个 `GuitarChord` 恰好一个 `ChordLayout`、每个 `ChordLayout` 恰好 6
条弦标记、对事件的可见节点数恒为 0、`ChordLayout` 无 `fallback` 字段因此
C2 恒为空集」。

**结果**：零契约违规；变异检验——临时在 `buildRenderScore` 漏派一类事件，
C1 断言红 204 条，证明矩阵能真的抓到回归。全量 vitest 74 文件 / 5882 用例；
corpus smoke 11/11；GB18030 encoding composition 10/10；只读审查（`/check`）
无 P1/P2；测试运行耗时 494ms。

## 2026-09-22 — M2 五线谱（Staff + VexFlow）渲染：人工 smoke + 修复复验（Electron 桌面窗口）

**人工 smoke 顺序**：corpus#05（含唯一 staff 声部的真实语料）→ 6 个
`tests/fixtures/jcx/*` 中 `style=staff` 的 fixture → 一份合成 stress 样例
（`K:Eb`、`M:3/4`、treble/bass/未知 clef 三声部、五种升降号、和弦、同小节与跨小节
tie、三连音、`Z` 休止、反复线、未知事件占位）。

**发现并修复的两项**：

| 发现 | 根因 | 修复 |
|---|---|---|
| staff SVG 不随 zoom 缩放 | VexFlow `SVGContext.resize()` 写 inline `width`/`height` 覆盖样式表 | resize 后写 `viewBox`、清 inline 尺寸，zoom 宽度放外层 section（`93cc62a`） |
| 同小节内 tie 视觉塌缩 | 端点解析正确，但实测符头间距仅 4.7px，弧跨不足以可辨 | `STAFF_METRICS.minNoteSlotWidth` 16 → 40（最宽 Bravura 符头 24 + 最小可辨弧跨 16），修复后 tie 跨度 36.7px（`93cc62a`） |

**复验结果**：

| 项 | 结果 |
|---|---|
| 50% 缩放 | 六小节一行缩进页宽 |
| 100% / 150% 缩放 | 等比缩放，换行随 zoom 变化，SVG 未被整体拉伸 |
| tie / 升降号 / 三连音 | 正确 |
| bass 谱号加线 | 正确 |
| 反复线 | 正确 |
| 占位角标（未知事件 / 降级节点） | 正确 |
| `clef` 三态诊断（正常 / 缺席 info / 未知 warning） | 正确 |

每项修复都有自造 fixture 的单元测试守住（`tests/unit/notation/staff.layout.test.ts`
等），真实语料仅用于人工复验，不进入测试。全量 vitest 73 文件 / 4448 用例；
corpus smoke 11/11；`grep -c artifactory package-lock.json` = 0；CI 三平台绿
（run `35688854397` 覆盖 T7.0–T7.4，run `35690835529` 覆盖 T7.5 修复）。

## 2026-09-17 — M2 TAB 六线谱渲染：全语料只读 smoke + 人工复验（Electron 桌面窗口）

**只读 smoke**（脚本在会话 scratchpad，不入库）：11 个真实语料文件中的 8 个 TAB 声部与
10 个简谱声部各走 `loadJcx → buildRenderScore → layoutTab/layoutJianpu → toSvg →
serializeSvg`，`availableWidth = 900`。断言：事件数 = 节点数（C1）、无 NaN/Infinity、
两次序列化逐字节相同、行谱不重叠、关系/弧线续行段不越所属 box。T6.5 前后逐节点比对：
宽度变化只有和弦符号 12u → 0（共 277 个）；无和弦符号的声部逐节点相同；同行弧线全部
不变；4 条简谱跨行续行末段从 4.7u 拉到 16u；诊断集合不变。一个文件有 24 条同弦
`-S-/-H-/-P-` 关系正常连线；两处同弦重复成员按设计标 fallback 并诊断；单音级 stroke
在语料中 0 次，组级前缀属 parse 不回填的已知限制②。

**人工复验**（corpus#10，100% / 50% / 150%）：

| 项 | 结果 |
|---|---|
| 六线、`x` 记号按弦分布、小节线贯穿、和弦符号在谱上方 | 通过 |
| 符干 + 减时线在第 6 弦下方，八分一条、十六分两条 | 通过 |
| 和弦符号写在小节中途时的空档（`\|\|\|\| \|\|\|\|`） | T6.5 修复后消失 |
| 和弦符号显示带引号 `"G"` | T6.5 修复后为 `G` |
| 简谱跨行 tie 末段退化成尖角 | T6.5 修复后为 16u 续行弧 |
| 50% / 150% 缩放 | 字号随缩放变、TAB 每行 10 / 3 小节、简谱同步换行，SVG 未被整体拉伸 |
| `x` 字形略高于弦线 | visual debt（HANDOFF §30.1） |

## 2026-09-16 — M2 简谱渲染人工 smoke（corpus#10，Electron 桌面窗口）

M2 T5 之后用一份两声部（TAB + 简谱）真实成品语料 corpus#10 在 `npm run dev` 的
Electron 窗口里人工检查简谱声部，逐轮修复后复验：

| 发现 | 根因 | 修复 |
|---|---|---|
| 简谱随窗口宽度等比缩放 | SVG `width:100%` 拉伸 | `b2b254d` 固定比例绘制、按容器宽度换行 |
| 歌词全部堆在文末、`*` 占位画成星号矩阵 | 歌词基线全局、skip 也画字形 | `5ae5a7b` 歌词按 system 归属，skip 不可见 |
| tie/slur 画成顶部长横线、跨行关系反向拉回行首 | 弧高固定、不跨行切段 | `3539e5f` 弧高随跨度、跨行切段 |
| 歌词首行被低八度点/减时线压住 | `lyricFirstOffset` 小于最深装饰 | `add5af9` 抬高并加几何不变量测试 |
| 连到全音符/breve 的弧落在延音线中间 | 端点取槽位中心 | `b85f8a6` 端点取数字字形中心 |
| 3 处 `2/1`（breve）只占宽不画延音线 | 时值分解上限 k ≥ 0 | `f77d3d2` 单点放行 `2/1` → 7 条延音线，简谱槽宽随之加宽 |

复验结果：短弧只跨相邻音、跨行关系两端各一小段、歌词与装饰不再相交。breve 修复
只读 smoke：`muse.render.duration.unrepresentable` 3 → 0，三处延音线严格在槽内且
不触及后续小节线，仅 3 个 breve 槽变宽、其余节点无漂移、system 数不变。仍可见的
预期项：`||` 画普通单线并给诊断；一个 UnknownEvent 占位。
每项修复都有自造 fixture 的单元测试守住，真实语料仅用于人工复验，不进入测试。

## 2026-09-14 — legacy JCX smoke test（历史记录，已被 M1.4–M1.8 的自动化回归取代）

The structural parser was tested locally against an extracted legacy Muse Pro `.jcx` file without adding that copyrighted fixture to this repository.

Observed parse result:

- `%MUSE2` recognized.
- Legacy Simplified Chinese text decoded as GB18030.
- Chinese title decoded correctly.
- 6 `%%gchord` definitions recognized: D, G7, C, A, Em, G.
- 2 tracks recognized:
  - V:1 — guitar accompaniment, `style=tab`.
  - V:2 — main melody, `style=jianpu`.
- Both track bodies were retained as source text.

This validates the first vertical slice:

```text
legacy bytes -> GB18030 decode -> JCX structural parser -> chord/track domain model
```

The source file itself is intentionally not included in the clean-room scaffold.
