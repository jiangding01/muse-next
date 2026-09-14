import type { GuitarChord, GuitarStringPosition } from '../../domain/music';

const FINGERED_FRET = /^(\d+)(?:\(([1-5])\))?$/;

export function parseGChordDirective(line: string): GuitarChord | null {
  const match = line.trim().match(/^%%gchord\s+([^=]+)=([^;]+);(.+)$/i);
  if (!match) return null;

  const [, rawName, rawBaseFret, rawStrings] = match;
  const name = rawName?.trim();
  const baseFret = Number.parseInt(rawBaseFret?.trim() ?? '', 10);
  const tokens = (rawStrings ?? '').split(',').map((token) => token.trim());

  if (!name || !Number.isFinite(baseFret) || tokens.length !== 6) {
    return null;
  }

  const strings: GuitarStringPosition[] = tokens.map((token, stringIndex) => {
    if (/^x$/i.test(token)) {
      return { stringIndex, state: 'muted', fret: null };
    }

    if (token === '0') {
      return { stringIndex, state: 'open', fret: 0 };
    }

    const fretMatch = token.match(FINGERED_FRET);
    if (!fretMatch) {
      return { stringIndex, state: 'muted', fret: null };
    }

    const fret = Number.parseInt(fretMatch[1] ?? '0', 10);
    const fingerText = fretMatch[2];
    const finger = fingerText
      ? (Number.parseInt(fingerText, 10) as 1 | 2 | 3 | 4 | 5)
      : undefined;

    return finger === undefined
      ? { stringIndex, state: 'fretted', fret }
      : { stringIndex, state: 'fretted', fret, finger };
  });

  return {
    name,
    baseFret,
    strings,
    barres: [],
  };
}
