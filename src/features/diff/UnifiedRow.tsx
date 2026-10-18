import { memo, useMemo } from "react";
import type { FileDiff } from "../../lib/ipc";
import { Gutter } from "./Gutter";
import { LineContent } from "./LineContent";
import type { HighlightMap } from "./model/highlight";
import type { DiffRow } from "./model/rows";
import { wordDiff, type Range } from "./model/wordDiff";
import type { UseLineSelection } from "./useLineSelection";
import styles from "./DiffRows.module.css";

interface Props {
  diff: FileDiff;
  row: Extract<DiffRow, { kind: "unified" }>;
  highlight: HighlightMap | null;
  selection?: UseLineSelection;
  onGutterClick?(hunk: number, line: number, shift: boolean): void;
}

const NO_RANGES: Range[] = [];

/** One line of a unified diff: old and new gutters, the sign and the content. */
export const UnifiedRow = memo(function UnifiedRow({
  diff,
  row,
  highlight,
  selection,
  onGutterClick,
}: Props) {
  const hunk = diff.hunks[row.hunkIndex];
  const line = hunk.lines[row.lineIndex];
  const partner = row.partner === null ? null : hunk.lines[row.partner];
  const ranges = useMemo(() => {
    if (partner === null) return NO_RANGES;
    return line.kind === "deletion"
      ? wordDiff(line.content, partner.content).old
      : wordDiff(partner.content, line.content).new;
  }, [line, partner]);
  const selected = selection?.hunkIndex === row.hunkIndex && selection.selected.has(row.lineIndex);
  const tokens = highlight?.get(row.hunkIndex)?.[row.lineIndex] ?? null;
  const click =
    onGutterClick && line.kind !== "context"
      ? (shift: boolean) => onGutterClick(row.hunkIndex, row.lineIndex, shift)
      : undefined;
  // One control per line, on the gutter that shows the line's number.
  const label =
    line.kind === "deletion"
      ? `Select removed line ${line.oldLineno}`
      : `Select added line ${line.newLineno}`;
  return (
    <div className={styles.row} data-kind={line.kind} data-selected={selected || undefined}>
      <Gutter
        lineno={line.oldLineno}
        pressed={selected}
        label={label}
        onClick={line.kind === "deletion" ? click : undefined}
      />
      <Gutter
        lineno={line.newLineno}
        pressed={selected}
        label={label}
        onClick={line.kind === "addition" ? click : undefined}
      />
      <span className={styles.sign} aria-hidden="true">
        {line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}
      </span>
      <LineContent
        text={line.content}
        tokens={tokens}
        ranges={ranges}
        noNewlineAtEof={line.noNewlineAtEof}
      />
    </div>
  );
});
