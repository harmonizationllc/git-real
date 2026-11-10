import type { AppError } from "../../../../lib/ipc";

export const MAX_EDIT_BYTES = 2 * 1024 * 1024;
export type NotEditable = "tooLarge" | "notText";

/** Placeholder copy for a file that cannot be edited here. */
export const REASONS: Record<NotEditable | "missing", string> = {
  tooLarge: "It is larger than 2 MB.",
  notText: "It is not UTF-8 text.",
  missing: "It is missing from the working tree.",
};

/** Why the file could not be read for editing, as placeholder copy. */
export function reasonFor(error: AppError): string {
  switch (error.kind) {
    case "tooLarge":
      return REASONS.tooLarge;
    case "binaryFile":
      return REASONS.notText;
    case "pathNotFound":
      return REASONS.missing;
    default:
      return error.message;
  }
}

/**
 * The placeholder copy for a file that has loaded but cannot be edited, or null while it loads or
 * when it is editable. Bytes already in hand win over a later refetch error.
 */
export function placeholderReason(
  decoded: EditableText | NotEditable | null,
  error: AppError | null,
): string | null {
  if (decoded !== null) return typeof decoded === "string" ? REASONS[decoded] : null;
  return error === null ? null : reasonFor(error);
}

/** The file's last path segment, as the editors name it in copy. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

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
