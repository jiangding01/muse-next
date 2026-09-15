# Muse Next — HANDOFF

> 面向后续实现 Agent 的项目交接文档  
> 项目代号：`muse-next`  
> 当前阶段：**M1.2 已完成，下一步进入 M1.3 `JCX_SPEC.md v0.1`**  
> 核心目标：以现代 TypeScript 技术栈重建已停止维护的 **Muse Pro 2.70** 的核心能力，并优先恢复其 `.jcx` 乐谱格式、谱面渲染、编辑与播放能力。

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
6. 下一步不要继续扩 Scanner；应该正式编写 `docs/JCX_SPEC.md`，然后进入 Lexer → AST → Parser → Serializer → Round-trip。

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
T: corpus#08
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

`corpus#08.jcx` 有：

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

# 17. corpus#08.jcx 是特殊样本

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

正式的 JCX 格式层实现（M1.4 Lexer + M1.5 AST，详见 §30.1 的文件结构清单）：

```text
src/formats/jcx/encoding/   # 编码检测 + 解码
src/formats/jcx/lexer/       # M1.4：source → token 流
src/formats/jcx/ast/          # M1.5：token 流 → Lossless AST
```

早期 scaffold（M0 时期，**已标 `@deprecated`**，M1.6 Parser 落地后删除；不要
把它们当作当前格式层实现，也不要在其之上继续开发）：

```text
src/formats/jcx/parseJcx.ts     # @deprecated，见文件内 JSDoc
src/formats/jcx/parseGChord.ts   # @deprecated，见文件内 JSDoc
src/domain/music.ts               # legacy scaffold model，M1.6 将重构/替换（非被 AST 替代）
src/notation/chord/ChordDiagram.tsx
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

→ M1.6
Parser

→ M1.7
Serializer

→ M1.8
Round-trip compatibility

→ M2
Notation Rendering

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
  指标，不是失败条件）：全语料共 **1 个**，即 `corpus#10.jcx` 第 101 行
  `|||2` 之后那个裸露的 `duration` 叶子（`2`）——它前面没有 pitchLetter 可
  依附，不能组成 note，落在 bodyLine.items 里原样保留。这正是**真实语料中
  未解释的 syntax residual**：JCX_SPEC §19.2 / Appendix A U26 已经调查过它，
  结论是更像笔误而非跳房子记号，证据不足以实现任何语义，Lossless AST 按设计
  原样保留，不猜测语义，留给 M1.6 或后续更多证据出现时再处理。
- Lexer `N/` 修复（`53d97d3`）：ABC 2.1 §4.3 的 `N/` 简写（等价 `N/2`）此前被
  切成两个 duration token，`D3/` 这种写法因此不能被 note 完整吸收；修复后
  `DURATION_RE` 按 `N/N` → `N/` → `N` 的顺序尝试最长匹配，语料里唯一一处
  `D3/`（`corpus#08.jcx`）不再产生孤立 duration 叶子。

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

---

# 31. 下一步：M1.3 `docs/JCX_SPEC.md`

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

Parser：

- [ ] 11 local corpus files parse
- [ ] no crash
- [ ] meaningful diagnostics
- [ ] V aliases normalize
- [ ] styles optional
- [ ] UTF-8 / GB18030 supported
- [ ] Muse marker optional
- [ ] text block safe
- [ ] guitar directives represented
- [ ] music body represented structurally

---

# 59. M1.7 Definition of Done

Serializer：

- [ ] AST → JCX
- [ ] UTF-8
- [ ] GB18030 compatibility
- [ ] preserve mode
- [ ] canonical mode
- [ ] field order
- [ ] duplicate fields
- [ ] text blocks
- [ ] inline fields
- [ ] Muse directives
- [ ] Voice aliases

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

M1.3 / M1.4 / M1.5 已完成（§30.1 有文件结构、不变量、语料回归结果的完整
现状快照；§55–§57 DoD 已逐条打勾给证据）。接手后请直接做：

```text
M1.6 — Parser（docs/JCX_SPEC.md §58 DoD）
```

从 §57 已完成的 Lossless AST 出发，把 AST 结构化为 Muse Domain Model：
Voice 属性别名归一化（§12.3）、style 缺省语义、`V:` 重复定义合并、
duplicate 字段的累加型/覆盖型分流（§8.12）等，都是这一步的工作范围。

不要把第一步改成：

```text
做 UI
做播放器
重构 Electron
换技术栈
重写 Scanner
重新讨论 M1.3–M1.5 已拍板的边界
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
```

确认 Scanner 输出：

```text
Unknown lines:    0
Unknown patterns: 0
```

确认 `jcx:corpus-test` 输出两级 OK（Lexer 级 + AST 级，见 §30.1）。

然后阅读 §30.1（M1.4 / M1.5 实际状态）与 `docs/JCX_SPEC.md` §12 / §58，
开始 M1.6 Parser。
