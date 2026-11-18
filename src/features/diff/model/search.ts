import type { FileDiff } from "../../../lib/ipc";
import type { DiffRow } from "./rows";
import { coveredText, orderedRange, rowLine, type Side, type TextRange } from "./selection";
import type { Range } from "./wordDiff";

export const SEARCH_HIT_CAP = 20_000;

export interface SearchOptions {
  wholeWord: boolean;
  matchCase: boolean;
}

export interface SearchHit {
  row: number;
  side: Side;
  start: number;
  end: number;
}

export interface SearchResult {
  hits: SearchHit[];
  capped: boolean;
}

/** A hit's identity across rebuilds: row key, side, start offset. */
export interface HitAnchor {
  key: string;
  side: Side;
  start: number;
}

export interface CellMarks {
  matches: Range[];
  current: Range | null;
}

export interface RowMarks {
  old: CellMarks | null;
  new: CellMarks | null;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** A compiled query: the literal as a RegExp, plus whether hits must be whole words. */
export type Matcher = RegExp & { wholeWord: boolean };

/**
 * null for an empty query; the RegExp has the `g` flag (and `i` unless matchCase). Whole-word
 * is enforced in `matchLine`, not with a lookbehind that older WebKit cannot compile.
 */
export function compileQuery(query: string, options: SearchOptions): Matcher | null {
  if (query === "") return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, options.matchCase ? "gu" : "giu");
  return Object.assign(re, { wholeWord: options.wholeWord });
}

/** Whether the code point just before `index` (a pair counts once) is a word character. */
function wordBefore(line: string, index: number): boolean {
  if (index === 0) return false;
  const low = line.charCodeAt(index - 1);
  const at = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1;
  return WORD_CHAR.test(String.fromCodePoint(line.codePointAt(at)!));
}

function wordAt(line: string, index: number): boolean {
  return index < line.length && WORD_CHAR.test(String.fromCodePoint(line.codePointAt(index)!));
}

/** Non-overlapping hits in `text` without its trailing newline. */
export function matchLine(text: string, re: Matcher): Range[] {
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  const out: Range[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(line); m !== null; m = re.exec(line)) {
    const end = m.index + m[0].length;
    if (re.wholeWord && (wordBefore(line, m.index) || wordAt(line, end))) {
      // Not a whole word here; a later, overlapping start may be.
      // A whole code point: inside a surrogate pair a `u` regex steps back and re-matches forever.
      re.lastIndex = m.index + (line.codePointAt(m.index)! > 0xffff ? 2 : 1);
      continue;
    }
    out.push({ start: m.index, end });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** The searchable cells of a row, old side before new; a split context row yields `new` only. */
function cells(diff: FileDiff, row: DiffRow): { side: Side; content: string }[] {
  const hunk = diff.hunks[row.hunkIndex];
  if (row.kind === "unified") {
    const line = hunk.lines[row.lineIndex];
    return [{ side: line.kind === "deletion" ? "old" : "new", content: line.content }];
  }
  const out: { side: Side; content: string }[] = [];
  const context = row.old !== null && row.old === row.new;
  if (row.old !== null && !context) out.push({ side: "old", content: hunk.lines[row.old].content });
  if (row.new !== null) out.push({ side: "new", content: hunk.lines[row.new].content });
  return out;
}

export interface SearchSeed {
  text: string;
  anchor: HitAnchor;
}

/**
 * The find query a single-row text range seeds, with the anchor of its own occurrence; null
 * when it seeds nothing. The anchor is a hit of the seed text unless the text overlaps itself
 * ("aa" selected at offset 1 of "aaaa"): hits never overlap, so pickCurrent then falls back.
 */
export function seedFromRange(
  diff: FileDiff,
  rows: DiffRow[],
  range: TextRange,
): SearchSeed | null {
  const { start, end } = orderedRange(range);
  if (start.row !== end.row) return null;
  const covered = coveredText(diff, rows, range);
  const text = covered.endsWith("\n") ? covered.slice(0, -1) : covered;
  if (text.trim() === "") return null;
  // Non-null: coveredText returned text for this row, so the row has a line on this side.
  const at = rowLine(diff, rows, start.row, range.side)!;
  const row = rows[start.row];
  const line = diff.hunks[at.hunkIndex].lines[at.lineIndex];
  // Must agree with the side convention in `cells()`: the side the hit is found on.
  const side: Side =
    row.kind === "unified"
      ? line.kind === "deletion"
        ? "old"
        : "new"
      : row.old !== null && row.old === row.new
        ? "new"
        : range.side;
  // coveredText's rule: only a cell of the range's own kind is cut at the offsets.
  const cut = line.kind === "context" || (line.kind === "deletion") === (range.side === "old");
  return { text, anchor: { key: row.key, side, start: cut ? start.offset : 0 } };
}

export function findHits(
  diff: FileDiff,
  rows: DiffRow[],
  query: string,
  options: SearchOptions,
): SearchResult {
  const re = compileQuery(query, options);
  const hits: SearchHit[] = [];
  if (re === null) return { hits, capped: false };
  for (let row = 0; row < rows.length; row++) {
    for (const cell of cells(diff, rows[row])) {
      for (const r of matchLine(cell.content, re)) {
        if (hits.length === SEARCH_HIT_CAP) return { hits, capped: true };
        hits.push({ row, side: cell.side, start: r.start, end: r.end });
      }
    }
  }
  return { hits, capped: false };
}

export function hitAnchor(hit: SearchHit, rows: DiffRow[]): HitAnchor {
  return { key: rows[hit.row].key, side: hit.side, start: hit.start };
}

/**
 * Index into `hits` for the current hit after a rebuild: the hit at `anchor` if one still
 * starts there, else the first hit at or after `firstVisibleRow`, else 0; null when empty.
 */
export function pickCurrent(
  hits: SearchHit[],
  rows: DiffRow[],
  anchor: HitAnchor | null,
  firstVisibleRow: number,
): number | null {
  if (hits.length === 0) return null;
  if (anchor !== null) {
    const kept = hits.findIndex(
      (h) => h.side === anchor.side && h.start === anchor.start && rows[h.row].key === anchor.key,
    );
    if (kept >= 0) return kept;
  }
  const next = hits.findIndex((h) => h.row >= firstVisibleRow);
  return next >= 0 ? next : 0;
}

/** One entry per row with hits; a split context row gets the same CellMarks object on both sides. */
export function buildMarks(
  hits: SearchHit[],
  rows: DiffRow[],
  current: number | null,
): Map<number, RowMarks> {
  const out = new Map<number, RowMarks>();
  hits.forEach((hit, i) => {
    let marks = out.get(hit.row);
    if (!marks) {
      marks = { old: null, new: null };
      out.set(hit.row, marks);
    }
    const cell = (marks[hit.side] ??= { matches: [], current: null });
    const range = { start: hit.start, end: hit.end };
    cell.matches.push(range);
    if (i === current) cell.current = range;
  });
  for (const [index, marks] of out) {
    const row = rows[index];
    if (row.kind === "split" && row.old !== null && row.old === row.new) marks.old = marks.new;
  }
  return out;
}
