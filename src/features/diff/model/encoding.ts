import type { FileDiff, TextEncoding } from "../../../lib/ipc";

const LABELS: Record<TextEncoding, string> = {
  utf8: "UTF-8",
  utf16Le: "UTF-16 LE",
  utf16Be: "UTF-16 BE",
  utf32Le: "UTF-32 LE",
  utf32Be: "UTF-32 BE",
};

export function encodingLabel(e: TextEncoding): string {
  return LABELS[e];
}

export function isDecoded(diff: FileDiff): boolean {
  return diff.oldEncoding !== null || diff.newEncoding !== null;
}

/** Toolbar text for a decoded diff, or null for an ordinary one. */
export function encodingNotice(diff: FileDiff): string | null {
  const { oldEncoding, newEncoding } = diff;
  const only = newEncoding ?? oldEncoding;
  if (only === null) return null;
  if (oldEncoding === null || newEncoding === null || oldEncoding === newEncoding) {
    return `Decoded from ${encodingLabel(only)}`;
  }
  return `Encoding changed from ${encodingLabel(oldEncoding)} to ${encodingLabel(newEncoding)}`;
}
