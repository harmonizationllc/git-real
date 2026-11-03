import { memo, useMemo } from "react";
import type { FileDiff, Hunk } from "../../lib/ipc";
import { Gutter } from "./Gutter";
import { LineContent } from "./LineContent";
import type { HighlightMap } from "./model/highlight";
import type { DiffRow } from "./model/rows";
import type { Side } from "./model/selection";
import { wordDiff, type Range, type WordDiff } from "./model/wordDiff";
import type { RowTint } from "./useTextRange";
import styles from "./DiffRows.module.css";

interface Props {
  diff: FileDiff;
  row: Extract<DiffRow, { kind: "split" }>;
  highlight: HighlightMap | null;
  tint: RowTint | null;
}

const NO_WORDS: WordDiff = { old: [], new: [] };

/** One side-by-side row: the old line on the left, the new line on the right. */
export const SplitRow = memo(function SplitRow({ diff, row, highlight, tint }: Props) {
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
  const cell = { hunk, hunkIndex: row.hunkIndex, highlight };
  // Only the cell on the range's side is tinted.
  const tintOn = (side: Side) => (tint?.side === side ? tint : null);
  return (
    <div className={styles.split}>
      <Cell {...cell} lineIndex={row.old} side="old" ranges={words.old} tint={tintOn("old")} />
      <Cell {...cell} lineIndex={row.new} side="new" ranges={words.new} tint={tintOn("new")} />
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
  tint,
}: {
  hunk: Hunk;
  hunkIndex: number;
  lineIndex: number | null;
  side: Side;
  ranges: Range[];
  highlight: HighlightMap | null;
  tint: RowTint | null;
}) {
  if (lineIndex === null) {
    return <div className={styles.cell} data-kind="empty" data-side={side} />;
  }
  const line = hunk.lines[lineIndex];
  const lineno = side === "old" ? line.oldLineno : line.newLineno;
  const tokens = highlight?.get(hunkIndex)?.[lineIndex] ?? null;
  const selected =
    tint === null ? null : { start: tint.from ?? 0, end: tint.to ?? line.content.length };
  return (
    <div
      className={styles.cell}
      data-kind={line.kind}
      data-side={side}
      data-selected={tint !== null || undefined}
    >
      <Gutter lineno={lineno} />
      <LineContent
        text={line.content}
        tokens={tokens}
        ranges={ranges}
        noNewlineAtEof={line.noNewlineAtEof}
        selected={selected}
      />
    </div>
  );
}
