# ADR-0001: Electron as the desktop runtime

Status: Accepted for Phase 1.

## Decision

Use Electron for the desktop application. Keep all score semantics, parsing, rendering models and command logic in environment-independent TypeScript modules. Electron is only the OS integration shell.

## Why

- The legacy product is a desktop editor and needs file dialogs, printing, clipboard, MIDI/audio and future OS integration.
- The rewrite goal is TypeScript-first. Electron keeps the main implementation language JavaScript/TypeScript instead of introducing a mandatory Rust layer.
- Chromium gives us one predictable SVG/Canvas rendering target on macOS, Windows and Linux.
- Renderer code can later be reused by a browser/PWA build if desired.

## Guardrails

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- Renderer gets OS capabilities only through a typed preload bridge.
- Domain/parser code must never import `electron`.
