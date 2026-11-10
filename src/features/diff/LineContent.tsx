import type { Token } from "./model/highlight";
import type { Range } from "./model/wordDiff";
import styles from "./LineContent.module.css";

const NBSP = " ";

interface Props {
  text: string;
  tokens: Token[] | null;
  ranges: Range[];
  noNewlineAtEof: boolean;
  /** The part of the line inside the viewer's text range. */
  selected?: Range | null;
}

interface Piece {
  text: string;
  className: string | null;
  marked: boolean;
  selected: boolean;
}

/**
 * Splits tokens at word-diff and selection boundaries so each piece is wholly marked or not and
 * wholly selected or not, keeping its token class.
 */
function pieces(
  text: string,
  tokens: Token[] | null,
  ranges: Range[],
  selected: Range | null,
): Piece[] {
  const toks = tokens ?? [{ text, className: null }];
  const cuts = new Set<number>([0, text.length]);
  let off = 0;
  for (const t of toks) {
    off += t.text.length;
    cuts.add(off);
  }
  for (const r of [...ranges, ...(selected ? [selected] : [])]) {
    cuts.add(r.start);
    cuts.add(r.end);
  }
  const bounds = [...cuts].sort((a, b) => a - b);
  const out: Piece[] = [];
  let ti = 0;
  let tokEnd = toks[0].text.length;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [s, e] = [bounds[i], bounds[i + 1]];
    // Skip tokens that end at or before this piece (zero-length tokens included).
    while (s >= tokEnd && ti + 1 < toks.length) {
      ti++;
      tokEnd += toks[ti].text.length;
    }
    out.push({
      text: text.slice(s, e),
      className: toks[ti].className,
      marked: ranges.some((r) => s >= r.start && e <= r.end),
      selected: selected !== null && s >= selected.start && e <= selected.end,
    });
  }
  return out;
}

/** Consecutive pieces with the same marked state, so one highlighted run renders as one box. */
function runs(parts: Piece[]): Piece[][] {
  const out: Piece[][] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last[0].marked === p.marked) last.push(p);
    else out.push([p]);
  }
  return out;
}

function pieceSpan(p: Piece, key: number) {
  const classes = [p.className, p.selected ? styles.selected : null].filter(Boolean);
  const className = classes.length > 0 ? classes.join(" ") : undefined;
  return (
    <span key={key} className={className}>
      {p.text}
    </span>
  );
}

export function LineContent({ text, tokens, ranges, noNewlineAtEof, selected = null }: Props) {
  const parts = text.length === 0 ? [] : pieces(text, tokens, ranges, selected);
  return (
    <code className={styles.code} data-line-text="" data-line-length={text.length}>
      {/* A non-breaking space keeps an empty line at full height. */}
      {parts.length === 0 ? NBSP : null}
      {runs(parts).map((run, i) =>
        run[0].marked ? (
          <mark key={i} className={styles.word}>
            {run.map(pieceSpan)}
          </mark>
        ) : (
          run.map(pieceSpan)
        ),
      )}
      {noNewlineAtEof && (
        <span className={styles.eof} title="No newline at end of file">
          ⏎
        </span>
      )}
    </code>
  );
}
