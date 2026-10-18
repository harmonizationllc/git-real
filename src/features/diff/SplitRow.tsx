import { memo, useMemo } from "react";
import type { FileDiff, Hunk } from "../../lib/ipc";
import { Gutter } from "./Gutter";
import { LineContent } from "./LineContent";
import type { HighlightMap } from "./model/highlight";
import type { DiffRow } from "./model/rows";
import { wordDiff, type Range, type WordDiff } from "./model/wordDiff";
import type { UseLineSelection } from "./useLineSelection";
import styles from "./DiffRows.module.css";

interface Props {
  diff: FileDiff;
  row: Extract<DiffRow, { kind: "split" }>;
  highlight: HighlightMap | null;
  selection?: UseLineSelection;
  onGutterClick?(hunk: number, line: number, shift: boolean): void;
}

const NO_WORDS: WordDiff = { old: [], new: [] };

/** One side-by-side row: the old line on the left, the new line on the right. */
export const SplitRow = memo(function SplitRow({
  diff,
  row,
  highlight,
  selection,
  onGutterClick,
}: Props) {
  const hunk = diff.hunks[row.hunkIndex];
  const oldLine = row.old === null ? null : hunk.lines[row.old];
  const newLine = row.new === null ? null : hunk.lines[row.new];
  // A context pair is one line on both sides; only an edited pair gets word marks.
  const words = useMemo(
    () =>
      oldLine && newLine && oldLine !== newLine
        ? wordDiff(oldLine.content, newLine.content)
        : NO_WORDS,
    [oldLine, newLine],
  );
  const cell = { hunk, hunkIndex: row.hunkIndex, highlight, selection, onGutterClick };
  return (
    <div className={styles.split}>
      <Cell {...cell} lineIndex={row.old} side="old" ranges={words.old} />
      <Cell {...cell} lineIndex={row.new} side="new" ranges={words.new} />
    </div>
  );
});

function Cell({
  hunk,
  hunkIndex,
  lineIndex,
  side,
  ranges,
  highlight,
  selection,
  onGutterClick,
}: {
  hunk: Hunk;
  hunkIndex: number;
  lineIndex: number | null;
  side: "old" | "new";
  ranges: Range[];
  highlight: HighlightMap | null;
  selection?: UseLineSelection;
  onGutterClick?(hunk: number, line: number, shift: boolean): void;
}) {
  if (lineIndex === null) return <div className={styles.cell} data-kind="empty" />;
  const line = hunk.lines[lineIndex];
  const lineno = side === "old" ? line.oldLineno : line.newLineno;
  const selected = selection?.hunkIndex === hunkIndex && selection.selected.has(lineIndex);
  const tokens = highlight?.get(hunkIndex)?.[lineIndex] ?? null;
  const click =
    onGutterClick && line.kind !== "context"
      ? (shift: boolean) => onGutterClick(hunkIndex, lineIndex, shift)
      : undefined;
  return (
    <div className={styles.cell} data-kind={line.kind} data-selected={selected || undefined}>
      <Gutter
        lineno={lineno}
        pressed={selected}
        label={side === "old" ? `Select removed line ${lineno}` : `Select added line ${lineno}`}
        onClick={click}
      />
      <LineContent
        text={line.content}
        tokens={tokens}
        ranges={ranges}
        noNewlineAtEof={line.noNewlineAtEof}
      />
    </div>
  );
}
