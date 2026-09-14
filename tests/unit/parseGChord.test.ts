import { describe, expect, it } from 'vitest';
import { parseGChordDirective } from '../../src/formats/jcx/parseGChord';

describe('parseGChordDirective', () => {
  it('parses Muse fret and finger syntax', () => {
    const chord = parseGChordDirective('%%gchord G=1;3(3),2(2),0,0,0,3(4)');

    expect(chord?.name).toBe('G');
    expect(chord?.baseFret).toBe(1);
    expect(chord?.strings[0]).toMatchObject({ state: 'fretted', fret: 3, finger: 3 });
    expect(chord?.strings[2]).toMatchObject({ state: 'open', fret: 0 });
  });
});
