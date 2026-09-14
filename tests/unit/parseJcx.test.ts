import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseJcx } from '../../src/formats/jcx/parseJcx';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('parseJcx', () => {
  it('parses score metadata, chords and tracks', () => {
    const source = readFileSync(path.join(here, '../fixtures/minimal.jcx'), 'utf8');
    const document = parseJcx(source);

    expect(document.format).toBe('MUSE2');
    expect(document.metadata.titles[0]).toBe('Fixture Song');
    expect(document.chords).toHaveLength(2);
    expect(document.tracks.map((track) => track.style)).toEqual(['tab', 'staff']);
  });
});
