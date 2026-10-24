const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * Replaces `[start, end)` of `value` with `ref`, padded with a space on each side whose neighbour
 * exists and is not whitespace. `caret` is the index right after everything inserted.
 */
export function insertIssueRef(
  value: string,
  start: number,
  end: number,
  ref: string,
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  const inserted = `${isSpace(before[before.length - 1]) ? "" : " "}${ref}${isSpace(after[0]) ? "" : " "}`;
  return { value: before + inserted + after, caret: start + inserted.length };
}
