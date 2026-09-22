# Compatibility validation log

> **当前验证状态**：本文件最早的一条记录是 M0 阶段针对早期脚手架 parser 的一次性
> 人工烟雾测试，早期脚手架代码（`parseJcx()`）已在 M1.6 移除。M1.4–M1.8 期间，
> 验证方式已经从「手工跑一次、记一条日志」升级为**自动化、可重复执行**的分级
> round-trip 回归：
>
> - fixture 矩阵（`npm run jcx:fixture-report`，102 个合成 fixture，六项检查，
>   见 `README.md` §7）；
> - 本地语料回归（`npm run jcx:corpus-test`，11 个真实语料文件，Lexer /
>   AST / Parse / Round-trip 四级，另含 GB18030 encoding composition 检查；
>   语料 git 忽略、CI 上跳过）；
> - 三平台 CI（`.github/workflows/ci.yml`，macOS/Windows/Ubuntu）。
>
> 最新实测数字与已知限制以 `README.md` §6/§7 与 `HANDOFF.md` §30.1 为准，不在本文件
> 重复维护。下面保留的是历史上第一条验证记录，作为项目验证方式演进的起点，不代表
> 当前的验证覆盖范围。

## 2026-09-22 — M2 五线谱（Staff + VexFlow）渲染：人工 smoke + 修复复验（Electron 桌面窗口）

**人工 smoke 顺序**：corpus#05（含唯一 staff 声部的真实语料）→ 6 个
`tests/fixtures/jcx/*` 中 `style=staff` 的 fixture → 一份合成 stress 样例
（`K:Eb`、`M:3/4`、treble/bass/未知 clef 三声部、五种升降号、和弦、同小节与跨小节
tie、三连音、`Z` 休止、反复线、未知事件占位）。

**发现并修复的两项**：

| 发现 | 根因 | 修复 |
|---|---|---|
| staff SVG 不随 zoom 缩放 | VexFlow `SVGContext.resize()` 写 inline `width`/`height` 覆盖样式表 | resize 后写 `viewBox`、清 inline 尺寸，zoom 宽度放外层 section（`6f5bc6d`） |
| 同小节内 tie 视觉塌缩 | 端点解析正确，但实测符头间距仅 4.7px，弧跨不足以可辨 | `STAFF_METRICS.minNoteSlotWidth` 16 → 40（最宽 Bravura 符头 24 + 最小可辨弧跨 16），修复后 tie 跨度 36.7px（`6f5bc6d`） |

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
| 简谱随窗口宽度等比缩放 | SVG `width:100%` 拉伸 | `d34978b` 固定比例绘制、按容器宽度换行 |
| 歌词全部堆在文末、`*` 占位画成星号矩阵 | 歌词基线全局、skip 也画字形 | `1cba425` 歌词按 system 归属，skip 不可见 |
| tie/slur 画成顶部长横线、跨行关系反向拉回行首 | 弧高固定、不跨行切段 | `9f2f1cb` 弧高随跨度、跨行切段 |
| 歌词首行被低八度点/减时线压住 | `lyricFirstOffset` 小于最深装饰 | `59b1082` 抬高并加几何不变量测试 |
| 连到全音符/breve 的弧落在延音线中间 | 端点取槽位中心 | `60fb332` 端点取数字字形中心 |
| 3 处 `2/1`（breve）只占宽不画延音线 | 时值分解上限 k ≥ 0 | `de23124` 单点放行 `2/1` → 7 条延音线，简谱槽宽随之加宽 |

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
