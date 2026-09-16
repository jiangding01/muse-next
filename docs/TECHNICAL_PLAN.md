# Muse Next — Technical Plan v0.1

> **实施状态说明（对齐 M1.8 封板后的现状）**：本文档是项目早期（M0/M1 起步阶段）
> 写下的技术方案，架构原则（§2）、模块边界（§4）、渲染/编辑/播放策略（§7–§10）与
> 非目标（§12）至今仍然有效，未被推翻。但 §5「Current vertical slice」与 §6
> 「JCX implementation strategy」描述的是 M0 时期的最小实现（`parseJcx()` /
> `MuseScoreDocument`），已被 M1.4–M1.8 的词法器/无损 AST/Domain/序列化管线取代；
> §11 的 M1 一栏也只列了立项时的粗粒度目标。实际的当前状态、模块清单与逐里程碑
> 验收证据以 [`HANDOFF.md`](../HANDOFF.md) §30/§30.1/§55–§60 为准，公开 API 与
> 管线总览见 [`README.md`](../README.md) §3/§4。下文各节保留原文，仅在描述与现状
> 不符处追加「现状」说明，不删除原计划文字。

## 1. Product goal

Rebuild the useful capabilities of legacy Muse Pro as a maintainable, cross-platform TypeScript application while preserving the semantics of existing `.jcx` files. The legacy binary is treated as a behavioral/specification reference, not as source code to translate mechanically.

The first compatibility target is **read + understand + render real `%MUSE2` documents**. Editing and serialization are added only after the format model is stable.

## 2. Architectural principles

1. **Clean-room rewrite.** Do not copy legacy executable code, bundled fonts, song files, icons or other assets unless redistribution rights are clear.
2. **Domain first.** `.jcx`, music semantics and editor commands must not depend on React/Electron.
3. **One score model, multiple views.** Staff, Jianpu, Guitar TAB, chord diagrams, source text, MIDI playback and print layout consume the same domain document.
4. **Parser is loss-aware.** Unknown Muse directives should eventually survive parse → serialize round-trips instead of being silently discarded.
5. **Renderer adapters are replaceable.** VexFlow may help with western staff/TAB notation, but the core model must not become a VexFlow model.
6. **Compatibility is measurable.** Legacy sample files and synthetic fixtures become regression tests. Later, Windows CI can compare exported behavior where legally and technically appropriate.

## 3. Selected stack

### Desktop runtime

- **Electron 44**
- **Electron Forge 7** for packaging/distribution
- Secure preload/context bridge for native capabilities

Rationale: TypeScript-first, strong macOS/Windows/Linux support, native file dialogs/printing, Chromium SVG/Canvas, and no mandatory Rust maintenance surface.

### UI

- **React 19.3**
- **Vite 8**
- **Zustand 5** for editor/application state
- CSS variables + component CSS initially; no large design-system dependency in Phase 1

A desktop music editor is dominated by custom notation/editor surfaces, so adding a heavy UI framework at the foundation would create more coupling than value. Accessible primitives can be added selectively later.

### Type system / quality

- **TypeScript 5.9** with strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- **Vitest 5** for unit/compatibility tests
- GitHub Actions matrix on macOS / Windows / Linux

TypeScript is intentionally pinned to 5.9 for the initial scaffold instead of immediately adopting a newly released compiler major; upgrade after the ecosystem/toolchain is verified.

### Music notation

- **Custom TypeScript domain model** is authoritative.
- **SVG** is the primary renderer for chord diagrams and Jianpu.
- **VexFlow 5** is the preferred evaluation candidate for western staff notation and possibly TAB, behind an adapter boundary.
- Do **not** use abcjs as the internal model. `.jcx` is ABC-like but contains Muse-specific directives, Jianpu/TAB semantics and layout behavior.

### Playback / MIDI

Planned, not wired into Phase 1:

- Tone.js/Web Audio for preview transport and fallback synthesis.
- Web MIDI / Electron permissions for physical MIDI output where supported.
- `@tonejs/midi` or a small dedicated SMF adapter for MIDI import/export after the Muse timing model is stable.

## 4. Module boundaries

```text
src/
├── domain/                 # authoritative score/music/chord model
├── formats/
│   └── jcx/                # Muse %MUSE2 parser + serializer
├── notation/
│   ├── chord/              # SVG chord rendering / geometry
│   ├── staff/              # later: VexFlow adapter
│   ├── jianpu/             # custom renderer
│   └── tab/                # custom/VexFlow evaluation
├── editor/                 # later: commands, selection, undo/redo
├── playback/               # later: transport, MIDI, synth
├── main/                   # Electron main process only
├── preload/                # typed capability bridge
├── renderer/               # React desktop UI
└── shared/                 # IPC contracts only
```

The scaffold currently contains the implemented subset of this tree. Directories are added when code exists rather than pre-creating empty architecture.

## 5. Current vertical slice

> **现状（M1.8 后）**：下面的流程图是 M0 阶段的最小验证 slice，`parseJcx()` /
> `MuseScoreDocument` 已在 M1.6 封板时删除（`git log` 提交 `fc3fc9e`），不再存在于
> 代码库中。实际管线是：
>
> ```text
> Local .jcx file
>     ↓ Electron file dialog
> byte buffer
>     ↓ decodeJcx（UTF-8 优先 / GB18030 回退）
> Muse 源文本
>     ↓ lexJcx → buildAst → parseJcxDocument（合称 loadJcx）
> Score（Domain 模型：voices / events / relations / 已归一化的 header）
>     ├── %%gchord 定义 → GuitarChord 模型 → React SVG 和弦图（已实现）
>     └── 其余 voices/events → Jianpu / TAB / Staff 渲染（M2，未开始）
> ```
>
> 反方向的 `serializeJcx`（preserve / canonical 两模式）已在 M1.7–M1.8 实现并通过
> round-trip 护栏验证，详见 `README.md` §4 与 `HANDOFF.md` §30.1。

The v0.1 scaffold proved this flow (原始 M0 描述，保留供历史参照)：

```text
Local .jcx file
    ↓ Electron file dialog
byte buffer
    ↓ UTF-8 / GB18030 decode
Muse source text
    ↓ parseJcx()
MuseScoreDocument
    ├── metadata
    ├── track definitions
    ├── raw track bodies
    └── %%gchord definitions
              ↓
        GuitarChord model
              ↓
       React SVG diagram
```

This is intentionally a **real compatibility slice**, not a mock UI.

## 6. JCX implementation strategy

> **现状**：Phase A/B/C 三个阶段规划的能力均已实现并通过 round-trip 护栏验证
> （M1.4–M1.8），不再是待办事项。原计划文字保留在下面，供理解设计意图使用；
> 实现细节与验收证据见 `HANDOFF.md` §30.1、公开 API 见 `README.md` §4。

### Phase A — Structural parser

Implement and test:

- `%MUSE2`
- `T:`, `C:`, `M:`, `L:`, `Q:`, `K:`
- `%%...` directives without losing unknown directives
- `V:` track definitions
- `[V:n]` bodies
- `%%gchord`
- source encoding (legacy Simplified Chinese files are often GBK/GB18030)

### Phase B — Music lexer/parser

Build a lexer before expanding handwritten regular expressions indefinitely. Parse:

- notes/rests
- durations
- bars/repeats
- ties/slurs
- tuplets/grace notes
- decorations
- chord annotations (`"G"` etc.)
- lyrics (`w:`)
- TAB-specific token forms

The result should be a typed AST with source spans so the visual editor can synchronize selection with the source editor.

### Phase C — lossless serializer

Required invariant:

```text
parse(source) -> AST -> serialize(AST)
```

must preserve known semantics and retain unknown directives/comments. Canonical formatting and byte-for-byte preservation are separate test modes.

## 7. Guitar/chord subsystem

`guitar-tabs-editor` is a useful reference for SVG chord geometry and chord-library ideas, but not the application architecture.

Core model:

```ts
interface GuitarChord {
  name: string;
  baseFret: number;
  strings: GuitarStringPosition[];
  barres: GuitarBarre[];
}
```

Muse syntax already observed:

```text
%%gchord G=1;3(3),2(2),0,0,0,3(4)
```

Phase 1 supports muted/open/fretted strings and finger numbers. Barre syntax remains an explicit reverse-engineering item until confirmed from real Muse data/help/behavior.

Future editor interaction:

- click string/fret to cycle open → fretted → muted
- set finger number
- drag/select barre
- choose base fret
- chord name / slash bass
- built-in and user chord libraries
- small score rendering + large edit preview share the same renderer

## 8. Editor architecture

Do not mutate the score model directly from React components. Use commands:

```text
UI gesture
   ↓
EditorCommand
   ↓
Reducer / command handler
   ↓
new MuseScoreDocument
   ↓
render + serializer
```

Examples:

- `InsertNote`
- `DeleteSelection`
- `SetChord`
- `SetStringFret`
- `SetTrackStyle`
- `TransposeSelection`

Undo/redo stores command/inverse-command or immutable document patches. This is critical for a notation editor and should be established before large editing features are added.

## 9. Rendering strategy

### Chords
Custom SVG. Already implemented in scaffold.

### Jianpu
Custom SVG renderer. Jianpu is central to Muse and should not be forced through a western notation engine.

### Staff
Evaluate VexFlow 5 through a narrow adapter:

```text
MuseScoreDocument -> StaffLayoutModel -> VexFlow adapter -> SVG
```

No VexFlow types in `domain/`.

### TAB
Evaluate both VexFlow TAB support and a custom renderer. Muse-specific guitar techniques and synchronized mixed staff/TAB layouts may require custom layout even if VexFlow supplies glyph primitives.

### Print/PDF
First render a deterministic page-layout model to SVG/HTML; Electron printing/PDF is an output adapter. Do not rebuild the old PostScript pipeline unless required for compatibility.

## 10. Desktop capability boundary

Renderer cannot call Node APIs directly.

Allowed bridge capabilities will be explicit and typed:

- open/save score
- export PDF/MIDI
- print
- recent files
- app preferences
- future MIDI device enumeration

No generic `execute`, unrestricted filesystem, or arbitrary IPC channel exposed to the renderer.

## 11. Milestones

### M0 — scaffold (this artifact)

- Electron + React + TypeScript
- secure preload bridge
- open `.jcx`
- UTF-8/GB18030 decode
- structural `%MUSE2` parser
- `%%gchord` parser
- SVG chord rendering
- parser tests
- cross-platform CI skeleton

### M1 — JCX specification + compatibility parser

- inventory all bundled `.jcx` syntax
- formal grammar/spec document
- source spans and diagnostics
- unknown directive retention
- all available legal fixtures parse without crash

**现状**：M1 在实施中被拆分为 M1.1–M1.8 子里程碑，全部已完成并封板（详见
`HANDOFF.md` §30 里程碑表、§55–§60 逐条 DoD 证据）：

- M1.1/M1.2 — 本地语料 Scanner + 首轮发现
- M1.3 — `docs/JCX_SPEC.md` v0.1（本节列的 inventory / 规格文档目标）
- M1.4 — 词法器（source spans / 诊断）
- M1.5 — 无损 AST
- M1.6 — Parser / Domain Model（unknown 保留、全部语料无崩溃解析）
- M1.7 — Serializer（preserve / canonical）
- M1.8 — Round-trip 兼容性护栏（fixture 矩阵 + closure + 三平台 CI）

### M2 — first real score rendering

**现状：当前进行中的下一阶段**（M1.8 已封板，`HANDOFF.md` §69 明确下一任务是 M2；
入口要求见 §40/§41/§52：从 `src/domain/` 的 `Score` 画谱面，推荐顺序
Chord → Jianpu → TAB → Staff，VexFlow 只作 Staff 的 adapter）。

- normalized note/time model
- staff proof-of-concept
- Jianpu proof-of-concept
- TAB proof-of-concept
- chord placement above/below score

### M3 — editor core

- selection/caret model
- command architecture
- undo/redo
- source ↔ visual selection mapping
- first editable note/chord flows

### M4 — playback/import/export

- playback transport
- MIDI preview/output
- MIDI import/export
- ASCII TAB import

### M5 — layout/distribution

- page layout
- print/PDF
- macOS/Windows/Linux packages
- signing/notarization strategy

## 12. Explicit non-goals for the first releases

- Nokia/Siemens/Ericsson/Motorola ringtone generation
- reproducing MFC UI pixel-for-pixel
- reproducing the old PostScript engine internally
- bundling the original MAESTRO.TTF or sample songs without rights review
- byte-for-byte emulation of undocumented bugs

## 13. Next engineering task

After this scaffold boots successfully on the developer Mac:

1. Feed all extracted `.jcx` files through a local compatibility analyzer (without committing copyrighted fixtures).
2. Generate a syntax inventory: directives, track styles, token forms, chord forms, lyrics and decorations.
3. Turn the inventory into `docs/JCX_SPEC.md`.
4. Expand parser tests with synthetic equivalents of every syntax form.
5. Begin source-span aware music lexer.
