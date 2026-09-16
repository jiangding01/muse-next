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
