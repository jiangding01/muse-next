# Muse Next

TypeScript-first, clean-room reimplementation of the legacy Muse score editor.

This repository starts with a real vertical slice: open a `.jcx` file, decode legacy Chinese text, run it through the lexer / lossless AST / parser pipeline into a music domain model, and render parsed guitar chord diagrams as SVG.

## Stack

- Electron 44 + Electron Forge 7
- React 19.3 + Vite 8
- TypeScript 5.9 (strict)
- Zustand 5
- Vitest 5

See [`docs/TECHNICAL_PLAN.md`](docs/TECHNICAL_PLAN.md) for architecture and milestones.

## Run

Requirements: Node.js 22.12+ (Node 24 recommended).

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run typecheck
npm test
npm run jcx:corpus-test   # local legacy corpus regression (lexer / AST / parse levels)
npm run jcx:scan
```

Create a local distributable:

```bash
npm run make
```

## What works in v0.1

- Electron desktop shell with a sandboxed renderer.
- Native open-file dialog for `.jcx`.
- UTF-8 first, GB18030 fallback decoding for legacy Muse files.
- Lossless JCX lexer + AST (`printAst` round-trips the decoded source byte-for-byte).
- Parser producing the music domain model (`src/domain/`): score header, voices,
  events, ties / slurs / tuplets / TAB relations, lyrics, directives.
- The `%MUSE2` magic header is optional, as in the legacy format.
- Structured diagnostics instead of exceptions for anything that cannot be normalised.
- `%%gchord` definitions including open/muted strings and finger numbers.
- SVG chord diagram rendering.
- Synthetic fixture tests plus a local legacy-corpus regression.

## Clean-room rule

Do not commit the legacy Muse executable, its original music samples, fonts, icons or other copyrighted assets into this repository unless redistribution rights have been confirmed. The old application is a compatibility/specification reference. Tests in this repo should use synthetic fixtures.
