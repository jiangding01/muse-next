export type JcxEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030";

export type JcxLineKind =
  | "blank"
  | "magic"
  | "comment"
  | "header"
  | "inline-field"
  | "directive"
  | "text"
  | "body"
  | "unknown";

export interface DecodedJcxFile {
  text: string;
  encoding: JcxEncoding;
}

export interface ClassifiedLine {
  kind: JcxLineKind;

  raw: string;
  trimmed: string;

  /**
   * Header name, e.g.
   *
   * T:
   * V:
   * w:
   */
  headerKey: string | null;

  /**
   * Header value without "X:" prefix.
   */
  headerValue: string | null;

  /**
   * Directive name without %%
   *
   * Example:
   *
   * %%gchord ...
   *
   * directiveName = "gchord"
   */
  directiveName: string | null;

  /**
   * Directive content after directive name.
   */
  directiveValue: string | null;

  /**
   * Inline ABC/Muse field.
   *
   * Examples:
   *
   * [V:1]
   * [V: 1]
   */
  inlineFieldKey: string | null;

  inlineFieldValue: string | null;
}

export interface VoiceDiscovery {
  lineNumber: number;

  raw: string;

  /**
   * Example:
   *
   * V:1 name="主旋律" style=jianpu
   *
   * id = "1"
   */
  id: string | null;

  /**
   * tab / jianpu / staff / ...
   */
  style: string | null;

  attributes: Record<string, string>;
}

export interface UnknownLine {
  file: string;
  lineNumber: number;
  raw: string;

  /**
   * Normalized representation used for grouping similar
   * unknown lines together.
   */
  pattern: string;
}

export interface UnknownPatternSummary {
  pattern: string;
  count: number;

  examples: Array<{
    file: string;
    lineNumber: number;
    raw: string;
  }>;
}

export interface JcxFileReport {
  file: string;

  bytes: number;

  encoding: JcxEncoding;

  lines: number;

  magicHeaders: Record<string, number>;

  headers: Record<string, number>;

  directives: Record<string, number>;

  voiceStyles: Record<string, number>;

  bodyFeatures: Record<string, number>;

  voices: VoiceDiscovery[];

  unknownLines: UnknownLine[];

  inlineFields: Record<string, number>;

  /**
   * Physical lines occurring inside
   * %%begintext / %%endtext.
   */
  textBlockLines: number;
}

export interface JcxCorpusSummary {
  fileCount: number;

  totalBytes: number;

  totalLines: number;

  encodings: Record<string, number>;

  magicHeaders: Record<string, number>;

  headers: Record<string, number>;

  directives: Record<string, number>;

  voiceStyles: Record<string, number>;

  bodyFeatures: Record<string, number>;

  unknownLineCount: number;

  unknownPatterns: UnknownPatternSummary[];

  inlineFields: Record<string, number>;

  textBlockLines: number;
}

export interface JcxCorpusReport {
  version: 1;

  generatedAt: string;

  corpusDirectory: string;

  summary: JcxCorpusSummary;

  files: JcxFileReport[];
}
