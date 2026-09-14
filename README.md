# Muse Next

TypeScript-first, clean-room reimplementation of the legacy Muse score editor.

This repository starts with a real vertical slice: open a `%MUSE2` `.jcx` file, decode legacy Chinese text, parse document/track/chord metadata, and render parsed guitar chord diagrams as SVG.

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
```

Create a local distributable:

```bash
npm run make
```

## What works in v0.1

- Electron desktop shell with a sandboxed renderer.
- Native open-file dialog for `.jcx`.
- UTF-8 first, GB18030 fallback decoding for legacy Muse files.
- `%MUSE2` structural parsing.
- Score metadata: `T/C/M/L/Q/K`.
- Track declarations and `[V:n]` raw bodies.
- `%%gchord` definitions including open/muted strings and finger numbers.
- SVG chord diagram rendering.
- Synthetic parser tests.

## Clean-room rule

Do not commit the legacy Muse executable, its original music samples, fonts, icons or other copyrighted assets into this repository unless redistribution rights have been confirmed. The old application is a compatibility/specification reference. Tests in this repo should use synthetic fixtures.
