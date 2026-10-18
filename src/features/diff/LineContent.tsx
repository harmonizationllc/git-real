import type { Token } from "./model/highlight";
import type { Range } from "./model/wordDiff";
import styles from "./LineContent.module.css";

interface Props {
  text: string;
  tokens: Token[] | null;
  ranges: Range[];
  noNewlineAtEof: boolean;
}

interface Piece {
  text: string;
  className: string | null;
  marked: boolean;
}

/** Splits tokens at word-diff boundaries so each piece is wholly marked or not. */
function pieces(text: string, tokens: Token[] | null, ranges: Range[]): Piece[] {
  const toks = tokens ?? [{ text, className: null }];
  const cuts = new Set<number>([0, text.length]);
  let off = 0;
  for (const t of toks) {
    off += t.text.length;
    cuts.add(off);
  }
  for (const r of ranges) {
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
    });
  }
  return out;
}

export function LineContent({ text, tokens, ranges, noNewlineAtEof }: Props) {
  const parts = text.length === 0 ? [] : pieces(text, tokens, ranges);
  return (
    <code className={styles.code}>
      {/* A non-breaking space keeps an empty line at full height. */}
      {parts.length === 0 ? " " : null}
      {parts.map((p, i) => {
        const className = p.className ?? undefined;
        return p.marked ? (
          <mark key={i} className={styles.word}>
            <span className={className}>{p.text}</span>
          </mark>
        ) : (
          <span key={i} className={className}>
            {p.text}
          </span>
        );
      })}
      {noNewlineAtEof && (
        <span className={styles.eof} title="No newline at end of file">
          ⏎
        </span>
      )}
    </code>
  );
}
