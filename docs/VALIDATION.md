# Compatibility validation log

## 2026-09-14 — legacy JCX smoke test

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
