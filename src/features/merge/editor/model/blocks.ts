import { EditorState, Facet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { BlockBarWidget } from "./blockBar";
import { parseConflicts, replacementFor, type Choice, type ConflictBlock } from "./markers";

export type BlockState = "unresolved" | "ours" | "theirs" | "both" | "custom";
export interface TrackedBlock extends ConflictBlock {
  id: number;
  state: BlockState;
  original: string;
}
export interface BlockLabels {
  ours: string;
  theirs: string;
}

export const pickBlock = StateEffect.define<{ id: number; choice: Choice | "restore" }>();
export const resetBlocks = StateEffect.define<string>();
export const blockLabels = Facet.define<BlockLabels, BlockLabels>({
  combine: (values) => values[0] ?? { ours: "ours", theirs: "theirs" },
});

const track = (text: string): TrackedBlock[] =>
  parseConflicts(text).map((b, id) => ({
    ...b,
    id,
    state: "unresolved",
    original: text.slice(b.from, b.to),
  }));

/** The text a pick writes over its block. */
const insertFor = (block: TrackedBlock, choice: Choice | "restore"): string =>
  choice === "restore" ? block.original : replacementFor(block, choice);

const field = StateField.define<TrackedBlock[]>({
  create: (state) => track(state.doc.toString()),
  update(blocks, tr) {
    for (const e of tr.effects) if (e.is(resetBlocks)) return track(e.value);
    const picked = new Map(
      tr.effects.filter((e) => e.is(pickBlock)).map((e) => [e.value.id, e.value.choice]),
    );
    if (!tr.docChanged && picked.size === 0) return blocks;
    return blocks.map((b): TrackedBlock => {
      const choice = picked.get(b.id);
      if (choice !== undefined) {
        // The pick replaced [from, to) wholesale: the block is exactly the inserted text.
        const from = tr.changes.mapPos(b.from, -1);
        const to = from + insertFor(b, choice).length;
        return { ...b, from, to, state: choice === "restore" ? "unresolved" : choice };
      }
      let touched = false;
      tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA < b.to && toA > b.from) touched = true;
      });
      // Text inserted exactly at either boundary stays outside the block.
      const from = tr.changes.mapPos(b.from, 1);
      const to = Math.max(from, tr.changes.mapPos(b.to, -1));
      return { ...b, from, to, state: touched ? "custom" : b.state };
    });
  },
});

export const blocksOf = (state: EditorState): TrackedBlock[] => state.field(field);

/** Conflicts left in the document, counted by re-parsing it. */
export const remainingConflicts = (state: EditorState): number =>
  parseConflicts(state.doc.toString()).length;

const line = (cls: string) => Decoration.line({ class: cls });
const MARKER = line("cm-conflict-marker");
const OURS = line("cm-conflict-ours");
const BASE = line("cm-conflict-base");
const THEIRS = line("cm-conflict-theirs");
const RESOLVED = line("cm-conflict-resolved");

/** Newline-terminated lines in one side of a block. */
const countLines = (s: string) => s.split("\n").length - 1;
const repeat = (deco: Decoration, n: number) => Array<Decoration>(n).fill(deco);

function decorate(state: EditorState): DecorationSet {
  const labels = state.facet(blockLabels);
  const ranges: ReturnType<Decoration["range"]>[] = [];
  blocksOf(state).forEach((b, i) => {
    ranges.push(
      Decoration.widget({
        widget: new BlockBarWidget(b, i + 1, labels, pick),
        block: true,
        side: -1,
      }).range(b.from),
    );
    if (b.state === "custom" || b.from === b.to) return;
    const first = state.doc.lineAt(b.from).number;
    if (b.state !== "unresolved") {
      const last = state.doc.lineAt(b.to - 1).number;
      for (let n = first; n <= last; n++) ranges.push(RESOLVED.range(state.doc.line(n).from));
      return;
    }
    // An unresolved block's text is still its original markers, so the line plan matches it exactly.
    const plan = [MARKER, ...repeat(OURS, countLines(b.ours))];
    if (b.base !== null) plan.push(MARKER, ...repeat(BASE, countLines(b.base)));
    plan.push(MARKER, ...repeat(THEIRS, countLines(b.theirs)), MARKER);
    plan.forEach((deco, k) => ranges.push(deco.range(state.doc.line(first + k).from)));
  });
  return Decoration.set(ranges, true);
}

const theme = EditorView.baseTheme({
  ".cm-conflict-marker": {
    background: "var(--color-surface-hover)",
    color: "var(--color-text-muted)",
    fontWeight: "600",
  },
  ".cm-conflict-ours": { background: "var(--color-hunk-bg)" },
  ".cm-conflict-base": {
    background: "var(--color-surface-hover)",
    color: "var(--color-text-muted)",
    opacity: "0.7",
  },
  ".cm-conflict-theirs": { background: "var(--color-added-bg)" },
  ".cm-conflict-resolved": { background: "var(--color-surface)" },
  ".cm-conflict-bar": {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.125rem 0.5rem",
    background: "var(--color-surface)",
    borderBlock: "1px solid var(--color-border)",
    color: "var(--color-text-muted)",
    // The global body font (styles/global.css), not the editor's monospace.
    fontFamily: "Inter, Avenir, Helvetica, Arial, sans-serif",
  },
  ".cm-conflict-bar button": {
    color: "var(--color-accent)",
    background: "none",
    border: "1px solid var(--color-border)",
    borderRadius: "4px",
    padding: "0 0.5rem",
    font: "inherit",
    cursor: "pointer",
  },
  ".cm-conflict-bar button:hover": { background: "var(--color-surface-hover)" },
});

/** Conflict block tracking, its line tints and action bars, and their base theme. */
export function conflictBlocks(): Extension {
  return [field, EditorView.decorations.compute([field, blockLabels], decorate), theme];
}

/** Replaces block `id` with `choice` (or its original markers for "restore") in one transaction. */
export function pick(view: EditorView, id: number, choice: Choice | "restore"): void {
  const block = blocksOf(view.state).find((b) => b.id === id);
  if (!block) return;
  view.dispatch({
    changes: { from: block.from, to: block.to, insert: insertFor(block, choice) },
    effects: pickBlock.of({ id, choice }),
  });
  view.focus();
}

/** Resolves every still-unresolved block with `choice` in one transaction. */
export function pickAll(view: EditorView, choice: Choice): void {
  const open = blocksOf(view.state).filter((b) => b.state === "unresolved");
  if (open.length === 0) return;
  view.dispatch({
    changes: open.map((b) => ({ from: b.from, to: b.to, insert: replacementFor(b, choice) })),
    effects: open.map((b) => pickBlock.of({ id: b.id, choice })),
  });
}

/** Moves the cursor to the next (1) or previous (-1) conflict, wrapping; false when there are none. */
export function goToConflict(view: EditorView, dir: 1 | -1): boolean {
  const blocks = parseConflicts(view.state.doc.toString());
  if (blocks.length === 0) return false;
  const head = view.state.selection.main.head;
  const after = blocks.filter((b) => b.from > head);
  const before = blocks.filter((b) => b.from < head);
  const target =
    dir === 1 ? (after[0] ?? blocks[0]) : (before[before.length - 1] ?? blocks[blocks.length - 1]);
  view.dispatch({
    selection: { anchor: target.from },
    effects: EditorView.scrollIntoView(target.from, { y: "start" }),
  });
  return true;
}
