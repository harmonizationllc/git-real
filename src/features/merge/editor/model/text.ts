export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export type NotEditable = "tooLarge" | "notText";
export interface EditableText {
  text: string;
  crlf: boolean;
}

/** Strict UTF-8 text with LF line endings, or why the bytes cannot be edited here. */
export function decodeEditable(bytes: ArrayBuffer): EditableText | NotEditable {
  if (bytes.byteLength > MAX_EDIT_BYTES) return "tooLarge";
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "notText";
  }
  if (raw.includes("\u0000")) return "notText";
  const crlf = raw.includes("\r\n");
  return { text: crlf ? raw.replace(/\r\n/g, "\n") : raw, crlf };
}

/** The text as it goes back to disk: CRLF restored only when the file used it. */
export function encodeForDisk(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\n/g, "\r\n") : text;
}

/** The number of "\n"-separated segments, so a final newline adds an empty line. */
export function lineCount(text: string): number {
  return text.split("\n").length;
}
