import { create } from 'zustand';
import type { MuseScoreDocument } from '../../domain/music';
import { parseJcx } from '../../formats/jcx/parseJcx';

interface MuseAppState {
  filePath: string | null;
  source: string;
  encoding: 'utf8' | 'gb18030' | null;
  document: MuseScoreDocument | null;
  error: string | null;
  openScore(): Promise<void>;
  setSource(source: string): void;
  reparse(): void;
}

export const useMuseAppStore = create<MuseAppState>((set, get) => ({
  filePath: null,
  source: demoSource,
  encoding: 'utf8',
  document: parseJcx(demoSource),
  error: null,

  async openScore() {
    const result = await window.museDesktop.openScore();
    if (result.canceled || !result.content) return;

    try {
      const document = parseJcx(result.content);
      set({
        filePath: result.path ?? null,
        source: result.content,
        encoding: result.encoding ?? null,
        document,
        error: null,
      });
    } catch (error) {
      set({
        filePath: result.path ?? null,
        source: result.content,
        encoding: result.encoding ?? null,
        document: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  setSource(source) {
    set({ source });
  },

  reparse() {
    try {
      set({ document: parseJcx(get().source), error: null });
    } catch (error) {
      set({ document: null, error: error instanceof Error ? error.message : String(error) });
    }
  },
}));

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
