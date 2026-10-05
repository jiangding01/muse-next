# Muse Next — HANDOFF

> 面向后续实现 Agent 的项目交接文档  
> 项目代号：`muse-next`  
> 当前阶段：**M0–M1.8 已封板；M2 Notation Rendering T0–T9 已全部完成（Chord / Jianpu / TAB / Staff 四种记谱可渲染 + T8 render matrix 契约测试 + T9 文档封板），✅ 2026-09-22 封板（原始 seal CI run 35700198783；T8.1 post-seal 契约收紧 run 35702615344；当前 HEAD run 35702885112 三平台全绿）；UI 设计 Brief 已完成（`docs/UI_DESIGN_BRIEF.md` v1.3.5）；M2.5 Score System Layout 方案冻结为 v1.0，**T0 已完成（2026-10-04，`6e5a532` + 命名修订 `3f5b48c`），T1 声部视觉分组已完成（`2b9882c`），T2 跨声部 measure identity 已完成（`218d143`），T2.1 小节错位锁存已完成（`9037351`），T3 共享小节时间轴已完成（`7ee1e27`），T3.5 TAB / 简谱节奏刻印已完成（`d2486aa`），T4 公共几何编排已完成（2026-10-05，`9661810`），T5 三个 voice layout 的外部几何适配已完成（2026-10-05，`ed4ea88`），均三平台 CI 全绿；T5.S VexFlow shared timing spike 已完成（2026-10-05，结论 `feasible-with-cost` / no adapter merged，M2.5 只承诺 Staff tier 1）；T6 和弦图层水平规划已完成（2026-10-05，`c74094e`）；T8 最终系统纵向编排已完成（2026-10-05，`b513261`）；T9a 页面模型已完成（2026-10-05，`49b0e11`）；T9b renderer system 化已完成（2026-10-05，`9eb5722`）；下一步先裁决 Staff 纵向墨迹越界（T9c 封板前裁决项），T9c 待用户明确指令**；M3 排在 M2.5 之后**（详见 §30 里程碑表、§30.1「M2 进行中状态」与「M2.5 T0 实际状态」、§69「当前明确的下一任务」）  
> 核心目标：以现代 TypeScript 技术栈重建已停止维护的 **Muse Pro 2.70** 的核心能力，并优先恢复其 `.jcx` 乐谱格式、谱面渲染、编辑与播放能力。

---

## 文档索引

- [`README.md`](README.md) —— 项目简介、架构管线、公开 API、开发与验证命令、质量护栏摘要
- [`CHANGELOG.md`](CHANGELOG.md) —— 按里程碑归纳的产品/架构/兼容性变化
- [`docs/JCX_SPEC.md`](docs/JCX_SPEC.md) —— `.jcx` 格式规格，逐条结论标注 evidence level
- [`docs/TECHNICAL_PLAN.md`](docs/TECHNICAL_PLAN.md) —— 早期技术方案与架构原则
- [`docs/VALIDATION.md`](docs/VALIDATION.md) —— 兼容性验证记录
- [`NOTICE.md`](NOTICE.md) —— 版权、语料与字体策略
- 本文档内的关键章节：§30 当前 Milestone 总览、§30.1 各里程碑实际状态（文件结构/
  边界/归一化规则/语料结果的完整快照）、§55–§60 各里程碑 Definition of Done、
  §69 当前明确的下一任务

---

## 0. 给接手 Agent 的一句话摘要

这是一个对旧 Windows 乐谱软件 **Muse Pro 2.70** 的现代化重实现项目。

不要尝试“移植旧 MFC 程序”或“照着 1.8 MB 的二进制逐函数翻译”。当前逆向已经确认：

1. 原程序是 **Windows 原生 VC6/MFC 应用**，不是 .NET；
2. 最关键的 `.jcx` 文件并不是复杂二进制格式，而是一个 **以 ABC notation 为基础、叠加 Muse 私有扩展的文本乐谱格式**；
3. 当前项目已经建立了现代 TypeScript/Electron/React 架构；
4. 已经用 11 个真实旧版 `.jcx` 样本完成第一阶段 Corpus Discovery；
5. Scanner v0.2 已能完整识别当前语料的“整行级结构”，最终结果为：
   - 11 个文件
   - 753 行
   - 55,467 bytes
   - GB18030 × 10
   - UTF-8 × 1
   - 10 类 Header
   - 1 类 Inline Field（`V`，共 39 次）
   - 6 个 Text Block 内容行
   - 6 类 Directive
   - 3 类 Voice Style
   - 15 类正文音乐语法特征
   - **Unknown lines = 0**
   - **Unknown patterns = 0**
6. 下一步不要继续扩 Scanner；应该正式编写 `docs/JCX_SPEC.md`，然后进入 Lexer → AST → Parser → Serializer → Round-trip。（此条为 M0/M1.2 阶段写下的历史记录——这条「下一步」在 M1.3–M1.8 均已完成；当前实际的下一步见 §69。）

---

# 1. 项目背景

## 1.1 原软件

目标软件：

```text
Muse Pro 2.70 专业版
```

这是一个已经停止维护的旧 Windows 乐谱编辑软件。

用户手中最初只有旧版安装程序：

```text
Muse Pro 2.70 专业版.exe
```

目标不是继续运行这个旧程序，而是：

- 恢复其中仍有价值的核心能力；
- 恢复 `.jcx` 文件格式；
- 建立现代、可维护、跨平台的新实现；
- 优先支持 macOS / Windows；
- 后续让更多人可以继续打开和编辑旧 Muse 乐谱；
- 避免项目被旧 Windows/MFC 技术栈绑死。

项目名称：

```text
muse-next
```

---

# 2. 项目目标

## 2.1 核心目标

最终希望得到一个现代桌面乐谱应用，至少具备：

- 打开旧 Muse `.jcx`
- 解析曲谱元数据
- 多 Voice / 多 Track
- 五线谱
- 简谱
- 吉他 TAB
- 歌词
- 吉他和弦图
- 谱面编辑
- 源码编辑
- 可视化编辑与源码同步
- MIDI 播放
- MIDI 导入/导出
- 打印/PDF
- 新格式保存
- 旧格式兼容保存

---

## 2.2 第一优先级

当前最优先的不是 UI，而是：

```text
完整理解 JCX
↓
建立稳定的 TypeScript 格式层
↓
实现 lossless parser/serializer
↓
保证旧文件可读、可回写
```

因为只要 `.jcx` 格式层稳定：

```text
JCX
 ↓
AST
 ↓
Domain Model
 ↓
Notation / Playback / Editor
```

后面的所有渲染、编辑、播放都可以独立推进。

---

## 2.3 非目标 / 暂不做

以下内容不属于当前 MVP：

- 复刻原 MFC UI
- 完整复刻原应用视觉风格
- 老式手机铃声生成功能
  - Nokia
  - Siemens
  - Ericsson
  - Motorola
- 原 PostScript/EPS 导出引擎的逐字节兼容
- 依赖旧 Windows DLL
- 在新应用中直接嵌入原 `Muse.exe`
- 将旧版字体直接打包发布（授权未确认）
- 将原始歌曲 `.jcx` 文件提交到公开仓库

---

# 3. Legacy Reverse Engineering 结论

## 3.1 安装程序

旧安装程序经过静态分析后确认：

- PE32
- Intel i386
- Windows GUI
- 外层不是主程序
- 外层属于 **Gentee / CreateInstall 风格安装器**
- 真正安装内容位于安装包内部的 PAK 数据

曾确认安装配置包含：

```text
product: muse2.7
default path: c:\Program Files\muse
program group: muse
```

这部分工作已经完成，不需要接手 Agent 再重新研究安装器，除非后续确实需要验证文件。

---

## 3.2 解包后的主要文件

历史逆向过程中共恢复约 31 个唯一文件，其中关键内容包括：

```text
Muse.exe
AdvanceNote.exe
*.jcx
*.tab
*.mid
help.doc
faq.doc
advancenote.doc
MAESTRO.TTF
default.dec
key.def
```

其中：

```text
Muse.exe
```

才是真正主程序。

历史分析记录的 SHA-256：

```text
99220d7c2fe3be4aae837e2ea4130ab15b319963020d09176f1047a0d68b7357
```

如后续需要安全或样本校验，可再次核对。

---

# 4. 原程序技术栈

## 4.1 Muse.exe

逆向结论：

```text
Native PE32 x86
Microsoft Visual C++ 6.0
MFC
非 .NET
```

不要再按 Delphi、VB6 或 C# 项目分析。

历史 RTTI / class string 中确认过类似：

```text
CWinApp
CDocument
CView
CDialog
CFrameWnd

CMuseDoc
CMuseView
CMainFrame

CPreView
CPageDlg
CStyleDlg
CFontDlg

CNote
CNotePtrList
CGuitaBase

CCrystalEditView
CCrystalTextBuffer
CCrystalTextView
```

这些名称揭示了原软件的大体模块边界，但**不要把旧 class hierarchy 直接照搬进新项目**。

---

## 4.2 AdvanceNote.exe

`AdvanceNote.exe` 是自定义装饰音/图形符号相关工具。

历史分析中确认其动态依赖：

```text
MFC42.DLL
MSVCRT.dll
```

进一步印证 VC6 + MFC 技术栈。

相关 legacy 文件：

```text
AdvanceNote.exe
default.dec
advancenote.doc
```

未来可作为高级功能研究，不是当前格式层阻塞项。

---

# 5. 已确认的原软件能力地图

## 5.1 乐谱文档

支持：

- `.jcx`
- 多 Voice / Track
- 五线谱
- 简谱
- 吉他 TAB
- 歌词
- 小节
- 拍号
- 调号
- 速度
- 音符与休止符
- 和弦
- 吉他和弦图

---

## 5.2 Script / Source Editor

原应用嵌入了 CrystalEdit 相关类：

```text
CCrystalEditView
CCrystalTextBuffer
CCrystalTextView
```

说明它本身就有“文本源代码 + 可视谱面”的双表示。

新实现也应该保留这一核心理念：

```text
JCX Source
    ↕
AST / Domain
    ↕
Visual Score
```

---

## 5.3 Visual Score Editor

历史能力大致包括：

- 鼠标编辑
- 键盘输入
- 数字小键盘输入
- 插入
- 删除
- 选择
- Copy/Paste
- Undo/Redo
- Staff / Jianpu 等不同显示模式

这部分后续在 M3 Editor Core 中实现。

---

## 5.4 Layout / Rendering

确认存在：

- Page Setup
- Font settings
- Note spacing
- Measures per line
- Forced line break
- Track spacing
- Preview
- Print
- Multiple pages
- Zoom
- PostScript / EPS 相关能力

原应用还带：

```text
MAESTRO.TTF
```

但授权情况未确认，因此：

> **不要直接将 `MAESTRO.TTF` 打包进开源/公开发行版本。**

---

## 5.5 MIDI

历史导入字符串/API 表明原程序使用 Windows MIDI API：

```text
midiOutOpen
midiOutClose
midiOutShortMsg
midiOutGetDevCapsA
midiOutGetNumDevs
timeSetEvent
```

并且曾发现：

```text
midi2abc version 2.2
```

相关字符串。

因此原软件应包含：

- MIDI 实时播放
- MIDI 输出设备
- Tempo
- MIDI Import
- MIDI Export
- MIDI → ABC/Muse 转换

---

# 6. 最重要的格式逆向结论：JCX 是文本格式

这是整个项目最关键的发现。

最初可能会假设 `.jcx` 是某种复杂私有二进制格式，但样本确认：

> `.jcx` 主要是一个 ABC notation 派生/扩展的文本格式。

真实文件可出现类似：

```text
%MUSE2

X: 1
T: <song title>
M: 4/4
L: 1/8
Q:1/4=66
K:G
```

因此项目策略从：

```text
reverse 1.8 MB C++ executable
```

转变为：

```text
reverse JCX grammar
→ TypeScript AST
→ Domain Model
→ Renderer / Editor / Playback
```

这也是当前路线必须坚持的核心判断。

---

# 7. 当前 Corpus

## 7.1 本地 Legacy Corpus

当前用户本地有 11 个真实 `.jcx`：

```text
legacy-corpus/jcx/
├── corpus#01.jcx
├── corpus#02.jcx
├── corpus#03.jcx
├── corpus#04.jcx
├── corpus#05.jcx
├── corpus#06.jcx
├── corpus#07.jcx
├── corpus#08.jcx
├── corpus#09.jcx
├── corpus#10.jcx
└── corpus#11.jcx
```

这些文件仅用于：

- 格式逆向
- 本地 regression
- compatibility testing

---

## 7.2 Git 策略

原歌曲文件不应提交。

建议保持：

```text
legacy-corpus/
  README.md
  jcx/
    .gitkeep
    *.jcx    # ignored
```

`.gitignore` 应包含类似：

```gitignore
/legacy-corpus/jcx/*
!/legacy-corpus/jcx/.gitkeep
```

如果本地还生成：

```text
MANIFEST.txt
```

也可以保持 ignored。

---

## 7.3 Generated Report

Scanner 输出：

```text
docs/generated/jcx-corpus-report.json
docs/generated/jcx-corpus-report.md
```

建议：

```gitignore
/docs/generated/
```

原因：

- 报告由本地 legacy corpus 派生；
- Markdown 中可能出现原始歌曲内容；
- 不适合作为公开 repo 的永久资产；
- 可以随 corpus 变化重新生成。

真正应该提交的是人工整理后的：

```text
docs/JCX_SPEC.md
```

---

# 8. Corpus Scanner v0.2

当前 Scanner 已完成并建议冻结。

目录：

```text
scripts/
└── jcx/
    ├── scan-corpus.ts
    └── lib/
        ├── decodeJcx.ts
        ├── classifyLine.ts
        └── types.ts
```

入口：

```bash
npm run jcx:scan
```

---

## 8.1 Scanner 职责

Scanner 是：

> **Corpus Discovery Tool**

它的任务是：

- 发现语法
- 统计语法
- 暴露未知
- 给 `JCX_SPEC` 提供 evidence

它不是：

- 正式 Parser
- AST builder
- Domain model parser
- Serializer

后续不要因为发现更多乐谱细节，就继续向 Scanner 中塞完整 parser 逻辑。

---

## 8.2 Decoder

当前 Decoder 已考虑：

```text
UTF-8
UTF-16LE
UTF-16BE
GB18030
```

实际 corpus 结果：

```text
GB18030 × 10
UTF-8   × 1
```

因此正式 JCX format layer 必须保留：

```ts
interface JcxSource {
  text: string;
  encoding:
    | 'utf-8'
    | 'gb18030'
    | 'utf-16le'
    | 'utf-16be';
}
```

不要只返回裸字符串。

---

# 9. Scanner v0.2 最终结果

当前真实扫描结果：

```text
Files:            11
Lines:            753
Bytes:            55467
Headers:          10 unique
Inline fields:    1 unique
Text block lines: 6
Directives:       6 unique
Voice styles:     3 unique
Body features:    15 discovered
Unknown lines:    0
Unknown patterns: 0
```

这意味着：

> 在当前 11 个真实样本中，所有“整行级结构”都已经被 Scanner 分类解释。

注意：

> `Unknown = 0` **不代表正文 token grammar 已经完整恢复**。

正文中的 note/duration/decorations/chord/tab syntax 仍然需要正式 Lexer 和 Parser。

---

# 10. 当前发现的 JCX Encoding

Corpus：

```text
gb18030 × 10
utf-8   × 1
```

后续序列化策略建议：

```text
default:
UTF-8

compatibility:
preserve source encoding
or
explicit GB18030
```

Node 内建 `TextDecoder` 可以读取 GB18030，但写回 GB18030 时需要注意：

> `TextEncoder` 只提供 UTF-8。

后续 Serializer 如需 GB18030 输出，可以考虑：

```text
iconv-lite
```

或者其他纯 JS/TS 可维护方案。

不要为了编码引入原生模块，除非必要。

---

# 11. Magic Header

Corpus 中：

```text
%MUSE2
```

只出现：

```text
6 / 11 files
```

所以它不是 parser 可以强制要求的 magic。

错误做法：

```ts
if (!source.startsWith('%MUSE2')) {
  throw ...
}
```

建议：

```ts
interface JcxDocument {
  formatMarker?: '%MUSE2';
}
```

这暗示 Muse 可以处理：

```text
Muse-native JCX
+
普通/接近普通 ABC
```

两类输入。

---

# 12. 当前发现的 Header

Corpus 共发现 10 种：

```text
w
C
V
T
L
K
M
I
Q
X
```

频率：

```text
w  × 94
C  × 27
V  × 27
T  × 19
L  × 16
K  × 11
M  × 11
I  × 6
Q  × 1
X  × 1
```

当前推荐语义：

| Field | 当前理解 |
|---|---|
| `X:` | ABC reference number |
| `T:` | Title，可重复 |
| `C:` | Composer / credit 类字段 |
| `M:` | Meter |
| `L:` | Default note length |
| `Q:` | Tempo |
| `K:` | Key |
| `V:` | Voice definition |
| `w:` | Lyric line |
| `I:` | Instruction / application information |

`I:` 的具体 Muse 使用方式需要继续在 `JCX_SPEC` 中分析，不要过早固定成单一含义。

---

# 13. Inline Field

Scanner 已确认：

```text
[V:1]
[V: 1]
```

两种形式都存在。

总数：

```text
V × 39
```

因此 grammar 至少应接受：

```ebnf
inline-field =
  "[" ws? field-name ws? ":" ws? field-value "]"
```

当前 corpus 唯一确认的 inline field：

```text
V
```

语义：

```text
切换当前 Voice
```

注意 Muse 对空格比较宽松：

```text
[V:1]
[V: 1]
```

都应接受。

---

# 14. Directives

当前 corpus 发现 6 类：

```text
%%gchord
%%showfinger
%%begintext
%%endtext
%%skip
%%indent
```

频率：

```text
gchord     × 6
showfinger × 3
begintext  × 2
endtext    × 2
skip       × 2
indent     × 1
```

推荐初步分类：

```text
Directives
│
├── Guitar / Muse extensions
│   ├── %%gchord
│   └── %%showfinger
│
├── Text
│   ├── %%begintext
│   └── %%endtext
│
└── Layout
    ├── %%skip
    └── %%indent
```

---

# 15. Text Block

已确认：

```text
%%begintext
...
%%endtext
```

中间内容必须：

- verbatim 保存
- 不 trim
- 不解析成乐谱
- 不进入 body lexer
- 不因为包含 A-G 字母而判断为 note

当前 corpus：

```text
Text block lines = 6
```

来自两个 text block，每个 3 行。

正式 Parser 应建模成类似：

```ts
interface JcxTextBlock {
  type: 'text-block';
  lines: string[];
}
```

最好同时保留：

```ts
raw: string
```

或 source span，以支持 lossless round-trip。

---

# 16. Voice

这是 JCX 最关键的 Muse 扩展之一。

当前 corpus 共发现：

```text
V header × 27
```

并发现 3 类显式 style：

```text
jianpu × 9
tab    × 8
staff  × 1
```

---

## 16.1 Voice 示例

历史样本中存在类似：

```text
V:1 name="吉他伴奏" style=tab clef=standardtab ins=24 vol=40 bracket=2
V:2 name="主旋律" style=jianpu ins=1 vol=100
```

也存在：

```text
V:1 style=tab name=伴奏吉他 play=1 instrument=25 volumn=20 bracket=3
```

---

## 16.2 两套属性命名

这是已经确认的重要兼容点。

旧式：

```text
ins=24
vol=40
```

另一套：

```text
instrument=24
volumn=46
play=1
```

因此 Parser 不能让磁盘字段直接污染 Domain Model。

建议归一化：

```text
ins
instrument
    ↓
instrument

vol
volumn
    ↓
volume
```

其中：

```text
volumn
```

虽然拼写看起来像 typo，但它是真实 legacy syntax，不能“修正后不再兼容”。

---

## 16.3 推荐 Domain Model

```ts
interface MuseVoice {
  id: string;

  name?: string;

  style?: 'staff' | 'jianpu' | 'tab';

  instrument?: number;
  volume?: number;
  play?: boolean;

  clef?: string;
  bracket?: number;
}
```

后续若遇到未知 style，不应直接 throw。

更稳健方案：

```ts
type MuseVoiceStyle =
  | 'staff'
  | 'jianpu'
  | 'tab'
  | string;
```

或者 Domain Model 分离 known/unknown。

---

## 16.4 Style 不是必需字段

`corpus#08` 有：

```text
9 voices
```

但这 9 个 Voice 都没有 `style=`。

其 Voice 大致为：

```text
V:1
V:2 ins=69
V:3 ins=33
...
```

所以：

```ts
style?: ...
```

必须 optional。

不要写：

```ts
style: 'staff' | 'jianpu' | 'tab';
```

并强制要求存在。

---

# 17. corpus#08 是特殊样本

这个文件建议后续单独作为 compatibility case。

它同时具备：

```text
唯一 UTF-8
唯一 X:
唯一 Q:
9 个 Voice
Voice 基本无 Muse style
大量 accidental
大量 note-chord
大量 ties
大量 tuplets
```

它很可能：

- 来源不同；
- 更接近普通 ABC；
- 或由 MIDI/ABC 转换链生成；
- 或属于 Muse 可以兼容读取的外部 ABC 风格。

不要把它当作异常删掉。

相反：

> 它是验证“JCX parser 是否真正兼容 ABC-like input”的关键样本。

---

# 18. Guitar Chord 扩展

`.jcx` 中已经确认真实存在：

```text
%%gchord
```

历史样本：

```text
%%gchord D=1;X,X,0,2,3,2
%%gchord G7=1;3,2,0,0,0,1
%%gchord C=1;X,3,2,0,1,0
%%gchord A=1;X,0,2,2,2,0
%%gchord Em=1;0,2,2,0,0,0
%%gchord G=1;3(3),2(2),0,0,0,3(4)
```

初步解释：

```text
X       muted string
0       open string
3       fret
3(4)    fret 3, finger 4
```

等号后：

```text
G=1;...
```

中的 `1` 很可能和 base fret / first fret 有关。

这一点仍需标为：

```text
INFERRED / UNVERIFIED
```

直到进一步从帮助文档或行为验证。

---

# 19. Chord Domain Model 建议

不要把 legacy `points / lines / crosses` 作为 core data model。

建议：

```ts
interface GuitarChord {
  id: string;

  name: string;

  root?: PitchClass;
  quality?: ChordQuality;
  bass?: PitchClass;

  baseFret: number;

  strings: [
    GuitarString,
    GuitarString,
    GuitarString,
    GuitarString,
    GuitarString,
    GuitarString,
  ];

  barres: Barre[];

  display: {
    showDiagram: boolean;
    showFingers: boolean;
    showOpenMuted: boolean;
    showName: boolean;
  };
}

interface GuitarString {
  fret: number | null;

  state:
    | 'fretted'
    | 'open'
    | 'muted';

  finger?: 1 | 2 | 3 | 4;
}

interface Barre {
  fret: number;
  fromString: number;
  toString: number;
  finger?: number;
}
```

JCX：

```text
%%gchord
```

应该只是 format adapter。

---

# 20. guitar-tabs-editor 参考项目

用户还有一个仓库：

```text
https://github.com/jiangding01/guitar-tabs-editor
```

它是：

```text
haixiangyan/guitar-tabs-editor
```

的 fork。

License：

```text
MIT
```

它对 Muse Next 有参考价值，但不能直接成为 Muse Core。

---

## 20.1 有价值的代码

重点可参考：

```text
src/components/Chord/Chord.jsx
src/components/Chord/parseSource.js
src/components/Chord/utils.js
src/components/TabP/TabP.jsx
src/components/Previewer/Body/Parser.js
src/components/Previewer/Body/Lyrics/Lyrics.jsx
src/assets/dataSource/chords.js
```

---

## 20.2 Chord renderer

已有 SVG 和弦图能力：

- 6 strings
- 5 frets
- dot
- barre
- muted X
- finger number
- chord name
- high-position chord
- small / large mode

这些几何计算可以：

```text
提取
→ 重写为现代 TypeScript
→ 变成 notation/chord adapter
```

但不要让其旧数据结构定义 Muse Core。

---

## 20.3 TAB renderer 的局限

原项目的 ASCII TAB 解析比较简单。

历史分析中注意到类似：

```js
/([\d])/g
```

这种实现。

意味着：

```text
10
12
15
```

等多位品位可能处理错误。

因此：

> 可以借鉴 UI/Geometry，不要直接复用 parser 作为 Muse TAB parser。

---

# 21. 当前正文 Syntax Discovery

Scanner 当前识别出 15 类正文特征：

```text
barline
note
fractional-duration
explicit-duration
quoted-annotation
note-chord
rest
accidental
slur-like-group
tie-or-hyphen
bang-decoration
broken-rhythm
grace-group
tuplet
repeat
```

频率最高的一些：

```text
barline              423
note                 415
fractional-duration  355
explicit-duration    213
quoted-annotation    189
note-chord            132
rest                  110
accidental             81
```

注意：

> Scanner 的 feature detector 只是发现语法“存在”，不是正式 grammar。

例如：

```text
tie-or-hyphen
slur-like-group
quoted-annotation
```

仍需正式 Lexer/Parser 精确定义。

---

# 22. 当前推荐整体架构

核心原则：

```text
JCX
 ↓
Lossless JCX AST
 ↓
Normalized Muse Domain Model
 ↓
Layout Model
 ↓
Renderer / MIDI / Editor
```

不要：

```text
JCX
 ↓
VexFlow objects
```

VexFlow 应只是 Renderer Adapter，不是 Domain Model。

---

# 23. Desktop 技术路线

项目当前建立的技术路线是：

```text
Electron
Electron Forge
React
Vite
TypeScript
Zustand
Vitest
```

历史 scaffold 选择版本：

```text
Electron 44
Electron Forge 7
React 19.3
Vite 8
TypeScript 5.9
Vitest 5
```

具体版本请：

> **以当前本地 `package.json` 为最终事实。**

不要为了“和 HANDOFF 一样”强行降级/升级依赖。

---

# 24. Electron 边界

推荐保持：

```text
Electron Main
├─ File IO
├─ Native dialogs
├─ Print
├─ PDF
├─ MIDI device / native integration
└─ app lifecycle

Preload
└─ Typed IPC bridge

Renderer
├─ React UI
├─ Editor
├─ Notation
└─ State
```

安全设置应保持：

```ts
contextIsolation: true
nodeIntegration: false
sandbox: true
```

Renderer 不要直接：

```ts
import fs from 'node:fs';
```

格式层则应该尽量完全独立于 Electron：

```text
src/formats/jcx
```

必须可以在：

```text
Vitest
Node scripts
Electron
future web app
```

中复用。

---

# 25. 推荐源码分层

目标结构可逐渐收敛为：

```text
src/
├── main/
│   └── ...
├── preload/
│   └── ...
├── shared/
│   └── ipc.ts
├── formats/
│   └── jcx/
│       ├── decode/
│       ├── lexer/
│       ├── parser/
│       ├── serializer/
│       ├── ast/
│       └── normalize/
├── domain/
│   ├── score/
│   ├── voice/
│   ├── note/
│   ├── chord/
│   └── tab/
├── notation/
│   ├── staff/
│   ├── jianpu/
│   ├── tab/
│   └── chord/
├── editor/
│   ├── commands/
│   ├── selection/
│   ├── history/
│   └── chord/
├── playback/
│   ├── transport/
│   ├── midi/
│   └── audio/
└── renderer/
    ├── app/
    ├── components/
    └── styles/
```

不要求一次性全部创建空目录。

只在进入对应 milestone 时建立。

---

# 26. 当前项目中已讨论/建立的 JCX 文件

**M1.4 / M1.5 更新（本节此前的清单已过时，按下方为准）：**

Scanner（M1.1，不变）：

```text
scripts/jcx/scan-corpus.ts
scripts/jcx/lib/decodeJcx.ts
scripts/jcx/lib/classifyLine.ts
scripts/jcx/lib/types.ts
```

语料回归 + 共享校验逻辑（M1.4 / M1.5 T6 新增）：

```text
scripts/jcx/corpus-lex-test.ts     # npm run jcx:corpus-test；Lexer + AST 两级断言
scripts/jcx/lib/astInvariants.ts    # AST 不变量校验，测试与脚本共用，避免两份实现漂移
```

正式的 JCX 格式层实现（M1.4 Lexer + M1.5 AST + M1.6 Parser，详见 §30.1 的
文件结构清单）：

```text
src/formats/jcx/index.ts      # 对外唯一入口：loadJcx + 类型再导出
src/formats/jcx/loadJcx.ts     # lexJcx → buildAst → parseJcxDocument 一站式
src/formats/jcx/encoding/       # 编码检测 + 解码
src/formats/jcx/lexer/           # M1.4：source → token 流
src/formats/jcx/ast/              # M1.5：token 流 → Lossless AST
src/formats/jcx/parse/             # M1.6：AST → Domain（归一化 + diagnostics）
src/domain/                         # M1.6：纯音乐模型，零 formats 依赖
```

**M1.6 T10b 已删除的早期 scaffold**（M0 时期产物，不要再去找它们，也不要按
旧签名写代码）：`src/formats/jcx/parseJcx.ts`、`src/formats/jcx/parseGChord.ts`、
`src/domain/music.ts`（旧 `MuseScoreDocument` / `MuseTrack` / `GuitarChord.baseFret`），
以及对应的 `tests/unit/parseJcx.test.ts`、`tests/unit/parseGChord.test.ts`、
`tests/fixtures/minimal.jcx`。应用层现状：

```text
src/renderer/app/store.ts             # 走 loadJcx，状态为 { score, diagnostics }
src/renderer/components/*.tsx          # 读 score.titles/credits/voices/chordShapes + 诊断列表
src/notation/chord/ChordDiagram.tsx     # 读 domain 的 GuitarChord（capoFret + strings[6]）
```

接手 Agent 开始工作前应先检查真实项目树：

```bash
find src scripts docs tests -maxdepth 4 -type f | sort
```

不要仅根据本 HANDOFF 假设所有早期 scaffold 文件仍保持原样。

---

# 27. TypeScript 工程约束

当前根级：

```text
tsconfig.json
```

应启用较严格配置。

关键选项：

```json
{
  "strict": true,
  "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true,
  "noImplicitOverride": true,
  "noFallthroughCasesInSwitch": true,
  "noImplicitReturns": true,
  "noEmit": true
}
```

这些严格模式是有意的。

不要为了快速消灭错误而关闭：

```text
strict
noUncheckedIndexedAccess
exactOptionalPropertyTypes
```

尤其 Parser 很依赖这些检查来避免：

- token 越界
- optional field 错误
- 不完整 switch
- 非法状态

---

# 28. 当前开发命令

已使用：

```bash
npm run typecheck
npm run jcx:scan
```

典型：

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "jcx:scan": "tsx scripts/jcx/scan-corpus.ts"
  }
}
```

接手后首先执行：

```bash
npm install
npm run typecheck
npm run jcx:scan
```

如果项目已有 test：

```bash
npm test
```

如果 Electron dev script 已配置：

```bash
npm run dev
```

具体以 `package.json` 为准。

---

# 29. Scanner 历史坑：不要回退

Scanner 初版曾有一个错误策略：

> 一旦进入 Voice，所有无法识别的行都自动当作 body。

伪代码：

```ts
if (
  classified.kind === 'unknown' &&
  hasActiveVoice
) {
  classified.kind = 'body';
}
```

这会造成：

```text
Unknown = 0
```

但这个 0 是假的。

后来已经移除这个策略。

第二轮扫描暴露：

```text
Unknown lines    45
Unknown patterns 5
```

随后分析确认：

```text
39 条 = inline [V:...]
6 条  = text block content
```

Scanner v0.2 正式加入：

```text
inline-field
text block state
```

最终才得到真正的：

```text
Unknown = 0
```

接手 Agent 不要再恢复“自动吞 Unknown”的策略。

---

# 30. 当前 Milestone

当前状态：

```text
✅ M0
Project initialization / scaffold

✅ M1.1
Corpus Scanner v0.2

✅ M1.2
Corpus Discovery / first analysis

✅ M1.3
JCX_SPEC.md v0.1

✅ M1.4
Lexer / Tokenizer

✅ M1.5
Lossless JCX AST

✅ M1.6
Parser / Domain Model

✅ M1.7
Serializer

✅ M1.8
Round-trip compatibility（fixture 矩阵 + closure + CI 看板，见 §30.1「M1.8
实际状态」；2026-09-16 GitHub Actions run 35054230663 于 macOS/Windows/Ubuntu
三平台 typecheck / test / fixture report 全绿后封板）

✅ M2
Notation Rendering（T0–T9 已完成，已推送：Chord / Jianpu / TAB / Staff 四种记谱可渲染，
T8 render matrix 契约测试（C1/C2/C3）与 T9 文档封板均已完成；
T7 ✅ 2026-09-22 封板（CI run 35696163723）；M2 ✅ 2026-09-22 封板：24d233c 推送后
GitHub Actions run 35700198783 macOS/Ubuntu/Windows 三平台 typecheck / test / fixture-report 全绿；
现状与债务总表见 §30.1「M2 进行中状态」）

→ M2.5
Score System Layout（乐谱系统版式：跨声部按小节对齐的统一 spacing、`bracket=N` 视觉分组成系统、
和弦图作为 system overlay（开启 D11 和弦名→`%%gchord`，同名 >1 不猜只画名 + 诊断）、TAB beam grouping、
两端对齐、歌词随简谱行、按系统分页；目标版式与架构边界见 `docs/UI_DESIGN_BRIEF.md` §2.7 / §10.16–10.18；
2026-09-22 用户裁决插在 M3 之前；方案已冻结为 `docs/M2.5_SYSTEM_LAYOUT_PLAN.md` v1.0；
T0 ✅ 2026-10-04（`6e5a532`，CI run 37137587990 三平台全绿；命名修订 `3f5b48c`）；
T1 ✅ 2026-10-04（`2b9882c`，CI run 37140019863 三平台全绿）；
T2 ✅ 2026-10-04（`218d143`，CI run 37177350122 三平台全绿）；
T2.1 ✅ 2026-10-04（`9037351`，CI run 37181088740 三平台全绿，小节错位锁存）；
T3 ✅ 2026-10-04（`7ee1e27`，CI run 37189546271 三平台全绿，共享小节时间轴）；
T3.5 ✅ 2026-10-04（`d2486aa`，CI run 37212689335 三平台全绿，TAB / 简谱节奏刻印）；
T4 ✅ 2026-10-05（`9661810`，CI run 37271250936 三平台全绿，公共几何编排）；
T5 ✅ 2026-10-05（`ed4ea88`，CI run 37284116914 三平台全绿，外部几何适配）；
T5.S ✅ 2026-10-05（VexFlow shared timing spike，`feasible-with-cost` / no adapter merged，Staff 保持 tier 1）；
T6 ✅ 2026-10-05（`c74094e`，CI run 37296973259 三平台全绿，和弦图层水平规划）；
T8 ✅ 2026-10-05（`b513261`，CI run 37305952319 三平台全绿，最终系统纵向编排）；
T9a ✅ 2026-10-05（`49b0e11`，CI run 37312875513 三平台全绿，页面模型）；
T9b ✅ 2026-10-05（`9eb5722`，CI run 37325626662 三平台全绿，renderer system 化），下一步先裁决 Staff 纵向墨迹越界，T9c 待用户指令）

→ M3
Editor Core

→ M4
Playback / MIDI

→ M5
Import / Export / Print

→ M6
Compatibility hardening / Packaging
```

## 30.1 M1.4 / M1.5 实际状态

M1.4（Lexer）与 M1.5（Lossless AST）已完成并通过 §56 / §57 的 DoD（逐条证据见
本节末尾）。给下一位接手 Agent 的现状快照：

**文件结构**（`src/formats/jcx/{encoding,lexer,ast}/`）：

```text
src/formats/jcx/
  encoding/
    decodeJcx.ts        编码检测 + 解码（BOM → ASCII → UTF-8 → GB18030 兜底）
    types.ts
  lexer/
    index.ts             对外入口 lexJcx()
    lexDocument.ts        逐行分类主循环（含 text block 状态机）
    lexLineKinds.ts        行级 token 化：field / directive / inline field / magic header 等
    lexModes.ts             §13.2 pitch/tab 模式状态机
    lexBody.ts / lexBodyCommon.ts / lexBodyPitch.ts / lexBodyTab.ts
                             正文 token 化（含 M1.5 T4 前置的 N/ 修复，见下）
    lineSplit.ts             CRLF/LF 行切分，行尾 eol token
    lineVocabulary.ts        行级正则 / 关键字表
    sourceSpan.ts            SourceSpan 工具
    token.ts                 token 类型总表 + flattenTokens/rawOf
    tokenBuilder.ts           行内 token 累积器
    diagnostics.ts            JcxDiagnostic 类型 + 构造
  ast/
    index.ts               对外入口 buildAst() + 类型重导出
    nodes.ts                 AST 节点总表（T1）
    astPath.ts                AstPath 构造/解析（行级 Lx.y、文档级 D.bom）
    buildLines.ts              行级 builder：9 种行 kind → JcxLineNode
    buildBodyLine.ts            inlineFieldLine / bodyLine 外壳装箱
    buildBodyItems.ts            正文 token 流 → note/rest/chord/grace/tabNote/tabGroup 分组主循环
    groupPitch.ts / groupTab.ts / groupBrackets.ts
                                 note/tabNote 组合规则、chord/grace/tabGroup 括号组合（参数化，防导入环）
    tokenCursor.ts                token 流游标（分组阶段用）
    leaf.ts                        token → 叶子节点构造
    printAst.ts                    AST → 原文还原（printNode/printLine/printAst）
```

**核心不变量**：

- Lexer 层：`flattenTokens(lines)` 的 `raw` 拼接 `=== decodeJcx(bytes).text`；
  逐行同理（§29.5）。
- AST 层：`printAst(buildAst(lexJcx(bytes))) === decodeJcx(bytes).text`。
- 两层都**零归一化、零自产 diagnostic**——AST 的 `diagnostics` 字段与
  `lexJcx` 的 `diagnostics` 是同一个数组引用（不复制、不新增）。

**AST 边界**（M1.5 已拍板，不在 M1.6 之前重新讨论）：

- A–F 六条组合规则：note = `accidental* pitchLetter octaveMark* duration?`；
  rest = `(rest|hiddenRest) (duration? | tabDurSep duration?)`；chord/grace/
  tabGroup 是括号组合，未闭合时省略 `close` 而不是拒绝构造；tabNote =
  `strokePrefix? stringLetter fret? tabDurSep? duration?`；brokenRhythm /
  tie / slur / tupletStart / tabRelation 永远是 note 的兄弟节点，不并入 note；
  `V:` 等字段行不切属性，只保留整段 `fieldValue`。
- 分组是 **mode-free** 的：分组器不读 `line.mode`，只读 token kind（lexer 已经
  在词法层用不同 token kind 区分了 pitch 与 tab，如 `pitchLetter` vs
  `stringLetter`、`chordOpen` vs `tabGroupOpen`）。
- 通用叶子（`kind: 'token'`）是**永久合法**的 fallback，不是待补全的占位——
  无法安全组合的 token（孤立 duration、多余的 `]`、悬空 strokePrefix……）原样
  落地为通用叶子，语料回归里的「残留通用叶子」清单是现状快照，不是缺陷清单
  （见下方语料回归结果）。
- `AstPath` 只承诺「同一次快照内唯一且确定」，不承诺跨编辑稳定；行级用
  `Lx[.y...]`，文档级（目前只有 BOM）用 `D.bom`；textBlock 内部子节点复用
  begin 行的 `Lx` 作为 path 基座（`Lx.0` 是 begin，`Lx.1..n` 是内容行，
  `Lx.(n+1)` 是 end），避免与 begin 行自身的物理行号 path 碰撞。

**测试与语料回归命令**：

```bash
npm run typecheck
npx vitest run
npm run jcx:corpus-test   # 语料不进 git，本地跑；CI 上目录缺失会打印 skip 并 exit 0
npm run jcx:scan
```

**语料回归结果**（11 个本地文件，`npm run jcx:corpus-test` 实际输出，两级）：

- Lexer 级：11/11 OK（0 个 error 级 diagnostic；1 个 warning；29 个 info；
  1 个 raw token，即 §26.4 U34a 那个孤立 `.`）。
- AST 级（M1.5 T6 新增）：`printAst` 全文不变量 + 逐行不变量 + path 唯一性
  递归检查（含 BOM、textBlock 的 begin/lines/end、body 组合节点及全部叶子）
  ——11/11 OK。
- **残留通用叶子**（**item 位置**口径，只统计 `bodyLine.items` /
  `inlineFieldLine.trailing` / chord-grace-tabGroup 的 `items`（含嵌套）里的
  `kind === 'token'` 节点，不算 note/rest/tabNote 内部 children、括号组
  open/close、字段行外壳 children——那些要么已被组合节点消费，要么是专用叶子，
  不是「没被组合」；`scripts/jcx/lib/astInvariants.ts` 的
  `collectResidualItemLeaves` 与 `tests/unit/jcx/ast/preservation.test.ts`
  里的两个固定用例——`"C2 |"` 残留 0、`"|2 |"` 残留 1——钉住这个口径；只是观测
  指标，不是失败条件）：全语料共 **1 个**，即 `corpus#10` 第 101 行
  `|||2` 之后那个裸露的 `duration` 叶子（`2`）——它前面没有 pitchLetter 可
  依附，不能组成 note，落在 bodyLine.items 里原样保留。这正是**真实语料中
  未解释的 syntax residual**：JCX_SPEC §19.2 / Appendix A U26 已经调查过它，
  结论是更像笔误而非跳房子记号，证据不足以实现任何语义，Lossless AST 按设计
  原样保留，不猜测语义，留给 M1.6 或后续更多证据出现时再处理。
- Lexer `N/` 修复（`9c812f1`）：ABC 2.1 §4.3 的 `N/` 简写（等价 `N/2`）此前被
  切成两个 duration token，`D3/` 这种写法因此不能被 note 完整吸收；修复后
  `DURATION_RE` 按 `N/N` → `N/` → `N` 的顺序尝试最长匹配，语料里唯一一处
  `D3/`（`corpus#08`）不再产生孤立 duration 叶子。

**DoD 证据**（对应 §56 / §57，逐条见文件/测试/命令而非重新誊写清单本身）：

- §56（M1.4 DoD）：不依赖 Electron / pure TypeScript —— `src/formats/jcx/{encoding,lexer}/`
  下 `grep -rn "electron"` 无命中；source spans —— `lexer/sourceSpan.ts` +
  每个 token 的 `span`；raw lexeme —— `token.raw`；no uncaught error on 11-file
  corpus / self-authored fixtures / strict TypeScript passes —— 均见上方语料
  回归结果与 `npm run typecheck`。
- §57（M1.5 DoD）：lossless / comments preserved / text blocks preserved /
  directive raw value preserved / duplicate fields preserved / order
  preserved / inline fields preserved —— `tests/unit/jcx/ast/lossless.test.ts`
  对全部 fixture 的断言①（`printAst === decodedText`）与本轮新增的
  `tests/unit/jcx/ast/preservation.test.ts`（`duplicate-fields.jcx` 等）；
  unknown/future syntax representation —— 通用叶子机制（`nodes.ts`）；source
  span —— 每个节点的 `span`；no renderer dependency —— `src/formats/jcx/ast/`
  下无任何渲染层 import。

**已知工程限制**（实现内部一致性问题，不是 JCX 格式语义未验证，因此不进
`JCX_SPEC.md` Appendix A）：

- **orderly 模式下「当前声部」判定在两个模块里不一致**（M1.6 T8 排查歌词对齐
  时发现）：`src/formats/jcx/parse/body/segments.ts` 的 `advanceOrderly`
  （T5 P1 修复）按 body 区 `V:` 行**自身写的 id** 切换「当前声部」，决定段落
  归属（`VoiceSegment.voiceId`）；但决定**词法扫描模式**（pitch 还是 tab，
  直接影响正文 token 被切成 `note`/`chord` 还是 `tabNote`/`tabGroup`）的
  `src/formats/jcx/lexer/lexModes.ts` 的 `resolveMode`（`'field'` 分支，约
  L335–349）仍按**声明顺序位置** `prescan.order[state.segmentIndex]` clamp，
  不看该行自身写的 id。两者在现有 11 个语料文件上从未分叉（`segments.ts`
  文件头注释已如此声称），但用最小构造样本可复现分叉：2 个声部、`V:2` 声明
  `style=tab`，body 区用 `V:2` 切换到该声部——`segments.ts` 正确把后续正文
  行归到 v2，但 `lexModes.ts` 仍按 position 把它解析成 pitch 模式，导致
  T6 扫出的事件 kind 与「预期该声部的 style」不一致。复现文件已用于 M1.6 T8
  的排查（未入库，属临时调试产物）。
  - 影响面：仅当 orderly 模式（无 `[V:...]`）下同时出现「≥2 个声部且 style
    不同」时才可能触发；11 个语料文件全部使用 `[V:...]`（inline 模式）或单
    一 style，不受影响。
  - 修复方向：统一两个模块的「当前声部」判定逻辑（例如让 `lexModes.ts` 也
    按行自身 id 查表，而不是 position clamp），属于 T4–T7 既有代码的改动，
    不在 M1.6 T8（歌词对齐）范围内，留给后续处理 orderly 多声部场景时一并
    解决。

### M1.6 实际状态（Parser / Domain，T10b 收口）

M1.6 已完成并通过 §58 DoD（逐条证据见本小节末尾）。管线定型为
**Lossless AST → `src/formats/jcx/parse/`（归一化）→ `src/domain/`（纯音乐模型）**，
应用层唯一入口是 `loadJcx`。

**文件结构**：

```text
src/formats/jcx/
  index.ts              对外唯一入口（loadJcx + Score/Voice/Diagnostic 等类型再导出）
  loadJcx.ts             lexJcx → buildAst → parseJcxDocument 一站式；LoadResult = ParseResult & { lex, ast }
  parse/
    index.ts              parseJcxDocument()；ParseResult { score, diagnostics, index } 的唯一定义处
    origin.ts              AST 节点 → SourceRef（AstPath 字符串）
    diagnostics.ts          parse 层 DiagnosticBag（`jcx.parse.<area>.<problem>`）
    header.ts               header 字段归一化（T/C/I/N/X/M/L/Q/K + unknown/ignored 分流）
    keyMeter.ts              M: / K: / Q: 解析（C、C| 等只留 raw）
    duration.ts               durationRaw × unitLength → Rational（L: 缺省推导）
    voice.ts                   V: 属性别名归一化 + unknownAttributes
    gchord.ts / directives.ts   %%gchord → GuitarChord；全部 %% 指令 + text block
    buildIndex.ts               DomainIndex（byPath / eventById / relationById / relationsByNote / voiceById）
    body/
      segments.ts                段落 → 声部归属（inline [V:n] 与 orderly 两种模式）
      scan.ts / scanLeaf.ts / scanPitch.ts / scanTab.ts
                                  AST item → MusicEvent + ScanMarker（marker 不进 events）
      pairing.ts + pairTies / pairSlurs / pairTuplets / pairTabRelations /
      pairBrokenRhythm / pairShared
                                  marker 配对为 Relation；broken rhythm 直接改写相邻时值
      lyrics.ts                    w: 音节对齐到可唱事件
src/domain/
  index.ts       公共入口 + DomainIndex 定义
  rational.ts     Rational（den>0、gcd=1；cmp 用 BigInt 交叉乘，无浮点近似）
  ids.ts           VoiceId / EventId / RelationId / NoteRef / noteRefKey
  sourceRef.ts      SourceRef（domain 自有的字符串类型，不 import AstPath）
  event.ts           MusicEvent 十个分支 + Note/Rest/TabNote/Decoration/ChordSymbol 值对象
  relation.ts         Tie / Slur / Tuplet / TabRelation（status 为 parse-recovery fact）
  voice.ts             Voice + LyricLine + isKnownVoiceStyle
  score.ts              Score 聚合根 + Meter/Tempo/KeySignature/GuitarChord/RawDirective/TextBlock
```

**Domain 边界**（已拍板，不在 M1.7 之前重新讨论）：

- **Event / Relation 是唯一真相源**：syntax marker（tuplet 起始、slur 括号、
  tie 连接符、broken rhythm、TAB 关系连接符）**永远不出现在 `Voice.events`**，
  它们在 parse 层被消费成 `Voice.ties/slurs/tuplets/tabRelations`；
  `pairing.ts` 有 consumed/unhandled 审计，语料上 unhandled 恒为 0。
- **NoteRef 而非独立 NoteId**：chord member 没有独立生命周期，
  `NoteRef { eventId, memberIndex? }`，省略 `memberIndex` 即指整个事件，
  反查 key 为 `noteRefKey()` = `` `${eventId}#${memberIndex ?? ''}` ``。
- **SourceRef 是 domain 自有的 `string`**：parse 层把 `AstPath` 的字符串形式写入，
  domain 因此不需要 import ast 层。
- **Rational 不用浮点**：`fromParts` 约分前后各查一次 safe integer 越界；
  `cmp` 用 BigInt 交叉乘。
- **零 formats 依赖守卫**：`tests/unit/domain/architecture.test.ts` 递归扫描
  `src/domain/**/*.ts`，禁止 import `formats/` `renderer/` `main/` `preload/`
  `notation/` `node:` `electron`（含 type-only 与动态 import）。T10b 删除
  `music.ts` 后该测试**不再有任何豁免文件**。
- **id 只在快照内稳定**：`voiceId` 按声明序号、`eventId` 按事件流下标、
  `relationId` 按 kind + 序号，**不跨编辑稳定**，reconciliation 留给 M3。

**归一化规则要点**（完整表见方案 v1.1 §2）：

- V: 属性别名 `nm/ins/vol/volumn/brk/brc/stv/spc/gch` → 正名字段；
  未识别 `k=v`（含 `play=`）进 `unknownAttributes`，不猜别名、不提升为布尔。
- `T:/C:/I:/N:` 多条保持有序数组，禁止拼接；同 id `V:` 重复为属性级后者赢、
  origins 累加。
- `L:` 缺省且有 `M:`：`<0.75 → 1/16`，`≥0.75 → 1/8`（CONFIRMED BY DOCUMENTATION）；
  缺省且无 `M:`：`unitLength` 留空、只存 `durationRaw`、不算 `duration`（方案 §7 E1）+ warning。
- `M:C` / `C|` 不换算，只留 raw（`Meter` 的 `raw` 分支）。
- body 内 `T:/C:/M:/K:/Q:/X:` 等非法 header 字段进 `score.ignoredFields`，
  不污染正式字段（`L:`/`w:` 除外）。
- `%%gchord` 项数 ≠ 6 或形态非法时**不构造** `GuitarChord`，
  但 `Score.directives` 永久保留每一条指令原文——「解析失败」永远不等于「原文丢失」。

**Evidence 策略（§0 固定审查项第 1 条）**：任何 spec 标 UNVERIFIED 的语义
**不得**因为「看起来合理」或「语料恒为某值」提升为 Domain 行为或字段，
只保留 raw + diagnostic。当前按此处理的已知未验证项：

| 项 | Domain 表示 | 未做什么 |
| --- | --- | --- |
| `play=` (§12.2) | `Voice.unknownAttributes` | 不提升为布尔、不猜别名 |
| `Z` 多小节休止 (§15.2) | `Rest { variant: 'Z', duration? }` | 不赋多小节语义 |
| `@` 隐藏休止 (§15.3) | `Rest { variant: '@' }` | 不赋隐藏行为，正常占时 |
| tuplet `q === 0` (U25) | `Tuplet { q: undefined }` + info | 不派生任何时值缩放 |
| `corpus#10` 的 `\|\|\|2` 残留裸 `2` (U26) | `UnknownEvent { raw: '2', tokenKind: 'duration' }` | 不实现通用 `\|N` 记号 |
| 临时记号跨音符延续 (§14.3) | 只存 `Note.accidental` 原值 | 不做小节内延续推断 |
| 横按记法 (§10.1) | `GuitarChord.barres` 恒为 `[]` | 不从指法反推横按 |
| repeat 形态的 barline (§18) | `BarlineEvent.raw` | 不解析反复语义，留 M2/M4 |
| 装饰属于哪个音 (方案 E2) | `DecorationEvent` 独立事件 | 归属由 M2 渲染层推断，Domain 不固化 |
| 歌词 `-` / `_` / `\|` (§24.3) | 普通字符 | 不做连字符/延长线语义 |

**对外入口**：

```ts
import { loadJcx } from 'src/formats/jcx';
const { score, diagnostics, index, lex, ast } = loadJcx(sourceOrBytes);
```

`loadJcx` 本身永不抛异常；唯一可能逸出的是字节输入时 `decodeJcx` 的
`JcxEncodingError`（UTF-16 BOM / 不支持的编码）。**结构问题一律以 diagnostic
呈现**，因此 renderer 的 store 里没有 `error` 状态，永远有一个可渲染的 `Score`。

**验证命令**：

```bash
npm run typecheck
npx vitest run             # 34 个测试文件 / 1706 个用例
npm run jcx:corpus-test    # 三级：Lexer / AST / parse，本地语料不进 git，缺目录时 skip 并 exit 0
npm run jcx:scan
```

**语料 parse 级结果**（11 个本地文件，`npm run jcx:corpus-test` 实际输出）：

- parse 级 11/11 OK，**0 条 error 级 diagnostic**。
- 27 个 voice、9288 个 event。
- tie：1161 resolved / 12 unresolved；slur：333 closed / 0 unclosed；
  tuplet：16 complete / 0 incomplete；TAB relation 24；lyric 音节对齐 94。
- gchord 6 个（`corpus#07`），`%%` 指令 13 条。
- parse 级 diagnostic 直方图（观测指标，非失败条件）：14 个 distinct code，
  最高的是 `jcx.rest.uppercase-z` 20、`jcx.parse.lyrics.overflow` 16、
  `jcx.parse.tie.unresolved` 12、`jcx.voice.segment-by-order` 9。
- `UnknownEvent` 清单：2 个，`tokenKind` 分别是 `duration`（U26 那个 `|||2`）
  与 `raw`（U34a 那个孤立 `.`）——与 AST 级「残留通用叶子」是同源的两处，
  是真实语料中未解释的 syntax residual，不是缺陷清单。

**§58 DoD 逐条证据**：

1. *11 local corpus files parse* —— `npm run jcx:corpus-test` parse 级 11/11 OK。
2. *no crash* —— `loadJcx` 异常契约（见 `loadJcx.ts` 顶部 JSDoc）+ 语料 0 error。
3. *meaningful diagnostics* —— `parse/diagnostics.ts` + 上方 14 code 直方图；
   每条 diagnostic 带 severity、span 与 `path`（AstPath 字符串）。
4. *V aliases normalize* —— `parse/voice.ts` + `tests/unit/jcx/parse/voice.test.ts`。
5. *styles optional* —— `Voice.style?: string`（原值保留）+ `isKnownVoiceStyle`
   守卫；`tests/unit/domain/architecture.test.ts` 有该守卫的用例。
6. *UTF-8 / GB18030 supported* —— `encoding/decodeJcx.ts`；语料 10 个 gb18030 +
   1 个 utf-8 全部 OK。
7. *Muse marker optional* —— 11 个语料里 **5 个没有 `%MUSE2`**
   （`corpus#02` / `corpus#03` / `corpus#08` / `corpus#10` / `corpus#11`）
   照样 parse 通过；T10b 同时移除了 renderer store 里 scaffold 自造的
   「无 `%MUSE2` 抛错」。
8. *text block safe* —— `parse/directives.ts` 的 `toTextBlock`，未闭合时
   `closed: false` 而不是拒绝构造或丢内容。
9. *guitar directives represented* —— `Score.chordShapes`（派生，只含合法 gchord）
   + `Score.directives`（事实，全部 `%%` 原文）；
   `tests/unit/jcx/parse/gchord.test.ts` / `directives.test.ts`。
10. *music body represented structurally* —— `MusicEvent` 十分支 + 四类 Relation +
    `LyricLine`；语料 9288 个 event；`tests/unit/jcx/parse/{scan,pairing,lyrics,invariants}.test.ts`。

**已知工程限制**：沿用上方 T8 写的「orderly 模式下当前声部判定在两个模块里
不一致」小节——M1.6 收口时仍未修复，影响面与修复方向不变（语料 11 个文件
全部不受影响）。

---

### M1.7 实际状态（Serializer，T7 收口）

M1.7 已完成并通过 §59 DoD（逐条证据见本小节末尾）。管线在 M1.6 的基础上补上
出口：**preserve 模式基于 AST + `printAst`**（逐字节还原原文），**canonical
模式基于 `src/domain/` 的 `Score`**（按规范形态重排版，允许丢弃纯排版细节，
但不得输出任何 UNVERIFIED 语义）。

**文件结构**：

```text
src/formats/jcx/serialize/
  index.ts              对外唯一入口 serializeJcx（preserve/canonical 两个重载）+
                         L2 投影再导出（projectScore / projectionEquals /
                         firstProjectionDifference）
  types.ts               PreserveOptions / CanonicalOptions / SerializeResult /
                         JcxUnencodableStrategy
  encodeJcx.ts            文本 → 字节（UTF-8 / GB18030，iconv-lite），架构守卫
                         只许 import iconv-lite + encoding/* + 同目录 types
  preserve.ts             `printAst(ast)` 的薄封装：AST → 原文文本 → 目标编码字节
  canonical/
    index.ts                组装：header → %% 指令/text block → 每声部 V: 声明
                             → body；固定输出 UTF-8 / 无 BOM / LF / 末尾换行
    header.ts                header 区（%MUSE2? / X / T* / C* / I* / M / L / Q /
                             unknownFields* / K，固定 role order）
    voice.ts                 V: 声明行（声部 id 按声明序号回写、属性拼写与固定顺序、
                             引号规则）
    body.ts                  声部 body 的断行规则（unitLengthChanges 强制断行 >
                             LyricLine.bodyRange 独占一行 > 小节线后断行）+ L: 重放
    bodyEvents.ts             单个 MusicEvent → 文本
    bodyRelations.ts          Tie/Slur/Tuplet/TabRelation/BrokenRhythm → marker，
                             落位与叠加顺序规则
    bodyFields.ts             body 区 ignoredFields 重放（body 字段行 or inline 字段）
    lyrics.ts                 w: 音节回写（分隔符由 offsetInLine 精确复原）+ 按
                             bodyRange 分组插入
    directives.ts             %% 指令 + text block 重放
    diagnostic.ts             canonicalWarning 工厂
  projection/
    index.ts                 projectScore 主函数 + 类型/比较函数再导出
    types.ts                  ProjectedScore 等纯数据形状
    refs.ts                   EventId/NoteRef → (voiceIndex, eventIndex[, memberIndex])
                             归一化 + Rational 归一化
    voice.ts / events.ts      逐 voice / 逐 event 投影
    compare.ts                firstProjectionDifference / projectionEquals（只报
                             字段路径，不报值——版权边界）
```

**公开 API**：

```ts
import { serializeJcx } from 'src/formats/jcx/serialize';

serializeJcx(astOrLoadResult, { mode: 'preserve', encoding?, onUnencodable? });
serializeJcx(score, { mode: 'canonical', magicHeader? });
// => { text, bytes, encoding, diagnostics }

import { projectScore, projectionEquals, firstProjectionDifference } from 'src/formats/jcx/serialize';
```

**canonical 规则摘要**：

- **行序**（拍板 B，固定 role order，覆盖 spec §27.3「保持原顺序」）：
  `%MUSE2? → X: → T:* → C:* → I:* → M: → L: → Q: → unknownFields* → K:`；
  Domain 不保存 header 字段的源行序，「原顺序」在 Domain → 文本方向不是可得事实。
- **V: 属性拼写与顺序**（拍板 C）：固定顺序
  `name sname style clef ins vol bracket brace staves space`，`ins=`/`vol=`
  用 CONFIRMED 短别名，`name=`/`sname=`/`style=`/`clef=`/`bracket=`/`brace=`/
  `staves=`/`space=` 用语料 CONFIRMED 的全称；`unknownAttributes`（含 `play=`
  等 UNVERIFIED 属性）按原序、原拼写追加在后；不含空白的值不加引号（即使含
  `"`），含空白的值加 `key="值"`，含空白且含 `"` 的值原样输出 + warning。
- **时值只用 raw**（拍板 F）：`M:`/`Q:`/`K:` 一律写值对象的 `raw`，不从
  `num`/`den` 或 Rational 重新拼；`L:` 是唯一由数值（`unitLength` 本身，不是
  从某个事件 Rational 反算）重建的字段。
- **relation 反写顺序**：`[tuplet.raw][slur '('...] 事件本体 [tie '-'][slur
  ')'...][分隔符]`（分隔符 = brokenRhythm.raw | TAB `-S-`/`-H-`/`-P-` | 空格）；
  组员级 tie 满足「覆盖全部成员各一次且状态一致」才折叠回事件级，否则逐成员写；
  TAB 标记按端点是否同组、是否为组内末成员分三种落位规则。
- **bodyRange/unitLengthChanges 断行**：`unitLengthChanges[].beforeEventId`
  是强制断行点（优先级最高，`L:` 必须紧贴生效事件前另起一行，否则会连带改写
  同一行前面事件的语义）；`LyricLine.bodyRange` 覆盖的事件区间独占一行（多
  verse 共用同一 range，按 `first#last` 去重后只产生一条事件行）；其余区间在
  小节线之后断行。两条规则冲突（`L:` 变化点落在一条正文中间）时只能牺牲歌词
  行整体性，发 `jcx.serialize.lyric-line-split`——按 T0 不变量⑥，真实语料从
  未触发这条冲突。
- **ignoredFields 重放规则**：body 区非法 header 字段（key ∈ T/C/I/M/K/Q/X）
  没有事件位置，统一写在 body 区开头（第一个 `[V:n]` 之前）；`name ∈
  T/C/I/M/K/Q/X` 写成 body 区字段行 `N: value`，其余（尤其 `L`/`w`）写成
  inline 字段 `[name:value]`（写成字段行会被提升为正式语义）；值含 `]`
  时原样输出 + warning（inline 语法无 escape）；值含换行时整条字段丢弃 +
  warning（两种写法都是单行语法）。
- **歌词分隔规则**：`LyricSyllable.text` 已含 `~`/`*`；两个音节之间是否有
  分隔符由 `offsetInLine` 精确复原（`syllables[i+1].offsetInLine ===
  syllables[i].offsetInLine + syllables[i].text.length` 即原文紧邻、不写
  分隔符，否则写回单个空格——拍板 D 规范化空白，不追究原文是几个空白）。

**canonical 有损项**（方案 §4，DoD 已注明的确定性代价，不是缺陷）：注释行不
输出（拍板 H，Domain 不建模注释）；空行、行尾空白、缩进不输出；冒号后空白
规整为一个；`V:` 属性原拼写与原顺序丢失（改用上面的固定规则）；orderly/inline
两种正文声部标注方式统一输出成 inline `[V:n]`；未闭合 text block 保持未闭合
（决策 9，不自动补 `%%endtext`）。

**diagnostics code 清单**（`jcx.serialize.*`，`grep -rn "jcx\.serialize\." src`
实测全集，11 个）：

```text
jcx.serialize.ignored-field-dropped        jcx.serialize.ignored-field-unencodable
jcx.serialize.lyric-line-split             jcx.serialize.lyric-line-unplaceable
jcx.serialize.lyric-range-shadowed         jcx.serialize.lyric-range-unresolved
jcx.serialize.tab-relation-member-position jcx.serialize.unencodable-replaced
jcx.serialize.unit-length-unrecoverable    jcx.serialize.unit-length-unresolved
jcx.serialize.voice-value-unencodable
```

**三条已知限制**（`canonical/body.ts` 文件头，M1.7 T4 实测）：

1. 深度畸形输入不保留词法扫描上下文：未闭合 `[` 里的 `|` 原文是
   `UnknownEvent`，canonical 原样写回后脱离非法上下文，重解析成正常
   `barline`（文本一致，只是分类变）。fixture 级矩阵用 `unclosed-chord.jcx`
   点名豁免 L2 断言，钉死差异恰好只有一处（`$.voices[0].events[3].tokenKind`）。
2. ~~`TabGroupEvent.stroke` parse 层从不填充~~ **已回填（2026-09-22，M2.5
   formats preflight）**：见 §30.1 M2.5 段落，`scan.ts` 顶层循环把紧邻
   `tabGroup` 的 `strokePrefix` 绑进 `TabGroupEvent.stroke`；`canonical/
   body.ts` 的文件头注释仍写着旧状态（本任务硬规则不改 serialize 代码/
   注释，留给下一次 touch 该文件时同步）。
3. 组级时值后缀 `[CEG]2` 的 `2` 被 parse 落成独立 `UnknownEvent`，canonical
   因此输出 `[CEG] 2`（往返一致，但形态与源文本不同）。

**`unclosed-chord.jcx` 的 L2 豁免**：见上方限制①；这是 fixture 级
`roundtrip.test.ts` 矩阵里**唯一**的 L2 豁免项，用「点名 + 钉死差异位置」表达
（差异恰好只有那一处），不放宽投影本身。该 fixture 的幂等是「从第二趟起稳定」
而非「第一趟就稳定」，矩阵单独断言这一点。

**语料四级回归结果**（`npm run jcx:corpus-test` 实际输出，11 个本地文件，
不写文件名）：

- Lexer 级 / AST 级 / parse 级：沿用 §30.1 M1.6 段落的数字，均 11/11 OK。
- **round-trip 级（第四级，本次新增）**：byte-identical 11/11、
  line-identical 11/11、semantic（L2 投影相等）11/11、canonical 幂等
  11/11——真实语料**没有**命中已知限制①那类差异，四项全部 100%。

**测试数**：`npx vitest run` 43 个测试文件 / 2608 个用例全部通过；
`npm run typecheck` 无错误。

**工程限制**：preserve 编辑约定——若替换 AST 中的节点，该节点及祖先的
`span` 会失效（`printAst` 不读 `span`，打印结果仍正确，但 `span` 失效后不能
再用它定位或查 `DomainIndex.byPath`），重建内部一致的快照唯一方式是
`loadJcx(serializeJcx(...).text)`，不能就地修补旧快照的派生字段（见
`preserve.ts` 文件头）。GB18030 默认 `onUnencodable: 'error'`（`encodeJcx.ts`），
显式传 `'replace'` 才会静默替换不可编码字符并发 `jcx.serialize.
unencodable-replaced` warning；canonical 恒 UTF-8，不受此限制。

**§59 DoD 逐条证据**：

- [x] *AST → JCX* —— `preserve.ts`（`printAst` 封装）+ `canonical/index.ts`
  （`Score` → 文本）。
- [x] *UTF-8* —— `encodeJcx.ts` 的 `'utf-8'` 分支；canonical 恒 UTF-8。
- [x] *GB18030 compatibility* —— `encodeJcx.ts` 的 `iconv-lite` 分支；语料
  10 个 gb18030 文件 preserve byte-identical 全部通过。
- [x] *preserve mode* —— `preserve.ts` + fixture 级 `roundtrip.test.ts` L3
  + 语料级 byte-identical 11/11。
- [x] *canonical mode* —— `canonical/index.ts` 组装 + fixture 级 L2 矩阵
  + 语料级 semantic 11/11。
- [x] *field order* —— `header.ts`（固定 role order）+ `voice.ts`（固定属性
  顺序）。
- [x] *duplicate fields* —— preserve 直接照抄原文（AST 无归一化）；canonical
  方向 `T:`/`C:`/`I:` 保序数组按拍板规则各占一行。
- [x] *text blocks* —— `directives.ts` 的 `renderTrailingTextBlocks`（未闭合
  保持未闭合，决策 9）。
- [x] *inline fields* —— `bodyFields.ts` 的 inline `[name:value]` 分支。
- [x] *Muse directives* —— `directives.ts` 的 `renderDirectives`（`%%` 指令
  原样重放，注释除外——决策/拍板 H）。
- [x] *Voice aliases* —— `voice.ts` 的固定拼写表（拍板 C）。

11 条全部可打勾，均有对应实现文件与语料/fixture 证据；无 UNVERIFIED 项被
虚勾——「Voice aliases」只回写 CONFIRMED 的短别名/全称，不包含 spec 标
UNVERIFIED 的 `volume=`。

### M1.8 实际状态（Round-trip guardrails，T0–T4，已封板）

M1.8 T0–T4 全部完成（逐条证据见本小节末尾）并于 2026-09-16 封板：push 后
GitHub Actions run 35054230663 在 macOS/Windows/Ubuntu 三平台上 typecheck、
`npm test`、`jcx:fixture-report` 三步全绿（首次 run 35054050143 的 Windows
失败是 fixture 名路径分隔符问题，已在 `fixtureNames` 生产端归一化为 `/`，
见 3042659）。**护栏定位**：本里程碑的产出是
断言、fixture、CI 产物，`src/` 是**零行为变更**——唯一 approved 例外是 T1
在 `canonical/body.ts` 加的一条谓词：`breaksLineAfter` 把
`UnknownEvent(tokenKind: 'barline')` 也算作断行点。作用域仅限断行规划，不
改变任何事件的语义分类；对 11 个真实语料文件，canonical 输出相对
`2975c1e`（M1.8 T0，本里程碑改动前的最后一个提交）逐字节不变——真实语料
从未触发这条断行规则的差异面（该规则只影响限制①命中的畸形输入）。

**fixture 矩阵**（`tests/fixtures/jcx/**/*.jcx`，运行时 glob，实测
102 个 fixture，全部原始输入无 error 级 diagnostic）：

- L1 parse：原始字节 `loadJcx` 无 error 级 diagnostic。
- L2 语义：`project(parse(x))` 与 `project(parse(canonical(x)))` 投影相等；
  唯一豁免 `L2_KNOWN_LIMITATION = { 'unclosed-chord.jcx':
  '$.voices[0].events[3].tokenKind' }`（单一定义来源见下）。
- L3 preserve：`preserve` 输出与原字节逐字节相等。
- 幂等（观测项）：`canonical(parse(canonical(x))) === canonical(x)`。
- **canonical document closure**（M1.8 T1 新增，零豁免）：把
  `canon1 = canonical(parse(x))` 当成二级 fixture 再走一遍矩阵——不动点
  `canonical(parse(canon1)) === canon1`、L2 相等
  `project(parse(canon1)) === project(parse(canon2))`、L3 闭包
  `preserve(loadJcx(canon1.bytes)).bytes === canon1.bytes`、reparse clean
  `loadJcx(canon1.text).diagnostics` 无 error 级——四项对**全部** fixture
  生效，`unclosed-chord.jcx` 也不例外（它的豁免只作用于「原始 → canon1」
  这一层，canon1 起就是不动点）。
- reparse health（M1.8 T0 新增）：原始输入无 error 级的 fixture（clean 组，
  实测 102/102，`malformedFixtureNames` 为空集）对 canonical 输出重解析
  设硬门槛（error=0）；若未来出现 malformed fixture，只观测错误数量，不设
  硬门槛。

**判定逻辑单一来源**（M1.8 T4，方案 §6 固定审查项 10）：
`tests/unit/jcx/serialize/fixtureMatrix.ts` 是唯一的判断逻辑实现——
`checkL1`/`checkL2`/`checkL3`/`checkIdempotent`/`checkReparseClean`/
`checkClosure` 六个函数，加上 `L2_KNOWN_LIMITATION` 常量。
`roundtrip.test.ts`、`roundtrip.closure.test.ts`（vitest 矩阵）与
`scripts/jcx/fixture-report.ts`（CI 看板脚本）三处都只 import 并调用这一份
逻辑，不得各自重新实现；`git grep -n "L2_KNOWN_LIMITATION ="` 只应命中
`fixtureMatrix.ts` 一处定义。

**语料级指标口径**（`npm run jcx:corpus-test`，11 个本地文件，不写文件名，
不进 git/CI）：

- T0 起的 round-trip 级五项指标：byte-identical、line-identical、
  semantic、reparseClean、idempotent；**失败条件是其中三项**
  byte-identical / semantic / reparseClean（line-identical 与 idempotent
  只观测，不影响退出码）。
- T1 新增 closure 一项，同样是失败条件。
- 上述四项失败条件（byte-identical / semantic / reparseClean / closure）
  实测 **11/11**。
- T3 新增 encoding composition（GB18030 → UTF-8 → GB18030 三段往返），
  **分母是 GB18030 文件数**（11 个语料里 10 个是 GB18030），与上面 11/11
  分开汇报，不混分母：实测 **10/10**。
- 11 个 `jcx.serialize.*` diagnostic code（`grep -rhoE
  "jcx\.serialize\.[a-z-]+" src` 实测全集）全部至少有一条直接正向测试：
  8 个由 fixture 矩阵/既有单测覆盖，`lyric-range-unresolved` /
  `unit-length-unrecoverable` / `unit-length-unresolved` 这三个
  serializer-only defensive branch（parser 不可达）由
  `canonical.boundary.domain.test.ts` 的手造 `Score` 单测覆盖（M1.8 T2）。

**四条已知限制**（`canonical/body.ts` 文件头①②③ + 本节新增④）：

1. **词法上下文丢失类**：未闭合括号上下文（chord `[` / grace `{` / TAB
   `[`）之后紧跟一条小节线时，小节线在原文里落在非法词法扫描上下文，
   parse 层产出 `UnknownEvent(tokenKind: 'barline')`；canonical 原样写回
   `|` 之后脱离了那个非法上下文，重解析成正常 `barline`——文本一致，只是
   事件分类漂移。矩阵内唯一实例是 `unclosed-chord.jcx`（`L2_KNOWN_
   LIMITATION` 钉死差异路径 `$.voices[0].events[3].tokenKind`）。M1.8 T2
   另外验证了同一类的两种形态——未闭合 `{` 后跟小节线、未闭合 TAB `[`
   后跟小节线——差异路径同构，按硬规则（L2 豁免名单不得扩大）**未入库**
   为 fixture，只在 `canonical.boundary.test.ts` 文件头描述形态，不写
   具体语料内容。
2. ~~`TabGroupEvent.stroke` parse 层从不填充~~ **已回填（2026-09-22，M2.5
   formats preflight）**：紧邻 `tabGroup` 的 `strokePrefix`（`V[ax/bx/]`
   的 `V`）现由 `scan.ts` 顶层循环绑进 `TabGroupEvent.stroke`，canonical
   的 `${event.stroke ?? ''}[...]` 规则随之生效并写回；真悬空的
   strokePrefix（不紧邻 `[` 或弦号）仍是 UNVERIFIED，不建模、不写回。
3. 组级时值后缀 `[CEG]2` 的 `2` 被 parse 落成独立 `UnknownEvent`，
   canonical 因此输出 `[CEG] 2`（往返一致，但形态与源文本不同）。
4. **（M1.8 T2 新发现，Domain 级语义丢失，非排版有损）**：`w:` 歌词行绑定
   到一个零事件声部时，canonical 找不到可挂载的事件区间，发
   `jcx.serialize.lyric-line-unplaceable` 并把**整条 `LyricLine` 从投影里
   丢弃**（不是排版细节丢失，是 Domain 语义本身在这条路径上不可逆）。
   差异表现为 `$.voices[0].lyricLines.length` 不相等，因此**不能**作为
   矩阵 fixture（会破坏 L2 相等）；`canonical.lyrics.test.ts` 已有直接
   单测钉住这个 warning + 丢弃行为。**未新增任何 L2 豁免**——这条限制
   不进 `L2_KNOWN_LIMITATION`，只作为已知限制记录在案，M1.8 T2 的探针
   验证过一种触发形态并确认现状，未入库为 fixture。

**canonical 有损项**（在 §30.1「M1.7 实际状态」清单基础上新增一条）：
`w:` 绑定零事件声部时该歌词行被丢弃并发 `jcx.serialize.
lyric-line-unplaceable`（即上面的已知限制④；两处记录同一件事，互为
交叉引用）。

**fixture report 与 CI 看板**（M1.8 T4）：新增 `scripts/jcx/fixture-report.ts`
（`npm run jcx:fixture-report`），复用上面「判定逻辑单一来源」跑 fixture 矩阵
（不含真实语料，语料指标仍只能本地 `npm run jcx:corpus-test`），stdout 打印
显式分母的六项指标；若 `GITHUB_STEP_SUMMARY` 环境变量存在（GitHub Actions
runner 上总是存在）额外追加 Markdown 表格。`.github/workflows/ci.yml` 在
`npm test` 之后新增一步 `npm run jcx:fixture-report`，三平台
（macOS/Windows/Ubuntu，见现有 job `strategy.matrix.os`）矩阵各跑一次。

**本地实测数字**（`npm run jcx:fixture-report`，2026-09-16）：

```text
fixtures: 102
L1 parse (no error):        102/102
L2 semantic exact:          101/102   pinned known limitation: 1/102   unexpected: 0
L3 preserve byte-identical: 102/102
idempotent (observational): 102/102
closure (fixed point/L2/L3/reparse): 102/102
reparse-clean (clean fixtures): 102/102   malformed observed error count: 0 across 0 fixture(s)
```

**测试数**：`npx vitest run` 实测 47 个测试文件 / 3352 个用例全部通过；
`npm run typecheck` 无错误。测试时长增量（T1 文件头实测，`npx vitest run
tests/unit/jcx/serialize` 各跑 3 次取中位数，均为 warm run）：本文件加入前
536ms（771 用例），加入后 572ms（1140 用例），增量约 +36ms，与同机三次采样
±50ms 的极差同量级——结论是这一矩阵对整体时长没有可测量的影响，而非一个
精确数字。

**验收边界（重要）**：以上全部数字来自本地 `npm run typecheck && npx
vitest run && npm run jcx:corpus-test && npm run jcx:fixture-report` 跑绿，
**只证明 workflow 配置与脚本本身正确**；封板证据是 push 后的实际运行：
GitHub Actions run 35054230663（commit 3042659）在 macOS/Windows/Ubuntu
三平台上 `npm run typecheck`、`npm test`、`jcx:fixture-report` 全部 success，
见 §60 后勾选表最后一条。

**M1.8 §60 DoD 逐条证据**：见 §60 后的勾选表。

### M2 进行中状态（Notation Rendering，T0–T9 已完成，✅ 2026-09-22 封板，CI run 35700198783）

**恢复位置（2026-09-16，最后一次实跑：typecheck 绿、vitest 58 文件 3907 用例绿、`jcx:corpus-test` 与 `jcx:fixture-report` 未受 M2 影响）**：M2 方案 v1.1.1 已冻结（任务序 T0 模型+守卫 → T1
`buildRenderScore` → T2 SVG 基础设施+度量 → T3 Chord → T4 排布/换行+Jianpu
布局 → T5 Jianpu SVG+头部+React → T6 TAB+缩放 → T7 Staff+VexFlow adapter →
T8 最终 render matrix（契约 C1/C2/C3）→ T9 文档封板）。T0–T5 已推送，
GitHub Actions run 35087178952 三平台全绿；随后按真实语料（corpus#10，一份
两声部 TAB+简谱成品）人工 smoke 的发现做了 **T5.2 real-world hardening**
（四个 fix 提交 + 一个 breve 时值能力提交，见下）；随后 **T6 TAB 六线谱 T6.1–T6.5 全部完成**（见下），
历史规划中的下一步曾是 T7 Staff + VexFlow adapter；该阶段已于 2026-09-22 完成并封板（见下方 T7 状态段）。`src/renderer` 里只剩五线谱声部显示「五线谱渲染待 T7」占位。随后 **T8 render matrix**（C1/C2/C3 三条契约对四种记谱的用例矩阵）与 **T9 文档封板**（本节与 CHANGELOG / VALIDATION / README 的同步）均已完成（见下方 T8/T9 状态段），M2 T0–T9 全部完成并于 2026-09-22 封板（原始 seal 依据 CI run 35700198783；seal 后的 T8.1 契约收紧由 run 35702615344 三平台全绿背书；T8.1 文档收尾 HEAD 3055fae 对应 run 35702885112 亦全绿）。

**管线与边界**（已由测试守住）：`loadJcx → {Score, DomainIndex} → RenderInput
→ src/notation/model（纯函数、flat 投影，不加 Measure）→ src/notation/{chord,
jianpu}/layout → SvgNode → serializeSvg / React SvgTree`。`src/notation/**`
零 react/DOM/renderer/formats/vexflow/`node:`/AST import、零 `.tsx`
（`tests/unit/notation/architecture.test.ts`）；反方向 renderer 不得 import
AST/parse 内部、不得声明 Domain→presentation helper；尺寸常量唯一来源
`src/notation/layout/metrics/`（目录：`shared.ts` / `chord.ts` / `jianpu.ts` / `tab.ts` +
`index.ts` 汇总，外部仍 `import ... from '../layout/metrics'`；守卫扫 `src/notation/**` 的裸数值字面量，
`// numeric-guard: allow` 白名单）；诊断码唯一来源
`src/notation/model/diagnostics.ts`（`muse.render.*`，只有 info/warning，
不回写 Domain）；`Anchor` 判别联合 document/voice/event/relation +
`anchorKey()`，SVG 节点带 `data-anchor-key` 供 UI 高亮。时值
`decomposeDuration(Rational) → {base=2^-k, dots≤2, beams, dashes} |
unrepresentable`，k ∈ [0,10]，判据是精确 `d = base × {1, 3/2, 7/4}`；唯一例外是
`2/1`（breve，仅 dots=0，`BREVE_EXPONENT`，corpus#10 有证据）→ 7 条延音线，
`3/1`/`7/2`/`4/1` 仍 unrepresentable（T5.2-E）。

**Jianpu 渲染裁决**（产品决定，不是格式事实；spec 未规定谱面外观）：C 固定映射
1（CONFIRMED BY DOCUMENTATION），显示 `K: <值>` 不生成 `1=X`；小节线只认
CONFIRMED 四种 `|` `|]` `|:` `:|`，`||`/`::` 等 DOC-ONLY 形态画普通单线 +
`muse.render.barline.unrecognized`；Z/@ 休止与未知事件保守占位 + 诊断（C1：
UnknownEvent 恰一个可见节点；C2：fallback 节点至少一条诊断）；tuplet 只画
括号不缩放；按容器宽度换行（ResizeObserver），SVG 1:1 绘制，
`cssPixelsPerUnitAtZoom1` 是 renderer 产品常量，**不写 1u≈1px 契约**；
歌词按列左对齐（居中留作视觉 polish）。

**T5.2 real-world hardening（人工 smoke corpus#10 后的四个 fix + E）**：

- A `5ae5a7b` 歌词：两趟布局（横向 system 打包 → 歌词三级归属
  target / 行内最后对齐 / `bodyRange` / 兜底 → 每 system rows →
  `restackSystems`），`*` skip 不可见不推进 tailX，y 由所属 system 推导；
  该谱歌词节点 567 → 192，可见 skip 0。
- B `3539e5f` 弧线：`jianpu/jianpuArcs.ts`，弧高
  `clamp(arcHeight + |span| × arcHeightFactor, arcHeightMin, arcHeightMax)`，
  跨 system 的 tie/slur 切成 start/middle/end 段，每段 y 取所属 system 几何、
  弧高取本段跨度，各段共用同一 `anchor`、诊断只发一次；缺 system 几何直接抛错
  不兜底。该谱 104 relation → 107 段，3 条跨行。
- C `add5af9` 歌词间距：`lyricFirstOffset` 18 → 30（推导：两个低八度点
  14.5u + 字号 12u + 余量）；`jianpu.clearance.test.ts` 守「歌词字顶严格低于
  同行所有减时线/附点/八度点」。
- D `b85f8a6` 弧线端点：节点新增 `glyphWidth`（主字形 visual bbox span，非槽位宽），
  tie/slur 端点改用字形中心，连到全音符/breve 的弧不再落在延音线中间；
  tuplet 括号与跨行续行端仍用槽位边界。
- E `f77d3d2` breve：`duration.ts` 单点放行 `2/1`（dots=0）→ 7 条延音线；
  新 `jianpu/jianpuSlotWidths.ts` 让简谱槽宽 ≥ `requiredDashExtent + dashGap`
  （7 条 = 120u + 6u），在 `layoutSystems` 前重累计 slot.x/width/measure.width；
  共享 `spacing.ts` 与 `maxSlotWidth = 96` 未动，`3/2`/`7/4` 槽宽不变。corpus#10：
  `unrepresentable` 3 → 0，仅 3 个 breve 槽变宽，之前节点无漂移。

**T6 TAB 六线谱（T6.1–T6.5 全部完成，✅ 2026-09-17 封板：3d7c018 推送后 GitHub Actions run 35192708064 macOS/Ubuntu/Windows 三平台 typecheck / test / fixture-report 全绿）**：

- T6.1 `f9dc692` 地基：`src/notation/tab/{tabGlyphs,tabEventNodes,tabSlotWidths,layoutTab}.ts`
  + `TAB_METRICS`（`stringCount: 6` 是唯一格式事实，其余产品决定）。`RenderVoice →
  layoutTab → TabLayout`，与 jianpu **平行独立**（不共享节点类型、互不 import）。
  第 1 弦最上；多位品位一个 text；品位白底遮弦线；小节线只认 CONFIRMED 四形态；
  pitch 事件 / grace 的 pitch 成员落入 TAB → outOfScope 可见占位 + warning（不猜弦品）；
  UnknownEvent 恰一可见节点；同弦重复成员全部照画 + fallback + warning
  （`tab.group-duplicate-string`）。实测：TAB 模式下大写字母是 UnknownEvent、
  混排 grace 不可达、`V[...]` 组级前缀不回填。
- metrics 拆分 `beafacd`：`layout/metrics.ts` → `layout/metrics/` 目录，九个导出逐字
  相等，numeric-guard 排除改目录前缀，architecture 守卫按文件枚举多出 24 条通过用例。
- T6.2 `bb0ee51` 时值装饰：`tabDurationGlyphs.ts`，由 `decomposeDuration` 推导，画在
  第 6 弦下方（base ≤ 1/4 符干 + 减时线；1/2 短符干；≥ 1 延音短横线；附点），组时值用
  Domain 已算好的末音值不重算；unrepresentable 不画 + fallback（诊断由 buildRenderScore
  发，不重发）；`requiredDurationExtent`（含附点 + 留白）并入 TAB-local 槽宽；
  `layoutTab` 两趟布局，按 `requiredSystemDepth` 用 `restackSystems` 逐行补高
  （`systemHeight` 92 覆盖到十六分音符）。
- T6.3 `6f8db32` 关系与 stroke：`tabRelations.ts`（`-S-/-H-/-P-` **同弦**关系线，
  跨弦由 parse 判 `jcx.parse.tab-relation.cross-string` 不建关系、渲染层不重报；端点
  按 `TabFretGlyph.memberIndex` 身份查找，不重放排序；`relationEndGap` 留白且 x1 ≤ x2；
  跨行 start/end 段同 anchor、label 只在 start）；`tabStrokes.ts`（`TabNote.stroke`
  原字符画第 1 弦上方不二次解释；`H` 前缀按「延长」附 info `tab.stroke-hold-inferred`
  （spec §26.4 INFERRED）；表外字符仍画 + warning `tab.stroke-unrecognized`；多成员拼接
  并入槽宽）。**能力边界**：M2 的 TAB 渲染支持单音级的扫弦/拨弦方向记号
  （`TabNote.stroke`，parse 层已填充），不支持组级的方向记号（`TabGroupEvent.stroke`，
  parse 层从不填充，M1.8 已知限制②）——每 TAB 声部一条 info
  `tab.group-stroke-not-modeled`，措辞不得写成「扫弦方向不可用」。
- T6.4 `bce5e7a` SVG 与 renderer：`tab/toSvg.ts`（与 jianpu 同约定：每节点一个 `<g>`
  带 `data-anchor-key`、fallback 角标、unknown 虚线框）；`renderer/components/notation/
  voiceRender.ts` 分派 tab；store `zoom`（clamp 到 `SCORE_VIEW_METRICS.zoomMin/Max`，
  非有限值拒绝）+ Toolbar 控件；**zoom 只作用渲染层像素换算**：画布宽 =
  `layout.width × cssPixelsPerUnitAtZoom1 × zoom`，`availableWidth = 容器像素 ÷
  (cssPixelsPerUnitAtZoom1 × zoom)`，layout 数值不变（D6），换行随之调整（D7）。
- T6.5 `8727c51` hardening（人工复验真实语料后）：① jianpu 跨行 tie/slur 续行段最小
  可见跨度 `arcContinuationMinSpan`（末段曾退化成 4u 尖角）；② TAB 关系续行段同规则
  `relationContinuationMinSpan`；③ **和弦符号不再占时间槽**：`SlotWidthKind` 新增
  `'overlay'`（width 0，x 贴后续第一个有宽度列或段末；等距降级下仍 0；decoration
  等策略未动）——真实语料 277 个和弦符号 12u → 0，TAB 每行多放一小节；④ 显示时去掉
  和弦符号外层一对 JCX 引号（`chordSymbolDisplayText`，Domain/serializer 不动）。
  全语料只读 smoke：无和弦符号的声部逐节点相同、同行弧线不变、诊断集合不变。
- 测试：tab.layout 27 / tab.duration 23 / tab.relations 25+3 / tab.toSvg 12 /
  scoreView.voiceRender 7 / spacing.overlay 12 / chordSymbolDisplay 9；全量 4140。

**T7 Staff + VexFlow（T7.0–T7.5 全部完成，✅ 2026-09-22 封板：3f00d35 推送后 GitHub Actions run 35696163723 macOS/Ubuntu/Windows 三平台 typecheck / test / fixture-report 全绿）**：

- T7.0 `f97b1cd` 地基：引入 `vexflow@5.0.0`（精确版本），全仓 vexflow 守卫
  （`tests/unit/notation/architecture.test.ts`）扫 `src/**`，唯一允许目录
  `src/renderer/integrations/vexflow/**`；守卫在该目录尚不存在时也必须通过
  （先立守卫、后写实现）。
- T7.1 `aa860f2` renderer-neutral 语义：`notation/staff/{staffPitch,staffDurations}.ts`
  等，`StaffPitch {letter, octave}` 用 scientific pitch notation 绝对八度号（中央
  C = octave 4），**大写字母 = 4、小写字母 = 5**（INFERRED / product decision，spec
  只钉死大小写的相对关系，没钉死绝对八度号）；语义时值 `'quarter'` 等由
  `decomposeDuration` 换算，`k ∈ [8,10]`（1/256 及更短）落 `beyondGlyphRange`（产品
  决定，范围收紧到 128th）；全程零 VexFlow 编码。
- T7.2 `c9ff3f7` `StaffLayout` 排布：`notation/staff/layoutStaff.ts`，纯数据、不碰
  vexflow；`STAFF_METRICS`（`src/notation/layout/metrics/staff.ts`，除 `lineCount: 5`
  外每项都是产品决定）；clef 只读 `voice.clef ∈ {treble,bass,alto,tenor}`（INFERRED
  扩展，不是已确认 JCX 能力），缺席 → treble + `staff.clef-absent`（info），其它值 →
  treble + `staff.clef-unrecognized`（warning）；调号只在 canonical spelling 与 raw
  一致时画（新 `layout/keySpelling.ts`），`keySignatureAccidentalReserve` 固定按 7
  个升降号保守预留；`M:` raw 不画拍号、不做 tick 校验（SOFT voice）；行首（clef/key/
  time）预留并入行首 stave 宽度、参与换行判定，预留空间归行首 stave 自己（不整体右移，
  避免死区）；范围外事件（越界 pitch 等）可见占位 + `staff.event-out-of-scope`
  （warning）；同修复 `K:Eb` 被 scoreHeader 误判为 mode 的 bug。
- T7.3 `8cbe6c0` 关系：tie 与 tuplet bracket 的 renderer-neutral 类型
  （`staffRelationTypes.ts`）与构造（`staffRelations.ts`）；不用 VexFlow `Tuplet`，
  自有 bracket 只画括号 + 数字（暂缓自动缩放裁决）；slur/lyrics 不画，voice 级发
  `staff.slur-not-modeled` / `staff.lyrics-not-modeled`（info）；grace 占位、逐 event
  发 `staff.grace-not-modeled`（info）；和弦成员里的休止占位 + `staff.chord-member-
  rest-not-modeled`（info）。9 条新诊断码（见下）在本轮与 T7.2 一起补齐。
- T7.4 `49ac5f1` VexFlow 5 真实渲染：`renderer/integrations/vexflow/renderStaff.ts`
  为**全仓唯一允许 import vexflow 的目录**（不是单文件），入口固定 `vexflow/bravura`
  （内嵌 Bravura/Academico 字体，仓库不放字体文件，调用方需先
  `await document.fonts.ready`）；横向真源：`notation/**` 只管 measure/system 切分与
  stave 目标宽，stave 内音符 x 全部交给 `Formatter().joinVoices([voice])
  .formatToStave(...)`，任何 pre-layout 的 `slot.x` 不参与最终定位；placeholder 用
  `TextNote`，chordSymbol 挂 `Annotation` 到下一 tickable、段末 zero-tick `TextNote`
  （保持 T6.5 overlay 契约）；barline 节点不生成 tickable，begin/end 分表映射；逐
  tickable 绘制而非 `voice.draw()`（`TextNote.draw()` 不 `openGroup`，需要手动包
  `<g>` 才能回写 `data-anchor-key`）；draw 后经 `getSVGElement()`/`openGroup` 回写
  anchor 属性；React 外层 wrapper + VexFlow 内层 host，`renderGeneration` 触发高亮
  重扫，StrictMode 幂等；每 stave try/catch 退化。
- T7.5 `93cc62a` 修复（Electron 人工 smoke 后）：① staff SVG 不随 zoom 缩放——根因
  VexFlow `SVGContext.resize()` 写 inline `width`/`height` 覆盖样式表，修法 resize
  后写 `viewBox`、清 inline 尺寸、zoom 宽度放外层 section；② 同小节 tie 塌缩——端点
  解析正确，实测符头间距仅 4.7px，`STAFF_METRICS.minNoteSlotWidth` 16 → 40（最宽
  Bravura 符头 24 + 最小可辨弧跨 16），修复后 tie 跨度 36.7px。
- 诊断码新增 9 条（`src/notation/model/diagnostics.ts`）：`staff.clef-absent`(info)、
  `staff.clef-unrecognized`(warning)、`staff.event-out-of-scope`(warning)、
  `staff.octave-mixed`(warning)、`staff.duration-beyond-glyph-range`(warning)、
  `staff.grace-not-modeled`(info，逐 event)、`staff.slur-not-modeled`(info)、
  `staff.lyrics-not-modeled`(info)、`staff.chord-member-rest-not-modeled`(info)。
- T7.5 smoke（人工，记录见 `docs/VALIDATION.md`）：Electron 桌面窗口，顺序
  corpus#05（含唯一 staff 声部的真实语料）→ 6 个 `tests/fixtures/jcx/*` 中
  `style=staff` 的 fixture → 一份合成 stress 样例（`K:Eb`、`M:3/4`、treble/bass/
  未知 clef 三声部、五种升降号、和弦、同小节与跨小节 tie、三连音、`Z` 休止、反复线、
  未知事件占位）。复验：50% 六小节一行缩进页宽，100%/150% 等比缩放、换行随 zoom
  变化，tie/升降号/三连音/bass 加线/反复线/占位角标/`clef` 三态诊断均正确。
- 数字：全量 vitest 73 文件 / 4448 用例；corpus smoke 11/11；vite renderer 打包
  1.39 MB（`vexflow/bravura` 比全字体入口省约 400 kB）；
  `grep -c artifactory package-lock.json` = 0；CI 三平台绿（run `35688854397`
  覆盖 T7.0–T7.4，run `35690835529` 覆盖 T7.5 修复）。

**T8 render matrix（✅ 已完成：`72f14eb` 只加测试，不改 `src/**`）**：为 C1/C2/C3
三条契约在 Chord / Jianpu / TAB / Staff 四种记谱上补齐用例，新增
`tests/unit/notation/render.matrix.test.ts`（317 行）+
`tests/unit/notation/renderMatrix.helpers.ts`（237 行，机械操作与契约/覆盖表的
**唯一权威出处**，T9 文档同步取这里而不是测试文件本身）。三条契约：C1 每个
`RenderItem` 在该声部布局里恰好一个可见节点；C2 每个 `fallback: true` 节点至少
一条诊断指向它；C3 每条渲染诊断的 `anchor` 可经 `DomainIndex` 解析且
`anchorKey()` 稳定。

- 用例构成（1434 条矩阵用例）：102 个 fixture × 两档 `availableWidth`
  （wide 100000 不换行 / narrow 16 逼出多行谱）× C1/C2/C3，另加 fixture × D12
  （style 缺席/未知）、fixture × chord 的 C1′ 口径、25 个合成边界用例 ×
  四种记谱 × 两档宽度 × 三条契约，加上 dangling 端点定点用例 9 条、反空转
  哨兵 3 条（每种记谱 fallback 节点数 > 0：jianpu 30 / tab 148 / staff 42；
  诊断种类数 > 10：staff 12 / tab 6 / jianpu 7；窄宽度下跨行 tie 确实产生
  > 1 个 system），以及跨行拆段 1 条、确定性（同输入两次布局结果相同）4 条、
  诊断码来源 1 条。
- chord 的 C1′ 口径：`Score.chordShapes` 是文档级对象，`ChordLayout.anchor`
  恒为 `{ kind: 'document' }`，与声部事件之间没有任何映射（D11：按名关联仅
  `INFERRED`，默认关闭）；矩阵断言改为「每个 `GuitarChord` 恰好一个
  `ChordLayout`、每个 `ChordLayout` 恰好 6 条弦标记、对事件的可见节点数恒为 0
  （不是漏画）、`ChordLayout` 没有 `fallback` 字段因此 C2 恒为空集」。
- 跳过项（均为显式改写，非静默跳过）：style 缺席/未知声部不跑通用 C1（D12 下
  无 layout），改为 D12 专用用例区分 style-absent / style-unknown 两态；
  dangling 端点用例（靠人为剪掉 `index.eventById` 里一项制造）不跑通用 C3
  （用通用 C3 断言等于断言「我造的故障没生效」），改为定点断言 relation 分支
  的 C3；跨记谱事件（tab 事件落入 jianpu/staff、pitch 事件落入 tab）靠
  `layoutVoiceAs` 强制分派造出，不依赖真实语料里恰好存在这类混排。
- 结果：零契约违规；变异检验通过——临时在 `buildRenderScore` 漏派一类事件，
  C1 断言红 204 条（证明矩阵不是摆设）。
- 数字：全量 vitest 74 文件 / 5882 用例；corpus smoke 11/11；GB18030 encoding
  composition 10/10；T8 只读审查（`/check`）无 P1/P2；测试运行耗时 494ms。

**T9 文档封板（✅ 本节，只改文档：`HANDOFF.md` / `CHANGELOG.md` /
`docs/VALIDATION.md` / `README.md`）**：把上面 T8 的契约与矩阵事实同步进这
四份文档；HANDOFF 顶部状态行与 §30 表 M2 行改为「T0–T9 完成、待 seal」（不
标 ✅，seal 由三平台 CI 全绿后单独 commit 补上）；§69「下一任务」改为指向
seal 流程与 M3 前的 UI 设计；把散落在 §30.1 第 5 条（T7 遗留）、T6 段（TAB
视觉细节）、T7 段第 6 条（Staff 遗留）里的债务合并为本节末尾的「M2 遗留债务
总表」，作为后续 Agent 恢复工作的单一入口。

**已知观察 / 待裁决（非债务，决策与说明记录，恢复时先看）**：

1. ~~duration capability（breve）~~ 已由 T5.2-E `f77d3d2` 解决（见上）。
2. 16 分音符最小槽宽 12u = 减时线长 12u，相邻减时线相连是正确写法，但紧跟小节线
   时显得拥挤（`12|`）；T4 间距设计，未动。
3. ~~`[V:1]` 段内 inline `L:` 同时进入两个声部的 `unitLengthChanges`：非 bug~~
   **已按 U06 结案修正**（2026-09-22，U06 修复任务）：只读探针证实这是真实
   泄漏（5 个语料 corpus#02/#03/#04/#10/#11 的简谱声部每小节时值曾 = 拍号 ×
   2.000），已改为「body `L:` 只作用于它所在的声部，不泄漏到其它声部」，
   归属产出于 `parse/body/segments.ts`（现拆到 `unitLengthBinding.ts`），装配
   在 `parse/index.ts`；`jcx.parse.unit-length.body-scope` 诊断改由那里发放。
   详见 `docs/JCX_SPEC.md` §8.5 / Appendix A U06。

**T8.1 `a3fa0fd`（M2 seal 之后的测试补丁，只改 tests）**：按用户六条补充裁决收紧矩阵——chord 退出 voice matrix，改为独立 document chord matrix（C1/C2 标 N/A，无 fake voice adapter）；D12 style 缺席/未知按声部级 fallback summary 测（两码各恰一条 + voice anchor 可解析 + `summarizeEvents` 确定性）；C3 加 ownership（event 的 voiceId 一致；relation 必须在该 Voice 的 ties/slurs/tuplets/tabRelations/brokenRhythms 之一）与 `anchorKey` 稳定/单射断言；C2 只并 RenderScore + layout 诊断，C3 另并 `layoutScoreHeader` 诊断；C1 只数 `layout.nodes` 的 event anchor（TAB stroke overlay 不重复计数有正面用例）；无硬编码 fixture 数。矩阵 1434→1194 用例（去掉 chord 空转），全量 74 文件 / 5642 用例；只读审查通过；仓库转 public 后 GitHub Actions run 35702615344（8e60856）macOS/Ubuntu/Windows 三平台全绿。

**M2 遗留债务总表（T9 整合，恢复 M3 前或做视觉 polish 时先查这里）**：下表合并了
T5.2/T6/T7 各阶段散落记录的债务（原 §30.1 第 5 条「T9 需记入文档的债务」、T6 TAB
visual debt、T7 第 6 条），按 视觉 / 架构 / 测试 分类，每行注明来源任务，T9 前均
不处理：

| 分类 | 内容 | 来源 |
|---|---|---|
| 视觉 | TAB `x` 品位字形比数字矮，按 `fretBaselineRatio` 定位后略高于弦线（可给 `x` 单独基线比例） | T6 |
| 视觉 | ~~TAB 相邻减时线不做 beam grouping~~ **已由 M2.5 T3.5 解决（`d2486aa`）**：TAB / 简谱按拍连成 beam 组（`M:` raw / 缺席时仍逐音画法） | T6 |
| 视觉 | TAB 休止画 `z`/`Z`/`@` 原字符，不用休止符号 | T6 |
| 视觉 | 简谱附点画在数字右侧、延音线之前（`X . _ _ _`），简谱习惯长音附点在延音线之后；未核实，用户 2026-09-17 已裁决记为 debt | T5.2 |
| 视觉 | 头部字号 CSS 与 `layout/metrics` 双来源，未统一 | T5 |
| 视觉 | **Staff header demand calibration**：行首预留按每个升降号 8 估算（`STAFF_METRICS.headerReserve`），VexFlow 5 实测约 11 / 个，≥ 2 个升降号的调号（D、B♭ 起）行首预留不足（C♯ 大调缺 59.4），tier 1 下行首小节内容被挤窄；另 Staff demand 不含 VexFlow stave 内部缩进（非行首 ≥ 17）——这是 Staff tier 2 的前置之一 | M2.5 T5.S |
| 视觉 | 歌词按列左对齐，居中留作视觉 polish | T5.2 |
| 视觉 | `STAFF_METRICS.lineGap` 8u 与 VexFlow 实际谱线距 10px 不一致（仅影响自绘 tuplet bracket / 热区偏移，不影响 VexFlow 自己画的谱线） | T7 |
| 视觉 | `keySignatureAccidentalReserve` 固定按 7 个升降号预留，偏保守（多数调号用不到这么宽） | T7 |
| 视觉 | Staff 不做 beam（暂缓单独裁决） | T7 |
| 视觉 | Staff slur/lyrics 不画，仅 voice 级 info 占位 | T7 |
| 视觉 | Staff 行内不做两端对齐、密度校准（40u）待后续 engraving 轮次 | T7 |
| 视觉 | Staff 极窄容器（`availableWidth` < 行首预留）时单小节超宽未测 | T7 |
| 视觉 | Staff `'256'` 时值码字形未核实 | T7 |
| 架构 | `ScoreHeaderTextLine.fontSize/width` 字段无消费方 | T5 |
| 架构 | a11y（无障碍）未做 | T5 |
| 架构 | `src/renderer/dist` 构建产物入库，待清理 | T5 |
| 架构 | `syllableKind` 类型可收窄 | T5 |
| 架构 | 350 行文件上限无自动守卫（人工约定） | T5 |
| 架构 | `src/notation/tab/tabEventNodes.ts` 339 行、`staffEventNodes.ts` 309 行，逼近 350 行上限，再加逻辑须先拆文件 | T6 / T7 |
| 架构 | ~~组级方向记号（`TabGroupEvent.stroke` 的 `V`/`U` 前缀）parse 层从不回填~~ **已回填（2026-09-22，M2.5 formats preflight）**；渲染层 `tabStrokes.ts` 早已写好消费该字段的画法，回填后随之生效（见 §30.1 M2.5 段落）；`tabGroupStrokeNotModeled` 诊断的措辞仍说「不支持」，未跟着更新（本任务不改 src/notation/**） | T6 |
| 测试 | 语料时值 `5/8` 2 处 `unrepresentable`，无专项回归 | T5 |
| 测试 | `spacing.ts` 里 `chordSymbol` 的两处判定点（`itemSlotWidth` 的 overlay 判定先行截断，`timedDurationOf` 穷尽性 `switch` 里再列一遍 `timed: false`）靠代码注释纪律保持一致，缺自动化的防分叉单测（两处改动不同步时不会有测试报警） | T6 |
| 测试 | VexFlow adapter（`renderer/integrations/vexflow/**`）无自动化 DOM 测试，人工 smoke 覆盖；不引入 jsdom 的理由是 5642 个用例（T8.1 后）全基于 Node 纯函数，不是「VexFlow 明示不兼容 jsdom」 | T7 |

**Jianpu Engraving Polish Phase A（2026-09-22，`80edda1`，独立于 M2.5 的字形/间距任务，用户 Electron 100% 实机复验通过）**：`jianpuGlyphs.ts` 机械拆出 `jianpuGlyphBuilders.ts`；附点/延音线/八度点/小节线/反复记号几何与 `JIANPU_METRICS` 重标定；`jianpuDashDotPlan` 按简谱惯例换算附点与延音线（`jianpuSlotWidths` 同源消费，只加宽契约保持）；文档页眉 `1=<调>` + 叠排拍号（`layoutScoreHeader.jianpuTonicLabel/jianpuMeterFraction`，仅含简谱声部时）；`buildHeaderLabels` 恒空（声部行首不再画 `K:/M:`，P1-2 改写为「声部行首不显示调号拍号，由页眉承担」）。**Phase B（减时线粗细/垂直间距/组内列宽字形层）未做**，与 beam 分组一并归 M2.5 T3.5。P2 debt：`labelFontSize`/`headerLabelGap` 成死常量、`labels` 渲染路径保留；`jianpuSections.ts` 336 行接近上限。**当前状态：Phase A 提交后主动暂停；不进 Phase B，不启动 M2.5 T0，需用户明确指令。**（2026-10-04 更新：用户指令启动 M2.5 T0；**Phase B 不单独实施**，横向 spacing / group width 留给 T3.5 / T4 一并解决。）

**M2.5 派发要点（方案已冻结：`docs/M2.5_SYSTEM_LAYOUT_PLAN.md` v1.0，2026-09-22；冻结后改动需用户裁决，T0 启动需用户明确指令）**：
- **T0 ✅（2026-10-04，`6e5a532`，CI run 37137587990 macOS/Ubuntu/Windows 全绿；命名修订 `3f5b48c`；见下方「M2.5 T0 实际状态」）**。
- **T1 ✅（2026-10-04，`2b9882c`，CI run 37140019863 三平台全绿；见下方「M2.5 T1 实际状态」）**。
- **T2 ✅（2026-10-04，`218d143`，CI run 37177350122 三平台全绿；见下方「M2.5 T2 实际状态」）**。
- **T2.1 ✅（2026-10-04，`9037351`，CI run 37181088740 三平台全绿；见下方「M2.5 T2.1 实际状态」）**。
- **T3 ✅（2026-10-04，`7ee1e27`，CI run 37189546271 三平台全绿；见下方「M2.5 T3 实际状态」）**。
- **T3.5 ✅（2026-10-04，`d2486aa`，CI run 37212689335 三平台全绿；见下方「M2.5 T3.5 实际状态」）**。
- **T4 ✅（2026-10-05，`9661810`，CI run 37271250936 三平台全绿；见下方「M2.5 T4 实际状态」）**。
- **T5 ✅（2026-10-05，`ed4ea88`，CI run 37284116914 三平台全绿；见下方「M2.5 T5 实际状态」）**。
- **T5.S ✅（2026-10-05，spike，结论 `feasible-with-cost` / no adapter merged；见下方「M2.5 T5.S 结论」与 `docs/M2.5_T5S_VEXFLOW_SHARED_TIMING_SPIKE.md`）**。
- **T6 ✅（2026-10-05，`c74094e`，CI run 37296973259 三平台全绿；见下方「M2.5 T6 实际状态」）**。
- **T8 ✅（2026-10-05，`b513261`，CI run 37305952319 三平台全绿；见下方「M2.5 T8 实际状态」）**。
- **T9a ✅（2026-10-05，`49b0e11`，CI run 37312875513 三平台全绿；见下方「M2.5 T9a 实际状态」）**。
- **T9b ✅（2026-10-05，`9eb5722`，CI run 37325626662 三平台全绿；见下方「M2.5 T9b 实际状态」）**。
- 前置条件（M2.5 之前、独立 formats 小任务）：~~`strokePrefix → TabGroupEvent.stroke` 回填~~ **已完成（2026-09-22，M2.5 formats preflight）**：`scan.ts` 顶层循环把紧邻 `tabGroup` 的 `strokePrefix` 绑进 `TabGroupEvent.stroke`，不改 Domain 类型/serializer 代码，dangling-stroke 诊断未对绑定成功的 group stroke 误报（真悬空的仍照常发 info）。U06（body `L:` 按声部作用域）已于 `8a74e8e` 结案。
- 架构：`src/notation/system/**`（contracts 叶子层 → groupVoices / measureIdentity / timeline / composeSystem / justify / chordOverlay / pageModel）；System = overlay layers（chord diagrams，`layoutChord` 保持 document 级）+ ordered voice layers（jianpu/tab/staff 接受外部 system/measure 几何）+ attached layers（lyrics）；voice layout 不得反向 import composer。
- 关键裁决：`MeasureTimeline` 只含 timed onset（绝对 Rational 累计 offset）+ `chordSymbol` zero-time overlay，barline 固定 `endX`，decoration/grace/unknown 走 voice-local slot；跨 voice measure identity = ordinal candidate + 结构兼容性校验（时值总量逐 measure 绝对相等，不预设相等，不等进 tier 3；缺 measure 留空保留公共宽度；冲突 fallback + 诊断，不重写事件）；公共 measure width = 各 voice demand 取 max → packing → water-filling justify（`justified: full|partial|none`，末行不拉）；D11 精确名匹配（0 只画名 / 1 名+图 / >1 只画名 + ambiguity 诊断）；`ComposedSystemLayout {target:'screen'|'page'}`，PageModel 只收 page 产物，单 system 不跨页；Staff 验收 = tier 1（共享 measure 边界/宽度），T5.S 为非阻塞 spike。
- 刻印（T3.5，先于 T4 demand solver）：TAB/简谱 beam 按拍分组（x/4 四分一拍、6/8 等附点四分一拍、5/8·7/8 与 `M:` raw 不分组；用 voice 自身 offset，不依赖 shared timeline）；**P1-3 窄化为新裁决**：Meter 不得直接决定 spacing，可用于 engraving grouping，glyph demand 反向约束最小宽度；扫弦 `V/U` → ↓/↑；纵向次序 和弦名 → 和弦图 → 箭头 → 第 1 弦。
- 任务链：T0 contracts + negative guards → T1 group → T2 measure identity → T3 timeline → T3.5 beam/demand → T4 packing/justify（+ positive guard）→ T5 voice external geometry（只做三个 layout 的 adapter）→ T5.S staff spike → T6 chord overlay → T8 system matrix + **纵向 system 组装**（composer 调用三个 external layout、层 top / height、歌词 / TAB 深时值补高、和弦带、`ScoreSystemLayout` / `ComposedSystemLayout`，T5 用户裁决 N-a）→ T9a PageModel → T9b renderer system 化 → T9c smoke/docs/seal。每步 ≤350 行、无 class/as/any、诊断码只追加、只用现有四种 Anchor。

**M2.5 T0 实际状态（2026-10-04，`6e5a532` CI run 37137587990 + 命名修订 `3f5b48c` CI run 37137776164，均三平台全绿）**：
- 范围：只做 contracts / system metrics / 诊断码 / negative guards；renderer、三个 voice layout、Domain / parse / serializer 零改动。
- **命名裁决（用户 2026-10-04，冻结方案的 post-freeze amendment）**：方案 §B.3 的 `SystemLayout`（跨声部成品谱 system）改名 **`ScoreSystemLayout`**，避免与 `layout/systems.ts` 的 `SystemLayout`（单声部换行结果，不动）同名不同义；`ComposedSystemLayout` / `PageComposedSystemLayout` 名称不变，`systems: readonly ScoreSystemLayout[]`。`docs/M2.5_SYSTEM_LAYOUT_PLAN.md` 顶部已加修订记录并全文替换；测试用 `@ts-expect-error` 钉住 contracts 不再导出 `SystemLayout`。
- `src/notation/system/contracts.ts`（199 行，预算 200，再加类型须拆文件）：纯类型叶子层。**T0 裁决 A**：白名单为精确的 type-only `../../domain`、`../layout/primitives`、`../model/types`（不放开 `model/**`）；`ChordDiagramOverlay.anchor: EventAnchor = Extract<Anchor,{kind:'event'}>`。`MeasureParticipation` 为真正的判别联合（`absent` 无 `localMeasureIndex`）；单页命名 `PageLayout`；补 `LayoutTarget` / `PackingPolicy` / `PageSpec` / `PageComposedSystemLayout = ComposedSystemLayout & {target:'page'}`。`JustifyState.partial` 以 §Q4.5 water-filling 为准（全部 measure 触顶后仍有剩余宽），§B.3 / §Q7.2「有 measure 触顶」的措辞与之矛盾，**T4 断言按 §Q4.5 写**。
- `src/notation/layout/metrics/system.ts`（`SYSTEM_METRICS`，用户整表裁决）：`systemGap` 24 / `layerGap` 8 / `chordBandGap` 6 / `maxJustifyRatio` 1.5 / `minJustifySlack` 2；`page` 794×1123、四边距 56、首页页眉 160、续页页眉 24、页脚 24。A4@96dpi 只是数值标定来源，**不建立 abstract unit 与 CSS px 的契约**；T9b 真实页面出来后再视觉标定。
- `model/diagnostics.ts` 追加 9 条（`system.group-span-overflow` / `system.connector-not-modeled` / `system.measure-count-mismatch` / `system.measure-structure-conflict` / `system.measure-timing-degraded` / `chord.name-ambiguous` / `chord.symbol-conflict` / `chord.diagram-collision` / `system.page-overflow`），**只定义不发放**，码表共 48 条；按冻结方案在 T1/T2/T6/T9a 发放。
- `architecture.test.ts` 追加 §Q7.4 negative guards 1/2/3/5（均先去注释再扫描，按规范化绝对路径判定，均带反例探针）：contracts 叶子 + type-only（值 import、`import { type X }`、re-export、bare/动态 import 均拦）；`jianpu|tab|staff|chord/**` import `system/` 只许 `system/contracts`；`SIBLINGS` 恒为四个记谱目录；`system/pageModel.ts` 零 screen 概念且不 import voice layout / composeSystem。positive guard 4 留 T4。`tests/unit/notation/system.contracts.test.ts`：码表、`@ts-expect-error` 类型断言（event anchor / participation / page-only 入参）、metrics 整表与页面可用高度 > 0。全仓 75 文件 / 5846 用例。
- 待办 / 债务：① **T9a 落地 `pageModel.ts` 时把守卫 5 的 `existsSync` 分支改成断言文件存在**（防改名后空跑）；② ~~`SystemLayout` 同名不同义~~ **已裁决改名 `ScoreSystemLayout`（`3f5b48c`）**；③ 守卫 2 只覆盖四个记谱目录，`layout/**` / `model/**` 反向 import `system/**` 无守卫（方案未要求，T4 再议）；④ ~~`docs/UI_DESIGN_BRIEF.md` 附录 A「39 条」计数过期~~ **已同步为 48 条并补齐 9 条用户话术**（Brief v1.3.2；第 29 条 `tab.group-stroke-not-modeled` 改注为遗留码）。

**M2.5 T1 实际状态（2026-10-04，`2b9882c`，CI run 37140019863 三平台全绿）**：
- 范围：只做 `Score.voices → SystemGroup[]` 的视觉分组；measure identity、timing、renderer、三个 voice layout、Domain / parse / serializer 零改动。`groupVoices` 尚无消费方（T4 composer 接入），渲染结果无变化。
- `src/notation/system/groupVoices.ts`（125 行）：`groupVoices(voices: readonly Voice[]): VoiceGrouping { groups, diagnostics }`，纯函数、确定性、不改入参。**分组规则（用户 2026-10-04 裁决 ①–④ + 补充裁决）**：安全整数 `bracket=N`（N ≥ 2）从当前声部起成 N 层 `bracket`/`declared` group，越界截断 + `group-span-overflow`（warning），截断到 1 层退为 singleton；`bracket=1` → singleton 无诊断；`bracket` 非安全整数（防御：parse 保证安全整数，手工 Voice 才有 1.5 / NaN / Infinity / `MAX_SAFE_INTEGER + 1`）或 N ≤ 0 → singleton + `group-declaration-ignored`（info）；`brace` / `staves` → 声明声部 singleton、**不吞并后续声部**、每个声明一条 `connector-not-modeled`（info）；属性优先级固定 bracket > brace > staves，**不做 fallback**；被前一 group 覆盖的声部只发诊断（`bracket` → ignored、`brace` / `staves` → not-modeled），**绝不改变 group**、每个属性只一条原因诊断；group 顺序与层序 = 文档顺序；诊断挂 voice anchor、`sourceRef = origins[0]`（空则省略），drafts 只收集一次。重复 `VoiceId` 视为人工破坏 Domain 的防御性输入：不新增诊断、不去重，按数组位置处理。
- 新增 info 码 `muse.render.system.group-declaration-ignored`（**post-freeze amendment**，方案顶部修订记录与 §Q1.5 / §C 已同步）；渲染码表共 49 条，其中 M2.5 码 10 条；message 只描述本版处理，不断言 JCX 格式非法。
- 测试 `tests/unit/notation/system.groupVoices.test.ts`：19 行分组矩阵 + 诊断契约（C3、level、措辞不含「非法」、`sourceRef`、id 稳定）+ 非安全整数五值 + 重复 VoiceId + fixture 全集划分不变量。**语料口径 = synthetic shape coverage**（1 / 2 / 3 / 9 声部四种已知形态由合成源码复刻），**真实语料本轮未重跑**（本机 `legacy-corpus/jcx/` 缺席）；真实 corpus probe 留到 T8 system matrix / T9 smoke 前。独立 review 的变异测试（覆盖区 bracket 扩张 / 重复报 / 越界报 overflow、措辞含「非法」、`isInteger` 退化、`JSON.stringify` 展示数值、单层仍产 bracket）全部被测试杀死。全仓 76 文件 / 6004 用例。

**M2.5 T2 实际状态（2026-10-04，`218d143`，CI run 37177350122 三平台全绿；以下为 T2 当时快照，T2.1 的变化见下一节）**：
- 范围：只做跨声部 measure identity（ordinal candidate + structural compatibility validation + 前缀对齐 / absent + T2 诊断）；T3 timeline、T4 width / packing、renderer、三个 voice layout、Domain / parse / serializer、contracts 零改动，不新增 `MeasureId`。`alignMeasures` 尚无消费方（T4 composer 接入），渲染结果无变化。
- `src/notation/system/measureIdentity.ts`（219 行）：`alignMeasures(groups, voices: readonly RenderVoice[]): MeasureAlignment { groups, diagnostics }`。阶段类型 `SliceTotal` / `AlignedMember` / `MeasureVerdict` / `AlignedMeasure` / `GroupMeasureAlignment` / `MeasureAlignment` 导出于此、供 T3 / T4 使用（裁决 A：不改 contracts，不伪造 `SystemMeasureGeometry` 的 x / width / demandWidth / timeline）。measure 一律由 `splitMeasures` 切出，按 ordinal 前缀对齐，超出范围 `absent`，**无 LCS / DTW / 搜索 / 插入 / 移动**。
- **判定（裁决 C / D / E）**：每个 ordinal 只在在场声部之间判定（< 2 即 compatible，singleton 恒走这里）。S1 trailing barline raw 去重后 > 1 或 S2 孤立线对非孤立线 → `structure-conflict`（无等价表；tail 不单独冲突，S4 只是描述事实）；否则已知绝对 `Rational` 总量（domain `add` / `equals`，零浮点、零比例、不读 Meter）不全等 → `total-mismatch`。任一冲突 → 整个 measure 所有在场者 `incompatible`，**不做多数投票**，`localMeasureIndex` 全保留。弱起 / 零时值小节 / `durationUnrepresentable`（1/3）均按字面绝对总量比较，不补偿。
- **诊断分工（裁决 B）**：T2 发 count 不等 → `measure-count-mismatch`（warning，group 内每个声部一条 voice anchor，sourceRef = `origins[0]`）；D3 → `measure-structure-conflict`（warning）；**D4 → `measure-timing-degraded`（info）**；后两者每个在场声部一条、挂该 measure 首事件 event anchor，sourceRef = 该事件 origin。**T3 只对 D1 / D2 / 溢出发 `timing-degraded`，并跳过 `verdict !== 'compatible'` 的 ordinal**，同一 ordinal 不重复报。
- **unresolved（裁决 G）**：`SliceTotal` 不可知时带 `reason: 'duration-undefined' | 'arithmetic-overflow'`（只捕获 `add` 的 `RangeError`，其它异常照抛）；T2 不因此发诊断、不标 incompatible，unresolved 不参与比较（其余已知总量不等仍 total-mismatch）。
- **防御（裁决 H）**：按 VoiceId 查找，重复 id 取首次；`SystemGroup.voiceIds` 有找不到的 VoiceId 时该声部按 absent 参与 alignment、不抛异常、结果确定，**整个 group 的全部 T2 诊断经 `diagnosticsSuppressed` 单一闸门抑制**（不把调用方错误伪装成源文件问题）；已解析但 0 个 measure 的真实 Voice 照常参与 count mismatch。
- `src/notation/system/timedDuration.ts`（44 行，裁决 F）：`eventTiming(event)` 穷尽 switch，T2 / T3 共用；不 export / 修改 `spacing.ts` 私有 helper；测试对 fixture 全集（10 种事件）与 `itemSlotWidth()` 的 kind / 宽度做 cross-check 防分叉。
- 测试 `tests/unit/notation/system.measureIdentity.test.ts`（50 条）：**synthetic shape coverage**（68/69、59/61、22/23 计数形态 + E-5 中段零时值小节），**真实语料本轮未重跑**。独立 review + 23 个变异（D4 错报 structure、两类浮点、多数投票、后缀对齐、absent 收诊断、重复 id 取末次、吞所有异常、去掉 RangeError catch、诊断闸门部分失效等）全部被杀。全仓 77 文件 / 6068 用例。
- **已知后果（F-1 的保守语义，不是 bug）**：某声部中段多出零时值小节时，其后所有 ordinal 错开一格，大面积落 tier 3（仍共享边界与宽度）并产生大量诊断；真实 corpus#10 / #11 恢复后应作为进入 T3 前最优先的只读 probe。
- **流程教训**：T2 review 时只读 agent 交回报告后仍在后台用旧备份恢复主工作区、覆盖了实现修改（已发现、停掉 agent、重新落地并复核）。此后 **mutation review 一律在独立 worktree / 临时副本里运行**，提示词明确禁止修改主工作区。

**M2.5 T2.1 实际状态（2026-10-04，`9037351`，CI run 37181088740 三平台全绿）**：
- **起因（T3 调研时的真实语料 probe）**：F-1 前缀对齐 + 规则 7（孤立线参与 ordinal 编号）在 corpus#10 / #11 上造成「判 compatible、实为错开一小节」的配对——某声部中段一根单独的小节线 measure（corpus#11 为单独的 `|:`）让其后全部 ordinal 错位，而各小节总时值相等，T2 判 compatible（corpus#10 有 8 个、corpus#11 有 15 个这样的 ordinal）。若不处理，T3 会在错位配对上建 shared timeline、T4 会共享其边界。
- **desync latch（用户裁决 R0-b + P2-4-b）**：某 ordinal 出现「isolated-barline-only measure vs 含至少一个 timed 事件（`eventTiming(...).timed === true`，不看 duration 是否已知、总量是否为正）的 measure」时，该 ordinal **仍为 `structure-conflict`**、诊断只在此报一次（每个在场声部一条，message 说明此后序号可能错开、不再做跨声部时间对齐）；**其后**全部 ordinal 判 `desynced`（在场者全 `incompatible`、`localMeasureIndex` 保留、不再判定、不发逐小节诊断，T3 不建 shared timeline）。普通 S1 raw 冲突、D4、孤立线 vs **纯 untimed** 非孤立 measure（只有 chordSymbol / decoration / grace / unknown，零时值）都不触发——后者只造成当前 ordinal 的 `structure-conflict`，后续照常判定。latch 只在本 group 内生效、本期不自动恢复同步、count-mismatch 不受影响。`MeasureVerdict` 增至四态。
- **`GroupMeasureAlignment.diagnosticsSuppressed`（R5-b）**：group 含找不到的 VoiceId 时为 true，**是 T3 继承 missing-voice 防御语义的唯一来源**（T3 不重复实现查找规则）。
- **`src/notation/system/measureFeatures.ts`（61 行，新建）**：从 `measureIdentity.ts` 抽出的纯函数（`sliceTotal` / `trailingBarline` / `isIsolatedLine` / `hasTimedEvent`），只看单个切片、不做跨声部判定；`SliceTotal` 唯一定义在此，`measureIdentity.ts`（204 行）只 `import type` + `export type` 转出，无循环依赖。
- **真实语料只读核对（ordinal 按 1 起算）**：corpus#10 第 50 个 ordinal 发生 isolated-line vs timed-content 结构冲突并触发 desync latch，其后 11 个 ordinal 为 `desynced`；corpus#11 第 6 个 ordinal 触发，其后 17 个 ordinal 为 `desynced`。T2 时被误判 compatible 的 8 / 15 个错位 ordinal **全部落入锁存区间**，两份语料触发点之前的判定与 T2 逐个一致；corpus#02 / #03 / #04 / #07 / #09 触发 0、desynced 0，判定与诊断与 T2 完全一致；单声部语料无 `desynced`。代价：corpus#11 只剩前 5 个 ordinal 有跨声部时间对齐。
- 测试：`system.measureIdentity.test.ts` 共 65 条（T2.1 新增 15 条：触发点 / 锁存后 / S1-only / D4 / 三声部 / 同位孤立线 / missing voice + latch / 跨 group 隔离 / 单声部 / tail S1 缺席 / 单音 tail 非孤立线 / P2-4-b ①②③）。独立 review 在独立 worktree 跑 33 个变异，加上补跑的 10 个，已知存活项（跨 group 泄漏、isIsolatedLine 不查 barline、tail 返回 `|`）均已补测杀死；P2-4-b 的两个关键变异（timed 退化成「任意非 barline」、退化成「resolved total > 0」）分别被 ①、② 杀死。全仓 77 文件 / 6090 用例，`jcx:corpus-test` 11/11。
- **流程教训**：mutation harness 必须 fail-fast——第一次 worktree 变异脚本因 zsh 不对 `$FILES` 分词导致拷贝全部失败、两侧 hash 都为空却判「未改动」的假绿（已发现并重跑）。此后 harness 固定 `set -euo pipefail`，显式文件列表，并在比较前确认源/目标文件存在、hash 非空、拷贝成功、变异实际生效、vitest 基线实际跑过。
- **T3 设计裁决（R1–R6，2026-10-04，待 T3 编码落地）**：R1 T3 显式保存 `OverlayOnset`（chordSymbol 贴附位置：后续 onset 下标或 measure-end）；R2 D1 / D2 / 溢出的 system `measure-timing-degraded` 只挂原因声部、该小节至少两个在场声部时才发、每个（声部, 小节）合并一条；R3 无 timed 事件的小节 `offsets = []`，方案与 contracts 措辞改为「非空时首项为 ZERO」；R4 单声部（或只剩一个在场声部）的 D1 / D2 记录 degraded 状态但不发 system 诊断；R5 继承 `diagnosticsSuppressed`；R6 导出纯函数 `voiceMeasureOnsets(slice)` 供 T3 / T3.5 共用，helper 不负责 tuplet，tuplet 由调用层结合 `Voice.tuplets` 判断。T3 阶段类型住在 `timeline.ts`，不伪造 `MeasureTimeline` 的 x / endX。

**M2.5 T3 实际状态（2026-10-04，`7ee1e27`，CI run 37189546271 三平台全绿；以下为 T3 当时快照，`voiceMeasureOnsets` 的实现位置在 T3.5 下沉到 `layout/`，见下一节）**：
- 范围：纯 timing 数据层——offsets / total / 逐声部 onset 映射 / chordSymbol overlay 位置 / 退化状态与诊断；**不求 x、不求 endX、不构造 `contracts.MeasureTimeline`**（T4 再用 §Q3.6 的段宽合成）；renderer、voice layout、Domain、parse 零改动；未开始 T3.5 / T4。
- **N1**：`measureFeatures.voiceMeasureOnsets(slice)` 是 T2 / T3 / T3.5 **唯一的 literal timing 累计实现**（绝对 `Rational`；timed 事件 `onset = off; off = add(off, duration)`，chordSymbol 只记当前 off，barline / decoration / grace / unknown 不进入；遇 undefined → `duration-undefined`，只捕获 `RangeError` → `arithmetic-overflow`）；`sliceTotal` 是它的纯投影（测试另有源码守卫：`sliceTotal` 体内不得出现 for / add / ZERO / RangeError）。T2 / T2.1 行为等价（原 65 条测试不改全绿；独立 review 对 fixture 216 片、真实语料 1104 片、手工篡改 720 片逐切片比对新旧 `sliceTotal` 全等）。
- **N2**：在场 `AlignedMember`（present / incompatible 分支）携带 T2 已解析的 `renderVoice`；`buildMeasureTimings(alignment)` 不接收 voices、不做 VoiceId 查找；missing-voice 的诊断闸门只读 `diagnosticsSuppressed`。
- **`src/notation/system/timeline.ts`（200 行）**：`buildMeasureTimings(alignment): MeasureTimings`，阶段类型 `TimedOnset` / `OverlayPosition` / `OverlayOnset` / `VoiceMeasureTiming` / `TimingDegradation`（= `UnresolvedReason | 'tuplet'`）/ `DegradationCause` / `SharedMeasureTiming`（`shared` / `not-compatible` / `degraded`）/ `GroupMeasureTiming` / `MeasureTimings`。`memberIndex` 恒指原始 `AlignedMeasure.members` 下标；`itemIndex` 是切片内下标（T4/T5 经 `slice.startIndex` 换算）。tuplet 成员集合按 RenderVoice 在单次调用内缓存（纯局部派生索引，无跨调用状态）。
- **规则**：T2 verdict 非 compatible（含 `desynced`）→ `not-compatible`，不重判 D3 / D4 / desync、不发诊断；D1 / overflow 沿用 T2 的 `SliceTotal` 原因（不再累计），D2 = 本小节切片里有事件属于该声部 `Voice.tuplets[].members` → `degraded`（causes 只列原因声部，多原因合并）；否则 onset 并集按 `cmp` 排序、`equals` 去重（与声部顺序无关），无 timed 事件时 `offsets = []`（R3）；chordSymbol 位置 = 同一声部后续第一个 timed 事件的 offset，否则 `measure-end`（R1，不以 onset === total 推断）；理论上已 resolved 却算出 unresolved 时按实际原因防御性降级、不 throw。
- **诊断（R2 / R4 / R5）**：`measure-timing-degraded`（info）只挂原因声部，每（声部, 小节）一条、多原因合并（message 列出原因），anchor = 该声部本小节首事件、sourceRef 取该事件；仅当本 ordinal ≥ 2 个在场声部且 `diagnosticsSuppressed === false` 时发；单声部 / 只剩一个在场声部只记 degraded 不发。已有 `duration.unresolved`、`tuplet.timing-not-modeled` 照旧保留。
- 测试：`system.timeline.test.ts` 共 **40 个测试声明**（voice-local 原语、并集、D1 / D2 / overflow、与 T2 / T2.1 衔接、单声部、零 timed 小节、overlay 位置含零时值 timed 反例、契约与防御）；全仓 Vitest **78 files / 6137 pass**（相对 T2.1 的 6090 净增 47 = 40 个新声明 + 架构 / svg 守卫对新文件 `timeline.ts` 逐文件展开的 7 条）。独立 review 在独立 worktree 跑 33 个变异 + 26 条反例探针，存活项（浮点排序、total 归一化两种写法、chordSymbol 进并集、非空 offsets 时末端映射到最后 onset、T3 层把 1/3 判退化、不沿用 T2 原因而重新累计、overlay 用声部内下标、anchor 改首个 note、sliceTotal 恢复第二套循环）全部补测后在独立 worktree 复跑确认被杀。
- **真实语料基线（只读，供 T3.5 / T4 回归）**：19 groups，shared **725**、degraded **8**、not-compatible **46**；8 个 degraded 全部来自 corpus#08 的单声部 tuplet 小节，按 R4 system timing 诊断 = 0；多声部真实语料当前**没有** D1 / D2 / overflow 退化；overlay 共 244 个，全部贴在后续 onset 上（measure-end 0）；把 group 声部顺序反转后结果不变。

**M2.5 T3.5 实际状态（2026-10-04，`d2486aa`，CI run 37212689335 三平台全绿；以下为 T3.5 当时快照，「T4 未启动」已过时，见下一节）**：
- 范围：TAB / 简谱的 voice-local beam 分组与刻印、notation-local 列宽需求、扫弦箭头；**不做**跨声部取 max / packing / justify / `xByOffsetIndex` / `endX` / `composeSystem`（T4）；Domain / parser / serializer 零改动、不新增诊断码。按用户裁决 Q15-c 分 5 个内部阶段（T3.5-0 原语迁移 → -1 分组核心与回归门 → -2 TAB 数据 → -3 简谱 → -4 TAB SVG / 扫弦 / renderer 接线），一个代码提交。
- **用户裁决 Q1–Q16（2026-10-04，冻结方案的 post-freeze amendment，方案顶部修订记录已同步）**：Q1 `eventTiming` / `voiceMeasureOnsets` 原样下沉 `layout/eventTiming.ts` / `layout/measureOnsets.ts`，`system/timedDuration.ts` / `measureFeatures.ts` 只 re-export（记谱目录按 §B.2 只能 import `system/contracts`，守卫 2 不放宽）；Q2 `TabContext.meter?: Meter`，`voiceRender` 只透传 `score.meter`（T3.5 的明确 renderer 例外，不代表开放 T4 renderer scope）；Q3 拍单位只取冻结表（`x/4`→1/4、`x/8` 且 `x%3===0`→3/8、`x/2`→1/2），其它分母 / 非法 `num` / raw / 缺席一律不分组、不类推 `/16`；Q4 chordSymbol 跳过不断组；Q5 grace 断组；Q6 同拍 = `floor(onset / beatUnit)`（BigInt 精确，只看 onset）；Q7 F-10 澄清：`1..commonBeams` 整组连续，更高 level 按最大连续段，≥ 2 → secondary span，= 1 → beamlet（组首向右、其余向左，长度复用 `beamLength`，不设 `beamHangLength`）；Q8 TAB 主梁在本组最深成员逐音最深减时线 y、次级朝谱线向上叠；Q9-d `TAB_METRICS.beamThickness = JIANPU_METRICS.beamThickness = 1.4`（继承既有 CSS），仍是线段、本期不加粗、SVG 必须实际消费；Q10 简谱组横线 `[x首 − h, x末 + h]`，`h = digitFontSize × digitGlyphWidthRatio / 2 = 4.8`；Q11 `G_min = minSlotWidth = 12`，相邻成员 gap ≥ G_min，同时值组只加宽到 `max(gaps, G_min)`，不同时值组不强制等距，废弃「组 demand ≤ 逐音 demand 之和」断言；Q12 `V → ↓`、`U → ↑`，其余原字符，诊断按原字符；Q13 F-11 只保证箭头在第 1 弦上方，chord 名 / 图与箭头的最终次序是 T6 integration contract；Q14 `beams` 字段恒在、raw / 缺席必为 `[]`，normalized 回归门 + 入库 sha256 golden；Q16 `tabGroupStrokeNotModeled` 不在本轮处理。
- **P1-3 窄化（F-9，语义升级，原样记录）**：`Meter` 仍不得直接决定 spacing / 拍宽；允许 `Meter` 用于 engraving grouping；允许 engraving 产生的 glyph minimum demand 反过来约束最小宽度。三条原样写在 `layout/beamGroups.ts` 文件头。
- 新文件：`layout/beamGroups.ts`（199 行，记谱无关分组核心：`beatUnitOf` / `beatIndex` / `planMeasureBeams` / `planVoiceBeams` / `equalizeGroupSpacing` / `BEAM_MIN_STEM_GAP`）、`layout/beamEngraving.ts`（组成员节点按 `EventId` 原位替换的共享骨架，节点同长同序、anchor 不变）、`tab/tabBeams.ts`（132 行，`tabMeasureSpacing` 是 T4 的 TAB 列宽需求出口）、`jianpu/jianpuBeams.ts`（108 行，`jianpuMeasureSpacing` 同理）。`TabLayout.beams` / `JianpuLayout.beams` 是独立字段，**组不进 `nodes`**（C1）；组成员节点只替换符干 / 清空逐音减时线。组线 SVG 用独立 class `tab-beam-line` / `jianpu-beam-line`（`global.css` 只给颜色），线粗由 `beamThickness` 呈现属性实际决定；未入组单音仍走旧画法与旧 CSS。
- 守卫：`layout/**` 不 import `system/**`；`src/notation/**` 只有 `layout/measureOnsets.ts` 值导入 Rational `add`；不以命名空间形式导入 Domain。
- 回归门（Q14）：`tests/fixtures/golden/t35-raw-absent.sha256.json`（168 条，由 `35f7ad9` 独立 worktree 运行 `scripts/notation/beam-regression-golden.ts` 生成，测试只读不改写）覆盖全部 fixture × `M:C` / `M:C|` / 删除 `M:` × 两档宽度的 TAB / 简谱 layout + SVG；规范化只允许去掉 `beams` 字段与 V/U 映射。
- 测试：全仓 Vitest **82 files / 6276 pass**（相对 T3 的 6137 净增 139）。独立只读 review 两轮（1 MEDIUM：组线 CSS 覆盖 metric，已修；3 LOW 已修；6 处未钉住裁决点已补测）。独立 worktree 变异 77 个，杀死 74 个；3 个存活记为**当前可达状态下不可观测的等价变异**（用户裁决）：`tabMeasureSpacing` 不传 beamed（逐音减时线项 12 被 `minSlotWidth` 12 遮蔽，函数契约由压窄 spacing 单测 + 对照变异钉住）、`jianpuMeasureSpacing` 不调 `equalizeGroupSpacing`（当前简谱同时值组列宽必然相等，review 模糊探测 3505 组差异 0）、golden helper 去掉规范化（只作用于基线侧）。
- **真实语料**：TAB 937 组 / 简谱 456 组；tuplet 整小节不分组 TAB 4 / 简谱 4（corpus#09）；D1 / 溢出 0；节点 / 列宽 / 行高相对不分组零漂移；扫弦 V/U 499 个（全在 corpus#03）画成箭头、`B` 5 个原样；真实语料无 raw / 缺席拍号（review 另做 102 条 raw / 缺席 normalized 比对零漂移）；T3 基线 19 groups / shared 725 / degraded 8 / not-compatible 46 不变。
- 已知限制（不在 T3.5 处理）：TAB 扫弦记号与 voice-local 和弦符号同在第 1 弦上方 −6 基线，corpus 有 54 处同 x 重叠（归 T6 integration）；简谱未入组单音的减时线仍是旧画法 `[x, x+12]`（raw / 缺席回归门要求不变）；`tabGroupStrokeNotModeled` 码保留未发。

**M2.5 T4 实际状态（2026-10-05，`9661810`，CI run 37271250936 三平台全绿；以下为 T4 当时快照，层纵向几何与 composer → layout 的归属已由 T5 裁决 N-a 改归 T8，见下一节）**：
- 范围：公共 demand solver + 逐 group packing + water-filling justify + shared measure 段几何，**第一版只到几何**；renderer / 三个 voice layout 默认路径 / Domain / parser / serializer 零改动，不新增诊断码。按用户裁决 O 分 3 个内部阶段（T4-0 demand → T4-1 justify → T4-2 compose），一个代码提交（14 文件：6 改 + 8 新）。
- **用户裁决 A–O + a / b / c（2026-10-05，冻结方案的 post-freeze amendment，方案顶部修订记录与 §Q3.6 / §Q4.1 / §Q7.4 / §D 已同步）**。
- **阶段产物（A）**：`system/composeSystem.ts` 导出 `composeSystemGeometry(renderScore, measurer, policy): ComposedSystemGeometry { target, lines: SystemLineGeometry[], diagnostics }`；`SystemLineGeometry { systemIndex, groupIndex, lineIndex, lineStartReserve, width, justified, measures: SystemMeasureGeometry[], barsPerStaffHonored? }`。**T4 不构造 `ScoreSystemLayout`**（~~layer 纵向几何归 T5~~ 已由 T5 裁决 N-a 改归 T8、和弦 overlay 归 T6、行高归 T8，不塞占位值）；T8 在其上组装。`systemIndex` 全文档按 group 文档顺序累加（N）。一次 compose 内 T1 / T2 / T3 各只跑一次；`diagnostics` = `renderScore.diagnostics` + T1 + T2 + T3（顺序固定）。
- **contracts 变更（G / D / E）**：`SystemMeasureGeometry.contentOffsetX` 新增——普通 measure 为 0，每行首 measure = 本行 `lineStartReserve`；shared timeline 的 x 已含它，**T5 不得重复叠加**。`demandWidth` = 量化后的内容最小宽（不含预留）。`MeasureTimeline` 新语义：`xByOffsetIndex[0] = contentOffsetX + lead'`、逐段累加；`endX` = 收尾 barline 的 measure-relative x（无收尾 barline 时为逻辑内容末端），**不再等于 measure 宽**；`geometry.width = endX + tail'`。零 timed 的 shared measure 保留空 timeline（C）；tier 3 无 timeline。
- **demand（J / M）**：新 `system/measureDemand.ts`（172 行）。每声部每 measure 的需求只有一个来源：TAB `planTabBeams` + `tabMeasureSpacing`、简谱 `planJianpuBeams` + `jianpuMeasureSpacing`、Staff `staffMeasureSpacing`，fallback 声部 0；按 `RenderVoice` 缓存，不再调 `spaceItems` / `widenFor*`。shared measure：按 T3 的 onset 映射把每列归到 lead（首 onset 前）/ 段 / tail（收尾 barline），各分量跨声部取 max，`demandWidth = lead + Σsegment + tail`（再与各声部整小节需求 max 取大，差额补进 tail）；tier 3 = 各在场声部整小节需求的 max。行首预留 = 各层行首预留的 max（当前只有 Staff 非 0；TAB 0，F）。
- **fixed-point（I）**：新 `system/geometryTicks.ts`（55 行），`SYSTEM_METRICS.geometryQuantum = 1/1024`（数值稳定性量化网格，非视觉 metric）。demand / 预留向上、可用宽向下取整到 tick；packing / water-filling / 段分配 / x 累计全链路整数 tick，产出时换回 unit（二进制精确）。`distributeTicks` 用 BigInt 求下取整份额，余数按下标顺序只补给有小数部分的项（每项 ≤ 精确份额上取整）。
- **packing**：逐 group 独立（F-5），沿用 `layoutSystems` 贪心（单个超宽 measure 独占一行）；阈值 = ⌊可用宽⌋ − ⌈行首预留⌉（预留在 packing **之前**扣）。page 策略的有效 hint（`Number.isSafeInteger(N) && N ≥ 1`）：本行 N 个放得下就强制 N 个，否则本行退回自动（H：不发诊断）。**`barsPerStaffHonored` 三态（a / b / c）**：缺席 = 没有可应用的有效 hint（缺席 / 非法 / screen / 全零 group 主动忽略）；`true` = 有效 page hint 被采用（文档自然结束导致末行不足 N 仍为 `true`）；`false` = 本行 N 个放不下、退回自动 packing。**全零 group**（预留 0 且全部需求 0，如只有 fallback 声部，M）忽略 hint、一行装完、`justified: 'none'`。
- **water-filling（新 `system/justify.ts`，82 行）**：`none` ⇔ 末行（含 group 唯一一行）、`Σdemand = 0` 或剩余 < `minJustifySlack`（2 unit）；否则按 demand 比例分配剩余宽，以**当轮**剩余宽用 BigInt 交叉乘判定越过 cap = `⌊demandTicks × 3/2⌋` 的 measure、固定在 cap 并重分配，直到无新触顶；收敛后仍有未触顶 → `full`（整数级严格 `Σ widthTicks === 内容可用 ticks`）；全部触顶仍有剩余 → `partial`（右侧留白，全部 measure 在 cap）。行首预留**不参与 justify / cap**，只加到行首 measure 的 `width` 与 `contentOffsetX`。measure 内终宽再按 lead / 段 / tail 的需求比例分回（`distributeMeasure`）。
- **Staff 抽取（O）**：新 `staff/staffHeader.ts`（51 行，谱号 / 调号 / 拍号行首预留原样搬出 `layoutStaff`，加 `staffLineHeaderReserve(score)`）；`staffSlotWidths.ts` 导出 `staffMeasureSpacing`；`layoutStaff.ts` 282 → 240 行。**Staff 默认输出零变化**：9 个 Staff 声部 × 3 档宽度共 27 条 layout hash 与 `58c015c` 逐条相同（review 另做 4 档 36/36 JSON 对比）。
- **守卫（B / K / L）**：§Q7.4 旧 positive guard 4（`composeSystem.ts` import 三个 voice layout 与 `layoutChord`）**作废重写**为：`measureDemand.ts` 真正值导入并调用三个 `*MeasureSpacing`、`composeSystem.ts` 真正值导入并调用 `measureDemand` 出口（禁止 unused import）；新增 negative guard：`system/**` 不 import 任何 voice layout 入口与 `layoutChord`（voice layout 正面边留给 T5、`layoutChord` 留给 T6）；`model/** → system/**` 并入既有方向守卫。`system.contracts.test.ts` 的 metrics 整表断言纳入 `geometryQuantum`。
- 测试：新增 `system.demand.test.ts` / `system.justify.test.ts` / `system.compose.test.ts`；全仓 Vitest **85 files / 6382 pass**（相对 T3.5 的 6276 净增 106）；fixture-report 105/105、corpus-test 11/11。独立只读 review 一轮（无 HIGH；2 MEDIUM：行首预留先扣的测试实为空转、诊断聚合有两段为空；6 LOW：water-filling 第二轮触顶、容差过松 1024 倍、tail 补差分支未覆盖、barsPerStaff 边界与混排、行首零 timed measure 被拉伸、不变量测试自比；均已补测），其中 barsPerStaff 的语义由用户裁决 a / b / c 定稿。独立 worktree 变异 **63 个，杀死 62 个**；唯一存活 `05-jianpu-pre-T35-spacing`（简谱 demand 不传分组计划）记为**当前可达状态下不可观测的等价变异**——简谱同时值组列宽在当前可达状态下天然相等，与 T3.5 已认可的 `J-no-equalize` 同因；主工作区 hash 零漂移。
- **真实语料（compose 实测）**：shared 725 / tier 3 54（not-compatible 46 + degraded 8）/ 零 timed shared 0；行数：宽 100000 → 19（每 group 一行，全 `none`）、宽 960 → 84（full 61 / partial 0 / none 23，none 含 9 个全零 fallback group，全在 corpus#08）、宽 16 → 471（全 `none`）；行首预留只在 corpus#05 的 Staff group 触发；不变量（`width ≥ demand ≥` 各 raw voice / segment demand、full 时整数级严格相等、partial 时全部触顶）零违例；112 个 shared measure 有非零 lead、215 个 shared measure 的 `lead + Σseg + tail` 严格大于各声部整小节最大值（最多 89.7）。T3 基线 19 / 725 / 8 / 46 与 T3.5 基线 937 / 456 不变。
- 已知限制（不在 T4 处理）：`composeSystemGeometry` 尚未接任何调用方（~~T5 接 voice layout~~ 生产编排归 T8，T5 只在测试侧把它整理成 external 输入；T9b 接 renderer）；可用宽为 `Infinity` 时按 0 处理（每 measure 一行，调用方从不传无限宽）。

**M2.5 T5 实际状态（2026-10-05，`ed4ea88`，CI run 37284116914 三平台全绿；以下为 T5 当时快照，T5.S 已完成，见下一节）**：
- 范围：**只做三个 voice layout（Jianpu / TAB / Staff）的 external geometry adapter**；renderer、`system/**`、Domain / parser / serializer 零改动（`git diff 25c3015` 对这些目录为空）。按用户裁决分 5 个内部阶段（T5-0 helper + 默认路径 golden → T5-1 Jianpu → T5-2 TAB → T5-3 Staff → T5-4 集成 + 守卫），一个代码提交（18 文件：7 改 + 11 新）。
- **用户裁决 A–P + 额外裁决 1–9（2026-10-05，冻结方案的 post-freeze amendment，方案顶部修订记录与 §B.4 / §Q3.1b / §Q3.3 / §Q3.5 / §Q7.4 / §D 已同步）**。
- **API（A1 / A2 / A3）**：三个 Context 新增可选 `external?: { measures: readonly SystemMeasureGeometry[]; systems: readonly System[] }`（原子成对、内联、不进 contracts）。缺席 → 走默认路径，**与 `25c3015` 逐字段一致**；存在 → 不换行、不 restack，`availableWidth` 不使用。external 输入的任何 mapping / system / timeline / 数值不变量失败一律 `RangeError`，**绝不回退**默认路径或 tier 3。
- **映射（B）**：measure 只按 `voiceId + participation.localMeasureIndex` 取公共框，**不是** `measureOrdinal`、也不是数组位置；本声部 local measure 的键集合必须恰为 `0..n−1`。absent 不造 measure / 节点 / slot / 诊断。
- **systemIndex（C）**：T4 的全文档全局 systemIndex 原样保留，**不得**作为 `systems[]` 下标、不重新编号；三个 layout 与 `tabRelations` 一律按 `System.index` 查找（默认路径 index 恒等于位置，结果不变）；`jianpuArcs` 跨行弧只遍历实际存在的行谱、两端缺失仍抛错；`assignLyricSyllables` 的兜底行谱参数化（external 取本声部最小 index）。
- **共享 helper（L）**：新 `layout/measurePlacement.ts`（212 行），结构类型、不 import `system/**` 与任何记谱目录：`mapExternalMeasures` / `placeExternalMeasure` / `externalExtent`。onset 映射（D）在 layout 内复用 `voiceMeasureOnsets` + Domain `equals` 与 `timeline.offsets` 精确匹配，不扩 contracts。
- **shared placement（E-c / J）**：每个不同 offset 的首个 timed 项是锚点，x 恒为 `geometry.x + xByOffsetIndex[k]`（Jianpu / TAB / 公共 timeline 三方逐位相等）；同 onset 的后续零时值 timed 项从锚点起保原宽向右排（左簇）；decoration / grace / unknown 等其余 untimed 项保原宽、整串**右贴下一锚点**（lead 段区间 `[contentOffsetX, 首锚点]`，末段贴 `endX`）；零宽 chordSymbol 位于段尾时逐位落在下一锚点；收尾 barline 在 `endX`、宽 `width − endX`。零 timed shared 跟随同一规则。左右簇相交即 `RangeError`——段内原宽按与 T4 `measureDemand` **同序同源**的累加与公共区间（tick 网格上两 x 之差）精确比较。
- **tier 3 placement（F-d）**：非尾 barline 内容按**本声部**比例拉满 `contentOffsetX → width − 尾宽`，尾 barline 保留原始 slot 宽并钉右；`bodyRaw = 0` 不除零；scale < 1（本声部整小节原宽 > 公共内容宽）为契约违例。
- **slot / node（P / 额外裁决 7）**：external slot 一律 clone，`x` 为 measure 内最终相对 x、`width` 为最终分配列宽；`node.width` 取最终宽；原 spacing 不被修改。节点 x = `system.origin.x + geometry.x + slot.x`。
- **external Jianpu / TAB（H-a / G / G-2a / I）**：**不 restack**，外部 System 的 y / height 为真值；`layout.systems` = 外部 systems 按 index 升序（对象原样、全局 index 原样，本声部没有 measure 的公共行谱也保留）；宽高取全部 system 的最大外沿（不依赖数组顺序）；TAB 弦线只覆盖本声部在该行谱上真实 measure 的范围，无 measure 的行谱不画。
- **external Staff（K-b，tier 1）**：`stave.x / width` = 公共 measure 的 `x / width`（行首 `width` 已含预留），行首 header 判据为 `contentOffsetX > 0`，**不重复叠加** `staffLineHeaderReserve`；不做 VexFlow 音符 x 对齐（tier 2 归 T5.S）。
- **T8 归属（N-a / 额外裁决 1，架构修改）**：T5 只提供三个 voice layout 的 external adapters；**T8 负责真正的纵向 system 组装**——调用三个 external layout、`VoiceLayerLayout.top / height`、Jianpu 歌词带补高、TAB 最深时值补高、T6 和弦 overlay 带、`system.box.height`、最终 `ScoreSystemLayout` / `ComposedSystemLayout`。§Q7.4 的「system → voice layout 正面边」改归 T8；T5.S / T6 期间**不得**提前组装半成品 composer 或固定层高。
- **默认路径回归门（M）**：`tests/fixtures/golden/t5-default-layout.sha256.json` **945 项**（全部 fixture × jianpu / tab / staff 强制记谱 × 宽 100000 / 960 / 16），基线 `25c3015`，**严格序列化**（区分 `-0` / `NaN` / `±Infinity` / `undefined` 键 / `Map`），由独立 `25c3015` worktree 运行 `scripts/notation/t5-default-golden.ts` 生成；`t5.defaultRegression.test.ts` 只读、不自动更新。会话内另对 11 份真实语料补比 99 项（3 宽度 × 3 记谱），漂移 0。
- 守卫：三个 voice layout **type-only** import `system/contracts` 的 `SystemMeasureGeometry` 并实际使用（含反例）；三个 layout 真正调用 `measurePlacement` 的三个出口；`measurePlacement.ts` 不 import `system/**` 与记谱目录；**T9b 前** `renderer/**` 不出现 `external`（可能过严误报，T9b 接 renderer 时删除 / 改写）；T4 的「`system/**` 不 import voice layout 入口」保持。
- 测试：新增 `layout.measurePlacement` / `jianpu.external` / `tab.external` / `staff.external` / `system.external.integration` / `t5.defaultRegression` 及两个 helper；全仓 Vitest **91 files / 6471 pass**；fixture-report 105/105、corpus-test 11/11。集成测试对全部 fixture × 宽 960 / 16 用真实 T4 输出逐声部跑 external（0 抛错，C1、shared timed x、Staff stave 边界全对）。独立只读 review 无 HIGH（1 MEDIUM：测试 `origin.x` 恒 0；4 LOW：Staff slot 断言空转、golden 序列化抹平 `-0` / `NaN`、system box 与 offsets 严格递增未校验、弧线端点缺失抛错无测试——均已补测 / 补校验）。独立 worktree 变异 **58 个全部杀死**（首轮 47 杀 46，存活的「宽高取最后一项」因单测构造巧合，已补反例）。主工作区 hash 零漂移。
- **真实语料**：T3 基线 19 / 725 / 8 / 46、T3.5 基线 937 / 456、T4 @960 shared 725 / tier 3 54 / full 61 / none 23 / partial 0 全部不变；真实语料中「记谱声部的全局 systemIndex 非 0」零样本（只有 corpus#08 的 fallback 声部），由合成多 group 用例覆盖。
- **已知限制（阶段性债务，T8 清理）**：① external 模式不 restack，Jianpu 歌词带与 TAB 深时值刻印可能暂时超出外部 `System.box.height`；② external shared 以公共 timeline 为最高优先级，T3.5「同时值 beam 组等距」在 external 路径**不再保证**（默认路径不受影响）。另：golden 生成脚本不在 `tsconfig` include 内（与 T3.5 生成脚本同模式，非生产路径）。
- **流程教训**：首次同步 mutation worktree 时，zsh 不对字符串文件列表分词、`set -e` 亦未中止，拷贝静默失败，被最后的条数检查拦下；此后 harness 一律写成 bash 脚本、用数组、每项检查显式 `|| exit 1`。

**M2.5 T5.S 结论（2026-10-05，VexFlow shared timing spike，用户裁决 A；结论文档 `docs/M2.5_T5S_VEXFLOW_SHARED_TIMING_SPIKE.md`）**：
- **结论 `feasible-with-cost`，no adapter merged**。M2.5 **继续只承诺 Staff tier 1**（stave x / width = 公共 measure 几何）；Staff tier 2（stave 内音符 x 与 Jianpu / TAB 逐音对齐）移为 **post-M2.5 enhancement**。spike 期间仓库零改动（生产代码、`system/**`、三个 voice layout、Domain / parser / serializer、renderer 均未动），恢复点仍是 `2678563` 之上的本文档提交。
- **依据**：VexFlow 官方 `5.0.0` 标签源码（提交 `8879d09`，与项目锁定版本一致）+ Chromium 实测（VexFlow 5 的字形宽度全靠 canvas `measureText` + Bravura 字体，Node 下为 0，故在浏览器中实验）。
- **布局链**：音符绝对 x = `tickContext.x + stave.getNoteStartX() + Stave.padding(12)`；Formatter 只在 `preFormat` 写 x；draw 不重算 x；Beam 斜率在 `postFormat` 时按当时符干 x 计算；Tie 端点基于最终 `getAbsoluteX`。
- **Route A**（Formatter 后覆写 `TickContext.x`，`tc.x = stave.x + target − noteStartX − Stave.padding`）成立：均匀 / 非均匀目标、stave.x ≠ 0、和弦 / 错位符头 / 休止 / 附点 / 升降号 / `TextNote` 占位，draw 后绝对 x 逐位命中；tie 跟随；beam 跟随（覆写须早于 beam postFormat）。**Route B**（手动 context）同样成立且修饰偏移与 A 完全相同，但维护成本更高；**Route C** 对「x 是否可控」不必要。外部 x 过窄时 VexFlow **不抛错、不挪动，静默重叠**。
- **关键约束（真实语料 probe）**：相邻锚点间距在 corpus#05（47 对）与 fixture（42 对）中**全部宽于** VexFlow 最小间距、小节尾全部放得下；冲突**只在非行首小节的首个 onset**——T4 让首个 onset 贴 measure 左边界，VexFlow 要求 ≥ 17（`noteStartX` 的 5 + padding 12）+ 首音左侧修饰：corpus#05 @960 有 **11 / 16** 小节过窄（最大缺口 **24.21**），fixture @960 有 6 / 14（最大 17）；行首小节在真实语料中全部放得下，但 T4 行首预留（104）对 ≥ 2 个升降号的调号即不足（VexFlow 每个升降号约 11，T4 按 8；见 §30.1 债务表「Staff header demand calibration」）。
- **tier 2 的三个 prerequisite（post-M2.5，单独立项）**：① Staff demand calibration（T4 范围：lead 计入 VexFlow 内部缩进与首音左侧修饰，行首预留按实际升降号宽度或 renderer 注入的测量接口；notation 层不得 import vexflow）；② Staff 契约扩展（标记哪些 stave 是 shared，或由 T8 / T9b 把公共几何交给 renderer；`StaffEventNode.slot` 不含 x）；③ renderer adapter（约 40–60 行，限 `renderer/integrations/vexflow/**`，只对 shared 小节覆写，tier 3 仍交 Formatter）。
- **硬约束**：**T6 / T8 期间不得顺手实现 Staff tier 2**（含 adapter、Staff demand 调整、契约标记）；下一任务为 **T6（chord overlay）**，待用户明确指令。

**M2.5 T6 实际状态（2026-10-05，`c74094e`，CI run 37296973259 三平台全绿；T8 已于 `b513261` 完成）**：
- 范围：**只做和弦图 overlay 的水平规划**——chordSymbol 收集、来源选择 / 语义去重、精确查表、shared / tier 3 x、footprint、碰撞与三种诊断；**不做**最终 y、`VoiceLayerLayout.top / height`、和弦带纵向堆叠、`system.box.height`、`ScoreSystemLayout` 组装与 renderer（均归 T8 / T9）。`chord/**`、三个 voice layout、contracts、renderer、Domain / parser / serializer 零改动。按用户裁决分 4 个内部阶段（T6-0 analysis 暴露 → T6-1 lookup / source / x → T6-2 collision / diagnostics → T6-3 tests / guards），一个代码提交（7 文件：4 改 + 3 新）。
- **用户裁决 A–N + 附加裁决 1–10（2026-10-05，冻结方案的 post-freeze amendment，方案顶部修订记录与 §Q5.2 / §Q7.4 / §D 已同步）**。
- **产物（A-a）**：`system/chordOverlay.ts` 导出 `planChordOverlays(renderScore, composed, measurer): ChordOverlayPlanning { plans: ChordOverlayPlan[], diagnostics }`；`ChordOverlayPlan { anchor, sourceRef, displayText, form: 'diagram' | 'name', shapeIndex?, groupIndex, systemIndex, measureOrdinal, x, footprint { left, right, height } }`，**不带 y**；T8 再加 y 组装最终 `ChordDiagramOverlay`。
- **T4 产物扩展（C-b）**：`ComposedSystemGeometry.analysis = SystemAnalysis { grouping, alignment, timings }`，纯数据、无函数 / cache；一次 compose 内 T1 / T2 / T3 仍只跑一次。`composed.diagnostics` 不变；T6 诊断只含三种码，不重新合并 analysis 内诊断；**T8 最终诊断顺序 = `composed.diagnostics` + T6 诊断**。
- **x（B-a / D-a）**：system box 内的时间锚点，图 / 名以它为中心。shared 只消费 T3 `OverlayOnset`（onset(k) → `G.x + xByOffsetIndex[k]`，measure-end → `G.x + endX`）；tier 3 = 与 T5 external layout 同源的 `placeExternalMeasure` slot x（spacing 按需计算）。缺公共几何、shared 缺 timeline → `RangeError`；degraded / not-compatible 正常走 tier 3。不 clamp。
- **流水线顺序**：shared = source resolution → 跨声部同文本去重 → 对保留候选精确查表（`chordSymbolDisplayText(raw) === chordShapes[i].name`，零归一化）→ `name-ambiguous`（每个保留候选一条）→ 碰撞；tier 3 不跨声部去重 / 判冲突，每个事件独立查表。同位置以 (voiceOrder, itemIndex) 最早者为 base，跨声部与 base 不同的每个事件一条 `symbol-conflict`（G/G/C → 1、G/C/C → 2），同声部同位置逐个保留；**§Q5.2「横向并排」作废**，同位置不同文本保持相同音乐 x。
- **footprint / 碰撞（G / F-4 / H-a / I / N）**：带图取真实 `ChordLayout` 局部包围（网格、居中名字、capo；`SYSTEM_METRICS.chordDiagramWidth = 108`），只画名取实测名宽；每 system 按 `systemIndex → x → measureOrdinal → voiceOrder → itemIndex` 严格判重叠，带图降级为只画名 + `diagram-collision`（info），降级后以名字框继续参与。`layoutChord` 按 shapeIndex 按需缓存、签名不变。
- **职责拆分**：`chordOverlaySources.ts`（86 行）只负责来源选择 / 去重 / 冲突，不认识几何、不查表、不调 `layoutChord`；`chordOverlay.ts`（197 行）负责定位 / 查表 / footprint / 碰撞 / 诊断汇总。守卫：`layoutChord` 只允许 `chordOverlay.ts` 值导入并调用；voice layout 入口对 `system/**` 仍禁止（T8）。
- 测试：新增 `system.chordOverlay.test.ts`（含 108 宽几何、独立逐元素 footprint 断言、去重 / 冲突组合、顺序契约、四种 tier 3 来源与 T5 external 节点 x 一致、跨 system / 首尾相接碰撞、RangeError、全 fixture 不静默丢弃）；全仓 Vitest **92 files / 6523 pass**；fixture-report 105/105、corpus-test 11/11。独立只读 review 无 HIGH（MEDIUM：去重三分支未测；LOW：footprint 预言同源等；均按用户裁决补测 / 修复）。独立 worktree 变异 41 个：**39 个非等价全部杀死**；2 个等价——tier 3 用 `measureOrdinal` 代 `slice.index`（前缀对齐下恒等，1320 个在场成员反例搜索 0）、`showFinger → false`（不影响 footprint）。主工作区 hash 零漂移。
- **真实语料**：chordSymbol 296（shared 244 / tier 3 52），唯一图形精确命中 38（corpus#07 6/6），宽 960 下带图 25、碰撞降级 13、左缘溢出 40；T3 19 / 725 / 8 / 46、T3.5 937 / 456、T4 @960 shared 725 / tier 3 54 / full 61 / none 23 / partial 0、T5 默认路径 golden 945 项均不变。review 的一次性探针（11 语料 × 4 策略共 1184 个 plan：0 抛错、诊断 id 0 重复、footprint 0 漏元素、external TAB chordSymbol x 与 plan x 对齐 shared 900/900、tier 3 208/208）记为验证证据，**不作为永久 golden**。
- **T8 / T9 集成前提（必须遵守）**：
  - **Staff**：T6 overlay x 是 shared musical anchor；Staff tier 1 下音符 x 仍由 VexFlow Formatter 决定，**本阶段不保证二者逐音一致**——这不是 T6 regression。
  - **TAB**：T8 调 external `layoutTab` 时必须继续传 `score.meter`，否则 tier 3 spacing（`planTabBeams`）与 T6 分叉。
  - **Chord**：T9 再调 `layoutChord` 时必须保持 `width = SYSTEM_METRICS.chordDiagramWidth`、`showFinger = score.showFinger`；不得重新做查表 / 去重 / 碰撞决策。
  - **T8 ownership**：左缘溢出（行首和弦图伸出 system 左缘）、和弦带高度（取各 plan `footprint.height`）、F-11 纵向次序（和弦名 → 和弦图 → 扫弦箭头 → TAB 第 1 弦）、最终 y 与 system 高度；TAB 扫弦与 voice 内 chordSymbol primary 节点同 x 的 54 处也在 T8 集成处理。

**M2.5 T8 实际状态（2026-10-05，`b513261`，CI run 37305952319 三平台全绿；T9a 已于 `49b0e11` 完成）**：
- 范围：**最终 vertical system 组装**——把 T4 公共几何、T6 和弦 overlay 规划与三种 voice layout（T5 external 路径）组装成
  最终 `ScoreSystemLayout` / `ComposedSystemLayout`。不接 renderer、不实现 Staff tier 2、不做 PageModel。一个代码提交
  （14 文件：5 改 + 9 新）。用户裁决 A–L + 修复轮裁决（2026-10-05，冻结方案顶部修订记录与 §Q7.4 / §D 已同步）。
- **API**：`system/composeLayout.ts` 导出 `composeScoreLayout(renderScore, index, measurer, policy): ScoreLayout
  { composed: ComposedSystemLayout, voiceLayouts: VoiceLayoutEntry[], diagnostics }`。`VoiceLayoutEntry` 为
  jianpu / tab / staff 判别联合（contracts 是叶子层，不能引用 voice layout 类型，所以非 contract 包装住在 system/）。
- **vertical-demand prepass（A）**：`system/verticalDemand.ts` 只凭 measure → system 归属算每个 (声部, system) 层高，不依赖
  y，因此「行高 ↔ layout y」不成环；每个真实 voice layout 最终**恰好调用一次**（守卫钉住）。
  - 简谱 = `systemHeight + lyricBandHeight(rows)`，沿用既有公式（**C**：不收紧 46u 余量）；行数口径与 external 路径一致
    （无目标兜底 = 本声部最小 systemIndex）。
  - TAB = `systemHeight + extraSystemHeight(本声部本行 measure)`，按 (声部, system) 计，不跨行、不跨声部。
  - Staff 固定 96；fallback 0。
  - **B**：已知记谱声部尾部缺 measure 的行仍保留基础高度空层，并照常作为该声部 external `systems` 的一项传入。
  - 缺失预期需求 / rebase 后 measure / 纵向 frame / 声部层 → `RangeError`（结构不变量被破坏，不静默给 0）。
- **纵向堆叠（`system/verticalLayout.ts`，E / G / I）**：和弦带 = `max(footprint.height) + chordBandGap`（无和弦 0、不留 gap），
  带在全部层之上（F-11）；层 top 相对 box 递推，`layerGap` 只在相邻已知记谱层之间；**fallback 层 `height = 0`、不计
  `layerGap`、不调用 layout、不进 `voiceLayouts`、绝不回退 Staff**；y 自 0 起，`systemGap` 只在相邻 system 之间、不计入
  box，跨 group 不重置。`ChordDiagramOverlay.y` = **overlay 块顶**（块底对齐带底）。
- **横向 extent（F + post-freeze amendment）**：`ScoreSystemLayout.box` 包含 **T4 system geometry + T6 chord ink extents**，
  **不宣称包含歌词墨迹**。left 向下、right 向上吸附到 `geometryQuantum = 1/1024`（各多 < 1 tick 的不可见留白，不裁墨迹），
  `box.origin.x = left`、`box.width = right − left`、`dx = −left`；最终 `measures[].x` 与 overlay x 统一 `+dx`，external
  `System.origin.x = left`、`width = box.width`。**精度契约**：T4 measure / shared x 为 bitwise-preserving rebase（二进制
  定点可证明）；tier 3 voice-local x 只承诺严格浮点误差界 `4ε·max(1,|x|,|local|,|origin|)`（合成用例 57.6 + 54 跨 2⁶
  即不逐位还原）；真实语料 2368 个 overlay 实测逐位相等只是 observed evidence，不是契约；也不加运行时相等断言。
- **简谱歌词居中（D）**：只改 external / systemized 路径——有目标音节 left = `node.x + node.glyphWidth/2 − 音节宽/2`；
  missing-target 仍从同一 (行谱, verse) 上一音节右侧顺排；legacy 默认路径逐字段不变（T5 golden 945 项未更新）。
  `buildLyricNodes` 新增可选 `centerOf` 参数，只由 external 路径传入。
- **诊断（H）**：`composed.diagnostics`（已含 renderScore / T1 / T2 / T3）→ T6 chord → voice layouts（group 顺序、组内
  `voiceIds` 顺序），只拼接、不重排、不去重、不重复合并 renderScore。
- **TAB / 简谱 meter**：两者都传文档 `meter`（beam 分组）；Staff 传整份 `score`。
- **守卫（J）**：三个 voice layout 入口只允许 `composeLayout.ts` 值导入，且各**恰好调用 1 次**（防止以后在测量趟再调一次、
  重开双布局循环）；`verticalLayout.ts` 不 import 任何记谱目录；`verticalDemand.ts` 只经 `jianpuVerticalDemand` /
  `tabVerticalDemand` 取层高；两个 helper 不得 import 各自的 layout 入口；`layoutTab` / `layoutJianpu` 默认路径真正使用
  迁出的 `extraSystemHeight` / `lyricBandHeight`。
- 文件：`composeLayout.ts` 195、`verticalLayout.ts` 116、`verticalDemand.ts` 98、`jianpuVerticalDemand.ts` 61、
  `tabVerticalDemand.ts` 49 行；测试 `system.composeLayout.test.ts` 244 / `.lyrics.test.ts` 150 / `.helpers.ts` 69、
  `system.verticalLayout.test.ts` 176 行。**文件规则**：自 T8 起新增或实质修改的 source / test 文件 ≤ 350 行；
  **`architecture.test.ts`（913 行）为历史冻结超长文件**，T8 守卫按豁免保留，**T9a / T9b / T9c 及以后任何新 architecture
  守卫不得再追加到该文件，必须新建 `architecture.<stage>.test.ts`**。
- 验证：typecheck；Vitest **95 files / 6710 pass**；fixture-report 105/105；corpus-test 11/11；T3 / T3.5 / T4 / T5 / T6
  baseline（5 files / 110）全绿。独立只读 review 无 CRITICAL / HIGH（MEDIUM：tier 3 精度不可证明 → 改为分级契约 + 合成
  用例；LOW：右界未吸附、测试 `as`、不可达兜底、守卫只验 ≥1、测试超 350 行、TAB 分 system 补高测试不足——均按裁决修复）。
  独立 worktree 变异 **60/60 杀死、0 等价**（含右界不吸附 / 向下吸附、缺失需求兜底 0、只平移一半路径、overlay 不随
  measure rebase、fallback 计入 gap、renderScore 诊断重复合并等）；主工作区 hash 零漂移。真实语料 11 文件 × 4 宽 ×
  screen/page 共 88 次运行：0 抛错，6232 measure 逐位还原，2368 overlay（shared 1952 / tier 3 416）全在误差界内，box 全部
  包住和弦墨迹；随机右溢出探针 20000 例 0 违反。
- **T9 集成前提（必须遵守）**：
  - **T9b chordSymbol**：systemized renderer 必须 suppress **全部** voice-local chordSymbol glyph（不是只 suppress 保留下来
    的 overlay anchor；被跨声部去重的同名事件也有 primary 节点）；layout nodes 保留，不改 voice layout。
  - **T9b 歌词溢出**：systemized 歌词居中后可能横向越过 system box（box 只含 T4 geometry + T6 chord ink；歌词墨迹要在
    external Jianpu layout 后才知道，纳入会重开 layout → box → layout 循环）；T9b / PageModel 联调时检查
    overflow-visible / clipping 策略。
  - **Staff**：仍是 tier 1，音符 x 由 VexFlow Formatter 决定，与 overlay x 不保证逐音一致。
  - **Chord**：T9 调 `layoutChord` 保持 `width = SYSTEM_METRICS.chordDiagramWidth`、`showFinger = score.showFinger`，
    不重新查表 / 去重 / 碰撞；overlay y 是块顶。

**M2.5 T9a 实际状态（2026-10-05，`49b0e11`，CI run 37312875513 三平台全绿；T9b 已于 `9eb5722` 完成）**：
- 范围：`PageComposedSystemLayout { target:'page' }` → `PageModel` 的纯数据 system → page 分配。contracts / metrics /
  diagnostics 与冻结的 `architecture.test.ts` 零改动；不接 renderer、不做打印 UI。一个代码提交（3 个新增文件）。用户
  裁决 A–N + 修复轮裁决（2026-10-05，冻结方案顶部修订记录、§Q6.6、§Q7.4 守卫 5、§D 已同步）。
- **API**：`pageModel(input, spec = SYSTEM_METRICS.page) → PageModelResult { model: PageModel, diagnostics }`（非 contract
  包装，**不修改现有 `PageModel` contract**；`model.pageSpec` 只要求值等于输入 spec）。
- **页面 box**：header / content / footer 都在左右边距内、等宽，header 贴上边距，content 紧接 header，footer 紧接 content、
  其下是下边距；首页与续页唯一差别是 header 高。默认首页 header (56,56,682,160) / content (56,216,682,827) /
  footer (56,1043,682,24)；续页 header (56,56,682,24) / content (56,80,682,963)。
- **分页**：只看输入顺序与 `box.height`，**完全不使用 `box.origin.x / y` 或 width**。页首无 gap、system 之间一个
  `systemGap`、页尾无 gap、翻页不继承 gap，放得下用 `≤`；**零高 fallback-only system 仍作为 system 参与 gap 语义**。
  `systemIndices` 保留原 `ScoreSystemLayout.index`，`PageLayout.index` 连续 0-based；空 system 输入 → `pages = []`。
- **overflow**：按 system **实际所在页**的内容高判断（`>` 才算，相等不算）；overflow system 独占并封页、不拆、不缩放，
  其后的 system 一律开新页（不另设判断：overflow 页 `used > capacity`，gap 与后续 height 均 ≥ 0，数学上必然放不下）；
  全谱第一个 system 若对首页超高，就直接 page 0 overflow，**不制造空首页**。每个 overflow system 一条
  `system.page-overflow`（warning），anchor 固定取第一层 voice——**只用于定位，不代表该声部造成超高**，措辞中性。
- **校验**：PageSpec 对所有调用都校验（含空输入），非法值 `RangeError`；system `height` 必须 finite 且 ≥ 0，
  `layers.length === 0` 属结构错误（对全部 system 先验，不只在 overflow 时）。`barsPerStaffHint` 在 M2.5 中字段缺席。
- **诊断**：page diagnostics 只含 T9a 自己的诊断；**最终 page-path 汇合顺序 = `scoreLayout.diagnostics → page
  diagnostics`**（id 键为 anchor + code，page-overflow 不与 T8 诊断撞 id）。M2.5 中只有测试走 page 路径，M5 再接入。
- **调用方前置条件**：compose 时 page policy 的 `contentWidth` 必须等于 PageSpec 内容宽；PageModel 无法反查，也不用
  `box.width` 校验（T8 box 合法地含和弦墨迹）。T8 产物可经属性收窄直接喂入（`if (c.target === 'page')
  pageModel({ target: c.target, systems: c.systems })`，无需 `as`）。
- **守卫**：`architecture.test.ts` 继续冻结（T0 守卫 5 照常检查已存在的 `pageModel.ts`）；**守卫 5「文件不存在时允许
  空跑」的到期提醒由 `architecture.t9a.test.ts` 的存在性断言正式承接**。t9a 守卫自带最小本地 helper：import 白名单、
  屏幕侧概念（`availableWidth` / `zoom` 不设词边界，含 `getAvailableWidth` / `maxZoom`；`ResizeObserver`、`scoreView`、
  `SCORE_VIEW`、`computeAvailableWidthUnits`）与抽样 DOM 入口禁用、正向依赖 `SYSTEM_METRICS` 与诊断 helper，均带
  反例；已知限制（接受）：正则级去注释遇字符串里的 `//` 可能误删同行代码。**T9b / T9c 的新守卫仍另建
  `architecture.<stage>.test.ts`**。
- 文件：`pageModel.ts` 157 行（预算 180）、`system.pageModel.test.ts` 320、`architecture.t9a.test.ts` 148。
- 验证：typecheck；Vitest **97 files / 6872 pass**；fixture-report 105/105；corpus-test 11/11；T3–T8 baseline 254 条
  全绿。独立只读 review 无 CRITICAL / HIGH（MEDIUM：anchor 测试分不清首层 / 最高层；LOW：续页内容高 = 0、自定义
  spec 只验 box、守卫词边界与注释、import 顺序、压缩字面量——均按裁决修复；冗余的 `!current.overflow` 已删除）。
  独立 worktree mutation 48 个：**47 non-equivalent mutants killed；1 equivalent mutant：width/height `<= 0` → `< 0`**
  （被内容宽高校验蕴含；直接的 width/height 正值检查是刻意保留的公开输入校验合同）；类型放宽（接受 screen 产物）由
  tsc 杀死。主工作区 hash 零漂移。真实语料 PageModel 探针（只作验证证据，不做 page-count golden）：默认 PageSpec
  11 文件共 34 页、0 overflow，每页 1–9 个 system；窄高合成 spec 88 页、3 overflow，index 一一对应、无超容量页、
  重复运行一致。
- 流程备注：本阶段起禁止 `npx` / `npm exec` / `pnpm dlx` 等隐式下载；typecheck / 测试走 `npm run` 脚本，scratch 探针用
  `node --import tsx`。

**M2.5 T9b 实际状态（2026-10-05，`9eb5722`，CI run 37325626662 三平台全绿；T9c 未启动，先裁决 Staff 纵向墨迹越界）**：
- 范围：**renderer system 化**——renderer 正式从声部级路径切到 `composeScoreLayout(screen) → system DOM`。不接 PageModel UI、
  不实现 Staff tier 2、不改 Domain / parser / serializer；冻结的 `architecture.test.ts` 零改动。一个代码提交（17 项：6 改、
  3 删、8 新）。用户裁决 A–P + 补充裁决 1–8 + 修复轮裁决（2026-10-05，冻结方案顶部修订记录与 §D 已同步）。
- **管线**：`ScoreView` 唯一编排入口 `composeScoreLayout(renderScore, index, MEASURER, { kind: 'screen', availableWidth })`
  → `buildScoreRender`（`components/notation/systemRender.ts`，纯组装）→ `SystemView`（每个 system 一个
  `section.score-system[data-system-index]`）。**旧 `voiceRender.ts` / `StaffVoiceView.tsx` 已删除**；`computeAvailableWidthUnits`
  迁入 `systemRender.ts`，公式不变（`cssWidth / (cssPixelsPerUnitAtZoom1 × zoom)`）。方案 §D 写的 feature flag 从未落地，
  没有双轨。
- **切片（`systemSlices.ts`）**：简谱 / TAB / Staff 全部按 system 切片。简谱 / TAB 在 layout 副本上按 `systemIndex` 过滤后调用
  **不改动的** toSvg，只把根 viewBox 换成声部 layout 自己的层 box（= system box 左上 + 层 top）；简谱 tuplet 按括号 y 归属、
  `L:` 标记按事件归属（不唯一 → `RangeError`），头部 labels 非空 → `RangeError`；Staff 一个 `(system, voice)` 一个 VexFlow
  host，`renderStaff(host, StaffSystemSlice)`，stave 平移到层内坐标，拍号沿用「整份 StaffLayout 第一条带拍号的 stave」。
- **chordSymbol**：全部声部内 chordSymbol（含被跨声部去重、tier 3、降级的）**只在 renderer 可见层抑制**（唯一判断
  `kind !== 'chordSymbol'`，三个切片构造各调用一次），layout nodes 保留，C1 契约不变。adapter 中处理 chordSymbol 的分支与
  `.vf-staff-chord-symbol` 样式保留，在 systemized 路径下不会触发。
- **和弦 overlay**：直接使用 T6 / T8 冻结的 `shapeIndex / x / y / anchor`——带图 = `layoutChord(chordShapes[shapeIndex],
  width = chordDiagramWidth, showFinger = score.showFinger)` 的子节点放进 `translate(x − 54, y)`；只画名 = 以 x 居中、基线
  `y + CHORD_METRICS.nameY`、字号写入 SVG 属性。renderer **不重新查表、不重做碰撞**；每块只有一个 `data-anchor-key`
  （chordSymbol 的 event anchor），`chordToSvg` 内部零 anchor 有回归测试。
- **横向（J4，正式设计）**：动态 `leftGutter = max(0, −system.box.origin.x…)`，每个 system `leftOffset = leftGutter +
  origin.x ≥ 0`，所有 system 的音乐 x = 0 对齐，和弦左墨迹不进入负滚动坐标（zoom 300% 也能横向滚动看全）。只要有行首和弦
  图向左伸出，排满整行的 system 会向右多出约 `leftGutter × zoom` 像素、可能出现横向滚动——**这是接受的取舍，不固定预留 54u**。
  `ResizeObserver` 观察 `min-width: 0` 的 `.score-systems` 内容宽，子内容溢出不反馈到 `availableWidth`。
- **纵向**：system 之间的 `systemGap` 只由 `.score-systems` 的 row-gap 放一次（不读 `box.origin.y`），层按 T8 的 top / height
  绝对定位。
- **fallback**：提示从 `renderScore.voices`（`!isKnownVoiceStyle`）**全量**生成，文档顺序、每声部一项——没有正文且单独成组
  （不产出 system）的 fallback 声部不再消失；system 内保留高 0 的层身份（带 voice anchor，高亮时不画 0 高描边）。
- **CSS**：Staff system SVG 及其祖先（host / 层 / system）`overflow: visible`，越界墨迹不被裁剪；overlay 叠在各层之上，只有
  和弦组接收点击；画布不再按 `max-width: 100%` 等比缩小（zoom 只走 px 换算）。
- **诊断**：`scoreLayout.diagnostics`（已含 renderScore / T1–T3 / T6 / 各声部）→ 页眉诊断，不再额外合并 `renderScore.diagnostics`；
  按 id 去重只是兜底。高亮 effect 依赖 `[selectedAnchorKey, scoreRender, renderGeneration]`，每个 Staff 切片画完都调用 `onRendered`。
- **已知风险 / 债务**：
  - **当前没有 ErrorBoundary**：结构不变量破坏时抛出的 `RangeError`（T5 / T8 / T9b 的设计是遇异常即抛、绝不回退）可能让
    `ScoreView` 整体渲染失败（白屏）。留给后续 renderer robustness 任务：增加用户可见的错误边界，**不吞异常**。
  - **T9c 封板前裁决项（不是普通 INFO）——Staff 纵向墨迹越界**：T8 给 Staff 层固定 96u 高（Staff 额外高度恒为 0），而真实可见
    墨迹（多条加线、低位延音线等）会明显越出 96u 层框。T9b 让墨迹不被裁剪后，它会**侵入相邻 system 的区域**（合成谱实测墨迹
    范围约 −118 到 233，层高 96）。M2.5 要为后续 selection / editing 提供可信的最终几何，必须在 M2.5 封板前裁决：
    **A** 接受 Staff tier 1 视觉越界，M3 继续以层 box 为交互边界；**B** 在 M2.5 封板前插入小阶段补 Staff vertical demand
    （用户当前倾向 B）。
- **守卫**：新建 `tests/unit/notation/architecture.t9b.test.ts`（自带本地 helper，`architecture.test.ts` 继续冻结）：renderer
  全体不得值导入 / 调用声部 layout 与 T4–T9a planner（`import type` 放行），`composeScoreLayout` 只有 ScoreView 值导入；
  旧路径文件与开关不存在；ScoreView 接线（screen policy、zoom 进入可用宽度、row-gap 只消费一次 systemGap、诊断公式、高亮
  依赖含 `renderGeneration`）；components 不 import vexflow；adapter 不碰 TickContext / x 覆写 / preFormat（不做 Staff tier 2）；
  SystemView 不读 `box.origin`；chordSymbol 只在 `systemSlices.ts` 判断；关键 CSS（overflow / overlay 叠放 / 高亮规则）。
  每条都带反例。
- 文件：`systemRender.ts` 152、`systemSlices.ts` 159、`SystemView.tsx` 58、`StaffSystemView.tsx` 56、`staffSystemSlice.ts` 30、
  `ScoreView.tsx` 176、`renderStaff.ts` 334 行；测试 `systemRender.test.ts` 193、`systemSlices.test.ts` 317、
  `architecture.t9b.test.ts` 252 行，全部 ≤ 350。
- 验证：typecheck；Vitest **99 files / 6927 pass**；fixture-report 105/105；corpus-test 11/11；T3–T9a baseline 401 条；
  render matrix 1215 条，全部通过。独立只读 review 无 CRITICAL / HIGH（7 条 MEDIUM、10 条 LOW 按裁决修复或记录）。独立 worktree
  mutation **47/47 杀死**（首轮唯一存活「Staff x 不做平移」是夹具 origin.x 恰为 0 的测试缺口，补用例后杀死）；主工作区 hash 零漂移。
  真实语料组装探针（11 文件 × 2 宽）所有不变量 0 违反（只作验证证据，**不做 page / system 数的永久 golden**）。
  Electron 渲染进程 smoke（合成谱面）：system DOM、systemGap 只一次、音乐起点对齐、overlay 点击命中 event anchor、chordSymbol
  不重复、多 system Staff 无重复 / 残留 SVG、空单独成组 fallback 提示存在、zoom 50 / 100 / 150 / 300（容器宽恒定无反馈循环、
  300% 横向滚动可见最左和弦）、resize 窄→宽→窄稳定、事件 / 和弦 / 诊断 / fallback 高亮、Staff 重绘后高亮恢复、Staff 越界墨迹
  不被裁剪、控制台无错误。
- 流程备注：实现阶段删除文件只用 `rm`（曾误用 `git rm --cached` 并立即 `git restore --staged` 撤回）；全程禁止 `npx` /
  `npm exec` / `pnpm dlx`，scratch 探针用 `node --import tsx`。

**M2 seal 与 M3 前置（T9 之后，恢复时从这里继续）**：**2026-09-22 追加裁决：M2 与 UI 目标版式确认之后、M3 之前先做 M2.5 Score System Layout（见 §30 路线表与 `docs/UI_DESIGN_BRIEF.md` §2.7.6、§10.17/10.18）；M2.5 的 System 模型 = overlay layers（chord diagrams）+ ordered voice layers（TAB/Jianpu/Staff 接受外部 system/measure 几何）+ attached layers（lyrics），chord 不是第四种声部 layout，system 高度由内容决定、分页只在 system 边界，`bracket` 只证明视觉分组、需定义 cross-voice measure mismatch policy。**原文：T0–T9 已全部完成并推送，
下一步不是继续写渲染代码，而是：

1. **M2 seal**：push 后确认三平台（macOS/Windows/Ubuntu）CI 全绿，再由一次独立
   的 seal commit 把 §30 里程碑表的 M2 行标 ✅ 并写入该次 CI 的 run 号（不得提前
   标、不得由本轮 T9 commit 代劳）。
2. **M3 前的 UI 设计**：seal 之后，下一步**不是** M3 编码，而是先产出「功能清单
   + 设计要求」，由用户拿去 Claude Design 做视觉设计，设计稿确认后再回来规划
   M3 Editor Core 的实现任务序。
3. 后续 Agent 接手时，先读本节上方的「M2 遗留债务总表」，视觉 polish 与架构/
   测试债务分别在 UI 设计阶段与 M3 早期任务中择机排入。

**工作流约束**（M2 全程，M3 起沿用）：每轮改动 → typecheck / vitest / corpus →
只读 `/check` 审查 → 修复复审 → 提交；里程碑 ✅ 只在 push 后三平台 CI 全绿后由
seal commit 补上；真实语料只以 `corpus#NN` 引用。

---

# 31. 下一步：M1.3 `docs/JCX_SPEC.md`

> 历史记录：本节是 M1.2 阶段写下的任务说明，M1.3 已完成
> （`docs/JCX_SPEC.md` 现已存在）。保留本节是因为 §32–§39 的结构建议/评级规则/
> 测试策略仍是后续里程碑参照的设计依据；当前实际的下一步见 §69。

这是接手 Agent 应该立即执行的任务。

创建：

```text
docs/JCX_SPEC.md
```

不要立刻先写 Lexer。

先把当前 evidence 固化成正式格式规格。

---

# 32. JCX_SPEC 推荐结构

```text
# JCX Format Specification

1. Scope
2. Status / Evidence Levels
3. Compatibility Model
4. Encoding
5. Lexical Conventions
6. Document Structure
7. Magic Header
8. Information Fields
   8.1 X
   8.2 T
   8.3 C
   8.4 M
   8.5 L
   8.6 Q
   8.7 K
   8.8 I
   8.9 V
   8.10 w
9. Inline Fields
   9.1 [V:n]
10. Muse Directives
   10.1 %%gchord
   10.2 %%showfinger
   10.3 %%begintext
   10.4 %%endtext
   10.5 %%skip
   10.6 %%indent
11. Text Blocks
12. Voice Model
   12.1 staff
   12.2 jianpu
   12.3 tab
13. Musical Body Grammar
14. Note
15. Rest
16. Duration
17. Accidental
18. Barline
19. Repeat
20. Tuplet
21. Grace Notes
22. Tie / Slur
23. Decorations
24. Lyrics
25. Guitar Chords
26. Guitar TAB
27. Encoding / Serialization
28. Compatibility Behavior
29. Unknown / Unverified Behavior
30. Test Matrix
```

---

# 33. Evidence Level

规格中的每项都必须标：

```text
CONFIRMED
INFERRED
UNVERIFIED
```

定义：

## CONFIRMED

真实 legacy corpus 或静态逆向直接证明。

例如：

```text
[V:1]
[V: 1]
```

存在。

## INFERRED

根据：

- ABC convention
- legacy string
- help documentation
- 多个样本

合理推断，但尚未完全验证。

例如：

```text
%%gchord name=1;...
```

中 `1` 的精确含义。

## UNVERIFIED

尚无足够证据。

必须明确写：

```text
UNVERIFIED
```

而不是为了规格完整性自行补全。

---

# 34. M1.4 Lexer 设计建议

写完规格之后再进入 Lexer。

推荐：

```text
src/formats/jcx/lexer/
├── token.ts
├── lexJcx.ts
├── lexBody.ts
└── sourceSpan.ts
```

---

## 34.1 不建议一次 Lexer 整个文件

JCX 是明显的 line-oriented + body-token 两层格式。

推荐：

```text
Source
 ↓
Document line scanner
 ↓
Header / Directive / TextBlock / Body Line
 ↓
Body Lexer
 ↓
Music Tokens
```

也就是：

```text
top-level lexer
+
music body lexer
```

而不是用一个超大 regex lexer 解决一切。

---

# 35. Token 必须包含 Source Span

为了：

- 报错
- 编辑器定位
- source ↔ visual sync
- round-trip
- diagnostics

Token 最好包含：

```ts
interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

interface SourceSpan {
  start: SourcePosition;
  end: SourcePosition;
}
```

Token：

```ts
interface JcxToken {
  kind: JcxTokenKind;
  raw: string;
  span: SourceSpan;
}
```

不要只保存：

```ts
{ kind, value }
```

否则以后编辑器会重新返工。

---

# 36. Parser 必须追求 Lossless

项目目标不是只“读懂音乐”，而是：

> 打开 legacy `.jcx` → 编辑 → 保存 → 最大限度不破坏原文件信息。

因此推荐：

```text
Lossless AST
+
Normalized Domain Model
```

两个层级。

---

## 36.1 Lossless AST

负责：

- 原字段顺序
- 重复字段
- whitespace
- comments
- raw directive
- unknown future extension
- source span
- legacy aliases

例如：

```ts
interface JcxFieldNode {
  type: 'field';
  key: string;
  value: string;
  raw: string;
  span: SourceSpan;
}
```

---

## 36.2 Domain Model

负责：

- Music semantics
- UI
- Playback
- Rendering
- Editing commands

例如：

```ts
interface Score {
  title?: string;
  meter?: Meter;
  key?: KeySignature;
  voices: Voice[];
}
```

不要让 UI 直接操作 raw AST。

---

# 37. Serializer 应支持两种模式

建议：

```ts
serializeJcx(document, {
  mode: 'preserve'
})
```

和：

```ts
serializeJcx(document, {
  mode: 'canonical'
})
```

## preserve

目标：

- 尽量保留源文件结构
- 保留原 encoding
- 保留 field order
- 保留 alias
- 保留 comments/layout text
- 适合 legacy 文件编辑

## canonical

目标：

- 输出 Muse Next 标准格式
- 默认 UTF-8
- 统一字段格式
- 适合新文件

---

# 38. Round-trip 定义

M1.8 不应只测试：

```text
parse succeeds
```

至少分三级。

## Level 1 — Parse

```text
legacy source
→ parse
```

不报错。

## Level 2 — Semantic Round-trip

```text
source
→ parse
→ serialize
→ parse
```

两个 AST/Domain 语义一致。

## Level 3 — Preserve Round-trip

未编辑文档：

```text
source
→ parse
→ serialize(preserve)
```

目标尽可能：

```text
same text
```

如果 encoding 也 preserve，则进一步：

```text
same bytes
```

这将是高价值 compatibility 指标。

---

# 39. Test Strategy

## 39.1 不提交真实歌曲

公开测试不能复制 legacy song corpus。

## 39.2 自建 Fixture

目录：

```text
tests/fixtures/jcx/
```

使用自己编写的最小案例：

```text
minimal.jcx
voice.jcx
inline-voice.jcx
text-block.jcx
gchord.jcx
lyrics.jcx
tuplet.jcx
grace.jcx
tab.jcx
jianpu.jcx
```

每个 fixture 只验证一个 grammar feature。

## 39.3 Local Corpus Regression

真实 11 文件仍然应该参与本地测试。

例如后续增加：

```bash
npm run jcx:corpus-test
```

它可以：

```text
scan
parse
serialize
reparse
validate
```

但 corpus 本身保持 git ignored。

---

# 40. M2：Notation Rendering

> 本节是早期规划，**M2 T0–T9 已全部完成并于 2026-09-22 封板**，实际状态与债务见
> §30.1「M2 进行中状态」。

完成 JCX format layer 后进入渲染。

推荐优先级：

```text
1. Chord Diagram
2. Jianpu
3. TAB
4. Staff
```

理由：

- Chord 已经有可借鉴 SVG 实现；
- Jianpu 是 Muse 的核心差异能力；
- TAB 也是重要功能；
- Staff 可以评估 VexFlow 作为 adapter。

---

# 41. VexFlow 原则

可以用：

```text
VexFlow
```

帮助渲染五线谱。

但一定坚持：

```text
Muse Domain Model
        ↓
VexFlow Adapter
        ↓
VexFlow
```

不要：

```text
JCX Parser
    ↓
VexFlow objects
```

否则：

- Jianpu 难实现；
- TAB/Chord 被框架绑死；
- Playback/Editor 依赖 renderer；
- 文件格式和渲染耦合。

---

# 42. Jianpu

简谱很可能需要：

```text
Custom SVG renderer
```

不要指望通用西方乐谱库直接解决。

建议：

```text
Domain Note
 ↓
Jianpu Layout
 ↓
Jianpu Glyph/Layout Model
 ↓
SVG
```

后续应独立建立：

```text
src/notation/jianpu/
```

---

# 43. TAB

TAB 也建议先有自己的 semantic model。

例如：

```ts
interface TabNote {
  string: number;
  fret: number;
  duration: Duration;
  techniques?: TabTechnique[];
}
```

不要用 ASCII 文本作为 Domain Model。

---

# 44. M3 Editor Core

编辑层建议采用 Command Architecture。

例如：

```text
InsertNoteCommand
DeleteSelectionCommand
ChangeDurationCommand
SetChordCommand
ChangeVoiceCommand
```

核心：

```text
Command
 ↓
Domain Model
 ↓
Undo / Redo
```

不要直接让 React component 任意 mutation。

---

# 45. Source ↔ Visual Sync

这是长期关键能力。

推荐所有 Domain/AST node 都有稳定 identity：

```ts
type NodeId = string;
```

建立：

```text
Source span
↕
AST node id
↕
Domain node id
↕
Rendered element
```

这样后续才能：

- 点谱面 → 光标跳 source
- 点 source → 高亮谱面
- diagnostics
- incremental update

---

# 46. M4 Playback

建议分：

```text
Transport
Timeline Builder
Playback Events
Audio/MIDI Adapter
```

即：

```text
Score
 ↓
Timeline
 ↓
PlaybackEvent[]
 ↓
MIDI / WebAudio
```

不要 Renderer 驱动 Playback。

---

# 47. MIDI

原 Muse 是 Windows MIDI API。

Muse Next 不需要照搬。

可选：

- Web MIDI（环境允许时）
- Electron/native bridge
- Tone.js / WebAudio
- SoundFont
- MIDI file writer

关键：

> Playback Core 使用平台无关事件模型。

---

# 48. Import / Export

后续规划：

## Import

- `.jcx`
- ABC
- MIDI
- ASCII Guitar TAB

## Export

- `.jcx`
- ABC
- MIDI
- PDF
- Print

EPS/PostScript 不属于早期目标。

---

# 49. Print / PDF

Electron 可以提供：

```text
print
printToPDF
```

但谱面本身应先生成：

```text
page layout model
```

而不是直接对 UI 截图打印。

未来结构：

```text
Score
 ↓
Layout Engine
 ↓
Pages
 ↓
SVG / DOM
 ↓
Print / PDF
```

---

# 50. Legacy Custom Ornament

原系统：

```text
AdvanceNote.exe
default.dec
```

说明 Muse 支持自定义 ornament / graphic symbols。

历史理解包括：

- line
- circle
- bezier
- polygon
- fill

该能力优先级较低。

规划在：

```text
M5 / M6
```

之后再逆向。

不要阻塞 JCX Core。

---

# 51. 版权 / Clean-room 边界

非常重要。

## 不应发布

- 原 `Muse.exe`
- 原 installer
- 原歌曲 corpus
- 原 `MAESTRO.TTF`（授权不明确）
- 原 help 文档的大段复制
- 原二进制资源直接嵌入

## 可以做

- 根据文件格式行为写新 Parser
- 自己定义 AST
- 自己实现 renderer
- 自己绘制 chord diagram
- 使用 MIT 项目中许可允许的代码/思路
- 自己编写测试 fixture
- 描述兼容行为
- 提供格式迁移工具

---

# 52. 不要做的架构选择

### 1. 不要直接翻译 MFC class

错误：

```text
CMuseDoc → MuseDoc class
CMuseView → MuseView class
```

新架构不需要复制 2000 年代 MFC Document/View。

### 2. 不要以 VexFlow 为 Domain

已经解释。

### 3. 不要用 regex 拼一个巨大 parser

JCX 已经确认有：

- header
- inline field
- text block
- nested syntax
- chord
- grace
- tuplets
- decorations
- aliases

应正式 Lexer/Parser。

### 4. 不要过早 Canonicalize

例如：

```text
ins → instrument
vol → volume
```

可以在 Domain normalize。

但 Lossless AST 必须知道原始写法。

### 5. 不要把 Scanner 演变为 Parser

Scanner v0.2 已完成使命。

---

# 53. 当前最重要的设计原则

后续 Agent 请始终保持：

```text
RAW SOURCE
    ↓
LOSSLESS AST
    ↓
NORMALIZED DOMAIN
    ↓
APPLICATION
```

而不是：

```text
RAW SOURCE
    ↓
NORMALIZED JS OBJECT
```

因为后者会丢：

- 原字段顺序
- comments
- alias
- spacing
- source location
- future extension

最终破坏 legacy round-trip。

---

# 54. 下一位 Agent 开工顺序

建议严格按以下顺序：

## Step 1

先确认 repo 状态：

```bash
git status
git log --oneline -5
```

## Step 2

确认当前文件：

```bash
find src scripts docs tests -maxdepth 4 -type f | sort
```

## Step 3

执行：

```bash
npm run typecheck
npm run jcx:scan
```

预期：

```text
Unknown lines:    0
Unknown patterns: 0
```

## Step 4

阅读：

```text
docs/generated/jcx-corpus-report.md
scripts/jcx/*
src/formats/jcx/*
```

## Step 5

创建：

```text
docs/JCX_SPEC.md
```

## Step 6

不要立即改 parser。

先提交 spec：

```bash
git add docs/JCX_SPEC.md
git commit -m "docs(jcx): add initial JCX format specification"
```

## Step 7

再开始 M1.4 Lexer。

---

# 55. M1.3 Definition of Done

`JCX_SPEC.md v0.1` 完成标准（**全部完成**；逐条证据同步维护在
`docs/JCX_SPEC.md` 的 Appendix C，本节不重复誊写，只给指针）：

- [x] Encoding —— JCX_SPEC §4
- [x] `%MUSE2` —— JCX_SPEC §7
- [x] 10 Headers —— JCX_SPEC §8.1–§8.11
- [x] `[V:...]` —— JCX_SPEC §9.1–§9.5
- [x] 6 Directives —— JCX_SPEC §10.1–§10.6
- [x] text block —— JCX_SPEC §11
- [x] Voice attributes —— JCX_SPEC §12.2
- [x] attribute alias —— JCX_SPEC §12.3
- [x] Voice style —— JCX_SPEC §12.6
- [x] body feature inventory —— JCX_SPEC §13–§26
- [x] gchord syntax —— JCX_SPEC §10.1
- [x] evidence level —— JCX_SPEC §2.1 + 全文标注
- [x] known unknowns —— JCX_SPEC Appendix A
- [x] serialization constraints —— JCX_SPEC §5.11 / §27 / §29.5
- [x] test matrix —— JCX_SPEC §30

不要为了“完整”虚构没见过的语法。

---

# 56. M1.4 Definition of Done

Lexer 应做到（**全部完成**；命令见 §30.1）：

- [x] 不依赖 Electron —— `src/formats/jcx/{encoding,lexer}/` 下无 `electron` import
- [x] pure TypeScript —— 同上，纯函数 + 类型，无 Node 专有 API 依赖
- [x] source spans —— `lexer/sourceSpan.ts`，每个 token 带 `span`
- [x] raw lexeme —— `token.raw`，`flattenTokens`/`rawOf`（`lexer/token.ts`）
- [x] top-level line grammar —— `lexer/lexLineKinds.ts` + `lexDocument.ts`
- [x] body tokens —— `lexer/lexBody.ts` / `lexBodyPitch.ts` / `lexBodyTab.ts`
- [x] no uncaught error on 11-file corpus —— `npm run jcx:corpus-test`，11/11 OK（§30.1）
- [x] clear diagnostics —— `lexer/diagnostics.ts`，`npm run jcx:corpus-test` 输出的
      err/warn/info 分级统计（§30.1：0 error / 1 warning / 29 info）
- [x] self-authored fixtures —— `tests/fixtures/jcx/*.jcx`，全部自构、不含语料原文
- [x] strict TypeScript passes —— `npm run typecheck`

---

# 57. M1.5 Definition of Done

AST（**全部完成**；命令见 §30.1）：

- [x] lossless —— `printAst(buildAst(lexJcx(bytes))) === decodeJcx(bytes).text`，
      `tests/unit/jcx/ast/lossless.test.ts` 断言①，全部 fixture 通过
- [x] comments preserved —— `commentLine` 节点（`ast/nodes.ts`），
      `tests/fixtures/jcx/comment-lines.jcx` / `inline-percent.jcx`
- [x] text blocks preserved —— `JcxTextBlockNode`（begin/lines/end），
      `tests/fixtures/jcx/text-block.jcx`
- [x] directive raw value preserved —— `directiveLine.children` 保留整段
      `directiveValue` token，`tests/fixtures/jcx/unknown-directive.jcx`
- [x] duplicate fields preserved —— `tests/fixtures/jcx/duplicate-fields.jcx` +
      `tests/unit/jcx/ast/preservation.test.ts`（T5 新增）
- [x] order preserved —— AST 行顺序即原文行顺序（`buildLines.ts` 单趟顺序处理）
- [x] inline fields preserved —— `JcxInlineFieldLineNode`，
      `tests/fixtures/jcx/inline-voice.jcx` / `inline-voice-spaced.jcx` /
      `inline-voice-alternating.jcx`
- [x] unknown/future syntax representation —— 通用 token 叶子机制
      （`ast/nodes.ts` 的 `JcxTokenLeaf` 作为 `JcxBodyNode` 永久成员），
      语料回归的残留叶子清单见 §30.1
- [x] source span —— 每个节点的 `AstPath` + `span`（`ast/nodes.ts` /
      `ast/astPath.ts`）
- [x] no renderer dependency —— `src/formats/jcx/ast/` 下无任何 `notation` /
      渲染层 import

---

# 58. M1.6 Definition of Done

Parser（**已完成**，逐条证据见 §30.1「M1.6 实际状态」末尾的 DoD 清单）：

- [x] 11 local corpus files parse
- [x] no crash
- [x] meaningful diagnostics
- [x] V aliases normalize
- [x] styles optional
- [x] UTF-8 / GB18030 supported
- [x] Muse marker optional
- [x] text block safe
- [x] guitar directives represented
- [x] music body represented structurally

---

# 59. M1.7 Definition of Done

Serializer：

- [x] AST → JCX
- [x] UTF-8
- [x] GB18030 compatibility
- [x] preserve mode
- [x] canonical mode
- [x] field order
- [x] duplicate fields
- [x] text blocks
- [x] inline fields
- [x] Muse directives
- [x] Voice aliases

逐条证据见 §30.1「M1.7 实际状态」末尾。

---

# 60. M1.8 Definition of Done

至少：

```text
11 / 11 corpus:
parse success
serialize success
reparse success
semantic equality
```

并尽量统计：

```text
byte-identical preserve rate
line-identical preserve rate
semantic round-trip rate
```

这些可以变成未来项目的重要 regression metrics。

**M1.7 T7 现状说明（不改写上面的 DoD 定义，仅记录已覆盖到什么程度）**：
本节列出的核心指标——`11/11 corpus` 的 parse success / serialize success /
reparse success / semantic equality，以及 byte-identical / line-identical /
semantic round-trip 三项 rate——已经由 `npm run jcx:corpus-test` 第四级
（`scripts/jcx/lib/roundtripInvariants.ts` + `printRoundtripSection`）在真实
语料上持续统计并作为常驻 regression metrics 输出：实测 byte-identical
11/11、line-identical 11/11、semantic 11/11、canonical 幂等 11/11（数字见
§30.1「M1.7 实际状态」）。**建议 M1.8 剩余范围**收敛到这份 DoD 未覆盖、
本次也未做的部分：

1. 把这四个指标接入某种持续回归看板/CI 产物（当前只在本地手动跑
   `npm run jcx:corpus-test`，CI 上语料目录缺失会跳过——见脚本文件头「语料
   不进 git」）；
2. `fixture` 级 `roundtrip.test.ts` 矩阵目前只有 11 个 legacy 语料对应的
   `tests/fixtures/jcx/**`，**尚未系统性构造能触发 canonical 三条已知限制
   （`canonical/body.ts` 文件头①②③）之外的边界场景**的最小 fixture，用于
   长期守住这几条限制不扩大；
3. round-trip 的「幂等」目前只在语料/fixture 上观测为真，尚未有单元级不变量
   证明「除已知限制①外必然幂等」这个性质本身（目前是经验观测，不是被证明的
   不变量）；
4. 未覆盖：多编码往返（GB18030 preserve → 转码到 UTF-8 → 再转回 GB18030）的
   语料级回归——当前 preserve byte-identical 只验证「原编码 → 原编码」，
   `options.encoding` 显式转码路径只有 fixture 级 `preserve.test.ts` 的单元
   用例，未接入语料脚本。

这些都不是「往返正确性还没做好」，而是「往返正确性已经做好之后，测试基础设施
和边界覆盖面还能再往前一步」的建议，留给下一位接手 Agent 判断优先级。

**M1.8 实施记录（T0–T4 逐条勾选，2026-09-16，证据见 §30.1「M1.8 实际状态」）**：

DoD 打勾只按最终实际结果给，不支持的条目不勾并写原因；本地跑绿只证明脚本
与 workflow 配置正确，**不等价于 CI 已跑绿**——见下方「CI 待确认」条目。

- [x] *11/11 corpus parse success* —— `npm run jcx:corpus-test` parse 级
  11/11 OK（本次未改动 parse 层，沿用 M1.6/M1.7 已证明的现状）。
- [x] *serialize success* —— round-trip 级 byte-identical 11/11，无
  `jcx.corpus.roundtrip-uncaught` 命中。
- [x] *reparse success* —— M1.8 T0 起 reparse-clean 纳入失败条件，实测
  11/11；canonical 输出自身 diagnostics 无 error 级的契约哨兵
  （`roundtrip.test.ts` 「契约哨兵」用例）同样全绿。
- [x] *semantic equality* —— L2 投影相等，语料 11/11（唯一 fixture 级豁免
  `unclosed-chord.jcx` 不出现在语料，语料本身零豁免）。
- [x] *byte-identical preserve rate* —— 11/11（含 10 个 GB18030 文件）。
- [x] *line-identical preserve rate* —— 11/11（观测项，非失败条件）。
- [x] *semantic round-trip rate* —— 11/11，另加 M1.8 T1 的 canonical
  document closure 零豁免矩阵 11/11（比 DoD 原定义更强的不变量）。
- [x] *fixture report 复用同一判断逻辑* —— `tests/unit/jcx/serialize/
  fixtureMatrix.ts` 单一来源，`roundtrip.test.ts` / `roundtrip.closure.
  test.ts` / `scripts/jcx/fixture-report.ts` 三处 import 同一份函数；
  `git grep` 确认 `L2_KNOWN_LIMITATION =` 只有一处定义。
- [x] *fixture report 显式分母* —— `npm run jcx:fixture-report` 本地实测
  见 §30.1（102 fixture，known limitation 1/102 单独列出，unexpected 0，
  exit code 由 unexpected/失败条件驱动）。
- [x] *HANDOFF 无语料文件名/本地路径* —— 已自查确认本次新增段落不含本地
  绝对路径与真实语料文件名（fixture 名如 `unclosed-chord.jcx`/
  `grace-unclosed.jcx` 是自建测试样本，不是语料，允许出现）。
- [x] **CI 三平台（macOS/Windows/Ubuntu，见 `.github/workflows/ci.yml`
  `strategy.matrix.os`）在 `npm run jcx:fixture-report` 步骤上实际跑绿** ——
  2026-09-16 GitHub Actions run 35054230663（commit 3042659）三平台的
  typecheck / `npm test` / fixture report 步骤均 success。首次 run
  35054050143 的 Windows `npm test` 失败为 fixture 名反斜杠分隔符问题，
  已在 `roundtrip.helpers.ts` 归一化后重跑通过。

---

# 61. 后续大阶段规划

## M2 — Rendering

目标：

```text
打开 JCX
→ 真正看到谱面
```

顺序建议：

1. chord
2. jianpu
3. tab
4. staff

## M3 — Editing

目标：

```text
真正可以改谱
```

包括：

- selection
- caret
- command
- undo
- redo
- note editing
- lyrics
- chord editing
- source sync

## M4 — Playback

目标：

```text
真正可以听
```

包括：

- tempo
- transport
- cursor
- MIDI
- playback events
- per-voice instrument/volume

## M5 — Import/Export

目标：

- MIDI import/export
- ABC import/export
- ASCII TAB import
- PDF
- Print

## M6 — Compatibility / Distribution

目标：

- Windows
- macOS
- packaging
- migration
- corpus regression
- legacy behavior verification
- optional ornament system

---

# 62. 风险清单

## R1 — Corpus 只有 11 个

Unknown=0 只表示：

```text
这 11 个样本
```

不能证明所有 Muse 文件格式。

设计必须接受 future unknown syntax。

## R2 — ABC 与 Muse Extension 边界

不要假设所有语法都是标准 ABC。

也不要假设所有语法都是 Muse 私有。

应在 spec 标注来源和 evidence。

## R3 — Encoding

GB18030 是真实主流 legacy encoding。

编码处理不能放在 UI 层。

## R4 — Round-trip 信息丢失

如果直接解析进 normalized model：

```text
字段顺序
alias
comment
spacing
layout directives
```

很容易丢失。

所以 Lossless AST 是强烈推荐。

## R5 — Jianpu

通用 notation 库不一定支持 Muse 的简谱细节。

预期需要 custom renderer。

## R6 — TAB

Muse TAB 语法未完全恢复。

不能依赖旧 guitar-tabs-editor parser。

## R7 — 原字体授权

不要直接发布 `MAESTRO.TTF`。

---

# 63. 可用的成功标准

项目不是以“UI 看起来像 Muse 2.70”为成功。

更有价值的指标：

```text
Legacy Open Rate
Round-trip Success Rate
Semantic Preservation Rate
Renderer Coverage
Editing Coverage
MIDI Playback Accuracy
```

例如：

```text
11 / 11 legacy samples parse
11 / 11 serialize
11 / 11 reparse
```

是比“界面完成 80%”更重要的早期目标。

---

# 64. 推荐 Commit 粒度

建议后续：

```text
docs(jcx): add initial JCX format specification

feat(jcx): add source span model

feat(jcx): add document lexer

feat(jcx): add music body lexer

feat(jcx): add lossless AST

feat(jcx): parse document fields and directives

feat(jcx): parse voice definitions

feat(jcx): parse music body

feat(jcx): add serializer

test(jcx): add round-trip fixtures

test(jcx): add local corpus regression runner
```

不要一个 commit 一次性塞完 Lexer + AST + Parser + UI。

---

# 65. 推荐 Agent 工作方式

每推进一种语法：

```text
1. 找 corpus evidence
2. 写 spec
3. 写 minimal fixture
4. 写 test
5. 实现 parser
6. 跑 typecheck
7. 跑 tests
8. 跑 local corpus
9. commit
```

即：

```text
Evidence-driven development
```

而不是“根据 ABC 经验一次性猜完整格式”。

---

# 66. 接手 Agent 不应该重新讨论的问题

以下决策已经基本收口：

### Desktop Runtime

当前选择：

```text
Electron
```

没有明显 blocker 不要切 Tauri。

原因：

- 当前项目强调 TypeScript-first；
- 不希望此阶段增加 Rust 维护面；
- 文件格式逆向和编辑器复杂度已经足够高。

### Domain Architecture

坚持：

```text
JCX
→ AST
→ Domain
→ Renderer
```

不要让 Renderer 模型成为 Domain。

### Corpus

真实 `.jcx` 保持本地 ignored。

### Scanner

v0.2 已完成。

不要继续做“大而全 Scanner”。

---

# 67. 当前最值得优先解决的问题

按优先级：

```text
P0  JCX_SPEC
P0  Lexer
P0  Lossless AST
P0  Parser
P0  Serializer
P0  Round-trip

P1  Chord renderer
P1  Jianpu renderer
P1  TAB renderer

P1  Editor Core

P2  MIDI
P2  Staff rendering
P2  Import/export

P3  Ornament
P3  Legacy ancillary features
```

---

# 68. 最终目标形态

理想架构：

```text
                       ┌──────────────────┐
                       │    JCX Source    │
                       └────────┬─────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │ Decoder / Lexer  │
                       └────────┬─────────┘
                                │
                                ▼
                       ┌──────────────────┐
                       │  Lossless AST    │
                       └────────┬─────────┘
                                │
                         Normalize
                                │
                                ▼
                       ┌──────────────────┐
                       │   Music Domain   │
                       └────────┬─────────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
       ┌────────────┐    ┌────────────┐    ┌────────────┐
       │  Renderer  │    │   Editor   │    │  Playback  │
       └─────┬──────┘    └────────────┘    └────────────┘
             │
   ┌─────────┼─────────┬──────────┐
   ▼         ▼         ▼          ▼
 Staff     Jianpu      TAB       Chord
```

反向保存：

```text
Domain Changes
      ↓
AST Update
      ↓
Serializer
      ↓
JCX
```

---

# 69. 当前明确的下一任务

M1.3 / M1.4 / M1.5 / M1.6 / M1.7 / M1.8 已完成
（§30.1 有文件结构、Domain 边界、归一化规则、evidence 策略、Serializer
模块清单/canonical 规则摘要、语料四级回归结果、以及 M1.8 T0–T4 的 fixture
矩阵/closure/CI 看板完整现状快照；§55–§60 DoD 已逐条打勾给证据，M1.8 于
2026-09-16 经 GitHub Actions 三平台全绿封板）。**M2 T0–T9 已全部完成**：
Chord / Jianpu / TAB / Staff 四种记谱可渲染（T0–T7，T7 Staff + VexFlow 已于
2026-09-22 封板 ✅）、T8 render matrix 补齐 C1/C2/C3 三条契约的用例、T9 完成
本轮文档封板；**M2 已于 2026-09-22 封板 ✅（CI run 35700198783）**（§30.1「M2 进行中状态」有 T0–T9 完整
状态、M2 遗留债务总表与「M2 seal 与 M3 前置」要点）。

恢复时：

```text
0. 2026-09-22：M2 封板、T8.1 收紧、`docs/UI_DESIGN_BRIEF.md` v1.1（§10 十五条已裁决）
   均已推送后**主动暂停**；不自动启动 M3，也不改 M2 代码。等用户拿 Brief 去
   Claude Design 出第一轮 8 张核心画面并确认后再继续；
1. 先阅读 §30.1 的 T0–T9 完整状态与「M2 遗留债务总表」（M2 已封板，
   T8.1 post-seal 契约收紧亦已三平台全绿，M2 代码不再改动）；
2. UI 设计目标版式已确认（Brief v1.3 §2.7，Guitar Arrangement System Profile：
   和弦图 → 六线谱 → 简谱 → 歌词，系统交错）；设计稿第一轮 8 张画面仍在用户侧进行；
3. 代码侧下一步是 **M2.5 Score System Layout**（用户 2026-09-22 裁决插在 M3 前）：
   方案已冻结为 `docs/M2.5_SYSTEM_LAYOUT_PLAN.md` v1.0（派发要点见 §30.1）；
   前置 formats preflight（`TabGroupEvent.stroke` 回填）已完成（`a358760`）；
   Jianpu Polish Phase A 已完成（`80edda1`）；Phase B 不单独实施（横向 spacing / group width 归 T3.5 / T4）；
   **M2.5 T0 已完成**（`6e5a532` + 命名修订 `3f5b48c`，均三平台 CI 全绿，见 §30.1「M2.5 T0 实际状态」）；
   **M2.5 T1 已完成**（`2b9882c`，三平台 CI 全绿，见 §30.1「M2.5 T1 实际状态」）；
   **M2.5 T2 已完成**（`218d143`，三平台 CI 全绿，见 §30.1「M2.5 T2 实际状态」）；
   **M2.5 T2.1 已完成**（`9037351`，三平台 CI 全绿，小节错位锁存，见 §30.1「M2.5 T2.1 实际状态」），
   **M2.5 T3 已完成**（`7ee1e27`，三平台 CI 全绿，共享小节时间轴，见 §30.1「M2.5 T3 实际状态」），
   **M2.5 T3.5 已完成**（`d2486aa`，三平台 CI 全绿，TAB / 简谱节奏刻印，见 §30.1「M2.5 T3.5 实际状态」），
   **M2.5 T4 已完成**（`9661810`，三平台 CI 全绿，公共几何编排，见 §30.1「M2.5 T4 实际状态」），
   **M2.5 T5 已完成**（`ed4ea88`，三平台 CI 全绿，三个 voice layout 的外部几何适配，见 §30.1「M2.5 T5 实际状态」），
   **M2.5 T5.S 已完成**（VexFlow shared timing spike，`feasible-with-cost` / no adapter merged，M2.5 只承诺 Staff tier 1，见 §30.1「M2.5 T5.S 结论」），
   **M2.5 T6 已完成**（`c74094e`，三平台 CI 全绿，和弦图层水平规划，见 §30.1「M2.5 T6 实际状态」），
   **M2.5 T8 已完成**（`b513261`，三平台 CI 全绿，最终系统纵向编排，见 §30.1「M2.5 T8 实际状态」），
   **M2.5 T9a 已完成**（`49b0e11`，三平台 CI 全绿，页面模型，见 §30.1「M2.5 T9a 实际状态」），
   **M2.5 T9b 已完成**（`9eb5722`，三平台 CI 全绿，renderer system 化，见 §30.1「M2.5 T9b 实际状态」），
   **当前主动暂停。下一步不是直接启动 T9c 并封板**，而是先裁决 Staff 纵向墨迹越界（§30.1「M2.5 T9b 实际状态」的
   T9c 封板前裁决项）：A 接受 Staff tier 1 视觉越界、M3 以层 box 为交互边界；或 B 在 M2.5 封板前插入小阶段补 Staff
   vertical demand（用户当前倾向 B）。裁决后再按指令推进（仍**不得**顺手实现 Staff tier 2）；启动时仍先给
   实现方案 + 测试矩阵再编码；新的 architecture 守卫必须新建 `architecture.<stage>.test.ts`，不得再往
   `architecture.test.ts` 追加；
4. M2.5 封板后再规划 M3A（source/save/history）→ M3B（selection + 三向同步）→ M3C（可视化编辑）。
```

**M2 入口要求**（§40/§41/§52）：从 `src/domain/` 的 `Score` 出发画谱面，
不是从 JCX 文本或 AST 直接画；推荐优先级 Chord → Jianpu → TAB → Staff
（§40 理由：Chord 已有可借鉴 SVG 实现，Jianpu 是核心差异能力）。VexFlow
只能作为 Staff 的 adapter，坚持 `Domain Model → Adapter → VexFlow` 单向
依赖（§41），不得让 `JCX Parser → VexFlow objects` 短路，否则 Jianpu/TAB/
Chord 会被框架绑死、Playback/Editor 会依赖 renderer。M1.8 对 M2 的唯一
铺路义务已经兑现：`loadJcx(serializeJcx(...).text)` 这条重建一致快照的
唯一路径被 fixture 矩阵 + closure 矩阵长期钉住（见 §30.1「M1.8 实际状态」），
M2 不需要、也不应该再去动 `src/formats/jcx/serialize/**` 的行为。

不要把第一步改成：

```text
做 UI
做播放器
重构 Electron
换技术栈
重写 Scanner
重新讨论 M1.3–M1.8 已拍板的边界
```

这些都不是当前 critical path。

---

# 70. 交接结束语

当前项目已经跨过最不确定的一步：

> “JCX 到底是什么？”

现在已经知道：

```text
它是一个 ABC-like、文本化、包含 Muse-specific extensions 的乐谱格式。
```

而且 11 个 legacy 样本的整行级结构已经全部分类完成。

因此接下来的工作已经从：

```text
Reverse Engineering Exploration
```

进入：

```text
Specification
→ Compiler-style Parsing
→ Compatibility Engineering
```

后续 Agent 应把项目当作一个：

> **“音乐格式编译器 + 乐谱领域模型 + 桌面编辑器”**

来设计，而不是把它当成一个普通 React UI 项目。

这会直接决定后续架构质量。

---

## Agent Start Here

```bash
git status
git log --oneline -5

npm install
npm run typecheck
npm run jcx:scan
npx vitest run
npm run jcx:corpus-test
npm run jcx:fixture-report
```

确认 Scanner 输出：

```text
Unknown lines:    0
Unknown patterns: 0
```

确认 `jcx:corpus-test` 输出四级 OK（Lexer 级 + AST 级 + parse 级 + round-trip
级，见 §30.1「M1.7 实际状态」），`jcx:fixture-report` 输出六项指标且
`unexpected: 0`（见 §30.1「M1.8 实际状态」）。**确认 push 后 GitHub Actions
三平台（macOS/Windows/Ubuntu）是否已经跑绿**——本地全绿不等于 CI 已确认，
见 §60 DoD 逐条勾选表最后一条。

然后阅读 §30.1（M1.4/M1.5 实际状态 + M1.6 实际状态 + M1.7 实际状态 +
M1.8 实际状态）与 §37 / §38 / §40 / §41 / §59 / §60，开始
`M2 — Notation Rendering`（§40，入口要求与不要做的架构选择见 §69）。
