import type { MuseScoreDocument, MuseTrack } from '../../domain/music';
import { parseGChordDirective } from './parseGChord';

const TRACK_SECTION = /^\[V:([^\]]+)]\s*$/;
const TRACK_DEFINITION = /^V:([^\s]+)\s*(.*)$/;
const HEADER_FIELD = /^([A-Z]):\s*(.*)$/;
const DIRECTIVE = /^%%([^\s]+)\s*(.*)$/;
const TRACK_PROPERTY = /(\w+)=(?:"([^"]*)"|([^\s]+))/g;

/**
 * @deprecated early scaffold; scheduled for removal after the M1.6 parser
 * migration. The new format pipeline is built on lexer + lossless AST.
 */
export function parseJcx(source: string): MuseScoreDocument {
  const normalized = source.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  if (lines[0]?.trim() !== '%MUSE2') {
    throw new Error('Unsupported score: expected %MUSE2 header.');
  }

  const metadata: MuseScoreDocument['metadata'] = {
    titles: [],
    credits: [],
  };
  const directives: Record<string, string[]> = {};
  const chords: MuseScoreDocument['chords'] = [];
  const trackDefinitions = new Map<string, Omit<MuseTrack, 'source'>>();
  const trackBodies = new Map<string, string[]>();
  let activeTrackId: string | null = null;

  for (const line of lines.slice(1)) {
    const section = line.match(TRACK_SECTION);
    if (section?.[1]) {
      activeTrackId = section[1].trim();
      if (!trackBodies.has(activeTrackId)) trackBodies.set(activeTrackId, []);
      continue;
    }

    if (activeTrackId) {
      trackBodies.get(activeTrackId)?.push(line);
      continue;
    }

    const chord = parseGChordDirective(line);
    if (chord) {
      chords.push(chord);
      continue;
    }

    const track = line.match(TRACK_DEFINITION);
    if (track?.[1]) {
      const id = track[1];
      const properties = parseTrackProperties(track[2] ?? '');
      const play = parseBooleanFlag(properties.play);
      const instrument = parseOptionalNumber(properties.instrument);
      const volume = parseOptionalNumber(properties.volumn ?? properties.volume);
      const bracket = parseOptionalNumber(properties.bracket);

      trackDefinitions.set(id, {
        id,
        ...(properties.name === undefined ? {} : { name: properties.name }),
        style: properties.style ?? 'staff',
        ...(play === undefined ? {} : { play }),
        ...(instrument === undefined ? {} : { instrument }),
        ...(volume === undefined ? {} : { volume }),
        ...(bracket === undefined ? {} : { bracket }),
      });
      continue;
    }

    const header = line.match(HEADER_FIELD);
    if (header?.[1]) {
      applyHeader(metadata, header[1], header[2] ?? '');
      continue;
    }

    const directive = line.match(DIRECTIVE);
    if (directive?.[1]) {
      const key = directive[1];
      directives[key] ??= [];
      directives[key].push((directive[2] ?? '').trim());
    }
  }

  const trackIds = new Set([...trackDefinitions.keys(), ...trackBodies.keys()]);
  const tracks: MuseTrack[] = [...trackIds].map((id) => {
    const definition = trackDefinitions.get(id);
    return {
      id,
      ...(definition?.name === undefined ? {} : { name: definition.name }),
      style: definition?.style ?? 'staff',
      ...(definition?.play === undefined ? {} : { play: definition.play }),
      ...(definition?.instrument === undefined ? {} : { instrument: definition.instrument }),
      ...(definition?.volume === undefined ? {} : { volume: definition.volume }),
      ...(definition?.bracket === undefined ? {} : { bracket: definition.bracket }),
      source: (trackBodies.get(id) ?? []).join('\n').trimEnd(),
    };
  });

  return {
    format: 'MUSE2',
    metadata,
    directives,
    chords,
    tracks,
    rawSource: normalized,
  };
}

function parseTrackProperties(input: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const match of input.matchAll(TRACK_PROPERTY)) {
    const key = match[1];
    const value = match[2] ?? match[3];
    if (key && value !== undefined) properties[key] = value;
  }
  return properties;
}

function parseBooleanFlag(value?: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === '1' || value.toLowerCase() === 'yes' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'no' || value.toLowerCase() === 'false') return false;
  return undefined;
}

function parseOptionalNumber(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function applyHeader(
  metadata: MuseScoreDocument['metadata'],
  field: string,
  value: string,
): void {
  switch (field) {
    case 'T':
      metadata.titles.push(value.trim());
      break;
    case 'C':
      metadata.credits.push(value.trim());
      break;
    case 'M':
      metadata.meter = value.trim();
      break;
    case 'L':
      metadata.defaultLength = value.trim();
      break;
    case 'Q':
      metadata.tempo = value.trim();
      break;
    case 'K':
      metadata.key = value.trim();
      break;
    default:
      break;
  }
}
