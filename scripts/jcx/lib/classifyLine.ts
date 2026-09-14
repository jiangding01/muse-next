import type { ClassifiedLine, VoiceDiscovery } from "./types";

const MAGIC_PATTERN = /^%MUSE\d*/i;

const DIRECTIVE_PATTERN = /^%%([A-Za-z0-9_-]+)(?:\s+(.*))?$/;

const HEADER_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*):(.*)$/;

/**
 * Inline ABC/Muse field.
 *
 * Muse corpus contains both:
 *
 * [V:1]
 * [V: 1]
 *
 * We intentionally tolerate whitespace around
 * the colon and value.
 */
const INLINE_FIELD_PATTERN =
  /^\[\s*([A-Za-z][A-Za-z0-9_-]*)\s*:\s*([^\]]*)\]\s*$/;

/**
 * Attribute syntax examples:
 *
 * name="主旋律"
 * style=jianpu
 * instrument=25
 */
const ATTRIBUTE_PATTERN =
  /\b([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;

export function classifyLine(raw: string): ClassifiedLine {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return createResult("blank", raw, trimmed);
  }

  if (MAGIC_PATTERN.test(trimmed)) {
    return createResult("magic", raw, trimmed);
  }

  const directiveMatch = DIRECTIVE_PATTERN.exec(trimmed);

  if (directiveMatch) {
    return {
      kind: "directive",

      raw,
      trimmed,

      headerKey: null,
      headerValue: null,

      inlineFieldKey: null,
      inlineFieldValue: null,

      directiveName: directiveMatch[1] ?? "",

      directiveValue: directiveMatch[2]?.trim() ?? "",
    };
  }

  /**
   * ABC/Muse comments generally begin with a single %.
   *
   * %% directives were already handled above.
   */
  if (trimmed.startsWith("%")) {
    return createResult("comment", raw, trimmed);
  }

  const inlineFieldMatch = INLINE_FIELD_PATTERN.exec(trimmed);

  if (inlineFieldMatch) {
    return {
      kind: "inline-field",

      raw,
      trimmed,

      headerKey: null,
      headerValue: null,

      inlineFieldKey: inlineFieldMatch[1] ?? "",

      inlineFieldValue: inlineFieldMatch[2]?.trim() ?? "",

      directiveName: null,
      directiveValue: null,
    };
  }

  const headerMatch = HEADER_PATTERN.exec(trimmed);

  if (headerMatch) {
    return {
      kind: "header",

      raw,
      trimmed,

      headerKey: headerMatch[1] ?? "",

      headerValue: headerMatch[2]?.trim() ?? "",

      inlineFieldKey: null,
      inlineFieldValue: null,

      directiveName: null,
      directiveValue: null,
    };
  }

  /**
   * We intentionally keep this heuristic conservative.
   *
   * The scanner is a discovery tool, not the production
   * JCX parser.
   */
  if (looksLikeMusicalBody(trimmed)) {
    return createResult("body", raw, trimmed);
  }

  return createResult("unknown", raw, trimmed);
}

function createResult(
  kind: ClassifiedLine["kind"],
  raw: string,
  trimmed: string,
): ClassifiedLine {
  return {
    kind,

    raw,
    trimmed,

    headerKey: null,
    headerValue: null,

    inlineFieldKey: null,
    inlineFieldValue: null,

    directiveName: null,
    directiveValue: null,
  };
}

/**
 * Parse:
 *
 * V:1 name="主旋律" style=jianpu
 *
 * or:
 *
 * V: guitar style=tab
 */
export function parseVoiceDefinition(
  lineNumber: number,
  rawValue: string,
  rawLine: string,
): VoiceDiscovery {
  const attributes: Record<string, string> = {};

  ATTRIBUTE_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;

  while ((match = ATTRIBUTE_PATTERN.exec(rawValue)) !== null) {
    const key = match[1];

    if (!key) {
      continue;
    }

    const value = match[2] ?? match[3] ?? match[4] ?? "";

    attributes[key] = value;
  }

  /**
   * Remove attributes so that the remaining first token
   * can be interpreted as the voice id.
   */
  const withoutAttributes = rawValue.replace(ATTRIBUTE_PATTERN, "").trim();

  const id = withoutAttributes.split(/\s+/).filter(Boolean)[0] ?? null;

  const style = attributes.style ?? null;

  return {
    lineNumber,
    raw: rawLine,
    id,
    style,
    attributes,
  };
}

/**
 * Discover high-level musical syntax features appearing
 * in a body line.
 *
 * These are deliberately feature names rather than AST
 * nodes.
 *
 * Their purpose is to answer questions such as:
 *
 * "Does the legacy corpus contain grace notes?"
 * "Does it contain tuplets?"
 * "Which files contain repeat endings?"
 */
export function analyzeBodyFeatures(line: string): string[] {
  const features = new Set<string>();

  if (/\|/.test(line)) {
    features.add("barline");
  }

  if (/\|:|:\|/.test(line)) {
    features.add("repeat");
  }

  if (/\[(?:1|2|3|4)\b/.test(line)) {
    features.add("alternate-ending");
  }

  if (/"[^\"]+"/.test(line)) {
    features.add("quoted-annotation");
  }

  if (/\{[^}]+\}/.test(line)) {
    features.add("grace-group");
  }

  if (/\(\d(?::\d(?::\d)?)?/.test(line)) {
    features.add("tuplet");
  }

  if (/[<>]/.test(line)) {
    features.add("broken-rhythm");
  }

  if (/(?:^|[^-])-(?:[^-]|$)/.test(line)) {
    features.add("tie-or-hyphen");
  }

  if (/[_^=][A-Ga-g]/.test(line)) {
    features.add("accidental");
  }

  if (/[A-Ga-g][,']*/.test(line)) {
    features.add("note");
  }

  if (/(?:^|[^A-Za-z])[zZ](?:[^A-Za-z]|$)/.test(line)) {
    features.add("rest");
  }

  if (/![^!]+!/.test(line)) {
    features.add("bang-decoration");
  }

  if (/\+[^+]+\+/.test(line)) {
    features.add("plus-decoration");
  }

  if (/\[[A-Za-z]:[^\]]+]/.test(line)) {
    features.add("inline-field");
  }

  if (/\[[^\]]*[,']?[A-Ga-g][^\]]*]/.test(line)) {
    features.add("note-chord");
  }

  if (/\/\d*|\d+\/\d+/.test(line)) {
    features.add("fractional-duration");
  }

  if (/[A-Ga-gzZ]\d+/.test(line)) {
    features.add("explicit-duration");
  }

  if (/\([^)]*[A-Ga-g][^)]*\)/.test(line)) {
    features.add("slur-like-group");
  }

  return Array.from(features).sort();
}

/**
 * A conservative heuristic for deciding whether a line
 * resembles ABC/Muse score content.
 *
 * Unknown lines outside voices remain visible in the
 * report instead of being silently accepted.
 */
function looksLikeMusicalBody(line: string): boolean {
  /**
   * A score body should normally contain at least one
   * notation-oriented construct rather than merely an
   * ASCII letter A-G.
   */

  // Notes / rests with common ABC duration or octave syntax.
  if (
    /(?:^|[\s|:[(\[{])[_^=]?[A-Ga-gzZ][,']*(?:\d+|\/\d*|\d+\/\d+)?/.test(line)
  ) {
    return true;
  }

  // Bar / repeat structures.
  if (/(?:\|:|:\||\|\]|\[\||\|\||\|)/.test(line)) {
    return true;
  }

  // Grace notes.
  if (/\{[^}]*[_^=]?[A-Ga-g][^}]*\}/.test(line)) {
    return true;
  }

  // Tuplets.
  if (/\(\d(?::\d(?::\d)?)?/.test(line)) {
    return true;
  }

  // ABC-style quoted annotations / chord symbols
  // attached to notation.
  if (/"[^"]+"(?=[_^=A-Ga-gzZ[{(])/.test(line)) {
    return true;
  }

  // Note chords such as [CEG].
  if (/\[[^\]]*[_^=]?[A-Ga-g][^\]]*\]/.test(line)) {
    return true;
  }

  return false;
}

/**
 * Used when grouping unknown syntax.
 *
 * Examples:
 *
 *   foo 123 "hello"
 *   foo 456 "world"
 *
 * both become approximately:
 *
 *   foo # "…"
 */
export function normalizeUnknownPattern(raw: string): string {
  return raw
    .trim()
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}
