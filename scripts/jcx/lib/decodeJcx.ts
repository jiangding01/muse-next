import { TextDecoder } from "node:util";

import type { DecodedJcxFile, JcxEncoding } from "./types";

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }

  return prefix.every((value, index) => bytes[index] === value);
}

function decode(
  bytes: Uint8Array,
  encoding: JcxEncoding,
  fatal = true,
): string {
  const decoder = new TextDecoder(encoding, {
    fatal,
  });

  return decoder.decode(bytes);
}

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

/**
 * JCX files from old Muse versions are commonly stored
 * using legacy Simplified Chinese encodings.
 *
 * Detection strategy:
 *
 * 1. Respect Unicode BOM if present.
 * 2. Try strict UTF-8.
 * 3. Fall back to GB18030.
 *
 * GB18030 is preferred instead of GBK because it is a
 * superset and is supported by WHATWG TextDecoder.
 */
export function decodeJcx(bytes: Uint8Array): DecodedJcxFile {
  // UTF-8 BOM
  if (hasPrefix(bytes, [0xef, 0xbb, 0xbf])) {
    return {
      encoding: "utf-8",
      text: stripBom(decode(bytes, "utf-8")),
    };
  }

  // UTF-16 LE BOM
  if (hasPrefix(bytes, [0xff, 0xfe])) {
    return {
      encoding: "utf-16le",
      text: stripBom(decode(bytes, "utf-16le")),
    };
  }

  // UTF-16 BE BOM
  if (hasPrefix(bytes, [0xfe, 0xff])) {
    return {
      encoding: "utf-16be",
      text: stripBom(decode(bytes, "utf-16be")),
    };
  }

  // First try strict UTF-8.
  //
  // "fatal: true" is important here. Otherwise invalid
  // UTF-8 bytes would silently become replacement chars
  // and we would incorrectly identify many GBK files
  // as UTF-8.
  try {
    return {
      encoding: "utf-8",
      text: decode(bytes, "utf-8", true),
    };
  } catch {
    // Continue to legacy encoding fallback.
  }

  try {
    return {
      encoding: "gb18030",
      text: decode(bytes, "gb18030", true),
    };
  } catch (error) {
    throw new Error(
      [
        "Unable to decode JCX file.",
        "Tried UTF-8 and GB18030.",
        "",
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
    );
  }
}
