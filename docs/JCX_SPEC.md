# JCX Format Specification

Version: v0.1 (draft)
Status: 证据固化阶段（M1.3），尚未被 Lexer / Parser 实现验证
Scope of authority: 本文件是 Muse Next 中 `.jcx` Lexer / Parser / Serializer 的**唯一格式依据**。实现与本文冲突时以本文为准；本文与证据冲突时按第 2.3 节的证据优先级修订本文。

---

## 1. Scope

### 1.1 范围

`.jcx` 是 Muse Pro 2.70 的文档格式：**纯文本、面向行**，语法派生自 ABC notation，含大量 Muse 私有扩展（简谱渲染、吉他六线谱、和弦图定义、排版指令、富文本装饰记号）。

覆盖：字节层（编码 / BOM / 行尾 / 末尾换行）、词法层（行分类 / 注释 / 空白 / 指令前缀）、文档层（magic header / 描述头 / 曲谱主体 / 文本块）、字段层（information field / inline field / voice 属性）、正文层（音符 / 休止 / 时值 / 小节线 / 装饰 / 歌词 / 和弦 / TAB）、序列化层（preserve 与 canonical）。

不覆盖：渲染几何（排版指令只登记语法与一句话语义）、MIDI 播放语义、`default.dec` 装饰符号库二进制格式（HANDOFF §50，延后至 M5/M6）、屏幕编辑器交互（原版文档中大量 UI 操作描述与文本格式无关，已排除）。

### 1.2 设计约束

本规格服务于 HANDOFF §53 的分层原则：

```
RAW SOURCE → LOSSLESS AST → NORMALIZED DOMAIN → APPLICATION
```

因此凡是本规格标注「必须保留」的信息，都必须能在 AST 上表达，且 `serializeJcx(doc, { mode: 'preserve' })` 必须能原样写回。**归一化（alias 合并、空格规整、默认值填充）只允许发生在 Domain Model 层，不允许发生在 AST 层。**

---

## 2. Status / Evidence Levels

### 2.1 等级定义

| 标签 | 含义 |
| --- | --- |
| `CONFIRMED` | 真实语料或 Muse Pro 2.70 原版文档直接证明。尽量附语料计数与文件数。 |
| `DOC-ONLY` | 全称 `CONFIRMED BY DOCUMENTATION; NOT OBSERVED IN CURRENT CORPUS`。原版文档记载，但 11 个语料文件中未出现。 |
| `CORPUS-ONLY` | 语料中实际出现，但原版文档完全未记载。 |
| `INFERRED` | 多源合理推断，语义未完全验证。每条必须写明推断依据。 |
| `UNVERIFIED` | 证据不足。**不得为了规格完整性自行补全语法。** |

计数写法示例：`CONFIRMED（corpus: 39 次 / 10 个文件；help 2.1.2）`。计数口径为「解码为 UTF-8 后的文本出现次数」；凡有多种统计口径的条目（如 §9.1 与 §9.3 的文件数）必须在该处注明用的是哪个口径。

### 2.2 语料规模

11 个 `.jcx` 文件。其中 2 个文件（一个自动存盘副本与其源文件）字节几乎完全相同，凡该对文件贡献的计数在本规格中标注为「含 1 对重复样本」，避免把同一证据算作两份独立证据。

### 2.3 证据优先级（裁决顺序）

```
真实语料 > 原版 help > 原版 faq > ABC 2.1 标准 > 静态逆向 > 现有 scaffold 代码
```

**硬性规则：`src/formats/jcx/parseJcx.ts`、`src/formats/jcx/parseGChord.ts` 不是格式事实来源**，本规格编写过程中未参考这两个文件，未来修订也不得引用它们作为依据。

### 2.4 已裁决的冲突

| # | 冲突 | 裁决 |
| --- | --- | --- |
| C1 | ABC 2.1 把 `%%gchord` 归为 abcm2ps/abc2midi 的**伴奏音型**指令 | **同名不同义**。Muse 的 `%%gchord` 是**吉他和弦图定义**（`名字=变调夹品位;第六弦到第一弦的品位列表`）。以 help 为准，见 §10.1。 |
| C2 | ABC 2.1 的 `I:` 是 instruction / stylesheet directive，可与 `%%` 互换 | **同名不同义**。Muse 的 `I:` 是「显示在乐谱左上方的备注文字」。以 help 为准，见 §8.8。 |
| C3 | ABC 2.1 规定 inline field 中 `[`、字段名、`:` 之间禁止空格，官方示例冒号后亦无空格 | Muse 语料与 help 均出现 `[V: 1]`。**Muse 允许冒号后空格**，见 §9.1。 |
| C4 | help 的 `V:` 属性总表无 `brace`/`brc`，faq 有 | 以 faq 为准登记为 `DOC-ONLY`，见 §12.4。 |
| C5 | ABC 2.1 中 `Z<n>` 是「n 小节的多小节休止」 | 语料中 `Z2` 出现在小节内部与其他音符并列，行为不符合多小节休止。Muse 的 `Z` 语义 `UNVERIFIED`，见 §15.2。 |
| C6 | 上游证据包称语料中简单装饰记号有 8 种（含 `!A!` `!B!` `!F!`） | **裁决为误判**。`!A!` 形态来自两个复合装饰记号相邻（`…!` + 音符字母 + `!…`）的正则误切。实际简单装饰记号为 5 种，见 §23.1。 |
| C7 | 上游证据包称语料中三连音出现 17 次，含 `(2` `(3` `(4` | **裁决为误判**。`(2` `(3` `(4` 三处来自 `%%gchord` 行内的指法括号 `3(3),2(2),…,3(4)`，不是正文 tuplet。实际正文 tuplet 见 §20。 |
| C8 | 上游证据包称 `D[...]` 是 TAB 拨弦方向标记（5 次） | **裁决为误判**。这 5 处出现在一个不含任何 TAB 声部的文件中，实为音符 `D` 紧邻和弦块 `[...]`。（`B[` 不在此列：实测 5 处全部落在 TAB 声部内。）见 §26.4。 |
| C9 | 上游证据包称语料中 `@` 出现 12 次（疑似 help 记载的隐藏休止符 `@`） | **裁决为误判**。语料中全部 `@` 都是复合装饰记号内的定位参数 `@x'N'` / `@y'N'`。隐藏休止符 `@` 在语料中**零出现**，见 §15.3。 |
| C10 | 上游证据包把 TAB 的 `x` 后缀语义列为待确认 | **已由 help 2.1.4 解决**：`x` = 右手拨弦，不指定具体品位，实际品位由和弦图决定。见 §26.3。 |

### 2.5 统计口径修正

C6/C7/C8/C9 四条修正意味着：**任何基于「宽松正则计数」的 body feature 统计都不可直接写进语法规则。** Lexer 必须先按 voice style 切换词法模式再计数（§13.2），否则会重复制造同类误判。

---

## 3. Compatibility Model

### 3.1 目标

> 打开 legacy `.jcx` → 编辑 → 保存 → 最大限度不破坏原文件信息。

### 3.2 三条兼容性铁律

1. **永不因为不认识而报错。** 未知字段、未知指令、未知 body token 一律降级为 raw 节点保留（§29），只产生非致命 diagnostic。此规则与 ABC 2.1 第 3 章「未定义字段必须被忽略」、7.1 节「必须优雅忽略不认识的 specifier」方向一致，但 Muse Next 更严格：不是忽略，而是**保留并回写**。
2. **永不静默归一化。** 所有 alias、空格变体、引号变体、拼写变体在 AST 上保持原样；归一化只发生在 Domain Model。
3. **永不假设默认存在。** magic header、`style=`、`X:`、`Q:` 在语料中都有缺席样本，任何「必有」假设都会与语料冲突。

### 3.3 Round-trip 分级（对齐 HANDOFF §38）

| 级别 | 定义 | 本规格的达标要求 |
| --- | --- | --- |
| L1 Parse | `source → parse` 不抛错 | 11/11 语料文件必须通过 |
| L2 Semantic | `source → parse → serialize → parse` 两次 AST 语义一致 | 必须通过 |
| L3 Preserve | 未编辑文档 `source → parse → serialize(preserve)` 输出同文本；若编码也 preserve 则同字节 | 目标为 11/11 字节一致；`§5` 列出的全部词法细节都是达成 L3 的必要条件 |

---

## 4. Encoding

### 4.1 观测事实

`CONFIRMED（corpus: 11/11 文件）`

| 事实 | 数据 |
| --- | --- |
| GB18030 编码文件 | 10 / 11 |
| UTF-8 编码文件 | 1 / 11（一个由 MIDI 导入产生的文件） |
| 带 BOM 的文件 | 0 / 11 |

### 4.2 文件内无编码声明

`CONFIRMED（help 全篇）`

help 没有任何「文件编码」字段或指令。其中出现的「字符集」参数（如字体设置里的 `134`）是 **Windows 字体 charset 号，用于字体渲染**，不得当作编码声明解析。ABC 2.1 的 `I:abc-charset` / `%%abc-charset` 在语料与 help 中均零出现。结论：**JCX 没有 in-band 编码声明，编码只能靠检测。**

### 4.3 检测策略（规范性）

按顺序执行：

1. **BOM 检测**。存在 UTF-8 BOM（`EF BB BF`）→ 判定 UTF-8，且 AST 记录 `hasBom: true`。UTF-16 BOM → 判定为不支持，报错退出（语料与文档均无 UTF-16 证据，不得猜测支持）。`INFERRED`（依据：语料 0/11 带 BOM，但格式未禁止；BOM 处理规则取自通用文本约定）。
2. **纯 ASCII** → 两种编码等价，标记 `encoding: 'ascii-compatible'`，写回时按原标记。
3. **严格 UTF-8 校验**。整文件通过 UTF-8 解码器且无替换字符 → 判定 UTF-8。
4. **否则判定 GB18030**。GB18030 是全覆盖编码，不会解码失败，因此必须放在最后作为兜底。
5. 解码失败无回退路径时，报 `JcxEncodingError` 并保留原始字节，允许上层以「二进制只读」方式打开。

> 注意顺序不可交换：GB18030 能吞下任意字节序列，若先试 GB18030 则 UTF-8 文件必被误判。

### 4.4 编码是逐文件属性

`CONFIRMED（corpus: 10 GB18030 + 1 UTF-8）`

AST 必须记录检测结果。preserve 模式必须按原编码写回（§27.2）。canonical 模式一律输出 UTF-8（§27.3）。

---

## 5. Lexical Conventions

本节全部条目都是 L3 preserve round-trip 的必要条件。

### 5.1 行尾（line ending）

`CONFIRMED（corpus: 11/11）`

- 6 个文件使用 CRLF，5 个文件使用 LF。
- **无一文件混用两种行尾。** 行尾风格是逐文件固定属性。
- 语料中不存在跨文件可推断的「标准」行尾。

规范要求：AST 记录 `lineEnding: 'crlf' | 'lf'`。preserve 模式复用该值。canonical 模式统一输出 LF（`INFERRED`，依据：跨平台工具链约定，无原版证据，属于 Muse Next 的自主选择而非格式事实）。

若未来出现混用行尾的文件，AST 必须能按行记录行尾（每个 line node 各带自己的 terminator），因此**建议一开始就按行存储行尾，而不是文件级单值**。

### 5.2 末尾换行

`CONFIRMED（corpus: 2/11 文件末尾无换行，含 1 对重复样本；末字节为 `]`）`

规范要求：AST 记录 `hasTrailingNewline: boolean`。preserve 模式必须精确保留；否则字节级不可逆。

### 5.3 行尾空白（trailing whitespace）

`CONFIRMED（corpus: 12 处 / 1 个文件）`

唯一出现行尾空白的是 MIDI 导入产物文件，且位置特殊：出现在 `V:` 头字段行尾（如 `V:1` 后跟一个空格、`V:2 ins=69` 后跟一个空格）。

规范要求：字段解析必须 **trim 后取值，但 AST 必须保留 raw 行原文**。preserve 模式写回 raw。

### 5.4 空行

`CONFIRMED（corpus: 20 处 / 3 个文件；其余 8 个文件零空行）`

**空行在 JCX 中没有结构语义。** 这是与 ABC 2.1 的关键差异：ABC 2.1（2.2.2 / 2.2.4）用空行分隔 tune、终结 file header；JCX 语料中的空行只是排版留白，且 JCX 文件恒为单 tune（§6.1）。

规范要求：空行作为 `BlankLineNode` 保留，不参与结构判定。

### 5.5 BOM

见 §4.3。AST 记录 `hasBom`，preserve 原样写回。语料中 0/11。

### 5.6 注释 `%`

`CONFIRMED（corpus: 20 行 / 1 个文件；help 2.1.3 末节）`

- **整行以 `%` 开头**（允许前导空白？语料中未出现前导空白后跟 `%` 的样本 → `UNVERIFIED`，实现应容忍并记录）即为注释行，内容原样保留。
- 语料中出现 3 条实义注释（MIDI 导入工具写入的来源说明）与 17 条**纯空注释**（整行仅一个 `%` 字符）。空注释必须保留，它们是导入工具的占位行。
- **行内 `%` 不是注释起点。** 关键反例：`K:G % 1 sharps`（`CONFIRMED`，corpus: 1 次 / 1 个文件）。该行的 `% 1 sharps` 是 `K:` 字段值的一部分。

规范要求：**字段值中的 `%` 一律按字面文本处理，不做注释切分。** 这与 ABC 2.1（2.2.5：`%` 之后到行尾全部是注释）直接冲突，**以语料为准**。

`INFERRED`：Muse 的注释判定是「行首字符 == `%` 且第二字符 != `%`」的整行判定，而非 ABC 的行内扫描。依据：上述反例 + 语料中不存在任何依赖行内注释语义的行。

### 5.7 指令前缀 `%%`

`CONFIRMED（corpus: 14 行 / 4 个文件；help 2.1.5.1）`

标准形态：`%%` 紧跟指令名，无空格（`%%showfinger yes`）。

**带空格变体** `%% continueall yes`：`CORPUS-ONLY`（corpus: 1 次 / 1 个文件）。`continueall` 本身是 help 页面参数表中的合法参数。

裁决：**Lexer 必须容忍 `%%` 后的空白**，匹配 `^%%[ \t]*([A-Za-z0-9_-]+)`；AST 保留该空白串，preserve 原样写回，canonical 收紧为无空格。

`UNVERIFIED`：原版是否真的接受该写法。若它在原版中实为失效行，本规格的容忍会造成渲染差异 —— 这是有意的兼容取舍，须发 diagnostic。

### 5.8 前导空白

语料中观测到**两类**前导空白场景：

| 场景 | 计数 | 形态 |
| --- | --- | --- |
| 文本块内容行 | `CONFIRMED`（3 行 / 2 个文件，含 1 对重复样本） | `%%begintext` / `%%endtext` 之间，首行 6 空格、续行约 18 空格，用于视觉对齐 |
| body 中的 `L:` 字段行 | `CONFIRMED`（5 行 / 5 个文件） | 行首 1 个空格，形如 `␣L: 1/4`，5/5 一致，非孤例 |

规范要求：

- **文本块内容行禁止 trim**（§11.3）。
- **字段行的前导空白必须保留在 raw 中**（值仍按 trim 后解析）。§13.3 的行分类因此必须允许字段行带前导空白，否则这 5 个文件的 body `L:` 会被误判为正文行。

### 5.9 断行反斜杠 `\`

`UNVERIFIED`（corpus: 0 次；help 未给出脚本级断行符）

ABC 2.1（2.2.6）定义行尾 `\` 抑制换行。语料零出现，help 只描述「换行位置由第一音轨决定，可被『强制换行』开关覆盖」这一 UI 级行为。

规范要求：**不定义 `\` 的语义**。若遇到行尾 `\`，按普通字符保留在 raw token 中并发 diagnostic。不得按 ABC 语义实现。

### 5.10 续行 `+:`

`UNVERIFIED`（corpus: 0 次；help/faq 0 次）

ABC 2.1 的 `+:` 续行机制在 JCX 中无任何证据。不实现。

### 5.11 preserve 模式必须保留的词法清单（规范性汇总）

1. 文件编码（§4.4）
2. BOM 有无（§5.5）
3. 每行的行尾符（§5.1）
4. 末尾换行有无（§5.2）
5. 每行的行尾空白（§5.3）
6. 空行及其位置（§5.4）
7. 注释行原文，包括空注释（§5.6）
8. `%%` 与指令名之间的空白（§5.7）
9. 文本块内容行的前导空白，以及字段行的前导空白（如 body `L:`）（§5.8）
10. 字段冒号后的空格有无（§8.1）
11. `[V:` 冒号后的空格有无（§9.1）
12. voice 属性的原始拼写、原始顺序、引号有无（§12.5）
13. 未知行的完整原文（§29）

---

## 6. Document Structure

### 6.1 顶层结构

`CONFIRMED（corpus: 11/11；help 2.1.1）`

```
JcxDocument
├─ MagicHeader?          %MUSE2（可选，§7）
├─ Preamble*             文件开头的注释行 / 空行
├─ TuneHeader            描述头：information fields（§8）
├─ DirectiveBlock*       %% 指令（§10），位置灵活
└─ TuneBody              曲谱主体：inline field / 正文行 / 歌词行 / 文本块
```

**JCX 文件恒为单 tune。** `CONFIRMED（corpus: 11/11 均为单曲）`。ABC 2.1 允许一个文件含多个 tune（以空行分隔），JCX 语料中无任何多 tune 样本，且 `X:` 只在 1 个文件中出现 1 次（§8.1），无从构成多 tune 编号体系。规范要求：**不实现多 tune 解析**；若未来出现第二个 `X:`，按未知重复字段处理（§8.12）并发 diagnostic。

### 6.2 header 与 body 的边界

`CONFIRMED（help 2.1.1 / 2.1.2；faq 常见错误条目；corpus 11/11）`

原版规则：描述头以 `T:` 开始、以 `K:` 结束；`K:` 必须是最后一个字段，`T:` 与 `K:` 必须存在（哪怕值为空）否则报错。与 ABC 2.1（3.1.14）一致。语料 11/11 均有 `T:` 与 `K:`，且 `K:` 恒在描述头末尾。

偏差：5/11 文件首行是 `%MUSE2` 或注释而非 `T:`；1 个文件在 `T:` 前还有 `X:`。

裁决：**不强制 header 起始字段。** header 区 = 从文件开头（跳过 magic header / 注释 / 空行）到第一个 `K:` 行（含）。`INFERRED`（依据：help 的 `K:` 终结规则 + ABC 同规则 + 11/11 语料；放宽起始条件是为兼容 5/11 实际首行）。

### 6.3 `%%` 指令的位置

`CONFIRMED（corpus: 14 行 / 4 个文件）`

观测到的位置：

- 在 `K:` 之后、`V:` 之前（和弦图定义、`%%showfinger`）。
- 在 `V:` 定义之后、`[V:n]` 之前（`%%indent`、`%% continueall`）。
- 在 body 中间（`%%begintext` / `%%endtext` / `%%skip` 紧跟在 `[V: 1]` 之后）。

规范要求：**`%%` 指令可出现在文档任意行位置**，AST 按出现顺序原地保留，不做重排。

### 6.4 body 中的 information field

`CONFIRMED（corpus: 5 处 / 5 个文件）`

`L:` 在 5 个文件中于 `[V:1]` 之后再次出现（形如 `L: 1/4`），用于覆盖该声部的默认单位音长。

规范要求：**`L:` 不是 header 专属字段**，body 中出现时按「从该点起生效」处理。ABC 2.1（3.1.7）同样允许 `L:` 出现在 body。

`UNVERIFIED`：`M:` / `K:` / `Q:` 是否也能出现在 body。help 2.1.3 描述了曲中变更（`[K:...]` 形式的内联控制），但语料中 inline field 只观测到 `V` 一种（§9.2）。不得据此实现 `[K:...]`。

### 6.5 AST 顶层建议形态

```ts
interface JcxDocument {
  encoding: 'gb18030' | 'utf-8' | 'ascii-compatible';
  hasBom: boolean;
  hasTrailingNewline: boolean;
  lines: JcxLineNode[];   // 逐行保留，顺序即原文顺序
}
```

**AST 的第一公民是「行」，不是「字段」。** 这直接来自 §5.11 的保留清单：任何按语义重组行顺序的 AST 都无法达成 L3。

---

## 7. Magic Header

### 7.1 语法

`CONFIRMED（corpus: 6 次 / 6 个文件；help 2.1.1）`

```
%MUSE2
```

必须是文件第一行，必须是半角英文字符（help 明确强调不能写成全角符号）。

### 7.2 它是可选的

`CONFIRMED（corpus: 6/11 有，5/11 无）`

5 个文件没有 magic header，其首行分别是 `T:` 字段行或 `%` 注释行（其中包括唯一的 UTF-8 文件）。

裁决：**规格不得把 `%MUSE2` 定义为强制头。** 缺省时的兜底规则：

```
无 magic header → 按当前支持的最新版本语法解析（即本规格描述的 2.70 语法）
```

`INFERRED`（依据：5/11 语料缺席且这些文件的其余语法与有 magic header 的文件完全同构；help 未描述缺席行为）。

### 7.3 与注释的关系

`%MUSE2` 以单个 `%` 开头，因此按 §5.6 的规则它同时是一个合法注释行。

规范要求：**只有文件第一行的 `%MUSE2` 被识别为 magic header**；出现在其他位置的 `%MUSE2` 按普通注释处理。`INFERRED`（依据：help 明确「版本信息是乐谱的第一行」；语料 6/6 均在第一行）。

### 7.4 其他版本号

`UNVERIFIED`。语料只见 `%MUSE2`。是否存在 `%MUSE1` / `%MUSE3` 无证据。help 2.1.4 末尾提到旧版吉他谱文件会被自动转换（1.0 → 2.x），暗示存在早期格式，但未给出其 magic header 写法。

规范要求：匹配 `^%MUSE(\w+)$` 并把版本串原样存入 AST；未知版本号不报错，按最新语法解析并发 diagnostic。

### 7.5 与 ABC 的差异

ABC 2.1（2.1）的文件标识是 `%abc` / `%abc-2.1`。JCX 的 `%MUSE2` 与之无关，且 JCX 语料中 `%abc` 零出现。不实现 ABC 文件标识。

---

## 8. Information Fields

### 8.0 通用语法

`CONFIRMED（corpus: 11/11）`

```
<字母><冒号><值>
```

- 字段名为**单个字母**，大小写敏感（`w:` 与 `W:` 在 ABC 中语义不同；JCX 语料只出现 `w:`）。
- 冒号后**空格可选**。语料统计：绝大多数字段带一个空格，但 `K:G % 1 sharps`（不带空格）、`Q:1/4=66`（不带空格）、25/27 条 `V:` 不带空格。
- **AST 必须记录冒号后的原始空白串**，preserve 原样写回。

`UNVERIFIED`：冒号是否允许全角 `：`。help 文本中出现过一处全角冒号写法，但高度疑似 Word 文档提取伪影（同一文档其余位置全为半角）。语料 0 次。规范要求：**只识别半角冒号**；遇到全角冒号行按未知行处理（§29）并发 diagnostic 提示可能的编码/输入法问题。

### 8.1 `X:` — 参考编号

- 等级：`CORPUS-ONLY`（corpus: 1 次 / 1 个文件；help 与 faq 全文零提及）
- 观测形态：`X: 1`
- 唯一出现它的文件是 MIDI 导入产物，推测由导入工具按 ABC 惯例写入。
- 语义按 ABC 2.1（3.1.1）为 tune 参考编号，正整数。
- 裁决：**解析并保留，但不赋予结构语义**（不用它切分 tune，见 §6.1）。`INFERRED`（依据：ABC 惯例 + 唯一样本是 ABC 工具链导入产物）。

### 8.2 `T:` — 标题

- 等级：`CONFIRMED`（corpus: 19 次 / 11 个文件；help 2.1.2）
- 语义：标题。**可多次出现**：第一条为主标题（大字号居中），其后为附标题（略小）。help 另注明可用作任意居中文字。
- 语料印证重复：7/11 文件有 2 条以上 `T:`，最多 3 条。第二条通常是演唱者或原作信息，**不是标题的续行**。
- 规范要求：见 §8.12 重复字段策略。**严禁把多条 `T:` 拼接成一个字符串。**

### 8.3 `C:` — 作者

- 等级：`CONFIRMED`（corpus: 27 次 / 10 个文件；help 2.1.2；faq 确认可写任意右上角文字）
- 语义：作者，可多条，从上到下居右显示。
- 语料印证重复：9/10 有 `C:` 的文件含 2～4 条，逐条分别对应作曲 / 作词 / 编配 / 录入等角色，但**格式本身不带角色标签**，角色只能由人从文本内容判断。
- 规范要求：**AST 按行序保留全部实例**；Domain Model 不得猜测角色映射（`UNVERIFIED`：是否存在固定顺序约定，语料显示顺序不固定）。

### 8.4 `M:` — 拍号

- 等级：`CONFIRMED`（corpus: 11 次 / 11 个文件；help 2.1.2）
- 语料取值：`2/4` `3/4` `4/4` `6/8`（全部为分数形式）。
- help 另记载简写：`M:C` = 4/4，`M:C|` = 2/2。等级 `DOC-ONLY`（语料 0 次）。
- ABC 2.1（3.1.6）另有 `M:none` 与复合拍号 `M:(2+3+2)/8`。JCX 无证据，**不实现**（`UNVERIFIED`）。

### 8.5 `L:` — 单位音长

- 等级：`CONFIRMED`（corpus: 16 次 / 11 个文件；help 2.1.2）
- 语料取值：`1/8`（多数）与 `1/4`。
- **可在 body 中重复出现**：见 §6.4。11 个文件各有 1 条 header 内 `L:`，另有 5 个文件在 `[V:1]` 之后再写一条。
- 缺省推断规则（help 2.1.2，与 ABC 2.1 3.1.7 完全一致）：按 `M:` 换算成小数，`< 0.75` → `1/16`，`>= 0.75` → `1/8`。等级 `CONFIRMED BY DOCUMENTATION`（语料中 `L:` 从未缺席，故规则未被语料验证）→ 标 `DOC-ONLY`。
- `UNVERIFIED`：body 中的 `L:` 作用域是「该声部到文件末尾」还是「到下一个 `[V:n]` 为止」。语料中每个文件只有一条 body `L:` 且紧跟第一个 `[V:1]`，无法区分这两种解释。实现时应记录该歧义并在 Domain Model 中选择「从该点起生效直到被下一条 `L:` 覆盖」，同时发 diagnostic。

### 8.6 `Q:` — 速度

- 等级：`CONFIRMED`（corpus: 1 次 / 1 个文件；help 2.1.2）
- 观测形态：`Q:1/4=66`（冒号后无空格）
- 语法：`<单位拍>=<每分钟拍数>`，与 ABC 2.1（3.1.8）的 2.1 标准形式一致。
- ABC 2.1 另支持引号文本（`Q:"Allegro" 1/4=120`）与多段音符长度，以及已弃用的 `Q:120` 形式。JCX 无证据，`UNVERIFIED`，不实现。
- 10/11 文件无 `Q:`：**速度字段可缺席**，Domain Model 需要一个默认速度，该默认值本规格不定义（`UNVERIFIED`：原版默认速度未见文档记载）。

### 8.7 `K:` — 调号

- 等级：`CONFIRMED`（corpus: 11 次 / 11 个文件；help 2.1.2）
- 语料取值：`F` `G` `C` `Eb` 以及 `G % 1 sharps`（含行内 `%` 字面文本，见 §5.6）。
- **结构作用：终结描述头**（§6.2）。
- help 记载的扩展形态（均为 `DOC-ONLY`，语料 0 次）：
  - 模式标记：`K:A Mix`，空格可省略。
  - 谱号：`K:A bass`，此处空格**不可**省略。
  - 谱号扩展名：`altou1` `altou2` `altod1` `altod2` `treble+8` `treble-8` `bass+8` `bass-8`。
- ABC 2.1（3.1.14）另有 `K:none`、显式升降号列表 `K:D Phr ^f`、`exp` 关键字、`K:HP` / `K:Hp`。JCX 无证据，`UNVERIFIED`，不实现。
- 规范要求：`K:` 的值在 v0.1 中**按 raw 字符串保留**，只在 Domain Model 层尝试解析 tonic + 可选模式；解析失败不报错。

### 8.8 `I:` — 备注（Muse 私有语义）

- 等级：`CONFIRMED`（corpus: 6 次 / 6 个文件；help 2.1.2；faq「怎样在乐谱左上方写文字」条目）
- **语义：显示在乐谱左上方的自由文本备注**，一般用于描述配器或演奏注意事项。
- **与 ABC 2.1 的语义完全不同。** ABC 2.1（3.1.17）的 `I:` 是 instruction / stylesheet directive，与 `%%` 可互换，且定义了 `abc-charset` / `abc-version` / `abc-include` / `abc-creator` 四个子指令。**JCX 的 `I:` 与这些毫无关系**，见 §2.4 C2。
- 规范要求：
  - **禁止把 `I:` 的值当作指令解析。**
  - **禁止实现 `I:directive` ↔ `%%directive` 的等价性。**
  - 值为纯自由文本，无子语法、无枚举。
- 作用域：help 的字段总表把 `I:` 标为「仅描述头」，不可出现在主体内联控制中。等级 `CONFIRMED BY DOCUMENTATION`（语料 6/6 均在描述头）。
- `UNVERIFIED`：多条 `I:` 是否叠加显示。语料中每个文件最多 1 条，help 未说明。按 §8.12 保留全部实例，Domain Model 暂按「全部保留、按序渲染」处理并发 diagnostic。

### 8.9 `V:` — 声部定义

见 §12 Voice Model（语法与属性表在该章完整给出）。

- 等级：`CONFIRMED`（corpus: 27 条头字段 / 11 个文件；help 2.1.2）

### 8.10 `w:` — 歌词

见 §24 Lyrics。

- 等级：`CONFIRMED`（corpus: 94 次 / 7 个文件；help 2.1.2）

### 8.11 文档记载但语料未出现的字段

| 字段 | 等级 | 语义 |
| --- | --- | --- |
| `S:` | `DOC-ONLY`（help 2.1.2 字段总表，无正文详述段落） | 来源 |

ABC 2.1 定义的 `A: B: D: F: G: H: m: N: O: P: R: r: s: U: W: Z:` 在 help、faq 与语料中**全部零出现**。

规范要求：**不得假定 Muse 实现了这些 ABC 字段。** 遇到它们时按未知字段处理（§29），保留并发 diagnostic。

### 8.12 重复字段策略（规范性）

`CONFIRMED（corpus: `T:` 19 次分布于 11 文件、`C:` 27 次分布于 10 文件、`L:` 16 次分布于 11 文件、`w:` 94 次分布于 7 文件）`

规则：

1. **AST 层：按出现顺序保留全部实例，每个实例是一个独立的 `JcxFieldNode`，携带自己的 `span`、`raw`、冒号后空白。禁止去重、禁止合并、禁止重排。**
2. **Domain Model 层**按字段类型区分：
   - **累加型**（`T:` `C:` `I:` `w:`）：保留为有序数组。`title: string[]`、`composers: string[]`。第一条的特殊地位（主标题）由渲染层决定，不在存储层剥离。
   - **覆盖型**（`L:` `M:` `K:` `Q:`）：后者覆盖前者，但覆盖发生在**文档位置序**上，即 body 中的 `L:` 只影响其后的内容（§8.5）。
   - **声部型**（`V:`）：按 id 归并，同 id 重复定义时后者的属性覆盖前者的同名属性（`INFERRED`，依据：ABC 2.1 第 3 章对 instruction 型字段的重复规则；语料中无同 id 重复样本）。
3. **序列化**：preserve 模式按 AST 顺序逐条写回。canonical 模式亦按原顺序写回（不做角色排序），仅规整空格。

### 8.13 body 中间出现字段的处理（规范性）

字段行出现在 `[V:n]` 之后时：

1. AST 仍记为 `JcxFieldNode`，但带 `region: 'body'` 标记。
2. `L:` 按 §8.5 处理。
3. `w:` 必然在 body 中（§24）。
4. 其他字段（`T:` `C:` `I:` `M:` `K:` `Q:` `X:`）出现在 body 中：**语料 0 次**。规范要求保留并发 diagnostic，Domain Model 忽略其影响（`UNVERIFIED`：原版行为未知；ABC 2.1 允许 `T:` 在 body 中标注段落小标题，但不得据此实现）。

---

## 9. Inline Fields

### 9.1 `[V:n]` — 声部切换

- 等级：`CONFIRMED`（corpus: 39 次 / 10 个文件；help 2.1.3 与 2.1.4）
- 语义：标志该行乐谱属于哪个声部。help 原文要求每行乐谱开头加上该标志。

两种空格写法并存（逐文件实测）：

| 写法 | 次数 | 文件数 |
| --- | ---: | ---: |
| `[V:1]`（冒号后无空格） | 13 | 7 |
| `[V: 1]`（冒号后一个空格） | 26 | 3（其中 1 个文件贡献 24 次） |

> 口径说明：**10 个文件**是「正文中出现过 `[V:...]`」的口径；§9.3 的多声部排布策略统计用的是「声部数 ≥2 且用 `[V:...]` 切分」的口径（7 个文件），两者差 3 个单声部文件。引用计数时务必说明用的是哪个口径。

help 原文中两种写法均出现。

**与 ABC 2.1 的冲突裁决**（§2.4 C3）：ABC 2.1（3.2）明文禁止 `[`、字段名、`:` 三者之间的空格，对冒号**之后**未置评，且全部官方示例无空格。**Muse 明确允许冒号后空格。** 规范要求：

- Lexer 接受 `\[V:[ \t]*([^\]]*)\]`。
- **AST 必须保留冒号后的原始空白串**（preserve 关键）。
- `[` 与 `V` 之间、`V` 与 `:` 之间的空格：语料 0 次，help 0 次 → `UNVERIFIED`，Lexer 可容忍但必须发 diagnostic。

### 9.2 位置约束

`CONFIRMED（corpus: 39/39 均独占一行）`

全部 39 处 `[V:...]` 都独占一行：行首即 `[`，行尾即 `]`，后面没有音符内容。

但 help 2.1.3 给出的示例是 `[V:1] ABCD|`（同行跟随正文）。

裁决：**Lexer 必须支持「`[V:n]` 后同行跟随正文」的形态**（依据 help），同时记录语料中 39/39 独占一行这一事实供 canonical 模式参考。等级：形态本身 `CONFIRMED BY DOCUMENTATION`，独占一行的实践 `CONFIRMED BY CORPUS`。

### 9.3 两种多声部排布策略

`CONFIRMED（corpus: 7 个具备多声部排布意义的文件）`

| 策略 | 描述 | 语料 |
| --- | --- | --- |
| 整段式 | 先写完整个 `[V:1]` 声部的全部小节，再写 `[V:2]` | 6 个文件（各 2 次 `[V:...]`） |
| 交替式 | 逐小节组轮流切换 `[V:1]` → `[V:2]` → `[V:3]` → 回到 `[V:1]`，循环 | 1 个文件（24 次切换 = 3 声部 × 8 组） |

另有 **3 个单声部文件**（含 1 对重复样本）各只出现 1 次 `[V:...]`，不构成排布策略，不计入本表；它们说明**单声部文件同样会写 `[V:n]`**，Parser 不得把 `[V:...]` 的存在当作「多声部」的判据。

规范要求：**两种策略都必须支持。** Parser 不得假设每个声部只出现一次；必须按「遇到 `[V:n]` 即把后续行归属到声部 n」的流式模型处理。

### 9.4 没有 inline field 的文件

`CORPUS-ONLY`（corpus: 1 个文件，9 个 `V:` 声部，0 个 `[V:...]`）

MIDI 导入产物文件声明了 9 个声部，但正文完全不用 `[V:...]` 切分。

`INFERRED` 推断规则：**描述头中 `V:` 的声明顺序 = body 中各正文段落的顺序**，即第 k 段连续正文行属于第 k 个声明的声部。

推断依据：(a) 该文件的正文段落数与 `V:` 条数一致；(b) 各段之间由 `V:` 行本身分隔（该文件的 `V:` 字段行散布在 body 中，每个 `V:` 行之后紧跟该声部的正文）；(c) 无其他可能的归属机制。

**风险提示**：只有 1 个样本，且它是工具生成而非人工书写。规范要求实现该规则时发 diagnostic，并在 Test Matrix 中单列 fixture（§30）。

### 9.5 其他 inline field

`UNVERIFIED`。语料中除 `V` 外**零出现**（无 `[K:...]` `[M:...]` `[L:...]` `[r:...]`）。help 2.1.3 提到曲中变更（`[K:]` 等），但未给完整语法示例。

规范要求：Lexer 遇到 `[<字母>:...]` 形态时，若字母不是 `V`，按**未知 inline field** 保留原文（§29），不解析其语义。**严禁按 ABC 2.1 补全 `[K:...]` / `[M:...]` 的行为。**

注意歧义：`[` 同时是和弦块（§14.4）与 TAB 拨弦组（§26.4）的起始符。消歧规则：`^\[[A-Za-z]:` 才是 inline field，否则是和弦/拨弦组。`INFERRED`（依据：ABC 2.1 同规则；语料中所有 `[X:` 形态均可由此规则正确分类）。

---

## 10. Muse Directives

语料中出现 6 种指令，共 14 行 / 4 个文件。help 2.1.5 记载的指令总数远大于此。

通用语法（`CONFIRMED`，help 2.1.5.1）：

```
%%<指令名> <值>
```

值的类型在 help 中分为 `<font>`、`<unit>`（长度，带 `cm`/`pt` 单位）、`<bool>`（`yes`/`no`、`1`/`0`、`true`/`false` 三套写法等价）。

### 10.1 `%%gchord` — 吉他和弦图定义

- 等级：`CONFIRMED`（corpus: 6 次 / 1 个文件；help 2.1.4「和弦图的自定义」）
- **与 ABC 生态的同名指令语义完全不同**，见 §2.4 C1。

语法（help 原文转述）：

```
%%gchord <和弦名>=<变调夹品位>;<第六弦>,<第五弦>,<第四弦>,<第三弦>,<第二弦>,<第一弦>
```

每个弦位可选带指法后缀 `(<手指号>)`。

自构示例（语法 token 级，不含作品内容）：

```
%%gchord Em=1;0,2,2,0,0,0
%%gchord G=1;3(3),2(2),0,0,0,3(4)
```

逐项语义：

| 元素 | 等级 | 语义 |
| --- | --- | --- |
| `=` 后数字 | `CONFIRMED`（help） | **变调夹（capo）放置的品位**，取值 1–20。不是和弦音数、不是优先级。语料 6/6 均为 `1`。 |
| 弦序 | `CONFIRMED`（help） | 分号后**从第六弦到第一弦**，逗号分隔，共 6 项 |
| `X` | `CONFIRMED`（help；corpus: 出现于 3 条） | 禁止弹该弦 |
| `0` | `CONFIRMED`（help；corpus: 大量） | 空弦 |
| `1`–`24` | `CONFIRMED`（help） | 品位数字 |
| `(1)`/`(2)`/`(3)`/`(4)` | `CONFIRMED`（help；corpus: 1 条使用） | 食指 / 中指 / 无名指 / 小指 |

未解决点：

- **横按**：`UNVERIFIED`。help 未给出横按记法。语料唯一带指法的条目（第六弦与第一弦同为品位 3 但指法不同）**不是**横按范例。不得自行发明 barre 语法。
- **非 6 弦乐器**：help 固定描述为「第六弦到第一弦」，未见任何弦数可变的说明。判定：**格式层面不支持非 6 弦**。语料无反例。
- 弦位项数不足 6 或多于 6 时的行为：`UNVERIFIED`。规范要求按未知指令值保留原文并发 diagnostic，不补齐、不截断。

### 10.2 `%%showfinger` — 和弦图指法显示

- 等级：`CONFIRMED`（corpus: 3 次 / 3 个文件；help 2.1.4）
- 语义：和弦图上显示手指编号还是黑点。
- 语料同时出现两种值写法：`%%showfinger 1`（1 次）与 `%%showfinger yes`（2 次）。
- help 记载布尔值三套写法等价：`yes`/`no`、`1`/`0`、`true`/`false`。
- 规范要求：Domain Model 归一化为 boolean；**AST 保留原始 token**（preserve 必须写回 `1` 而不是 `yes`）。

### 10.3 `%%begintext` — 文本块开始

- 等级：`CONFIRMED`（corpus: 2 次 / 2 个文件，含 1 对重复样本；help 2.1.5.5 与 faq 交叉印证）
- 见 §11。

### 10.4 `%%endtext` — 文本块结束

- 等级：`CONFIRMED`（corpus: 2 次 / 2 个文件，含 1 对重复样本；help 2.1.5.5）
- 见 §11。

### 10.5 `%%skip` — 垂直位移

- 等级：`CONFIRMED`（corpus: 2 次 / 2 个文件，含 1 对重复样本；help 2.1.5.4）
- 语料形态：`%%skip 1cm`
- 语义：控制下一行曲谱整体上移 / 下移；负值表示上移。
- 前置条件（`CONFIRMED BY DOCUMENTATION`）：必须先在页面参数中打开「强制换行」，否则不生效；且该功能限专业版。
- 值类型 `<unit>`：语料只见 `cm`。`pt` 等其他单位为 `DOC-ONLY`（help 的 `<unit>` 类型定义）。

### 10.6 `%%indent` — 首排缩进

- 等级：`CONFIRMED`（corpus: 1 次 / 1 个文件；help 2.1.5.3 参数总表，无独立示例段落）
- 语料形态：`%%indent 2.5cm`
- 语义：第一排缩进。
- 附注：`%%indent <length>` 也是 ABC 2.1（11.4.1）正式列出的页面格式指令，这是 JCX 与 ABC 生态少数真正同义的指令之一。

### 10.7 文档记载、语料未出现的指令清单

全部等级 `DOC-ONLY`。每项一句话语义，不展开子语法（§1.2）。

**和弦图 / 吉他类**

| 指令 | 语义 |
| --- | --- |
| `%%showstroke <bool>` | 扫弦 / 琶音符号是否显示在音符左边 |
| `%%showpattern <bool>` | 显示完整和弦图还是只显示和弦名 |
| `%%showcheck <bool>` | 和弦图是否显示空弦 / 禁弹记号 |
| `%%showname <bool>` | 和弦图是否显示和弦名 |
| `%%chordgridwidth <unit>` | 和弦图小格宽度 |
| `%%chordgridheight <unit>` | 和弦图小格高度（help 内部用词在「长度」与「高度」间漂移，指同一参数） |
| `%%gchordspace <unit>` | 和弦符号与谱表的间距 |
| `%%tabstemheight <unit>` | TAB 符干高度 |
| `%%tabstringsep <unit>` | TAB 弦线间距 |
| `%%tab_btextspace <unit>` | TAB 下方文字间距 |

**字体类（12 项，语法统一为 `%%<name>font <font>`）**

`composerfont` `titlefont` `subtitlefont` `vocalfont` `voicefont` `textfont` `jianpufont` `tabfont` `gchordfont` `barnumberfont` `barlabelfont` `tempofont` —— 分别控制作者 / 标题 / 副标题 / 歌词 / 声部名 / 注释文本 / 简谱 / TAB / 和弦名 / 小节号 / 小节标签 / 速度标记的字体。

**页面 / 排版类**

`pageheight` `pagewidth` `leftmargin` `topmargin` `botmargin` `staffwidth` `scale` `systemsep` `sysstaffsep` `strictness1` `barsperstaff` `barnumbers` `composerspace` `continueall` `titlespace` `titleleft` `subtitlespace` `vocalspace` `textspace` —— 页面尺寸、页边距、谱表宽度、缩放、系统间距、每行小节数、小节编号策略（`-1` 不显示 / `1` 从 1 起连续 / `2` 从 2 起隔 2 小节）、各部件垂直留白。

> 其中 `continueall` 是语料中唯一以「`%%` 带空格」变体出现的指令（§5.7）。

**V2.70 新增简谱排版参数（`jp*` 前缀，20 余项）**

`jpbeamspace` `jpbeamthickness` `jpbeamnotespace` `jpoctavedotspace` `jpoctavedotsize` `jprhythmdotsize` `jprhythmdotspace` `jprhythmdotxshift` `jprhythmdotyshift` `jpbarlength` `jpbaryshift` `jphighoctavenotespace` `jplowoctavenotespace` `jplowoctavebeamspace` `jpextendthickness` `jpgracescale` `jpgraceyshift` `jpaccscale` `jpkeysigxshift` `jpkeysigyshift` `jpkeysigwidth` `jpwedgeyshift` —— 简谱专用精细排版：减时线间距 / 粗细、八度点、附点、小节线长度与偏移、高低八度音符间距、延音线粗细、倚音缩放与偏移、临时记号缩放、调号偏移与宽度、渐强渐弱楔形偏移。

`staffwedgeyshift` `staffwedgespread` `showkeymeter` `showpagenumber` —— 五线谱楔形偏移 / 张开度、是否显示调号拍号、是否显示页码。

> **文档伪影警告**：help 中 `jpgraceyshift` 与 `jpwedgeyshift` 各出现两次且两次语义不同（一次水平、一次垂直；一次偏移、一次宽度），高度疑似原文档笔误（第一处可能应为 `jpgracexshift`，第二处可能应为 `jpwedgewidth`）。规范要求：**这两个名称按 `UNVERIFIED` 对待**，不要为它们写语义化解析，只按未知指令保留。

**渐强 / 渐弱脚本语法**

- 等级：`DOC-ONLY`（仅 faq 记载；help 正文未给出脚本符号）
- `(>` 渐强开始、`>)` 渐强结束、`(<` 渐弱开始、`<)` 渐弱结束。
- **这是 help / faq 信息不对称的典型案例**：只读 help 会完全遗漏该语法。
- **实现警告**：这些 token 与 §14 的 broken rhythm `>` `<` 和 §22 的 slur `(` `)` 在词法上高度冲突。v0.1 **不实现**该语法（`UNVERIFIED`：无语料样本可验证消歧规则）。

**富文本内联标记**

- 等级：`DOC-ONLY`（仅 faq 记载，标注为 2.5 版本后新增；help 完全未提及）
- `$f'...'` 字体、`$s'...'` 字号、`$i` 斜体、`$b` 粗体。
- **注意**：`$f` / `$s` 在语料中确实出现，但都出现在 `!...!` 复合装饰记号内部（§23.2），而非作为独立的正文富文本标记。二者是否同一机制 `UNVERIFIED`。

**其他 DOC-ONLY 能力**

- 描述文字 `^` / `_` 前缀双引号文字块 + `\n` 多行（help 2.1.4）。
- 反复标记的引号文字替代（`"1、3、5"|0` 形式，help 2.1.3）。
- 旧版吉他谱文件（Muse 1.0 → 2.x）自动转换（help 2.1.4 末节）。
- 装饰记号扩展的两条途径（扩展字体 / 绘画脚本，faq；对应 `default.dec`，本规格不涉及）。

### 10.8 未知指令处理

见 §29.2。

---

## 11. Text Blocks

### 11.1 语法

- 等级：`CONFIRMED`（corpus: 1 个块 × 2 个文件，含 1 对重复样本；help 2.1.5.5 与 faq 交叉印证）

```
%%begintext
<任意文本行>*
%%endtext
```

### 11.2 语义

- 插入评述性文字块，原样多行显示在曲谱中，字体走「注释字体」（`%%textfont`）设置。
- 限专业版功能（help 明确标注两次）。
- 前置条件：与 `%%skip` 同样需要先打开「强制换行」。
- 典型场景：需要大段文字说明的曲谱。

### 11.3 内容行的词法规则（规范性）

`CONFIRMED（corpus: 3 行，首行 6 空格、续行约 18 空格）`

1. **内容行禁止 trim。** 前导空白是作者用于视觉对齐的有效信息。
2. **内容行不参与任何其他行分类。** 即便某内容行以 `%` 或 `T:` 开头，在 `%%begintext`…`%%endtext` 之间也一律是文本内容。
3. **内容行不按 `%%` 前缀要求书写。** ABC 2.1（11.4.5）要求 typeset text 块内每行以 `%%` 开头；**Muse 不要求**，语料 3/3 内容行均无 `%%` 前缀。以语料为准。
4. 未闭合的 `%%begintext`（无 `%%endtext`）：`UNVERIFIED`（语料 0 次）。规范要求按「延伸到文件末尾」处理并发 diagnostic，不报错。
5. 空块（两指令相邻）：`UNVERIFIED`，按零行内容处理。

### 11.4 AST 形态

```ts
interface JcxTextBlockNode {
  type: 'textBlock';
  beginRaw: string;       // '%%begintext' 原文，含其后空白
  lines: JcxRawLineNode[];// 内容行，原样，含前导空白与行尾
  endRaw: string | null;  // null 表示未闭合
  span: SourceSpan;
}
```

---

## 12. Voice Model

### 12.1 `V:` 语法

`CONFIRMED（corpus: 27 条 / 11 个文件；help 2.1.2）`

```
V:<voice-id> [<属性> ...]
```

- `<voice-id>`：help 规定可取任意名字但**不能含空格**。语料中 27/27 为纯数字 1–9。非数字 id 为 `DOC-ONLY`。
- 冒号后空格：25 条不带、2 条带（`V: 1`）。**必须先 trim 再取 id。**
- 属性以空格分隔，形态为 `key=value`。
- **属性顺序不固定**（`CONFIRMED`）：语料中观测到 `name style clef ins vol bracket`、`style clef ins vol bracket`、`style name play instrument volumn` 等多种顺序。**Parser 必须按 key 解析，不得按位置解析。**
- 声部数上限：help 记载最多 20 个音轨（`DOC-ONLY`；语料最多 9 个）。

自构示例：

```
V:1 name=Guitar style=tab clef=standardtab ins=24 vol=40 bracket=2
V:2 name="Lead Line" style=jianpu play=1 instrument=0 volumn=64
V:3
```

### 12.2 完整属性表

| 属性 | 简写 | 等级 | 取值 / 范围 | 语义 | 语料计数 |
| --- | --- | --- | --- | --- | ---: |
| `name` | `nm` | `CONFIRMED`（help；corpus） | 字符串，可带双引号 | 声部名，显示在该声部首行左侧 | 13 次 / 6 文件（全称形式；`nm=` 简写语料 0 次，为 `DOC-ONLY`） |
| `sname` | `snm` | `DOC-ONLY` | 字符串 | 声部副名，显示在除首行外的各行左侧 | 0 |
| `instrument` | `ins` | `CONFIRMED`（help；corpus） | 整数（MIDI 音色号） | 播放乐器 | `ins=` 18 次 / 6 文件；`instrument=` 4 次 / 2 文件 |
| `volumn` | `vol` | `CONFIRMED`（help；corpus） | 整数 | 音量。**原版拼写即为 `volumn`（非 `volume`）** | `vol=` 10 次 / 5 文件；`volumn=` 5 次 / 2 文件 |
| `bracket` | `brk` | `CONFIRMED`（help；corpus） | 整数 N | 从当前声部起 N 行谱用方括号连接；**不改变声部名显示方式** | `bracket=` 7 次 / 7 文件；`brk=` 0 次（`DOC-ONLY`） |
| `brace` | `brc` | `DOC-ONLY`（**仅 faq**，help 的属性总表遗漏） | 整数 N | 从当前声部起 N 行用花括号连接，**并把当前声部名标在花括号中间** | 0 |
| `staves` | `stv` | `DOC-ONLY` | 整数 N | 从当前声部起 N 行用竖线连接，声部名标在竖线中间 | 0 |
| `space` | `spc` | `DOC-ONLY` | 数值 + 可选单位，数字前可加 `+`/`-` 表示相对增减 | 该行与下一行的间距，默认单位 pt | 0 |
| `gchords` | `gch` | `DOC-ONLY` | `<bool>` | 是否显示该声部的吉他和弦 | 0 |
| `style` | — | `CONFIRMED`（help；corpus） | `staff` \| `jianpu` \| `tab` | 声部记谱类型，见 §12.6 | 18 次 / 10 文件 |
| `clef` | — | `CONFIRMED`（help；corpus） | `standardtab`（help：目前唯一取值，缺省即此值） | TAB 声部谱号 | 5 次 / 5 文件，值恒为 `standardtab` |
| `play` | — | `CORPUS-ONLY` | 语料恒为 `1` | **语义未文档化。** 推测为「是否参与播放」 | 5 次 / 2 文件 |

关于 `play=`：`UNVERIFIED`。help 与 faq 全文零提及。规范要求保留该属性、不赋予行为，Domain Model 中以 `unknownAttributes` 承载。

### 12.3 别名归一化表（Domain 层，规范性）

```
name       ← name  | nm
sname      ← sname | snm
instrument ← instrument | ins
volume     ← volumn | vol            ※ 注意 Domain 用正确拼写 volume
bracket    ← bracket | brk
brace      ← brace  | brc
staves     ← staves | stv
space      ← space  | spc
gchords    ← gchords | gch
style      ← style
clef       ← clef
```

**硬性规则：归一化只发生在 Domain Model。** AST 上必须保留原始拼写。preserve 序列化写 `volumn=46` 的文件绝不能被写回成 `vol=46` 或 `volume=46`。

`UNVERIFIED`：是否存在第三套别名（例如正确拼写的 `volume=`）。语料只有 2 个文件使用「新写法」，样本不足以穷尽历史别名。规范要求：**未识别的 `key=value` 一律保留为 unknown attribute，不猜测其为某个已知属性的别名。**

### 12.4 值的引号

`CONFIRMED（corpus: 两种写法并存）`

- 不带引号：`name=伴奏`（5 个文件）
- 带双引号：`name="伴奏"`（1 个文件，该文件是同时使用 `instrument=`/`volumn=` 全称写法的两个文件之一）

ABC 2.1（7.1）的官方示例全部带引号（`name="Tenore I"`），未展示无引号写法。

`INFERRED`：带引号是「新写法」，无引号是「旧写法」，二者语义相同。依据：引号写法与全称属性名写法在同一批文件中共现，呈版本聚类；两种写法的值内容形态一致。

`UNVERIFIED`：值本身含空格时的行为（引号是否成为必需）。语料中所有声部名都不含空格。规范要求：解析时若值以 `"` 开头，取到下一个 `"` 为止；否则取到下一个空白为止。AST 记录 `quoted: boolean`。

### 12.5 AST 形态（规范性）

```ts
interface JcxVoiceAttrNode {
  rawKey: string;      // 原始拼写：'vol' | 'volumn' | 'ins' | ...
  rawValue: string;    // 原始值，不含引号
  quoted: boolean;     // 值是否带双引号
  span: SourceSpan;
}

interface JcxVoiceFieldNode {
  type: 'voice';
  rawId: string;           // trim 前的 id 原文
  colonSpacing: string;    // 冒号后的原始空白
  attrs: JcxVoiceAttrNode[]; // 原始顺序
  raw: string;
  span: SourceSpan;
}
```

必须保留：原始拼写、原始顺序、引号有无、属性间原始空白（或至少可重建）。

### 12.6 Style

`CONFIRMED（help 2.1.2 / 2.1.3：可取 staff、jianpu、tab 三值；corpus: jianpu 9 次、tab 8 次、staff 1 次）`

#### 12.6.1 `style` 是可选的

`CONFIRMED（corpus: 1 个文件的全部 9 个声部均无 style=，另有部分声部只写 V:n）`

**不得把 style 定义为必需字段。** TypeScript 上必须是 `style?: JcxVoiceStyle`，不得写成 `style: 'staff' | 'jianpu' | 'tab'` 并强制存在。

缺省值：`UNVERIFIED`。help 未说明省略 `style=` 时的默认声部类型。规范要求：Domain Model 中 `style` 保持 `undefined`，由渲染层决定回退（建议回退到 `staff`，但这是 Muse Next 的产品决定，不是格式事实，必须在代码注释中标注）。

#### 12.6.2 `staff` — 五线谱

正文使用标准 ABC 字母记谱（§13.2 模式 A）。

#### 12.6.3 `jianpu` — 简谱

**关键事实**（`CONFIRMED`，corpus: 9 个 jianpu 声部全部如此）：

> `style=jianpu` 声部的正文**仍然是 ABC 字母记谱**（A–G / a–g + 八度撇号逗号 + 时值后缀）。语料中**未观察到任何用数字 1–7 记谱的正文**。

即：**`jianpu` 只是渲染指示，不改变存储记谱法。** 正文 grammar 与 `staff` 声部完全相同（§13.2 模式 A）。

音名映射（`CONFIRMED BY DOCUMENTATION`，faq 中「简谱与五线谱音名对应」条目）：简谱模式下音名固定按 C 大调对应数字，`C` 对应 do（1），不随调式变化；五线谱模式下音名是绝对音高，随谱号而变。这是**渲染层**差异，不是词法差异。（faq 原文的强断言程度未逐字引用，此处为转述。）

help 提到的「简谱快速输入」（小键盘 0/1–7、`+`/`-` 调音长、`*`/`/` 调音高）属于**屏幕编辑器交互**，与 `.jcx` 文本语法无关，不得写入 Lexer。

#### 12.6.4 `tab` — 吉他六线谱

正文使用**完全不同的记谱体系**，见 §26 与 §13.2 模式 B。

#### 12.6.5 未知 style

`INFERRED`（依据：HANDOFF 第 16.3 节的设计要求；help 与 ABC 2.1 的宽容方向）。规范要求：**未知 style 值不得报错。** 保留原值，Domain 标记为 unknown，渲染回退到默认。help 与 ABC 2.1（4.6，未知谱号名应被忽略）都支持这一宽容方向。

---

## 13. Musical Body Grammar

### 13.1 写法策略（本章的元规则）

本规格对正文构造采取两级处理，严格执行任务约束：

| 级别 | 条件 | 本规格给出什么 |
| --- | --- | --- |
| **G-级（Grammar）** | help 明确描述**且**语料印证 | 形式化 grammar（EBNF 或等价的形式化文字） |
| **F-级（Feature）** | 仅 Scanner / 语料观测到，help 未描述 | 只列「特征 + 示例 + 待 Lexer 验证」，**不给完整 grammar** |

每个构造在 §14–§26 中标注其级别。

### 13.2 两种 body 词法模式（规范性）

`INFERRED`

JCX 的正文不是单一语言，而是两种记法：

| 模式 | 适用 voice style | 特征 |
| --- | --- | --- |
| **模式 A（pitch mode）** | `staff`、`jianpu`、无 style | 字母 = 音高，`,`/`'` = 八度，数字/`/` = 时值 |
| **模式 B（tab mode）** | `tab` | 小写字母 = **弦号**，紧跟数字 = **品位**，`*`/`/` = 时值分隔符 |

**因此 Lexer 必须按当前生效的 voice style 切换词法模式。**

推断依据：

1. help 2.1.4 明确规定 TAB 中 `a`–`f` 表示第 1–6 弦，且「因为数字已被品位占用，必须用 `*` 或 `/` 分隔品位与音长」—— 这与模式 A 中数字直接表示时值倍数**直接冲突**，同一串字符在两种模式下含义不同。
2. 语料反证：同一串 `c0` 在 TAB 声部是「第 4 弦空弦」，在 staff 声部是「音符 c 的 0 倍时值」（后者无意义）。
3. §2.4 的 C8/C9 误判正是「不按模式切换就统计」造成的：一个不含任何 TAB 声部的文件里的 `D[` 被误当成 TAB 拨弦前缀（而同形态的 `B[` 在 TAB 声部中确实是拨弦前缀，见 §26.4）；`!...!` 内部的 `@x`/`@y` 被误当成隐藏休止符 `@`（§15.3）。

**这一设计含义（Lexer 必须按 voice style 切换模式）标注为 `INFERRED`**：它是从上述语法冲突推导出的实现要求，原版 Muse 内部是否真的如此实现无法验证。

模式切换的触发点：

- 遇到 `[V:n]` → 查 `V:n` 的 `style` → 切换模式。
- 无 `[V:n]` 的文件（§9.4）→ 按段落顺序对应声部 → 切换模式。
- `style` 缺省 → 模式 A。

### 13.3 行级分类（规范性）

正文区每一行按以下优先级分类（**顺序不可交换**）：

```
1. 处于 %%begintext…%%endtext 之间          → TextBlockContentLine（§11.3）
2. 整行为空或纯空白                          → BlankLine（§5.4）
3. 行首为 '%%'（允许其后空白）               → DirectiveLine（§5.7, §10）
4. 行首为 '%'                                → CommentLine（§5.6）
5. 匹配 ^[A-Za-z]:                           → FieldLine（§8）
6. 行首匹配 ^\[[A-Za-z]:                     → InlineFieldLine（§9）
7. 其余                                      → MusicLine（本章）
```

注意第 5 条与第 7 条的冲突风险：ABC 2.1（第 3 章）禁止在 body 中使用 `A-G/X-Z/a-g/x-z` 作为字段名，正是为了避免音符与字段混淆。JCX 语料中未出现「以音符字母加冒号开头」的正文行，故该规则在语料范围内安全，但 `UNVERIFIED`：一个以 `C:` 开头的 TAB 正文行（`C` 不是合法弦号，但理论上可写）会被误判为 `C:` 字段。规范要求：在 body 区内，只有 §8 登记过的字段名（`L` `w` `V` 等）才触发 FieldLine 分类；其余字母加冒号发 diagnostic 并按 MusicLine 处理。

### 13.4 Beam 与空格

`CONFIRMED BY DOCUMENTATION`（help 2.1.3：「输入时不留空格」自动连梁；ABC 2.1 4.7 同规则）

相邻无空格的音符自动组梁，有空格则断梁。语料中大量使用空格分组（如 `(c/d/e/g/ )` 中结尾空格）。

规范要求：**空格在正文中是有语义的**（影响符梁），AST 必须保留正文内的空白 token，不得 collapse。

ABC 2.1 的反引号 `` ` ``（梁内可读性分隔符）在 JCX 中零出现，不实现。

---

## 14. Note

级别：**G-级**（help 2.1.3 音高小节 + 语料大量印证）

### 14.1 音高字母

`CONFIRMED（corpus: 全部 pitch-mode 声部；help 2.1.3）`

```
pitch-letter = "A".."G" | "a".."g"
```

大写为较低八度区，小写为其上一个八度（与 ABC 2.1 4.1 一致）。

### 14.2 八度修饰

`CONFIRMED（corpus: 大量；含三连逗号 `F,,,` 与双撇号 `c''`；help 2.1.3 记载可叠加 2–3 个）`

```
octave-mark = { "," | "'" }
```

`,` 降八度，`'` 升八度，可叠加。

`UNVERIFIED`：混合叠加（如 `C,'`）的行为。ABC 2.1 规定顺序无关且可抵消，help 未说明，语料 0 次。不实现抵消逻辑，保留原文。

### 14.3 完整音符 grammar

```ebnf
note        = [ decoration* ] [ accidental ] pitch-letter octave-mark* [ duration ]
accidental  = "^" | "^^" | "_" | "__" | "="        (* §17 *)
duration    = §16
```

### 14.4 和弦块 `[...]`

级别：**G-级**（help 2.1.3「同时按」+ 2.1.4「同弦记法」；corpus 大量）

```ebnf
note-chord = "[" note { note } "]"
```

- 括号内多个音符同符干同时发声。
- 语料形态举例（自构）：`[CEG]`、`[C/2-C/2]`。
- ABC 2.1（4.17）规定和弦内部不能有空格、升降号必须附着在单个音符上、可混入休止 `z`。JCX 未见反例，按同规则实现，标 `INFERRED`（依据：ABC 同源 + 语料无反例）。
- **时值取值规则的重要差异**（`CONFIRMED BY DOCUMENTATION`，help 2.1.4）：pitch 模式下同弹音符的时值取**第一个音**；TAB 模式下取**最后一个音**。这是两种模式的又一处语义分叉（§13.2）。

### 14.5 消歧

`[` 有三种含义：inline field（§9.1）、和弦块（本节）、TAB 拨弦组（§26.4）。消歧规则见 §9.5 与 §26.4。

---

## 15. Rest

### 15.1 `z` — 可见休止

- 级别：**G-级**（help 2.1.3；corpus 110+ 次）
- `CONFIRMED`

```ebnf
rest = "z" [ duration ]
```

语料形态：`z8`、`z4`、`z/2`、`z2`。

### 15.2 `Z` — 第二种休止

- 级别：**F-级**
- `CONFIRMED`（corpus: 20 次 / 3 个文件，含 1 对重复样本；help 2.1.3 把 `z`/`Z` 并列为休止符且「可加时长」，但**未说明二者差异**）

**与 ABC 2.1 的冲突**（§2.4 C5）：ABC 2.1（4.5）规定 `Z<n>` 是「n 个小节的多小节休止」。但语料中 `Z` 出现在小节内部、与普通音符并列（自构等价形态：`G2 Z2|`、`E2 ZD/E/|`），行为不符合多小节休止。

裁决：**`Z` 的精确语义 `UNVERIFIED`。**

规范要求：
- Lexer 识别 `Z [duration]` 为一个 rest token，`kind: 'Z'`。
- **禁止按 ABC 的多小节休止语义实现。**
- Domain Model 保留 `Z` 与 `z` 的区分，不合并。
- 发 diagnostic 提示语义待定。

升级所需证据：一个只含 `Z` 且能对照原版渲染结果的样本，或 help 中遗漏的 `Z` 说明段落。

### 15.3 `@` — 隐藏休止符

- 级别：**F-级**
- `DOC-ONLY`（help 2.1.3 与 faq；corpus: **0 次**）

**重要修正**（§2.4 C9）：语料中的全部 `@` 字符都是复合装饰记号内的定位参数 `@x'N'` / `@y'N'`（§23.2），**不是**隐藏休止符。任何把语料中的 `@` 计为隐藏休止符的统计都是误判。

文档语义：不显示但占时长；若整行被 `@` 占满，则该声部该行不显示（用于节省谱面空间）。

规范要求：Lexer 在 pitch 模式下识别 `@ [duration]` 为 hidden rest，但因零语料样本，标 `DOC-ONLY` 并在解析到时发 info 级 diagnostic。**必须先排除 `!...!` 内部的 `@`**，即装饰记号整体先于正文 token 切分。

### 15.4 ABC 的 `x` 不可见休止

`UNVERIFIED` / 不实现。ABC 2.1（4.5）用 `x` 表示不可见休止；但 JCX 中 `x` 在 TAB 模式下是「右手拨弦」（§26.3），语义冲突。help 用 `@` 而非 `x` 表示隐藏休止。**不得实现 ABC 的 `x` 休止。**

---

## 16. Duration

级别：**G-级**（help 2.1.3 音长小节；corpus 大量）

### 16.1 pitch 模式的时值

`CONFIRMED`

```ebnf
duration = integer                     (* N 倍单位音长 *)
         | integer "/"                 (* N/2；整数后接裸斜杠 *)
         | "/" [ integer ]             (* 1/N；'/' 简写为 '/2' *)
         | integer "/" integer         (* 分数倍数，如 3/2 *)
         | "//"                        (* 简写为 1/4 *)
```

help 与 ABC 2.1（4.3）在此完全一致：`A2` = 2 倍，`A/2` = 1/2，`A/` 简写 `A/2`，`A//` 简写 `A/4`，`A3/2` = 1.5 倍，`A3/` = `A3/2`。

`CONFIRMED`（依据：ABC 2.1 §4.3 明确 `A3/` = `A3/2`；语料 pitch 声部（非 `style=tab`）1 次 / 1 文件：`corpus#05.jcx` 的 `D3/`）。此前 lexer 的 `DURATION_RE` 缺这一分支，导致 `D3/` 被误切成 `duration:"3"` + `duration:"/"` 两个游离叶子；已在 M1.5 T4 AST 预演中发现并修复。

**统计口径说明**：全语料对正则 `\d+/(?![\d/])` 的原始命中有 280 次、6 个文件，但绝大多数集中在 `corpus#02.jcx` / `corpus#04.jcx` 等文件的 `style=tab` 声部（如 `e0/d1/c2/...`），那是 `stringLetter + fret + tabDurSep` 的 TAB 记谱，与本节的 pitch 时值无关，不计入。剔除 TAB 声部后，仅 pitch 声部的真实命中为 1 次（上述 `corpus#05.jcx` 一例）。

语料印证：`A,3/2`、`c/2`、`d/`、`G8`、`z/2`、`fx/`、`ax//`（TAB 中的 `//`）、`D3/`（pitch 声部裸斜杠）。

基准为 `L:` 声明的单位音长（§8.5）。

### 16.2 附点与 broken rhythm

`CONFIRMED`（help 2.1.3；corpus: `>` 18 次）

```ebnf
broken-rhythm = ">" | ">>" | ">>>" | "<" | "<<" | "<<<"
```

- `a>b`：前音附点、后音减半。`a<b` 相反。
- `>>` 双附点 / 减到 1/4；`<<<` 三附点 / 减到 1/8（help 与 ABC 2.1 4.4 一致）。
- help 明确 `a>b` 与 `a3b` 等价。

**语料事实**：`>` 出现 18 次；**`<` 零出现**。`<` 形态标 `DOC-ONLY`。

**实现警告**：`>` `<` 与 §10.7 记载的渐强 / 渐弱 `(>` `>)` `(<` `<)` 词法冲突。v0.1 不实现后者（§10.7），因此 `>` / `<` 一律按 broken rhythm 解析。若未来实现渐强渐弱，必须先解决该消歧（升级条件见附录 A）。

### 16.3 TAB 模式的时值

见 §26.5。TAB 模式**必须**用 `*` 或 `/` 分隔品位与时值，规则不同。

---

## 17. Accidental

级别：**G-级**（help 2.1.3；corpus 大量）

```ebnf
accidental = "^" | "^^" | "_" | "__" | "="
```

| 记号 | 语义 | 等级 | 语料 |
| --- | --- | --- | ---: |
| `^` | 升 | `CONFIRMED` | 166 次 |
| `^^` | 重升 | `DOC-ONLY`（ABC 2.1 4.2；help 未单列） | 0 |
| `_` | 降 | `DOC-ONLY` | **0 次** |
| `__` | 重降 | `DOC-ONLY` | 0 |
| `=` | 还原 | `CONFIRMED` | 大量，集中于 1 个文件 |

**降号 `_` 在 11 个语料文件中零出现**，是一个值得注意的空白：它意味着降号路径从未被真实数据验证过。规范要求实现 `_` 但在 Test Matrix 中单列 fixture（§30）。

消歧注意：`=` 同时出现在 `V:` 属性（`key=value`）与 `%%gchord` 定义中。这些行在 §13.3 的行分类阶段已被拦截为 FieldLine / DirectiveLine，不会进入正文 token 流。**这是行分类优先级不可交换的又一理由。**

---

## 18. Barline

级别：**G-级**（help 2.1.3 小节线小节；corpus 423 处含 `|` 的正文行）

help 记载的完整小节线表：

| 记号 | 语义 | 等级 | 语料 |
| --- | --- | --- | ---: |
| `\|` | 普通小节线 | `CONFIRMED` | 大量 |
| `\|]` | 细 + 粗，终止线 | `CONFIRMED` | 9 次 |
| `\|\|` | 细 + 细双线 | `DOC-ONLY` | 0 |
| `[\|` | 粗 + 细，起始线 | `DOC-ONLY` | 0 |
| `:\|` | 右反复 | `CONFIRMED` | 6 次 |
| `\|:` | 左反复 | `CONFIRMED` | 6 次 |
| `::` | 双反复（等价 `:\|` 紧接 `\|:`） | `DOC-ONLY` | 0 |
| `[:]` | 虚小节线 | `DOC-ONLY` | 0 |
| `[\|]` | 不可见小节线（仅影响分行） | `DOC-ONLY` | 0 |

ABC 2.1（4.8）另有 `.` 前缀虚线小节线（`.|`）、`|::`、`::|`。JCX 无证据，`UNVERIFIED`，不实现。

**Lexer 要求**：小节线必须**最长匹配优先**（`|]` 先于 `|`，`|:` 先于 `|`），否则 `|]` 会被切成 `|` + `]`，而 `]` 又会与和弦块闭括号混淆。

ABC 2.1 要求解析器对小节线形状宽容（`|`、`[`、`]`、`:` 的任意组合都应识别）。JCX 采纳这一宽容原则：未在上表中的组合按 unknown barline token 保留（§29.3）。`INFERRED`（依据：ABC 同源规则 + §3.2 铁律 1）。

---

## 19. Repeat

级别：**F-级**（help 有描述，但语料对关键构造零印证）

### 19.1 反复小节线

见 §18：`|:` 与 `:|` 均 `CONFIRMED`（各 6 次）。

### 19.2 跳房子（反复房子）

- `DOC-ONLY` + `UNVERIFIED` 混合
- **语料中 `[1` / `[2` 零出现**（11/11 文件均不含分房反复）。

help 记载的形态：

- `[2` 等价于 `[|]2`。
- 数字 1–9 表示段号。
- `[` 后的数字表示「新行开头的反复，不带小节线」。
- 引号文字替代：写 `|0` 时用前面的双引号文字替代段落标记文本（如 `"1、3、5"|0`）。
- faq 补充：反复符号 `|:` 及 `[1`、`[2` **只有在该声部是第一声部时才会显示**。

ABC 2.1（4.9–4.10）另有 `|1` / `:|2` 缩写、列表与区间形式 `[1,3` `[1-3` `[1,3,5-7`。JCX 无证据。

裁决：

- `[<digit>` 形态：按 help 实现为 repeat-ending token，等级 `DOC-ONLY`。
- `|<digit>` 与 `|0` 引号替代：`UNVERIFIED`，**不实现**。ABC 2.1 明确 `| 1`（带空格）不合法而 `| [1` 合法，这类细则在 JCX 中无任何证据支撑。**实现说明（更正）**：lexer 当前并不会把барline 之后的裸数字保留为 unknown/raw token，而是继续按 §16.1 的通用 duration 规则把它切成一个独立的 `duration` 叶子（例如 `\|2` → `barline('\|')` + `duration('2')`），M1.5 T4 的 AST 预演正是靠这个孤立 `duration` 叶子发现了下面的语料样本。
- 列表 / 区间形式：`UNVERIFIED`，不实现。

**`\|<digit>` 语料调查**（M1.5 T4 后补，evidence-driven）：

`corpus#10.jcx` V:2（pitch/jianpu 声部）第 101 行含唯一一处（形态为 `...z2 \|\|\|2D2 ...`，前后旋律不引用） `\|<digit>` 字面形态（`\|\|\|2` 中的后两个 `\|` + `2`）。逐项核实：

1. **该声部反复结构**：通篇检索 V:2 全部正文行，`:\|` 与 `\|:` **均零出现**——整首曲子没有任何反复起止标记，与「第二房子」所需的反复上下文不符。
2. **前后小节对照**：同一声部更早处已有一次不带数字的 `\|\|`（双细线，纯乐句/段落分界），其后紧跟的一整段旋律与本行 `\|\|\|2` 之后的旋律**逐字符相同**——即全曲用「原样重复抄写整段旋律」而非 ABC 反复记号来表达副歌重复（与全曲零 `:\|`/`\|:` 的事实互证）。据此，`\|\|\|2` 更可能是誊抄时的笔误（多打或错位的字符），而非有意的跳房子标记。
3. **help.txt / faq.txt（只读）核查**：`help.txt` §2.1.3.9「反复段落标记」只描述 `[<digit>` 方括号形态（`[2` 等价于 `[\|]2`）及 `\|0` 引号替代，**未提及**紧邻小节线省略方括号的 `\|1` / `:\|2` 写法。`faq.txt` (28)(39) 同样只提到 `\|:` 与 `[1`、`[2`。两份文档都没有支撑「裸小节线+数字」跳房子缩写的段落。
4. **ABC 2.1 §4.8–4.10 原文**（`docs/generated/abc-2.1-reference.md` 第 142 行）：标准确实记载「反复房子 `[1`、`[2` 紧邻小节线时可缩写为 `\|1`、`:\|2`」，但这是**标准侧**的证据，不能替代 JCX 侧的语料/文档印证（§28.3：JCX 无语料/无文档支撑的 ABC 构造一律不实现）；且标准给出的缩写族是「单线 `\|` 或右反复 `:\|` + 数字」，并不包含双细线 `\|\|` + 数字（本例是 `\|\|` 双线之后紧跟另一段 `\|2`，不是双线本身带数字）。

**三种可能的证据强弱**：

| 假设 | 证据 | 强弱 |
| --- | --- | --- |
| (a) `\|\|` + `\|2`：ABC 4.9 风格的第二房子缩写 | 仅语法形状吻合 ABC 标准；但声部内无任何反复起止标记，语义上「第二遍」无从谈起；help/faq 均未记载此缩写 | 弱 |
| (b) `\|\|\|2` 是笔误（误多打字符或与更早处 `\|\|D2` 重复段落的抄写失误） | 同一声部内有一处几乎逐字符相同的「`\|\|` + 相同后续旋律」先例，且该处没有数字；全曲零反复标记，与「原样重复抄写」的写作方式一致 | 较强 |
| (c) 其他未知构造 | 无更多样本、无文档支撑 | 无法评估 |

**裁决（更正）**：证据不足以支撑 (a)，維持**不实现**；lexer 不改动，`\|2` 中的 `2` 继续按通用 duration 规则切成孤立 `duration` 叶子（M1.8 之后若拿到含真实反复结构的样本再复议）。已同步登记 Appendix A U26。

**消歧**：`[1` 与和弦块 `[...]`、inline field `[V:` 的区分靠「`[` 后紧跟数字」。`INFERRED`（依据：ABC 同规则；语料无样本可验证）。

---

## 20. Tuplet

级别：**G-级**（help 2.1.3 连音小节；corpus 印证两种形态）

```ebnf
tuplet = "(" digit [ ":" digit [ ":" digit ] ]
```

语义（help，与 ABC 2.1 4.13 一致）：

- 简写 `(n`：接下来 n 个音符按固定规则占时。
- 一般式 `(p:q:r`：r 个音符占 q/p 的时值。

**语料事实（已修正）**（§2.4 C7）：

| 形态 | 次数 | 文件 |
| --- | ---: | --- |
| `(3` | 8 | 1 个文件 |
| `(3:0:3` | 8 | 1 个文件 |

> 上游证据包曾统计出 `(2` / `(3` / `(4` 共 17 次，其中 3 次来自 `%%gchord` 行内的指法括号（`3(3),2(2),…,3(4)`），不是正文 tuplet。本规格采用修正后的计数。

`UNVERIFIED`：`(3:0:3` 中 `q=0` 的含义。ABC 2.1 中 q 是「占几个标准单位」，0 无意义；推测为「使用默认 / 覆盖整小节」，但**无证据**，不得据此实现时值计算。规范要求：解析出 `(p:q:r` 三元组，当 `q === 0` 时按 `q` 缺省（即回退到简写规则）处理并发 diagnostic。此处「按缺省处理」是 `INFERRED`（依据：ABC 2.1 规定 q 缺省时按 p 与拍号推断；`0` 最接近「未指定」）。

**消歧**：`(3` 与 slur 起始 `(`（§22.2）的区分靠「`(` 后是否紧跟数字」。`CONFIRMED`（help 两处语法本身即如此区分；语料无反例）。上游证据包提到的「slur-like-group 正则可能把 `(3...` 误判为连音线」正是没做这一消歧所致。

---

## 21. Grace Notes

级别：**G-级**（help 2.1.3 装饰音小节；corpus 17 处）

```ebnf
grace-group = "{" [ "@" ] grace-content "}"
```

| 形态 | 语义 | 等级 | 语料 |
| --- | --- | --- | ---: |
| `{...}` | 前倚音 | `CONFIRMED` | pitch 模式 14 处 |
| `{@...}` | 后倚音 | `DOC-ONLY` | 0 |

其他文档事实（`CONFIRMED BY DOCUMENTATION`）：

- 倚音无独立时长；`{a2}` 等价于 `{a}`。
- ABC 2.1（4.12）另有 `{/...}` 前缀斜杠表示碎音（acciaccatura）。JCX 无证据，`UNVERIFIED`，不实现。

**两种模式下的内容差异**（`CONFIRMED`，corpus）：

| 模式 | 内容形态 | 自构示例 |
| --- | --- | --- |
| pitch 模式 | 单个或多个音符字母 | `{G}` `{D}` `{c}` |
| TAB 模式 | 弦品组合，可内嵌滑奏 / 敲击 / 钩弦标记 | `{b11-S-}` `{b8-H-b9-P-}` |

这是 §13.2 模式切换要求的又一处证据：同一个 `{...}` 构造在两种模式下的内部 grammar 不同，Lexer 必须知道当前模式才能正确切分内容。

`@` 在 grace group 开头（后倚音）与 §15.3 的隐藏休止符 `@`、§23.2 的定位参数 `@x` 三者共用同一字符。消歧靠上下文位置：`{` 之后 → 后倚音；`!` 之内 → 定位参数；其余 → 隐藏休止符。`INFERRED`（依据：三处语法位置互斥；语料只印证了 `@x`/`@y` 一种）。

---

## 22. Tie / Slur

级别：**G-级**（help 2.1.3；corpus 印证）

### 22.1 Tie（延音线）`-`

`CONFIRMED`（corpus: 58 处；help 2.1.3）

```ebnf
tie = "-"
```

- 连接**相同音高**的相邻音符，视为一个音演奏。
- ABC 2.1（4.11）要求 `-` 必须紧邻**前一个**音符，后一个音符前可留空格（`abc-|cba` 合法，`c4 -c4` 不合法）。JCX 语料无反例，按同规则实现，`INFERRED`。

**歧义提示**：`-` 在三处出现：tie（本节）、歌词音节分隔（§24.3）、TAB 的滑奏 / 敲击 / 钩弦标记 `-S-` `-H-` `-P-`（§26.6）。

- 歌词中的 `-`：**语料的 `w:` 行中零出现**，故在语料范围内 `-` 全部是 tie 或 TAB 标记。但 help 明确 `-` 是合法的歌词音节分隔符，故这不是可以固化的规则，只是当前语料的巧合。
- 消歧靠行类型（`w:` 行 vs MusicLine）与模式（TAB 模式先匹配 `-[SHP]-`）。

### 22.2 Slur（连音线）`( )`

`CONFIRMED`（corpus: 70 处；help 2.1.3）

```ebnf
slur = "(" music-element+ ")"
```

- 括号必须紧贴音符字母（help）。
- ABC 2.1（4.11）支持嵌套与点号前缀虚线 slur（`.(cde)`）。JCX 无证据，`UNVERIFIED`，不实现虚线；嵌套按栈处理，`INFERRED`（依据：ABC 同源；语料未见嵌套反例）。
- **与 tuplet 的消歧见 §20。**
- **与渐强渐弱 `(>` `(<` 的潜在冲突见 §10.7 / §16.2。**

---

## 23. Decorations

`!...!` 在语料中有**两种结构完全不同的形态**，必须分开定义。上游证据包把二者合并统计（28 次），本规格拆分。

### 23.1 形态一：简单演奏记号

- 级别：**G-级**（help 2.1.3 装饰记号小节；corpus 印证）
- `CONFIRMED`

```ebnf
simple-decoration = "!" decoration-name "!"
decoration-name   = 字母/数字串
```

**语料实际出现的简单记号（已修正，§2.4 C6）**：

| token | 次数（含 1 对重复样本） | 文件数 |
| --- | ---: | ---: |
| `!st!` | 78 | 2 |
| `!sanpie!` | 14 | 2 |
| `!ATT!` | 10 | 2 |
| `!TRILL!` | 6 | 2 |
| `!DOWNBOW!` | 2 | 2 |

> 修正说明：上游证据包列出 8 种，其中 `!A!` `!B!` `!F!`（以及未列出的 `!C!` `!D!` `!E!` `!G!`）全部是**正则误判**：正则 `![^!]+!` 跨越了中间的音符字母，把**前一个记号的结束 `!`** 与**后一个记号的起始 `!`** 配成一对。
>
> 逐处定位（每个文件 10 处，两文件为重复样本）显示误判有**两种成因**，比例悬殊：
>
> - **7/10 来自两个简单记号 `!st!` 相邻**，形如 `!st!` + 音符 `E` + `!st!`（`…(!st!E!st!D |…`）。
> - **3/10 来自两个复合记号相邻**，形如 `…$s'40'\080!` + 音符 `F` + `!@y'10'…`。
>
> **多数情形是简单记号相邻，不是复合记号相邻。** Lexer 若只在复合记号相邻处做消歧，会漏掉 7/10 的情形。正确做法是：`!...!` 一律从左向右成对匹配、不跨越已闭合的记号，见 §23.3。
>
> 实际简单记号只有上表 5 种，且全部集中在 2 个文件（其中 1 对为重复样本），独立来源仅 1 份。

**help 记载但语料未出现的记号**（`DOC-ONLY`）：

`!STACC!` `!SLIDE!` `!EMBAR!` `!UPBOW!` `!ROLL!` `!HAT!` `!AIT!` `!SEGNO!` `!(!` `!)!`

> 注意 `!ATT!`（语料）与 `!AIT!`（help）字面相近。是否为同一记号的不同拼写、或 help 文本提取伪影（`T`/`I` 混淆）：`UNVERIFIED`。规范要求两者都保留原文，不合并。

`!st!` 与 `!sanpie!` 的语义：`UNVERIFIED`。二者均不在 help 的记号列表中，属于 `CORPUS-ONLY`。**不得据拼写猜测语义。**

help 另注明专业版可扩充装饰记号（通过扩展字体或绘画脚本，对应 `default.dec`）。这意味着 **`!...!` 的名字集合是开放的**，Lexer 不得使用白名单校验。

ABC 2.1（4.14）定义了完整的标准记号表与 10 个单字符简写（`.` `~` `H` `L` `M` `O` `P` `S` `T` `u` `v`）。**JCX 中零证据支持单字符简写**，且 `~` 在 JCX 中是歌词符号（§24.3）、`H`/`P`/`S` 在 TAB 中是敲击 / 钩弦 / 滑奏标记（§26.6）—— 语义冲突严重。规范要求：**严禁实现 ABC 的单字符装饰简写。**

ABC 2.1 的 `+symbol+` 形式在 2.1 已弃用，JCX 零出现，不实现。

### 23.2 形态二：复合定位 / 字体指令

- 级别：**F-级**（help 完全未描述该形态；纯语料观测）
- `CORPUS-ONLY`

观测特征（不给完整 grammar）：

```
! [ @x'<数>' ] [ @y'<数>' ] [ $f'<字体名>' ] [ $s'<数>' ] <载荷> !
```

语料中的参数组合（共 4 类，全部出现在 2 个文件中，其中 1 对为重复样本）：

| 组合 | 次数 | 自构等价示例 |
| --- | ---: | --- |
| 仅 `$f` + `$s` + 转义载荷 | 44 | `!$f'Maestro'$s'40'\070!` |
| `@y` + `$f` + `$s` + 转义载荷 | 4 | `!@y'10'$f'Maestro'$s'40'\080!` |
| `@y` + `$f` + `$s` + 文本载荷 | 68 | `!@y'10'$f'SimSun'$s'15'A!` |
| `@x` + `@y` + `$f` + `$s` + 文本载荷 | 12 | `!@x'16'@y'10'$f'SimSun'$s'15'AB!` |

参数含义：

| 参数 | 等级 | 说明 |
| --- | --- | --- |
| `@x'N'` | `INFERRED` | 水平定位偏移。依据：与 `@y` 成对出现、值域为小整数（9–16）、faq 记载的富文本标记体系中 `$` 系列确为排版参数。精确单位与原点 `UNVERIFIED`。 |
| `@y'N'` | `INFERRED` | 垂直定位偏移。依据同上。语料值为 6 或 10。 |
| `$f'<name>'` | `CONFIRMED`（faq 记载 `$f` 为字体标记；corpus 印证） | 字体名。语料出现两个西文符号字体名（大小写不一致的两种拼写，说明**字体名大小写不敏感或未规范化**）与一个中文字体名。 |
| `$s'<N>'` | `CONFIRMED`（faq 记载 `$s` 为字号；corpus 印证） | 字号。语料值为 `40`（配符号字体）与 `15`（配中文字体）。 |
| 载荷 `\NNN` | `UNVERIFIED` | 3 位数字转义码，语料出现 4 个不同值。**是字符编码还是内部符号表索引无法反解。** 恒与符号字体 + 字号 40 同现，推测是从符号字体中取一个字形。 |
| 载荷 文本 | `CONFIRMED`（corpus） | 直接的显示文字，恒与中文字体 + 字号 15 同现。语料中为表示把位 / 指法的单字与表示速度变化的词组。 |

**未解决点（全部 `UNVERIFIED`）**：

1. `\NNN` 的编码体系（字符码？字形索引？）。
2. 参数是否可乱序、是否可省略某项（语料只见 4 种固定组合）。
3. `$i`（斜体）`$b`（粗体）是否可用于此处（faq 记载它们属于富文本标记，但语料的 `!...!` 内零出现）。
4. 该形态与 faq 记载的「正文级富文本标记」是否是同一机制（§10.7）。
5. `'` 是否是唯一的参数引号形式。

**规范要求**：

- Lexer 必须能把整个 `!...!` 切为**一个 token**（含内部的 `@` `$` `'` `\` 与中文字符），且必须**先于**正文 token 切分执行 —— 否则内部的 `@` 会被误当隐藏休止符（§15.3）、字母会被误当音符。
- AST 保留完整原文 `raw`，并**尽力**解析出参数列表；解析失败时降级为 unknown decoration，保留 raw。
- preserve 模式按 raw 原样写回，**不得规整参数顺序或引号**。
- 该形态在 §30 Test Matrix 中有专属 fixture。

### 23.3 两形态的判别

`INFERRED`：`!` 之后若立即出现 `@` 或 `$`，则为复合形态；否则为简单形态。依据：语料 100% 符合该规则；无反例。

---

## 24. Lyrics

### 24.1 `w:` 字段

- 级别：**G-级**（help 2.1.2 歌词小节；corpus 94 次 / 7 个文件）
- `CONFIRMED`

### 24.2 对齐规则

`CONFIRMED BY DOCUMENTATION`（help）：

1. `w:` 与**上一行音符**逐音节对应。
2. **跳过装饰音**（倚音不占歌词音节）。
3. **有 tie 的两个音符视为独立两个音符**，可各对应一个音节（**与 ABC 2.1 不同**：ABC 中 tie 连接的音符是一个音）。
4. 一个音符行下可有多个 `w:` 行，表示多段歌词。
5. 英文以空格断字，中文以每字为间隔。

**语料事实**：`w:` 只出现在 7 个文件中（其余 4 个为纯器乐曲）；且**只跟在 pitch 模式（jianpu / staff）声部的正文行后，从未跟在 TAB 声部正文行后**（`CONFIRMED`，corpus: 94/94）。

ABC 2.1（5.1）允许 `w:` 推迟到 tune body 末尾统一书写。JCX 无证据，`UNVERIFIED`，不实现推迟对齐。

### 24.3 对齐符号

| 符号 | help 语义 | 等级 | 语料计数 |
| --- | --- | --- | ---: |
| `*` | 跳过一个音符（中英文通用） | `CONFIRMED` | 767 次 |
| `~` | 连接两字对应同一个音符（中英文通用） | `CONFIRMED` | 1 次 |
| `-` | 英文单词内断开音节 | `DOC-ONLY` | **0 次** |
| `\-` | 转义，输出真实的 `-` 字符 | `DOC-ONLY` | 0 次 |
| `_` | — | **`UNVERIFIED`** | 0 次 |
| `\|` | — | **`UNVERIFIED`** | 0 次 |

关于 `_` 与 `|`：ABC 2.1（第 5 章）定义 `_` 为「前一音节延长覆盖额外一个音符」、`|` 为「推进到下一小节」。**help 与 faq 均未把它们列为歌词符号。**

裁决：**不实现 `_` 与 `|` 的歌词语义。** 遇到时按普通字符保留并发 diagnostic。这是「宁可不解释，也不臆造」原则的直接应用。

关于 `~` 的精确语义：`UNVERIFIED`（仅 1 个样本）。help 说「连接两字对应同一音符」，ABC 2.1 说「显示为空格，把多个单词合并到同一音符下」，两者方向一致但细节不同（是否显示空格）。规范要求按 help 实现，标 diagnostic。

关于 `*` 的精确语义：help 明确为「跳过一个音符」。语料中大量出现连续 `*` 串（自构等价形态：`w: *******`），符合「整段无歌词但需占位」的用法。`CONFIRMED`。

ABC 2.1 的诗节编号惯例（`w:` 行首数字 + `~`）在 JCX 中零证据，不实现。

### 24.4 AST 形态

`w:` 行必须保留原文整串；音节切分是 Domain Model 的职责，且切分结果必须可追溯到原文 offset（供编辑器高亮）。

---

## 25. Guitar Chords

### 25.1 和弦符号 `"..."`

- 级别：**G-级**（help 2.1.4 和弦小节；corpus 189 次引号串）
- `CONFIRMED`

```ebnf
chord-symbol = '"' [ "^" ] chord-text '"'
chord-text   = <根音> [ <升降> ] [ <类型> ] [ "/" <低音> ]
```

语料实际形态（语法 token 级，均为通用和弦名，不含作品内容）：

```
"C" "G" "Am" "Em" "F" "B7" "G7" "Adim" "D/#F"
```

要点：

- 斜杠低音：`"D/#F"`（`CONFIRMED`，corpus: 15 次 / 1 个文件）。注意**升降号写在低音字母之前**（`#F` 而非 `F#`）。
- `^` 前缀（`DOC-ONLY`）：只显示和弦名文字、不显示和弦图，视为描述文字。语料 0 次。

### 25.2 空引号 `""`

- `CORPUS-ONLY`（corpus: 12 次 / 1 个文件）
- 形态：`""` 后直接跟 TAB 正文。
- `INFERRED` 语义：**无和弦时的占位**，用于保持和弦列的排版对齐。依据：(a) 它只出现在 TAB 声部，(b) 出现位置与该文件其他行的和弦符号列对齐，(c) 空字符串无任何可显示内容。
- 规范要求：Domain Model 必须把「空和弦占位」与「有和弦符号」建模为**不同的两种节点**，不得把 `""` 归一化为「无和弦」而丢失该 token（否则 preserve 失败）。

### 25.3 与 ABC annotation 的区分

ABC 2.1（4.19）定义了五种方向前缀 annotation：`^"text"` `_"text"` `<"text"` `>"text"` `@"text"`。

JCX 只有 `^` 前缀有文档支持（§25.1），其余四种零证据。

**严重冲突警告**：若实现 ABC 的 `_"..."` `<"..."` `>"..."` `@"..."`，将与 JCX 的降号 `_`（§17）、broken rhythm `<` `>`（§16.2）、隐藏休止符 `@`（§15.3）产生大面积词法冲突。

裁决：**只实现 `^` 前缀，其余四种一律不实现**（`UNVERIFIED`）。

### 25.4 和弦图定义

见 §10.1 `%%gchord`。

和弦符号（`"Am"`）与和弦图定义（`%%gchord`）的关联：`INFERRED`。推断：正文中的和弦名在 `%%gchord` 定义表中查找同名条目以取得指板图；未定义的和弦名由程序按内置和弦库渲染。依据：(a) 语料中 `%%gchord` 定义的 6 个和弦名全部在同文件正文中作为 `"..."` 出现，(b) help 把该指令称为「和弦图的**自定义**」，暗示存在内置默认，(c) 其他文件大量使用和弦名却完全没有 `%%gchord` 定义。

内置和弦库的内容：`UNVERIFIED`，不在本规格范围（属于渲染层资源）。

---

## 26. Guitar TAB

本章描述模式 B（§13.2）。**TAB 声部的 body grammar 与 pitch 模式不同**，Lexer 必须按 voice style 切换。

### 26.1 触发条件

`CONFIRMED`（corpus: 8 个 `style=tab` 声部）

`V:n style=tab`，通常伴随 `clef=standardtab`。

### 26.2 弦号

- 级别：**G-级**（help 2.1.4 明确记载；corpus 大量印证）
- `CONFIRMED`

```
a = 第 1 弦   b = 第 2 弦   c = 第 3 弦
d = 第 4 弦   e = 第 5 弦   f = 第 6 弦
```

**小写字母在 TAB 模式下是弦号，不是音高。** 这是与模式 A 最根本的分歧。

`UNVERIFIED`：大写字母 `A`–`F` 在 TAB 模式下的含义。语料中 TAB 正文只使用小写。

### 26.3 品位

- 级别：**G-级**（help 2.1.4）
- `CONFIRMED`

```ebnf
fret = digit+ | "x"
```

| 值 | 语义 | 等级 |
| --- | --- | --- |
| `0`–`24` | 品位数字 | `CONFIRMED`（help） |
| `x` | **右手拨弦，不指定具体品位；实际品位由当前生效的和弦图决定** | `CONFIRMED`（help 2.1.4） |

> **这解决了上游证据包的开放问题**（§2.4 C10）：`x` 后缀不是「品位延续」或「装饰性拨弦」，而是 help 明文定义的「由和弦图决定品位的右手拨弦」。语料中 `x` 后缀出现 3167 次，与「和弦名 + 扫弦音型」的写法高度一致，与该语义吻合。

自构示例（TAB，语法 token 级）：

```
"C"ex/cx/bx/ax/ |
```

### 26.4 拨弦 / 扫弦方向前缀

- 级别：**G-级**（help 2.1.4 六线谱装饰符号表）
- 语法：方向字母写在音符 / 音符组**左边**。

help 记载的完整符号表（`CONFIRMED BY DOCUMENTATION`）：

| 符号 | 语义 |
| --- | --- |
| `V` | 上扫弦 |
| `U` | 下扫弦 |
| `A` | 上琶音 |
| `B` | 下琶音 |
| `P` | 延长音 |
| `H` | 延长 |
| `'` | 加重 |
| `S` | 反复记号 |
| `T` | 颤音 |
| （一个在 help 文本中被提取为中文句号的符号） | 切音 |

**语料计数（已修正，§2.4 C8）**：

| 前缀 | 次数 | 文件 | 状态 |
| --- | ---: | --- | --- |
| `V[` | 301 | 1 个 TAB 文件 | `CONFIRMED` |
| `U[` | 198 | 同上 | `CONFIRMED` |
| `B[` | 5 | 4 个文件，**全部位于 `style=tab` 声部区间内** | `CONFIRMED` |
| `D[` | 5 | 1 个**不含任何 TAB 声部**的文件 | **误判**，见下 |

> 修正说明：上游证据包把 `D[` ×5 列为拨弦前缀，但这 5 处全部出现在一个 9 声部、无任何 `style=` 属性（因而无 TAB 声部）的文件中，实为音符 `D` 紧邻和弦块 `[...]`。
>
> 相反，`B[` 的 5 处经逐行核对其与前后 `[V:n]` 标记的相对位置，**全部落在 `style=tab` 的 `V:1` 区间内**，且所在行本身都含 `x` 后缀（TAB 拨弦记号），因此 5/5 都是真实的「下琶音」前缀，**不存在 pitch 模式误判**。
>
> 这组对照正说明：**同一个「大写字母 + `[`」形态的归属只能靠模式切换判定**，靠字面统计必然出错。

help 的 `H` 符号存在**语义重载**（`CONFIRMED`，help 内部不一致）：既在装饰符号表中表示「延长」，又在音符间关系中表示「敲击 hammer-on」（§26.6）。help 未做消歧说明。规范要求：按位置区分 —— 出现在 `-H-` 形态中为敲击；作为独立前缀时为延长。`INFERRED`（依据：两处语法位置不同；语料只印证了 `-H-`）。

被提取为中文句号的「切音」符号：`UNVERIFIED`，高度疑似 Word → 文本提取伪影，真实符号未知。不实现。

### 26.5 TAB 时值

- 级别：**G-级**（help 2.1.4 明确说明）
- `CONFIRMED`

**因为数字已被品位占用，TAB 中必须用 `*` 或 `/` 分隔品位与时值：**

```ebnf
tab-note = [ stroke-prefix ] string-letter fret [ ( "*" | "/" ) duration-value ]
```

| 写法 | 语义 | 等级 | 语料 |
| --- | --- | --- | --- |
| `a1*2` | 第 1 弦 1 品，2 倍单位音长 | `CONFIRMED`（help） | `*N` 形态大量 |
| `a1/2` | 第 1 弦 1 品，1/2 单位音长 | `CONFIRMED`（help） | `/` 与 `//` 大量 |
| `a1*3/2` | 附点（在 `L:1/8` 下为附点八分） | `DOC-ONLY` | 0 |

**同弹音符的时值取最后一个音**（help 明确，与 pitch 模式取第一个音相反）。见 §14.4。

### 26.6 同弦相邻音关系标记

- 级别：**G-级**（help 2.1.4；corpus 印证 3 种）
- 统一形态：`-<字母>-` 夹在两个 TAB 音符之间。

| 标记 | 语义 | 等级 | 语料计数 |
| --- | --- | --- | ---: |
| `-` | tie（延音） | `CONFIRMED`（help） | 与 §22.1 合并统计 |
| `-S-` | 滑奏 slide | `CONFIRMED` | 20 次 / 1 个文件 |
| `-H-` | 敲击 hammer-on | `CONFIRMED` | 2 次 / 1 个文件 |
| `-P-` | 钩弦 pull-off | `CONFIRMED` | 2 次 / 1 个文件 |

**Lexer 要求**：在 TAB 模式下，`-[SHP]-` 必须**先于**单独的 `-` 匹配（最长匹配优先），否则 `-S-` 会被切成 `-` + `S` + `-`，而 `S` 又是扫弦符号表中的「反复记号」。

### 26.7 TAB 装饰音

- `CONFIRMED`（corpus: 3 处形态；help 2.1.4）
- 形态：`{<TAB 音符序列，可含 -S-/-H-/-P->}`
- 见 §21 的模式差异表。

### 26.8 TAB 休止与和弦块

- TAB 休止符：`CONFIRMED`（help 2.1.4 提及 tab 休止符；语料 `style=tab` 声部中实见 `z` 28 处
  与 `zzz` 1 处，见 §26.9）。**升级依据**：此前判定为 `DOC-ONLY` 是因为统计时未按 §13.2 切换
  词法模式，`z` 被归到了 pitch 模式的计数里；按模式重新归属后证据充分。写法与 §15.1 一致。
- TAB 中的 `[...]`：表示同时拨响的多根弦（`CONFIRMED`，corpus: 504 次与 `V[` / `U[` / `B[` 前缀配合出现）。**与 pitch 模式的和弦块共用括号，但内容 grammar 不同**（内部是弦品对而非音高），且时值取值规则相反（§14.4）。

### 26.9 TAB 声部中出现的共享构造

- 级别：**F-级**（help 的 TAB 小节未提及这些构造；纯语料观测）
- `CONFIRMED BY CORPUS ONLY`

`style=tab` 声部的正文并非只由 §26.2–§26.8 的 TAB 构造组成，语料中还出现了三类原本
只在 pitch 模式描述过的构造：

| 构造 | 章节 | 语料计数 | 文件 |
| --- | --- | ---: | --- |
| 休止符 `z`（含连写 `zzz`） | §15.1 | 28 + 1 | 2 个 TAB 文件 |
| 三连音 `(3:0:3` | §20 | 9 | 1 个 TAB 文件 |
| 连音线 `(...)` | §22.2 | 5 | 同上 |

三者的**词法形态与 pitch 模式完全一致**（同样的起始字符、同样的最长匹配规则），语料中
未观察到任何 TAB 专属变体。

**规范要求**：Lexer 在模式 B 下必须按 §15 / §20 / §22.2 同样切分这三类构造，不得把它们
降级为未知 token（§29.3）。切分顺序上它们位于 `barline` 之后、TAB 专有 token 之前；
其中 §20 必须先于 §22.2（`(3` 的括号属于三连音而非连音线）。

时值写法仍遵守 §26.5：TAB 休止的时值同样必须由 `*` / `/` 引出（语料形态 `z/`），
脱离弦号的裸数字在 TAB 中无定义。

> 这三类构造此前被 §26.8 判定为「TAB 声部未观察到」，实为统计时未按 §13.2 切换模式所致 ——
> 与 §2.4 C8 / C9 同源的方法论错误。

---

### 26.10 与 pitch 模式的差异汇总（规范性）

| 维度 | 模式 A（pitch） | 模式 B（TAB） |
| --- | --- | --- |
| 小写字母 | 音高（高八度区） | **弦号** |
| 紧跟字母的数字 | **时值倍数** | **品位** |
| 时值写法 | `A2` `A/2` 直接后缀 | **必须用 `*` 或 `/` 分隔** |
| `x` | 无定义（ABC 中为不可见休止，JCX 不实现） | **右手拨弦，品位由和弦图决定** |
| `'` `,` | 八度修饰 | `'` 为「加重」装饰符号；`,` 无定义 |
| `[...]` 时值 | 取**第一个**音 | 取**最后一个**音 |
| `{...}` 内容 | 音高字母 | 弦品对 + 关系标记 |
| 前置大写字母 | 音高 | **拨弦 / 扫弦方向符号** |
| `w:` 歌词 | 可跟随 | 语料中从未跟随 |

---

## 27. Encoding / Serialization

### 27.1 两种模式

```ts
serializeJcx(document, { mode: 'preserve' })
serializeJcx(document, { mode: 'canonical' })
```

### 27.2 preserve 模式（规范性）

目标：未编辑的文档输出**同字节**。

规则：

| 维度 | 规则 |
| --- | --- |
| 编码 | 按 AST 记录的原编码输出（GB18030 文件写回 GB18030） |
| BOM | 按 `hasBom` 原样输出 |
| 行尾 | 按记录的逐行行尾输出 |
| 末尾换行 | 按 `hasTrailingNewline` 输出 |
| 行尾空白 | 原样保留 |
| 空行 | 原位保留 |
| 注释 | 原文保留，含纯 `%` 空注释 |
| magic header | 有则原样保留，无则**不得补写** |
| 字段顺序 | 按 AST 行序，不重排 |
| 重复字段 | 全部保留（§8.12） |
| 字段冒号后空格 | 原样 |
| `%%` 后空白 | 原样（含 `%% continueall` 变体） |
| voice 属性 | 原始拼写、原始顺序、原始引号 |
| 布尔值写法 | 原样（`1` 不写成 `yes`） |
| 文本块内容 | 原样，含前导空白 |
| 未知内容 | raw 原样回写（§29） |

**编辑后的行**：只有被编辑的节点重新生成文本，未触碰的节点必须写回其 `raw`。这要求 AST 节点携带 `raw` + `dirty` 标志。

GB18030 编码风险（`INFERRED`）：若用户在 GB18030 文档中输入了 GB18030 无法表示的字符（如 emoji），preserve 编码写回会失败。规范要求：检测到不可编码字符时**不得静默丢字**，必须报错并提示用户转为 UTF-8 保存。

### 27.3 canonical 模式（规范性）

目标：输出 Muse Next 标准格式，适合新建文件。

| 维度 | 规则 | 等级 |
| --- | --- | --- |
| 编码 | 一律 UTF-8，无 BOM | Muse Next 决定 |
| 行尾 | 一律 LF | Muse Next 决定 |
| 末尾换行 | 一律有 | Muse Next 决定 |
| magic header | 一律输出 `%MUSE2` | `INFERRED`（依据：6/11 语料有；help 要求第一行为版本信息） |
| 字段冒号后 | 统一一个空格（`T: xxx`） | `INFERRED`（依据：语料多数写法） |
| `%%` 后 | 无空格 | `CONFIRMED`（help 标准写法） |
| voice 属性名 | **仍用原始拼写**（见下） | 规范决定 |
| voice 属性顺序 | 保持原顺序 | 规范决定 |
| 字段顺序 | 保持原顺序，不按角色排序 | 规范决定 |
| 行尾空白 | 去除 | Muse Next 决定 |
| 布尔值 | 统一 `yes` / `no` | `INFERRED`（依据：help 首选写法） |

**关于 canonical 是否归一化 voice 属性拼写**：本规格裁决为**不归一化**。理由：`volumn` 是原版拼写，把它写成 `volume` 会产生原版 Muse 无法读取的文件，违背兼容目标。canonical 模式的目标是「Muse Next 标准格式」，但该格式仍必须能被原版 Muse 打开。

### 27.4 序列化不变式（测试用）

对任意语料文件 `f`：

```
parse(f) → serialize(preserve) === f            (字节级，L3)
parse(f) → serialize(canonical) → parse → 语义 === parse(f)   (L2)
serialize(canonical) 的输出再次 canonical 序列化 === 自身      (幂等)
```

---

## 28. Compatibility Behavior

### 28.1 版本兼容

- `%MUSE2` 缺席 → 按最新语法解析（§7.2）。
- 未知 magic header 版本 → 按最新语法解析 + diagnostic（§7.4）。
- help 提及 Muse 1.0 吉他谱文件的自动转换能力（`DOC-ONLY`）：**不在 v0.1 范围**，1.0 格式无任何样本。

### 28.2 专业版功能

`%%begintext` / `%%endtext` / `%%skip` 在原版中限专业版，且 `%%skip` 与文本块定位依赖「强制换行」开关。

规范要求：Muse Next **不实现版本分级**，全部功能可用。但解析「依赖强制换行」的指令时应在 Domain Model 中记录该前置条件，供渲染层判断。

### 28.3 与 ABC 工具链的互操作

**JCX 不是合法的 ABC 文件**，不应尝试用 ABC 解析器读取，也不应声称输出 ABC 兼容。关键不兼容点：

| 点 | JCX | ABC 2.1 |
| --- | --- | --- |
| 文件标识 | `%MUSE2` | `%abc` |
| `I:` | 左上角备注文字 | instruction directive |
| `%%gchord` | 和弦图定义 | 未定义（abcm2ps 中为伴奏音型） |
| 行内 `%` | 字段值的一部分 | 注释起点 |
| 空行 | 无结构语义 | 分隔 tune |
| `[V: 1]` | 合法 | 未置评，官方示例无空格 |
| `Z` | 语义未定 | 多小节休止 |
| `x` | TAB 右手拨弦 | 不可见休止 |
| `_` `<` `>` `@` 前缀引号 | 未实现 | annotation 方向前缀 |
| `clef=standardtab` | 合法 | 谱号表中无 tab |
| `V:` 的 `ins`/`vol`/`play`/`style`/`bracket` | 合法 | 未定义（属 7.1 允许的自定义 specifier） |

未来若要做 ABC 导出，必须是**有损转换**并显式列出丢失项。

---

## 29. Unknown / Unverified Behavior

本章与 HANDOFF §36 的 lossless 要求一致。

### 29.1 未知字段

```ts
interface JcxUnknownFieldNode {
  type: 'unknownField';
  key: string;        // 单字母
  value: string;
  colonSpacing: string;
  raw: string;
  span: SourceSpan;
}
```

- 不报错，产生 `warning` 级 diagnostic：`unknown information field '<key>'`。
- Domain Model 收集到 `document.unknownFields[]`，不参与语义。
- **preserve 与 canonical 都必须原样回写。**

### 29.2 未知指令

```ts
interface JcxUnknownDirectiveNode {
  type: 'unknownDirective';
  name: string;
  prefixSpacing: string;  // '%%' 与 name 之间的空白
  value: string;          // 原始值串，不解析
  raw: string;
  span: SourceSpan;
}
```

- 不报错，产生 `info` 级 diagnostic（指令数量多且大部分是排版参数，warning 会造成噪音）。
- **§10.7 清单中的指令虽有文档语义，但 v0.1 不解析其值**，同样按本节处理（保留 name + raw value），只是不发 diagnostic。
- 值的类型解析（`<unit>` / `<bool>` / `<font>`）留待 M2 渲染层需要时再实现。

### 29.3 未知 body token

```ts
interface JcxRawTokenNode {
  type: 'rawToken';
  text: string;
  span: SourceSpan;
}
```

- Lexer 遇到无法归入任何已知构造的字符序列时，**按「最短可疑片段」切出 raw token**，继续向后解析，**不中止整行**。
- 产生 `warning` 级 diagnostic，携带 span 供编辑器下划线提示。
- **禁止丢弃、禁止跳过。** 一行内的 raw token 拼接回去必须能还原原文。

### 29.4 未知行

若整行无法分类（§13.3 兜底为 MusicLine，理论上不会发生），保留为 `JcxRawLineNode`，原文完整保留。

### 29.5 行级不变式（测试用）

对任意行 node `n`：

```
concat(n 的全部子 token 的 text) + n.lineEnding === 原始行字节解码后的文本
```

该不变式是 L3 preserve round-trip 的逐行保证，必须作为 Lexer 单元测试的通用断言。

---

## 30. Test Matrix

### 30.1 原则

- 全部 fixture **自行编写**，不得复制真实语料内容（HANDOFF §39.1 / §51）。
- 每个 fixture **只验证一个语法点**。
- fixture 目录：`tests/fixtures/jcx/`。
- 真实语料参与**本地回归**（计划新增 `npm run jcx:corpus-test`，M1.8 前实现，当前 package.json 尚无此脚本），但语料保持 git ignored。
- **本任务不创建 fixture 文件**，仅定义矩阵。

### 30.2 Fixture 矩阵

基线 fixture（HANDOFF §39.2）：

| fixture | 验证的单一语法点 | 章节 |
| --- | --- | --- |
| `minimal.jcx` | 最小合法文档：`T:` + `K:` + 一行正文 | §6.2 |
| `voice.jcx` | `V:` 头字段与属性解析 | §12.1, §12.2 |
| `inline-voice.jcx` | `[V:n]` 声部切换（整段式） | §9.1, §9.3 |
| `text-block.jcx` | `%%begintext` / `%%endtext` 与前导空白保留 | §11 |
| `gchord.jcx` | `%%gchord` 六弦品位 + 指法括号 | §10.1 |
| `lyrics.jcx` | `w:` 与 `*` / `~` 对齐符号 | §24 |
| `tuplet.jcx` | `(3` 与 `(3:0:3` | §20 |
| `grace.jcx` | `{...}` 前倚音（pitch 模式） | §21 |
| `tab.jcx` | TAB 弦品 + `x` + `*N` 时值，以及 TAB 声部中的 `z` 休止 / `(3` 三连音 / `(...)` 连音线 | §26.2, §26.3, §26.5, §26.9 |
| `jianpu.jcx` | `style=jianpu` 声部正文仍为 ABC 字母记谱 | §12.6.3 |

本轮证据新增的 fixture：

| fixture | 验证的单一语法点 | 章节 |
| --- | --- | --- |
| `crlf.jcx` | CRLF 行尾的逐行保留与 preserve 回写 | §5.1 |
| `lf.jcx` | LF 行尾（与 `crlf.jcx` 配对） | §5.1 |
| `no-trailing-newline.jcx` | 末尾无换行的字节级保留 | §5.2 |
| `trailing-space.jcx` | `V:` 行尾空白保留 + 值 trim | §5.3 |
| `blank-lines.jcx` | 空行不产生结构语义，原位保留 | §5.4 |
| `comment-lines.jcx` | 实义注释 + 纯 `%` 空注释保留 | §5.6 |
| `inline-percent.jcx` | `K:G % 1 sharps`：行内 `%` 不是注释 | §5.6 |
| `no-magic-header.jcx` | 缺少 `%MUSE2` 时正常解析且不补写 | §7.2 |
| `magic-header.jcx` | `%MUSE2` 存在时的识别与保留 | §7.1 |
| `duplicate-fields.jcx` | 多条 `T:` / `C:` 的顺序与全实例保留 | §8.12 |
| `body-field-l.jcx` | `L:` 出现在 `[V:1]` 之后的作用域 | §6.4, §8.5 |
| `inline-voice-spaced.jcx` | `[V: 1]` 冒号后空格的保留 | §9.1 |
| `inline-voice-alternating.jcx` | 交替式多声部排布（3 声部 × 8 组 = 24 次切换） | §9.3 |
| `voice-without-inline.jcx` | 无 `[V:...]` 时按声明顺序归属段落 | §9.4 |
| `voice-alias-old.jcx` | `ins=` / `vol=` 旧写法 | §12.2, §12.3 |
| `voice-alias-new.jcx` | `instrument=` / `volumn=` 新写法 + 引号 name | §12.2, §12.4 |
| `voice-no-style.jcx` | `style` 缺省不报错、不填默认值 | §12.6.1 |
| `voice-unknown-style.jcx` | 未知 style 值不报错 | §12.6.5 |
| `voice-unknown-attr.jcx` | `play=1` 等未知属性保留为 unknown | §12.2, §29.1 |
| `unknown-directive.jcx` | 未知 `%%` 指令保留并回写 | §29.2 |
| `directive-spaced.jcx` | `%% continueall yes`（`%%` 后带空格）变体 | §5.7 |
| `showfinger-variants.jcx` | `1` 与 `yes` 两种布尔写法各自保留 | §10.2 |
| `decoration-simple.jcx` | `!TRILL!` 等简单记号 | §23.1 |
| `decoration-adjacent.jcx` | 两个记号中间夹一个音符，简单相邻与复合相邻两种成因各一例（防 C6 误判回归） | §23.1, §23.3 |
| `decoration-complex.jcx` | `!@x'N'@y'N'$f'..'$s'N'载荷!` 整体成单 token | §23.2 |
| `tab-direction.jcx` | TAB 声部内的 `V[...]` / `U[...]` / `B[...]` 拨弦前缀 | §26.4 |
| `tab-relation.jcx` | `-S-` / `-H-` / `-P-` 最长匹配优先 | §26.6 |
| `tab-grace.jcx` | TAB 装饰音 `{...}` 内含关系标记 | §26.7, §21 |
| `pitch-chord-adjacent.jcx` | pitch 模式下 `D[...]`：音符紧邻和弦块（防 C8 误判回归；与 `tab-direction.jcx` 配对） | §26.4, §14.4 |
| `rest-z-upper.jcx` | `Z` 与 `z` 不合并、不按 ABC 多小节休止处理 | §15.2 |
| `accidental-flat.jcx` | `_`（降号）路径（语料零覆盖） | §17 |
| `broken-rhythm-left.jcx` | `<`（语料零覆盖） | §16.2 |
| `barline-variants.jcx` | `\|]` 最长匹配优先于 `\|` | §18 |
| `empty-chord.jcx` | `""` 空和弦占位不被归一化掉 | §25.2 |
| `chord-slash-bass.jcx` | `"D/#F"` 斜杠低音 | §25.1 |
| `encoding-gb18030.jcx` | GB18030 检测与原编码回写 | §4.3, §27.2 |
| `encoding-utf8.jcx` | UTF-8 检测（与上配对，检测顺序不可交换） | §4.3 |
| `encoding-bom.jcx` | BOM 存在时的保留 | §5.5 |
| `unknown-field.jcx` | 未知单字母字段保留并回写 | §29.1 |
| `unknown-body-token.jcx` | 未知 body token 不中止整行 | §29.3 |
| `duration-slash.jcx` | `N/` 裸斜杠 = `N/2`（`C3/ D/ E//`），`N/N` 分数优先于 `N/` | §16.1 |

### 30.3 语料回归（不进 git）

| 断言 | 目标 |
| --- | --- |
| L1 parse 无异常 | 11 / 11 |
| L2 语义 round-trip | 11 / 11 |
| L3 preserve 字节一致 | 11 / 11 |
| diagnostic 中无 `error` 级 | 11 / 11 |
| §29.5 行级不变式 | 全部行 |

---

## Appendix A — Known Unknowns

汇总全部 `UNVERIFIED` 与关键 `INFERRED` 条目及其升级条件。

### A.1 UNVERIFIED

| # | 条目 | 章节 | 升级所需证据 |
| --- | --- | --- | --- |
| U01 | 行首带前导空白的 `%` 是否仍为注释 | §5.6 | 一个含前导空白注释行的原版可读文件 |
| U02 | `%% continueall`（`%%` 后带空格）在原版中是否生效 | §5.7 | 原版渲染对照，或反汇编中的指令解析逻辑 |
| U03 | 行尾 `\` 的语义 | §5.9 | 含行尾 `\` 的原版样本 |
| U04 | 字段冒号是否允许全角 `：` | §8.0 | 原版 help 的原始 .doc 版式，或含全角冒号的可读样本 |
| U05 | `M:none` / 复合拍号是否支持 | §8.4 | 原版样本或 help 遗漏段落 |
| U06 | body 中 `L:` 的精确作用域（到文件末尾 vs 到下一个 `[V:n]`）；其行首 1 个空格是否有语义 | §8.5, §5.8 | 一个含多条 body `L:` 且跨声部的样本 |
| U07 | 原版的默认速度（无 `Q:` 时） | §8.6 | 原版播放行为观测或反汇编常量 |
| U08 | `K:` 的模式 / 谱号扩展语法是否真被实现 | §8.7 | 含 `K:A Mix` / `K:A bass` 的原版样本 |
| U09 | 多条 `I:` 是否叠加显示 | §8.8 | 含 2 条以上 `I:` 的样本 |
| U10 | `M:` `K:` `Q:` `T:` `C:` 出现在 body 中的行为 | §8.13 | 相应样本 |
| U11 | `[ V:1]` / `[V :1]` 等异常空格是否合法 | §9.1 | 原版解析行为观测 |
| U12 | `[K:...]` `[M:...]` 等其他 inline field 是否实现 | §9.5 | 含这些 inline field 的原版样本 |
| U13 | §9.4 的「声明顺序 = 段落顺序」规则的普适性 | §9.4 | 第二个无 `[V:...]` 的多声部样本（最好是人工书写而非工具生成） |
| U14 | `%%gchord` 的横按记法 | §10.1 | help 遗漏段落，或含横按的和弦图样本 |
| U15 | `%%gchord` 弦位项数异常时的行为 | §10.1 | 原版容错行为观测 |
| U16 | `jpgraceyshift` / `jpwedgeyshift` 的真实参数名（疑 help 笔误） | §10.7 | help 的原始 .doc |
| U17 | 渐强渐弱 `(>` `>)` `(<` `<)` 与 slur / broken rhythm 的消歧规则 | §10.7, §16.2, §22.2 | 含渐强渐弱脚本的原版样本 |
| U18 | faq 的正文富文本标记 `$f` `$s` `$i` `$b` 是否与 §23.2 的复合装饰记号同一机制 | §10.7, §23.2 | 含正文级 `$f` 的样本 |
| U19 | 未闭合 `%%begintext` 的行为 | §11.3 | 相应样本 |
| U20 | 是否存在第三套 voice 属性别名（如正确拼写的 `volume=`） | §12.3 | 更大规模的存量语料，或产品各历史版本对照 |
| U21 | voice 属性值含空格时引号是否必需 | §12.4 | 含空格声部名的样本 |
| U22 | `style` 缺省时原版的默认声部类型 | §12.6.1 | 原版渲染对照 |
| U23 | 音符八度标记混合叠加（`C,'`）的行为 | §14.2 | 相应样本或 help 遗漏段落 |
| U24 | `Z` 的精确语义（明确不是 ABC 的多小节休止） | §15.2 | 只含 `Z` 的样本 + 原版渲染对照 |
| U25 | `(3:0:3` 中 `q=0` 的含义 | §20 | 原版时值计算行为观测 |
| U26 | `[<digit>` 跳房子与 `\|<digit>` / `\|0` 引号替代的实际语法 | §19.2 | `\|<digit>` 已更正：语料 11 个文件中 1 处疑似写法（`corpus#10.jcx` 第 101 行 `\|\|\|2`），但该声部全程零 `:\|`/`\|:` 反复标记、且与更早处一个不带数字的同旋律 `\|\|` 段落几乎逐字符重复，更可能是笔误而非跳房子记号（详见 §19.2 证据表），不构成有效实现证据，`不实现`。仍需含真实反复结构（`:\|`/`\|:` 与 `\|1`/`:\|2` 共现）的原版样本才能升级 |
| U27 | `!st!` 与 `!sanpie!` 的语义 | §23.1 | help 遗漏段落，或原版符号表 |
| U28 | `!ATT!`（语料）与 `!AIT!`（help）是否同一记号 | §23.1 | help 的原始 .doc |
| U29 | `!...!` 复合形态中 `\NNN` 转义码的编码体系 | §23.2 | 原版字体资源或符号表 |
| U30 | `!...!` 复合形态的参数是否可乱序 / 可省略 | §23.2 | 更多参数组合的样本 |
| U31 | 歌词符号 `_` 与 `\|` 在 JCX 中是否有语义 | §24.3 | help 遗漏段落，或含这些符号的 `w:` 行样本 |
| U32 | 歌词 `~` 是否显示为空格（help 与 ABC 表述不同） | §24.3 | 原版渲染对照 |
| U33 | TAB 模式下大写字母 `A`–`F` 作为弦号是否合法 | §26.2 | 相应样本 |
| U34 | help 中被提取为中文句号的「切音」符号的真实字符 | §26.4 | help 的原始 .doc |
| U34a | 候选写法：ASCII `.`。语料中 1 个 TAB 文件出现 1 例，位置在一个拨弦组之后、下一个 `V[` 之前 —— 正是 §26.4 拨弦 / 扫弦前缀的语法槽位，与「切音」符号的书写位置吻合。仅 1 例，`UNVERIFIED`，暂按 §29.3 切为 `raw` + warning，不实现语义 | §26.4 | 第二个含该字符的样本，或 help 的原始 .doc |
| U35 | 内置和弦库的内容（未定义和弦名如何渲染） | §25.4 | 原版资源逆向 |

### A.2 关键 INFERRED

| # | 条目 | 章节 | 推断依据摘要 | 升级所需证据 |
| --- | --- | --- | --- | --- |
| I01 | 编码检测顺序（BOM → ASCII → UTF-8 严格校验 → GB18030 兜底） | §4.3 | GB18030 全覆盖，必须最后试 | 反例文件 |
| I02 | 注释判定为「行首整行判定」而非 ABC 的行内扫描 | §5.6 | `K:G % 1 sharps` 反例 | 更多含行内 `%` 的样本 |
| I03 | header 区 = 开头到第一个 `K:`（放宽起始条件） | §6.2 | help 的 `K:` 终结规则 + 5/11 文件首行非 `T:` | — |
| I04 | 无 magic header 按最新语法解析 | §7.2 | 5/11 缺席且语法同构 | 早期版本样本 |
| I05 | 只有第一行的 `%MUSE2` 是 magic header | §7.3 | help「第一行」表述 + 6/6 语料 | — |
| I06 | `X:` 解析但不赋予结构语义 | §8.1 | 唯一样本来自 ABC 工具链导入 | 多 tune 样本 |
| I07 | 同 id `V:` 重复时后者覆盖 | §8.12 | ABC 2.1 instruction 型字段规则 | 同 id 重复样本 |
| I08 | 引号 name 是「新写法」，与无引号语义相同 | §12.4 | 与全称属性名共现的版本聚类 | 版本对照 |
| I09 | **Lexer 必须按 voice style 切换词法模式** | §13.2 | TAB 与 pitch 模式对「字母 + 数字」的解释直接冲突；C8/C9 误判即由不切换模式造成 | 原版反汇编中的模式分支 |
| I10 | 和弦块内部规则沿用 ABC（无空格、升降号附着单音） | §14.4 | ABC 同源 + 语料无反例 | 反例样本 |
| I11 | `@` 三处用法按位置消歧 | §21 | 三处语法位置互斥 | 含隐藏休止符 `@` 的样本 |
| I12 | `!` 后紧跟 `@` 或 `$` 判为复合装饰形态 | §23.3 | 语料 100% 符合 | 反例样本 |
| I13 | `""` 是无和弦占位 | §25.2 | 只出现在 TAB 声部且与和弦列对齐 | 原版渲染对照 |
| I14 | 正文和弦名在 `%%gchord` 表中查找，未定义则用内置库 | §25.4 | 定义的 6 个和弦名全部在同文件正文出现；help 称「自定义」 | 原版资源逆向 |
| I15 | `H` 按位置区分「敲击」与「延长」 | §26.4 | help 两处语法位置不同 | 含独立 `H` 前缀的样本 |
| I16 | canonical 模式的各项格式选择（LF、UTF-8、补 `%MUSE2` 等） | §27.3 | 语料多数写法 + help 首选写法；属 Muse Next 产品决定 | 不适用（非格式事实） |

---

## Appendix B — Evidence Sources

证据来源类型，按 §2.3 的优先级排列（优先级规则本身只在 §2.3 定义一次，此处不复述）：

1. **Legacy corpus — 11 个真实 `.jcx` 文件**。Muse Pro 2.70 时代的乐谱文档，含 1 对重复样本（一个自动存盘副本与其源文件）与 1 个 MIDI 导入产物；10 个 GB18030、1 个 UTF-8。**不随仓库分发**（HANDOFF §7.2 / §51），仅用于本地回归。本规格全部计数均来自对这批文件解码文本的直接统计。

2. **Muse Pro 2.70 原版 help 文档**。相关章节：2.1.1 脚本概述、2.1.2 描述头、2.1.3 五线谱/简谱脚本输入、2.1.4 吉他六线谱脚本输入、2.1.5 脚本控制显示风格/页面设置。只转述语法规则，未整段复制（HANDOFF §51）。已知存在 Word → 文本提取伪影（插图丢失、符号被替换为中文标点、参数名重复），风险已在 §10.7、§23.1、§26.4 逐条标注。

3. **Muse Pro 2.70 原版 faq 文档**。补充了 help 遗漏的内容：`brace`/`brc` 属性、渐强渐弱脚本语法、富文本标记 `$f`/`$s`/`$i`/`$b`、`K:` 必须最后出现。与 help 的不一致已在 §2.4 C4 与 §10.7 裁决。

4. **advancenote 文档**。判定为与 JCX 文本语法无关（全文描述 `default.dec` 图形编辑器），不进入语法证据链。

5. **ABC notation Standard v2.1 (Dec 2011)** — https://abcnotation.com/wiki/abc:standard:v2.1 。用途是**区分「ABC 标准语法」「abcm2ps 等实现扩展」「ABC 未定义语法」三类**，为 JCX 私有扩展定位提供参照；**不作为 JCX 行为的依据**，凡 JCX 无语料 / 无文档支持的 ABC 构造一律不实现（§28.3）。

6. **静态逆向结论**（HANDOFF §3–§6）：JCX 是文本格式、原程序为 MFC 应用、装饰符号库为 `default.dec`、自动存盘文件名来源。仅用于交叉印证，未单独支撑任何语法条款。

**明确排除的来源**：`src/formats/jcx/parseJcx.ts` 与 `src/formats/jcx/parseGChord.ts` —— 编写过程中未读取，不得作为格式事实（§2.3）。

---

## Appendix C — DoD Checklist（HANDOFF §55）

| # | DoD 项 | 状态 | 对应章节 |
| --- | --- | --- | --- |
| 1 | Encoding | 完成 | §4（检测策略 §4.3、逐文件属性 §4.4）、§27.2 |
| 2 | `%MUSE2` | 完成 | §7（可选性 §7.2，语料 6/11） |
| 3 | 10 Headers | 完成 | §8.1–§8.10（`X` `T` `C` `M` `L` `Q` `K` `I` `V` `w`），另 §8.11 登记 `S:` 为 DOC-ONLY |
| 4 | `[V:...]` | 完成 | §9.1–§9.5（两种空格写法、两种排布策略、无 inline field 的情形） |
| 5 | 6 Directives | 完成 | §10.1–§10.6（`gchord` `showfinger` `begintext` `endtext` `skip` `indent`） |
| 6 | text block | 完成 | §11（含前导空白保留规则 §11.3） |
| 7 | Voice attributes | 完成 | §12.2 完整属性表（12 项） |
| 8 | attribute alias | 完成 | §12.3 归一化表 + AST 保留原拼写规则 |
| 9 | Voice style | 完成 | §12.6（可选性、jianpu 仍用字母记谱、未知 style 不报错） |
| 10 | body feature inventory | 完成 | §13–§26，每项标注 G-级 / F-级（§13.1） |
| 11 | gchord syntax | 完成 | §10.1（变调卡品位、六弦顺序、`X`/`0`/品位、指法括号、横按 UNVERIFIED） |
| 12 | evidence level | 完成 | §2.1 定义；全文逐条标注 |
| 13 | known unknowns | 完成 | Appendix A（36 项 UNVERIFIED + 16 项关键 INFERRED） |
| 14 | serialization constraints | 完成 | §5.11 保留清单、§27 两种模式、§27.4 不变式、§29.5 行级不变式 |
| 15 | test matrix | 完成 | §30（10 个基线 + 40 个新增 fixture，各注明单一语法点与章节号） |

---

*JCX_SPEC v0.1 — 本文件的每一条结论都必须可追溯到 Appendix B 列出的证据来源。新增结论时请同步更新 Appendix A 与 Appendix C。*
