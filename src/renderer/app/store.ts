/**
 * Renderer 应用状态（M1.6 T10b）。
 *
 * 迁移要点：此前的 `parseJcx` scaffold 已删除，改为走格式层统一入口
 * `loadJcx`（`src/formats/jcx`），状态里保存的是正式 Domain 的 `Score`
 * 与整条管线合并后的 `diagnostics`。
 *
 * 两条行为变更：
 * 1. **不再要求 `%MUSE2` magic header**——spec §7.2 明确它是可选的，缺失
 *    时旧 scaffold 会抛错，属于 scaffold 自造的约束。
 * 2. **解析失败不再抛异常**——`loadJcx` 对字符串输入永不抛（见其 JSDoc 的
 *    异常契约），无法结构化的内容一律以 diagnostic 呈现，因此本 store 不再
 *    需要 `error: string | null`，也永远有一个可渲染的 `Score`。
 *
 * Electron 边界（HANDOFF §24）：只从 `src/formats/jcx` 与 `src/domain` 导入，
 * 不碰 `node:` / `electron`；文件读取仍然经 `window.museDesktop` IPC。
 */

import { create } from 'zustand';

import type { Score } from '../../domain';
import type { JcxDiagnostic } from '../../formats/jcx';
import { loadJcx } from '../../formats/jcx';

const demoSource = `%MUSE2
T: Muse Next Demo
C: Clean-room TypeScript scaffold
M: 4/4
L: 1/8
Q: 1/4=96
K: G
%%showfinger yes
%%gchord G=1;3(3),2(2),0,0,0,3(4)
%%gchord C=1;X,3(3),2(2),0,1(1),0
%%gchord D=1;X,X,0,2(1),3(3),2(2)
V:1 name="Guitar" style=tab play=1 instrument=24 volumn=64
V:2 name="Melody" style=jianpu play=1 instrument=0 volumn=64
[V:1]
"G"fxcx/bx/fx/ax/bx/cx/ | "C"excx/bx/ex/ax/bx/cx/ | "D"dxcx/bx/dx/ax/bx/cx/ |
[V:2]
G2 A2 B2 d2 | c2 B2 A2 G2 |
`;

interface ParsedSource {
  readonly score: Score;
  readonly diagnostics: readonly JcxDiagnostic[];
}

function parse(source: string): ParsedSource {
  const { score, diagnostics } = loadJcx(source);
  return { score, diagnostics };
}

interface MuseAppState extends ParsedSource {
  filePath: string | null;
  source: string;
  encoding: 'utf8' | 'gb18030' | null;
  openScore(): Promise<void>;
  setSource(source: string): void;
  reparse(): void;
}

export const useMuseAppStore = create<MuseAppState>((set, get) => ({
  filePath: null,
  source: demoSource,
  encoding: 'utf8',
  ...parse(demoSource),

  async openScore() {
    const result = await window.museDesktop.openScore();
    if (result.canceled || result.content === undefined) return;

    set({
      filePath: result.path ?? null,
      source: result.content,
      encoding: result.encoding ?? null,
      ...parse(result.content),
    });
  },

  setSource(source) {
    set({ source });
  },

  reparse() {
    set(parse(get().source));
  },
}));
