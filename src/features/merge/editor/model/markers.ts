export interface ConflictBlock {
  from: number;
  to: number;
  ours: string;
  base: string | null;
  theirs: string;
  oursLabel: string;
  theirsLabel: string;
  trailingNewline: boolean;
}
export type Choice = "ours" | "theirs" | "both";

type Marker = "<" | "|" | "=" | ">";

/** Exactly seven of one marker character, then a space and a label, or the end of the line. */
const MARKER_LINE = /^([<|=>])\1{6}(?: (.*))?$/;

/** The marker kind and label of a line, or null for an ordinary line. */
function markerOf(line: string): { kind: Marker; label: string } | null {
  const m = MARKER_LINE.exec(line);
  return m ? { kind: m[1] as Marker, label: m[2] ?? "" } : null;
}

interface Line {
  text: string;
  from: number;
  to: number;
  newline: boolean;
}

/** The lines of `text` with their offsets; no empty line follows a final "\n". */
function lines(text: string): Line[] {
  const out: Line[] = [];
  let from = 0;
  for (;;) {
    const nl = text.indexOf("\n", from);
    if (nl === -1) {
      if (from < text.length || out.length === 0) {
        out.push({ text: text.slice(from), from, to: text.length, newline: false });
      }
      return out;
    }
    out.push({ text: text.slice(from, nl), from, to: nl + 1, newline: true });
    from = nl + 1;
  }
}

const join = (ls: Line[]) => ls.map((l) => l.text + "\n").join("");

/** Git's conflict blocks in document order; malformed markers are plain text. */
export function parseConflicts(text: string): ConflictBlock[] {
  const ls = lines(text);
  const blocks: ConflictBlock[] = [];
  let start = -1;
  let startLabel = "";
  let bar = -1;
  let eq = -1;
  ls.forEach((line, i) => {
    const m = markerOf(line.text);
    if (!m) return;
    if (m.kind === "<") {
      start = i;
      startLabel = m.label;
      bar = -1;
      eq = -1;
    } else if (start === -1) {
      return;
    } else if (m.kind === "|") {
      if (eq === -1) bar = i;
    } else if (m.kind === "=") {
      if (eq === -1) eq = i;
    } else if (eq !== -1) {
      blocks.push({
        from: ls[start].from,
        to: line.to,
        ours: join(ls.slice(start + 1, bar === -1 ? eq : bar)),
        base: bar === -1 ? null : join(ls.slice(bar + 1, eq)),
        theirs: join(ls.slice(eq + 1, i)),
        oursLabel: startLabel,
        theirsLabel: m.label,
        trailingNewline: line.newline,
      });
      start = -1;
    }
  });
  return blocks;
}

/** The text that replaces `block` for `choice`; never adds a newline at the end of the file. */
export function replacementFor(block: ConflictBlock, choice: Choice): string {
  const text =
    choice === "ours" ? block.ours : choice === "theirs" ? block.theirs : block.ours + block.theirs;
  return block.trailingNewline || !text.endsWith("\n") ? text : text.slice(0, -1);
}
