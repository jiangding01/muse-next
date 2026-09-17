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
