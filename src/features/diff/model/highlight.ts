import { LanguageDescription, type LanguageSupport } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import type { Parser } from "@lezer/common";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import type { FileDiff, Hunk } from "../../../lib/ipc";

export interface Token {
  text: string;
  className: string | null;
}

/** Tokens per hunk line, keyed by hunk index. */
export type HighlightMap = Map<number, (Token[] | null)[]>;

/** Picks a grammar from the file name; null when CodeMirror has none for it. */
export function languageFor(path: string): LanguageDescription | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return LanguageDescription.matchFilename(languages, name);
}

const supports = new Map<string, Promise<LanguageSupport>>();

/** Loads a language once; later calls share the promise. A failed load is not cached. */
export function loadLanguage(desc: LanguageDescription): Promise<LanguageSupport> {
  let p = supports.get(desc.name);
  if (!p) {
    p = desc.load().catch((e: unknown) => {
      supports.delete(desc.name);
      throw e;
    });
    supports.set(desc.name, p);
  }
  return p;
}

/** A language's parser, sharing `loadLanguage`'s cache. */
export function loadParser(desc: LanguageDescription): Promise<Parser> {
  return loadLanguage(desc).then((support) => support.language.parser);
}

/** Parses `text` once and splits the highlighted spans into per-line tokens. */
export function tokenize(text: string, parser: Parser): Token[][] {
  const tree = parser.parse(text);
  const lines: Token[][] = text.split("\n").map(() => []);
  const starts: number[] = [];
  let acc = 0;
  for (const line of text.split("\n")) {
    starts.push(acc);
    acc += line.length + 1;
  }
  let lineNo = 0;
  let pos = 0;
  const emit = (from: number, to: number, className: string | null) => {
    while (from < to) {
      while (lineNo + 1 < starts.length && from >= starts[lineNo + 1]) lineNo++;
      const lineEnd = lineNo + 1 < starts.length ? starts[lineNo + 1] - 1 : text.length;
      const end = Math.min(to, lineEnd);
      if (end > from) lines[lineNo].push({ text: text.slice(from, end), className });
      from = end < to ? end + 1 : end; // skip the newline
    }
  };
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (from > pos) emit(pos, from, null);
    emit(from, to, classes);
    pos = to;
  });
  if (pos < text.length) emit(pos, text.length, null);
  return lines;
}

/** One side of a hunk as a single text, with the hunk line index of each text line. */
export function sideText(hunk: Hunk, side: "old" | "new"): { text: string; lineIndices: number[] } {
  const skip = side === "old" ? "addition" : "deletion";
  const lineIndices: number[] = [];
  const parts: string[] = [];
  hunk.lines.forEach((line, i) => {
    if (line.kind === skip) return;
    lineIndices.push(i);
    parts.push(line.content);
  });
  return { text: parts.join("\n"), lineIndices };
}

/** Tokens for every hunk line; context lines take the new side's tokens. */
export function highlightHunk(hunk: Hunk, parser: Parser): (Token[] | null)[] {
  const out: (Token[] | null)[] = hunk.lines.map(() => null);
  for (const side of ["old", "new"] as const) {
    const { text, lineIndices } = sideText(hunk, side);
    const lines = tokenize(text, parser);
    lineIndices.forEach((lineIndex, k) => {
      // DiffLine.content never contains "\n" (the backend strips line endings),
      // so `lines` has exactly one entry per index in `lineIndices`.
      out[lineIndex] = lines[k];
    });
  }
  return out;
}

/** Highlights every hunk of a diff with one parser. */
export function highlightDiff(diff: FileDiff, parser: Parser): HighlightMap {
  const map: HighlightMap = new Map();
  diff.hunks.forEach((hunk, i) => map.set(i, highlightHunk(hunk, parser)));
  return map;
}

/** Tokens for each line of a whole file, parsed as one text so constructs span lines. */
export function highlightText(lines: string[], parser: Parser): (Token[] | null)[] {
  // tokenize("") yields one empty line; keep one entry per input line.
  if (lines.length === 0) return [];
  return tokenize(lines.join("\n"), parser);
}
