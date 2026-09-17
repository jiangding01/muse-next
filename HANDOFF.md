# Muse Next — HANDOFF

> 面向后续实现 Agent 的项目交接文档  
> 项目代号：`muse-next`  
> 当前阶段：**M0–M1.8 已封板；M2 Notation Rendering 进行中（T0–T6 已完成：Chord / Jianpu / TAB 三种记谱可渲染，T7 Staff + VexFlow 未开始）**（详见 §30 里程碑表、§30.1「M2 进行中状态」、§69「当前明确的下一任务」）  
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

🟡 M2
Notation Rendering（进行中：T0–T6 已推送，Chord / Jianpu / TAB 可渲染；T7 Staff +
VexFlow → T8 render matrix → T9 文档封板未开始；现状与恢复位置见 §30.1「M2 进行中状态」）

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
- Lexer `N/` 修复（`53d97d3`）：ABC 2.1 §4.3 的 `N/` 简写（等价 `N/2`）此前被
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
2. `TabGroupEvent.stroke` parse 层从不填充，`V[ax/bx/]` 的 `V` 与悬空
   strokePrefix 在 Domain 里没有事实，canonical 无从写回（spec §26.4）。
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
见 3f578fe）。**护栏定位**：本里程碑的产出是
断言、fixture、CI 产物，`src/` 是**零行为变更**——唯一 approved 例外是 T1
在 `canonical/body.ts` 加的一条谓词：`breaksLineAfter` 把
`UnknownEvent(tokenKind: 'barline')` 也算作断行点。作用域仅限断行规划，不
改变任何事件的语义分类；对 11 个真实语料文件，canonical 输出相对
`8df1aa0`（M1.8 T0，本里程碑改动前的最后一个提交）逐字节不变——真实语料
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
2. `TabGroupEvent.stroke` parse 层从不填充，`V[ax/bx/]` 的 `V` 前缀与悬空
   strokePrefix 在 Domain 里没有事实字段，canonical 无从写回（spec
   §26.4）。
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
GitHub Actions run 35054230663（commit 3f578fe）在 macOS/Windows/Ubuntu
三平台上 `npm run typecheck`、`npm test`、`jcx:fixture-report` 全部 success，
见 §60 后勾选表最后一条。

**M1.8 §60 DoD 逐条证据**：见 §60 后的勾选表。

### M2 进行中状态（Notation Rendering，T0–T5.2 已提交，未封板）

**恢复位置（2026-09-16，最后一次实跑：typecheck 绿、vitest 58 文件 3907 用例绿、`jcx:corpus-test` 与 `jcx:fixture-report` 未受 M2 影响）**：M2 方案 v1.1.1 已冻结（任务序 T0 模型+守卫 → T1
`buildRenderScore` → T2 SVG 基础设施+度量 → T3 Chord → T4 排布/换行+Jianpu
布局 → T5 Jianpu SVG+头部+React → T6 TAB+缩放 → T7 Staff+VexFlow adapter →
T8 最终 render matrix（契约 C1/C2/C3）→ T9 文档封板）。T0–T5 已推送，
GitHub Actions run 35087178952 三平台全绿；随后按真实语料（corpus#10，一份
两声部 TAB+简谱成品）人工 smoke 的发现做了 **T5.2 real-world hardening**
（四个 fix 提交 + 一个 breve 时值能力提交，见下）；随后 **T6 TAB 六线谱 T6.1–T6.5 全部完成**（见下），
**下一步是 T7 Staff + VexFlow adapter**。`src/renderer` 里只剩五线谱声部显示「五线谱渲染待 T7」占位。

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

- A `1cba425` 歌词：两趟布局（横向 system 打包 → 歌词三级归属
  target / 行内最后对齐 / `bodyRange` / 兜底 → 每 system rows →
  `restackSystems`），`*` skip 不可见不推进 tailX，y 由所属 system 推导；
  该谱歌词节点 567 → 192，可见 skip 0。
- B `9f2f1cb` 弧线：`jianpu/jianpuArcs.ts`，弧高
  `clamp(arcHeight + |span| × arcHeightFactor, arcHeightMin, arcHeightMax)`，
  跨 system 的 tie/slur 切成 start/middle/end 段，每段 y 取所属 system 几何、
  弧高取本段跨度，各段共用同一 `anchor`、诊断只发一次；缺 system 几何直接抛错
  不兜底。该谱 104 relation → 107 段，3 条跨行。
- C `59b1082` 歌词间距：`lyricFirstOffset` 18 → 30（推导：两个低八度点
  14.5u + 字号 12u + 余量）；`jianpu.clearance.test.ts` 守「歌词字顶严格低于
  同行所有减时线/附点/八度点」。
- D `60fb332` 弧线端点：节点新增 `glyphWidth`（主字形 visual bbox span，非槽位宽），
  tie/slur 端点改用字形中心，连到全音符/breve 的弧不再落在延音线中间；
  tuplet 括号与跨行续行端仍用槽位边界。
- E `de23124` breve：`duration.ts` 单点放行 `2/1`（dots=0）→ 7 条延音线；
  新 `jianpu/jianpuSlotWidths.ts` 让简谱槽宽 ≥ `requiredDashExtent + dashGap`
  （7 条 = 120u + 6u），在 `layoutSystems` 前重累计 slot.x/width/measure.width；
  共享 `spacing.ts` 与 `maxSlotWidth = 96` 未动，`3/2`/`7/4` 槽宽不变。corpus#10：
  `unrepresentable` 3 → 0，仅 3 个 breve 槽变宽，之前节点无漂移。

**T6 TAB 六线谱（T6.1–T6.5 全部完成，✅ 2026-09-17 封板：8f58fcb 推送后 GitHub Actions run 35192708064 macOS/Ubuntu/Windows 三平台 typecheck / test / fixture-report 全绿）**：

- T6.1 `7b99950` 地基：`src/notation/tab/{tabGlyphs,tabEventNodes,tabSlotWidths,layoutTab}.ts`
  + `TAB_METRICS`（`stringCount: 6` 是唯一格式事实，其余产品决定）。`RenderVoice →
  layoutTab → TabLayout`，与 jianpu **平行独立**（不共享节点类型、互不 import）。
  第 1 弦最上；多位品位一个 text；品位白底遮弦线；小节线只认 CONFIRMED 四形态；
  pitch 事件 / grace 的 pitch 成员落入 TAB → outOfScope 可见占位 + warning（不猜弦品）；
  UnknownEvent 恰一可见节点；同弦重复成员全部照画 + fallback + warning
  （`tab.group-duplicate-string`）。实测：TAB 模式下大写字母是 UnknownEvent、
  混排 grace 不可达、`V[...]` 组级前缀不回填。
- metrics 拆分 `eb26103`：`layout/metrics.ts` → `layout/metrics/` 目录，九个导出逐字
  相等，numeric-guard 排除改目录前缀，architecture 守卫按文件枚举多出 24 条通过用例。
- T6.2 `ef5eb3a` 时值装饰：`tabDurationGlyphs.ts`，由 `decomposeDuration` 推导，画在
  第 6 弦下方（base ≤ 1/4 符干 + 减时线；1/2 短符干；≥ 1 延音短横线；附点），组时值用
  Domain 已算好的末音值不重算；unrepresentable 不画 + fallback（诊断由 buildRenderScore
  发，不重发）；`requiredDurationExtent`（含附点 + 留白）并入 TAB-local 槽宽；
  `layoutTab` 两趟布局，按 `requiredSystemDepth` 用 `restackSystems` 逐行补高
  （`systemHeight` 92 覆盖到十六分音符）。
- T6.3 `44431ba` 关系与 stroke：`tabRelations.ts`（`-S-/-H-/-P-` **同弦**关系线，
  跨弦由 parse 判 `jcx.parse.tab-relation.cross-string` 不建关系、渲染层不重报；端点
  按 `TabFretGlyph.memberIndex` 身份查找，不重放排序；`relationEndGap` 留白且 x1 ≤ x2；
  跨行 start/end 段同 anchor、label 只在 start）；`tabStrokes.ts`（`TabNote.stroke`
  原字符画第 1 弦上方不二次解释；`H` 前缀按「延长」附 info `tab.stroke-hold-inferred`
  （spec §26.4 INFERRED）；表外字符仍画 + warning `tab.stroke-unrecognized`；多成员拼接
  并入槽宽）。**能力边界**：M2 的 TAB 渲染支持单音级的扫弦/拨弦方向记号
  （`TabNote.stroke`，parse 层已填充），不支持组级的方向记号（`TabGroupEvent.stroke`，
  parse 层从不填充，M1.8 已知限制②）——每 TAB 声部一条 info
  `tab.group-stroke-not-modeled`，措辞不得写成「扫弦方向不可用」。
- T6.4 `7d711d8` SVG 与 renderer：`tab/toSvg.ts`（与 jianpu 同约定：每节点一个 `<g>`
  带 `data-anchor-key`、fallback 角标、unknown 虚线框）；`renderer/components/notation/
  voiceRender.ts` 分派 tab；store `zoom`（clamp 到 `SCORE_VIEW_METRICS.zoomMin/Max`，
  非有限值拒绝）+ Toolbar 控件；**zoom 只作用渲染层像素换算**：画布宽 =
  `layout.width × cssPixelsPerUnitAtZoom1 × zoom`，`availableWidth = 容器像素 ÷
  (cssPixelsPerUnitAtZoom1 × zoom)`，layout 数值不变（D6），换行随之调整（D7）。
- T6.5 `57670e2` hardening（人工复验真实语料后）：① jianpu 跨行 tie/slur 续行段最小
  可见跨度 `arcContinuationMinSpan`（末段曾退化成 4u 尖角）；② TAB 关系续行段同规则
  `relationContinuationMinSpan`；③ **和弦符号不再占时间槽**：`SlotWidthKind` 新增
  `'overlay'`（width 0，x 贴后续第一个有宽度列或段末；等距降级下仍 0；decoration
  等策略未动）——真实语料 277 个和弦符号 12u → 0，TAB 每行多放一小节；④ 显示时去掉
  和弦符号外层一对 JCX 引号（`chordSymbolDisplayText`，Domain/serializer 不动）。
  全语料只读 smoke：无和弦符号的声部逐节点相同、同行弧线不变、诊断集合不变。
- 测试：tab.layout 27 / tab.duration 23 / tab.relations 25+3 / tab.toSvg 12 /
  scoreView.voiceRender 7 / spacing.overlay 12 / chordSymbolDisplay 9；全量 4140。

**已知观察 / 待裁决 / visual debt（恢复时先看）**：

0. TAB visual debt：`x` 品位字形比数字矮，按 `fretBaselineRatio` 定位后略高于弦线
   （可给 `x` 单独基线比例）；相邻减时线不做 beam grouping（连续八分音符各画各的
   减时线，不合并成横梁）；休止画 `z`/`Z`/`@` 原字符不用休止符号；单音级 stroke 在
   语料里 0 次、组级 `V[`/`U[`/`B[` 不显示（限制②）。

1. ~~duration capability（breve）~~ 已由 T5.2-E `de23124` 解决（见上）。
2. 附点位置（**记为 debt，用户 2026-09-17 裁决**）：现画在数字右侧、延音线之前
   （`X . _ _ _`）；简谱习惯长音的附点在延音线之后。未核实，属视觉 polish，
   T9 前不处理。
3. 16 分音符最小槽宽 12u = 减时线长 12u，相邻减时线相连是正确写法，但紧跟小节线
   时显得拥挤（`12|`）；T4 间距设计，未动。
4. `[V:1]` 段内 inline `L:` 同时进入两个声部的 `unitLengthChanges`：**非 bug**，
   parse 诊断 `jcx.parse.unit-length.body-scope` 已按 U06「从该行起生效直到
   被下一条 L: 覆盖」处理。
5. T9 需记入文档的债务：头部字号 CSS/metrics 双来源；
   `ScoreHeaderTextLine.fontSize/width` 无消费方；a11y 未做；
   `src/renderer/dist` 产物入库待清理；语料时值 `5/8` 2 处 unrepresentable；
   `syllableKind` 类型可收窄；350 行上限无自动守卫；歌词居中 polish。

**T7 Staff + VexFlow 派发要点（方案 §T7，未变）**：`notation/staff/layoutStaff.ts`
（纯数据，不碰 vexflow）+ `renderer/integrations/vexflow/renderStaff.ts`（全仓唯一
import vexflow）+ `ScoreView` staff 分派 + `package.json`（`vexflow@5.0.0`）+
`tests/unit/notation/staff.layout.test.ts`；必须真实渲染出五线谱；T0 的 vexflow 守卫
仍绿；`M:` 为 raw 时不喂 VexFlow；clef 未解析回退 treble + 诊断；范围外事件可见占位
+ 诊断；完成前本地 Electron 人工 smoke；`package-lock.json` 不计文件预算但
`grep -c artifactory package-lock.json` 必须为 0。然后 T8 最终 render matrix（Opus）
→ T9 文档封板。

**工作流约束**（M2 全程）：每轮改动 → typecheck / vitest / corpus → 只读
`/check` 审查 → 修复复审 → 提交；里程碑 ✅ 只在 push 后三平台 CI 全绿后由
seal commit 补上；真实语料只以 `corpus#NN` 引用；M2 封板后、M3 前先做 UI
设计（功能清单 + 设计要求）。

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
  2026-09-16 GitHub Actions run 35054230663（commit 3f578fe）三平台的
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
2026-09-16 经 GitHub Actions 三平台全绿封板）。**M2 已完成到 T6，TAB 六线谱已于
2026-09-17 封板**（§30.1「M2 进行中状态」有 T0–T6 完整状态、T6 visual debt、
待裁决事项与 T7 派发要点）。**当前项目在 T6 后主动暂停，不自动启动 T7。**

恢复时：

```text
1. 先阅读 §30.1 的 T6 完整状态与 visual debt；
2. 若决定继续 M2，再从 T7 Staff / VexFlow 的前置规划开始
   （T7 Staff/VexFlow → T8 render matrix → T9 文档封板 → M2 seal）；
3. 当前不要继续 T7。
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
