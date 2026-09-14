export type TrackStyle = 'staff' | 'jianpu' | 'tab' | string;

export interface MuseTrack {
  id: string;
  name?: string;
  style: TrackStyle;
  play?: boolean;
  instrument?: number;
  volume?: number;
  bracket?: number;
  source: string;
}

export type GuitarStringState = 'muted' | 'open' | 'fretted';

export interface GuitarStringPosition {
  stringIndex: number;
  state: GuitarStringState;
  fret: number | null;
  finger?: 1 | 2 | 3 | 4 | 5;
}

export interface GuitarBarre {
  fret: number;
  fromString: number;
  toString: number;
  finger?: 1 | 2 | 3 | 4 | 5;
}

export interface GuitarChord {
  name: string;
  baseFret: number;
  strings: GuitarStringPosition[];
  barres: GuitarBarre[];
}

export interface MuseScoreMetadata {
  titles: string[];
  credits: string[];
  meter?: string;
  defaultLength?: string;
  tempo?: string;
  key?: string;
}

export interface MuseScoreDocument {
  format: 'MUSE2';
  metadata: MuseScoreMetadata;
  directives: Record<string, string[]>;
  chords: GuitarChord[];
  tracks: MuseTrack[];
  rawSource: string;
}
