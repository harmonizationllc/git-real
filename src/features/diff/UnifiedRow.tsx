import { memo, useMemo } from "react";
import type { FileDiff } from "../../lib/ipc";
import { Gutter } from "./Gutter";
import { LineContent } from "./LineContent";
import type { HighlightMap } from "./model/highlight";
import type { DiffRow } from "./model/rows";
import { wordDiff, type Range } from "./model/wordDiff";
import type { RowTint } from "./useTextRange";
import styles from "./DiffRows.module.css";

interface Props {
  diff: FileDiff;
  row: Extract<DiffRow, { kind: "unified" }>;
  highlight: HighlightMap | null;
  tint: RowTint | null;
}

const NO_RANGES: Range[] = [];

/** One line of a unified diff: old and new gutters, the sign and the content. */
export const UnifiedRow = memo(function UnifiedRow({ diff, row, highlight, tint }: Props) {
  const hunk = diff.hunks[row.hunkIndex];
  const line = hunk.lines[row.lineIndex];
  const partner = row.partner === null ? null : hunk.lines[row.partner];
  const ranges = useMemo(() => {
    if (partner === null) return NO_RANGES;
    return line.kind === "deletion"
      ? wordDiff(line.content, partner.content).old
      : wordDiff(partner.content, line.content).new;
  }, [line, partner]);
  const tokens = highlight?.get(row.hunkIndex)?.[row.lineIndex] ?? null;
  const side = line.kind === "deletion" ? "old" : "new";
  // A line of the other kind than the range's side (a deletion on the new side) is shaded whole.
  const whole = tint !== null && line.kind !== "context" && tint.side !== side;
  const selected =
    tint === null
      ? null
      : {
          start: whole ? 0 : (tint.from ?? 0),
          end: whole ? line.content.length : (tint.to ?? line.content.length),
        };
  return (
    <div
      className={styles.row}
      data-kind={line.kind}
      data-side={side}
      data-selected={tint !== null || undefined}
    >
      <Gutter lineno={line.oldLineno} />
      <Gutter lineno={line.newLineno} />
      <span className={styles.sign} aria-hidden="true">
        {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}
      </span>
      <LineContent
        text={line.content}
        tokens={tokens}
        ranges={ranges}
        noNewlineAtEof={line.noNewlineAtEof}
        selected={selected}
      />
    </div>
  );
});
