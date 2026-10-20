import { EditorState } from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blockLabels,
  blocksOf,
  conflictBlocks,
  goToConflict,
  pick,
  pickAll,
  pickBlock,
  remainingConflicts,
  resetBlocks,
} from "./blocks";
import { parseConflicts, replacementFor } from "./markers";

const B1 = "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\n";
const B2 = "<<<<<<< HEAD\nm\n=======\nn\n>>>>>>> feature\n";
const ONE = `pre\n${B1}post\n`;
const TWO = `pre\n${B1}mid\n${B2}post\n`;
const DIFF3 = "pre\n<<<<<<< HEAD\nx\n||||||| base\nb\n=======\ny\n>>>>>>> feature\npost\n";

const stateOf = (doc: string) => EditorState.create({ doc, extensions: [conflictBlocks()] });

const views: EditorView[] = [];
function viewOf(doc: string): EditorView {
  const view = new EditorView({ state: stateOf(doc) });
  views.push(view);
  return view;
}
afterEach(() => {
  views.splice(0).forEach((v) => v.destroy());
});

/** Applies a pick the way `pick` does, without a view. */
function applyPick(state: EditorState, id: number, choice: "ours" | "theirs" | "both" | "restore") {
  const block = blocksOf(state).find((b) => b.id === id)!;
  const insert =
    choice === "restore"
      ? block.original
      : choice === "ours"
        ? block.ours
        : choice === "theirs"
          ? block.theirs
          : block.ours + block.theirs;
  return state.update({
    changes: { from: block.from, to: block.to, insert },
    effects: pickBlock.of({ id, choice }),
  }).state;
}

/** Line number -> css classes added by the block decorations. */
function lineClasses(state: EditorState): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue;
    source.between(0, state.doc.length, (from, _to, value) => {
      const cls = (value.spec as { class?: string }).class;
      if (!cls) return;
      const n = state.doc.lineAt(from).number;
      out.set(n, [...(out.get(n) ?? []), cls]);
    });
  }
  return out;
}

// Contract: every parsed block is tracked as unresolved and remembers its original marker text.
describe("block tracking", () => {
  it("should track every parsed block as unresolved with its original text", () => {
    const blocks = blocksOf(stateOf(TWO));
    expect(blocks.map((b) => [b.id, b.state, b.original])).toEqual([
      [0, "unresolved", B1],
      [1, "unresolved", B2],
    ]);
  });
  it("should track nothing in a document without markers", () => {
    expect(blocksOf(stateOf("plain\n"))).toEqual([]);
  });
});

// Contract: a pick replaces the block with the chosen text and records the state.
describe("picking a block", () => {
  it("should replace the block and set the state for ours", () => {
    const state = applyPick(stateOf(ONE), 0, "ours");
    expect([state.doc.toString(), blocksOf(state)[0].state]).toEqual(["pre\nx\npost\n", "ours"]);
  });
  it("should replace the block and set the state for theirs", () => {
    const state = applyPick(stateOf(ONE), 0, "theirs");
    expect([state.doc.toString(), blocksOf(state)[0].state]).toEqual(["pre\ny\npost\n", "theirs"]);
  });
  it("should replace the block and set the state for both", () => {
    const state = applyPick(stateOf(ONE), 0, "both");
    expect([state.doc.toString(), blocksOf(state)[0].state]).toEqual(["pre\nx\ny\npost\n", "both"]);
  });
  it("should write the original text back and set unresolved on restore", () => {
    const state = applyPick(applyPick(stateOf(ONE), 0, "ours"), 0, "restore");
    expect([state.doc.toString(), blocksOf(state)[0].state]).toEqual([ONE, "unresolved"]);
  });
  it("should not make its own block custom", () => {
    const state = applyPick(stateOf(ONE), 0, "ours");
    expect(blocksOf(state)[0].state).not.toBe("custom");
  });
  it("should leave other blocks untouched and shift them", () => {
    const state = applyPick(stateOf(TWO), 0, "ours");
    const second = blocksOf(state)[1];
    expect([second.state, state.doc.sliceString(second.from, second.to)]).toEqual([
      "unresolved",
      B2,
    ]);
  });
});

// Contract: block ranges follow the document and a hand edit inside a block marks it custom.
describe("editing around blocks", () => {
  it("should map block ranges through edits before the block", () => {
    const state = stateOf(ONE).update({ changes: { from: 0, insert: "zz" } }).state;
    const block = blocksOf(state)[0];
    expect(state.doc.sliceString(block.from, block.to)).toBe(B1);
  });
  it("should make a typed change inside a block custom", () => {
    const at = ONE.indexOf("x\n");
    const state = stateOf(ONE).update({ changes: { from: at, insert: "typed " } }).state;
    expect(blocksOf(state)[0].state).toBe("custom");
  });
  it("should not make an insertion at the block start custom", () => {
    const at = ONE.indexOf("<<<<<<<");
    const state = stateOf(ONE).update({ changes: { from: at, insert: "above\n" } }).state;
    expect(blocksOf(state)[0].state).toBe("unresolved");
  });
  it("should not make an insertion at the block end custom", () => {
    const at = ONE.indexOf("post");
    const state = stateOf(ONE).update({ changes: { from: at, insert: "below\n" } }).state;
    expect(blocksOf(state)[0].state).toBe("unresolved");
  });
  it("should keep text typed exactly at the block start outside the block", () => {
    const at = ONE.indexOf("<<<<<<<");
    const state = stateOf(ONE).update({ changes: { from: at, insert: "above\n" } }).state;
    const block = blocksOf(state)[0];
    expect(state.doc.sliceString(block.from, block.to)).toBe(B1);
  });
  it("should keep text typed exactly at the block end outside the block", () => {
    const at = ONE.indexOf("post");
    const state = stateOf(ONE).update({ changes: { from: at, insert: "below\n" } }).state;
    const block = blocksOf(state)[0];
    expect(state.doc.sliceString(block.from, block.to)).toBe(B1);
  });
  it("should keep text typed at the block start after a later pick", () => {
    const at = ONE.indexOf("<<<<<<<");
    const typed = stateOf(ONE).update({ changes: { from: at, insert: "above\n" } }).state;
    expect(applyPick(typed, 0, "ours").doc.toString()).toBe("pre\nabove\nx\npost\n");
  });
  it("should keep text typed at the block end after a later pick", () => {
    const at = ONE.indexOf("post");
    const typed = stateOf(ONE).update({ changes: { from: at, insert: "below\n" } }).state;
    expect(applyPick(typed, 0, "ours").doc.toString()).toBe("pre\nx\nbelow\npost\n");
  });
  it("should cover exactly the inserted text for a picked block", () => {
    const state = applyPick(stateOf(ONE), 0, "ours");
    const block = blocksOf(state)[0];
    const expected = replacementFor(parseConflicts(ONE)[0], "ours");
    expect(state.doc.sliceString(block.from, block.to)).toBe(expected);
  });
  it("should cover exactly the original text after a restore", () => {
    const state = applyPick(applyPick(stateOf(ONE), 0, "ours"), 0, "restore");
    const block = blocksOf(state)[0];
    expect(state.doc.sliceString(block.from, block.to)).toBe(block.original);
  });
  it("should not invert an empty resolved block when text is typed at its point", () => {
    const empty = "<<<<<<< a\n=======\ny\n>>>>>>> b\n";
    const picked = applyPick(stateOf(empty), 0, "ours");
    const state = picked.update({ changes: { from: 0, insert: "t" } }).state;
    const block = blocksOf(state)[0];
    expect(block.to).toBeGreaterThanOrEqual(block.from);
  });
  it("should replace tracking from new text on resetBlocks", () => {
    const state = stateOf(ONE).update({
      changes: { from: 0, to: ONE.length, insert: TWO },
      effects: resetBlocks.of(TWO),
    }).state;
    expect(blocksOf(state).map((b) => [b.id, b.state])).toEqual([
      [0, "unresolved"],
      [1, "unresolved"],
    ]);
  });
});

// Contract: remaining conflicts always come from re-parsing the document, not from block states.
describe("remainingConflicts", () => {
  it("should count every marker block in a fresh document", () => {
    expect(remainingConflicts(stateOf(TWO))).toBe(2);
  });
  it("should drop to one after one of two blocks is picked", () => {
    expect(remainingConflicts(applyPick(stateOf(TWO), 0, "ours"))).toBe(1);
  });
  it("should be zero after a custom edit deletes the markers", () => {
    const state = stateOf(ONE).update({
      changes: { from: 0, to: ONE.length, insert: "done\n" },
    }).state;
    expect(remainingConflicts(state)).toBe(0);
  });
  it("should be unchanged after a custom edit that keeps the markers", () => {
    const at = ONE.indexOf("x\n");
    const state = stateOf(ONE).update({ changes: { from: at, insert: "typed " } }).state;
    expect(remainingConflicts(state)).toBe(1);
  });
});

// Contract: pick and pickAll drive the view; pickAll only resolves blocks still unresolved.
describe("pick and pickAll", () => {
  it("should replace the block through the view", () => {
    const view = viewOf(ONE);
    pick(view, 0, "theirs");
    expect(view.state.doc.toString()).toBe("pre\ny\npost\n");
  });
  it.each([
    ["ours", "x\n"],
    ["theirs", "y\n"],
    ["both", "x\ny\n"],
  ] as const)("should dispatch the %s replacement with its effect", (choice, insert) => {
    const view = viewOf(ONE);
    const spy = vi.spyOn(view, "dispatch");
    pick(view, 0, choice);
    const spec = spy.mock.calls[0][0] as {
      changes: unknown;
      effects: ReturnType<typeof pickBlock.of>;
    };
    expect([spec.changes, spec.effects.is(pickBlock), spec.effects.value]).toEqual([
      { from: ONE.indexOf("<<<<<<<"), to: ONE.indexOf("post"), insert },
      true,
      { id: 0, choice },
    ]);
  });
  it("should dispatch the original text for a restore", () => {
    const view = viewOf(ONE);
    pick(view, 0, "ours");
    const spy = vi.spyOn(view, "dispatch");
    pick(view, 0, "restore");
    const spec = spy.mock.calls[0][0] as { changes: { insert: string } };
    expect(spec.changes.insert).toBe(B1);
  });
  it("should do nothing for an unknown block id", () => {
    const view = viewOf(ONE);
    pick(view, 99, "ours");
    expect(view.state.doc.toString()).toBe(ONE);
  });
  it("should resolve only unresolved blocks in pickAll", () => {
    const view = viewOf(TWO);
    pick(view, 0, "ours");
    pickAll(view, "theirs");
    expect(view.state.doc.toString()).toBe("pre\nx\nmid\nn\npost\n");
  });
  it("should resolve every block in pickAll with the chosen side", () => {
    const view = viewOf(TWO);
    pickAll(view, "both");
    expect(view.state.doc.toString()).toBe("pre\nx\ny\nmid\nm\nn\npost\n");
  });
  it("should give each block exactly its inserted text and state after pickAll", () => {
    const view = viewOf(TWO);
    pickAll(view, "both");
    const doc = view.state.doc;
    const [a, b] = blocksOf(view.state);
    expect([a.state, b.state]).toEqual(["both", "both"]);
    expect(doc.sliceString(a.from, a.to)).toBe("x\ny\n");
    expect(doc.sliceString(b.from, b.to)).toBe("m\nn\n");
  });
  it("should map every block of a pickAll over adjacent blocks", () => {
    const adjacent = `pre\n${B1}${B2}post\n`;
    const view = viewOf(adjacent);
    pickAll(view, "theirs");
    const doc = view.state.doc;
    const [a, b] = blocksOf(view.state);
    expect([a.state, b.state]).toEqual(["theirs", "theirs"]);
    expect([doc.sliceString(a.from, a.to), doc.sliceString(b.from, b.to)]).toEqual(["y\n", "n\n"]);
    expect(doc.toString()).toBe("pre\ny\nn\npost\n");
  });
  it("should restore every adjacent block after pickAll", () => {
    const adjacent = `pre\n${B1}${B2}post\n`;
    const view = viewOf(adjacent);
    pickAll(view, "ours");
    pick(view, 0, "restore");
    pick(view, 1, "restore");
    expect(view.state.doc.toString()).toBe(adjacent);
    expect(blocksOf(view.state).map((b) => b.state)).toEqual(["unresolved", "unresolved"]);
    expect(parseConflicts(view.state.doc.toString())).toHaveLength(2);
  });
  it("should restore each block of a spaced pickAll in turn", () => {
    const view = viewOf(TWO);
    pickAll(view, "both");
    pick(view, 1, "restore");
    pick(view, 0, "restore");
    expect(view.state.doc.toString()).toBe(TWO);
  });
  it("should keep a custom block's range and state across pickAll of the others", () => {
    const view = viewOf(TWO);
    const at = TWO.indexOf("m\n");
    view.dispatch({ changes: { from: at, insert: "typed " } });
    pickAll(view, "ours");
    const [a, b] = blocksOf(view.state);
    expect([a.state, b.state]).toEqual(["ours", "custom"]);
    expect(view.state.doc.sliceString(b.from, b.to)).toBe(
      "<<<<<<< HEAD\ntyped m\n=======\nn\n>>>>>>> feature\n",
    );
  });
  it("should not add a newline when a pick resolves a block that ends the file", () => {
    const view = viewOf("<<<<<<< a\nx\n=======\ny\n>>>>>>> b");
    pick(view, 0, "ours");
    expect(view.state.doc.toString()).toBe("x");
  });
  it("should not dispatch from pickAll when every block is already resolved", () => {
    const view = viewOf(TWO);
    pickAll(view, "ours");
    const before = view.state;
    pickAll(view, "theirs");
    expect(view.state).toBe(before);
  });
  it("should not dispatch from pickAll when nothing is unresolved", () => {
    const view = viewOf("plain\n");
    const before = view.state;
    pickAll(view, "ours");
    expect(view.state).toBe(before);
  });
});

// Contract: goToConflict moves the cursor to the next/previous block start, wrapping around.
describe("goToConflict", () => {
  const starts = (doc: string) => [doc.indexOf("<<<<<<< HEAD\nx"), doc.indexOf("<<<<<<< HEAD\nm")];

  it("should go forward to the next block", () => {
    const view = viewOf(TWO);
    view.dispatch({ selection: { anchor: starts(TWO)[0] } });
    goToConflict(view, 1);
    expect(view.state.selection.main.head).toBe(starts(TWO)[1]);
  });
  it("should wrap forward past the last block to the first", () => {
    const view = viewOf(TWO);
    view.dispatch({ selection: { anchor: starts(TWO)[1] } });
    goToConflict(view, 1);
    expect(view.state.selection.main.head).toBe(starts(TWO)[0]);
  });
  it("should go backward to the previous block", () => {
    const view = viewOf(TWO);
    view.dispatch({ selection: { anchor: starts(TWO)[1] } });
    goToConflict(view, -1);
    expect(view.state.selection.main.head).toBe(starts(TWO)[0]);
  });
  it("should wrap backward before the first block to the last", () => {
    const view = viewOf(TWO);
    view.dispatch({ selection: { anchor: 0 } });
    goToConflict(view, -1);
    expect(view.state.selection.main.head).toBe(starts(TWO)[1]);
  });
  it("should go forward from inside a block to the next block, not the current one", () => {
    const view = viewOf(TWO);
    view.dispatch({ selection: { anchor: starts(TWO)[0] + 5 } });
    goToConflict(view, 1);
    expect(view.state.selection.main.head).toBe(starts(TWO)[1]);
  });
  it("should go backward from inside a block to that block's own start", () => {
    const view = viewOf(TWO);
    view.dispatch({ selection: { anchor: starts(TWO)[1] + 5 } });
    goToConflict(view, -1);
    expect(view.state.selection.main.head).toBe(starts(TWO)[1]);
  });
  it("should stay on the only block when going either way from its start", () => {
    const view = viewOf(ONE);
    const start = ONE.indexOf("<<<<<<<");
    view.dispatch({ selection: { anchor: start } });
    goToConflict(view, 1);
    expect(view.state.selection.main.head).toBe(start);
    goToConflict(view, -1);
    expect(view.state.selection.main.head).toBe(start);
  });
  it("should leave the selection alone when there are no conflicts", () => {
    const view = viewOf("plain\ntext\n");
    view.dispatch({ selection: { anchor: 3 } });
    goToConflict(view, 1);
    expect(view.state.selection.main.head).toBe(3);
  });
  it("should return true when it moved", () => {
    expect(goToConflict(viewOf(TWO), 1)).toBe(true);
  });
  it("should return false when there are no conflicts", () => {
    expect(goToConflict(viewOf("plain\n"), 1)).toBe(false);
  });
});

// Contract: unresolved blocks are tinted per region, resolved blocks get the resolved tint.
describe("decorations", () => {
  it("should tint marker, ours, base and theirs lines of an unresolved block", () => {
    const classes = lineClasses(stateOf(DIFF3));
    expect([2, 3, 4, 5, 6, 7, 8].map((n) => classes.get(n))).toEqual([
      ["cm-conflict-marker"],
      ["cm-conflict-ours"],
      ["cm-conflict-marker"],
      ["cm-conflict-base"],
      ["cm-conflict-marker"],
      ["cm-conflict-theirs"],
      ["cm-conflict-marker"],
    ]);
  });
  it("should not tint lines outside the block", () => {
    const classes = lineClasses(stateOf(DIFF3));
    expect([classes.get(1), classes.get(9)]).toEqual([undefined, undefined]);
  });
  it("should tint a resolved block", () => {
    const classes = lineClasses(applyPick(stateOf(ONE), 0, "ours"));
    expect(classes.get(2)).toEqual(["cm-conflict-resolved"]);
  });
  it("should not tint a custom block", () => {
    const at = ONE.indexOf("x\n");
    const state = stateOf(ONE).update({ changes: { from: at, insert: "typed " } }).state;
    expect([...lineClasses(state).values()].flat()).toEqual([]);
  });
});

/** Every widget decoration in document order, with its position and spec. */
function widgets(state: EditorState) {
  const out: { pos: number; spec: { block?: boolean; side?: number; widget: WidgetType } }[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === "function") continue;
    source.between(0, state.doc.length, (from, _to, value) => {
      const spec = value.spec as { block?: boolean; side?: number; widget?: WidgetType };
      if (spec.widget) out.push({ pos: from, spec: spec as never });
    });
  }
  return out;
}
const barOf = (w: { spec: { widget: WidgetType } }, view: EditorView) =>
  w.spec.widget.toDOM(view) as HTMLElement;

// Contract: every block, whatever its state, has one block-level bar widget before its first line.
describe("action bar widgets", () => {
  it("should emit one bar per block at the block start", () => {
    const state = stateOf(TWO);
    expect(widgets(state).map((w) => w.pos)).toEqual(blocksOf(state).map((b) => b.from));
  });
  it("should make each bar a block widget placed before the position", () => {
    for (const w of widgets(stateOf(TWO))) {
      expect([w.spec.block, w.spec.side]).toEqual([true, -1]);
    }
  });
  it("should number the bars from 1 in document order", () => {
    const view = viewOf(TWO);
    const names = widgets(view.state).map((w) => barOf(w, view).getAttribute("aria-label"));
    expect(names).toEqual(["Conflict 1", "Conflict 2"]);
  });
  it("should pass the facet labels to every bar", () => {
    const state = EditorState.create({
      doc: TWO,
      extensions: [conflictBlocks(), blockLabels.of({ ours: "mine", theirs: "yours" })],
    });
    const view = viewOf("");
    for (const w of widgets(state)) {
      const text = [...barOf(w, view).querySelectorAll("button")].map((b) => b.textContent);
      expect(text).toEqual(["Keep mine", "Take yours", "Keep both"]);
    }
  });
  it("should keep a bar for a resolved block, showing its state", () => {
    const state = applyPick(stateOf(TWO), 0, "ours");
    const view = viewOf("");
    const [first] = widgets(state);
    expect(first.pos).toBe(blocksOf(state)[0].from);
    expect(barOf(first, view).textContent).toContain("Kept ours");
    expect(widgets(state)).toHaveLength(2);
  });
  it("should keep a bar for a custom block, showing Edited", () => {
    const at = ONE.indexOf("x\n");
    const state = stateOf(ONE).update({ changes: { from: at, insert: "typed " } }).state;
    const view = viewOf("");
    const all = widgets(state);
    expect(all).toHaveLength(1);
    expect(barOf(all[0], view).textContent).toContain("Edited");
  });
  it("should emit no bar for a document without conflicts", () => {
    expect(widgets(stateOf("plain\n"))).toEqual([]);
  });
  it("should sort a bar before the line decoration at the same position", () => {
    const state = stateOf(ONE);
    const at = blocksOf(state)[0].from;
    const order: string[] = [];
    for (const source of state.facet(EditorView.decorations)) {
      if (typeof source === "function") continue;
      source.between(at, at, (from, _to, value) => {
        if (from === at) order.push((value.spec as { widget?: unknown }).widget ? "bar" : "line");
      });
    }
    expect(order).toEqual(["bar", "line"]);
  });
});

// Contract: labels default to "ours" / "theirs" and can be supplied through the facet.
describe("blockLabels", () => {
  it("should default to ours and theirs", () => {
    expect(stateOf(ONE).facet(blockLabels)).toEqual({ ours: "ours", theirs: "theirs" });
  });
  it("should use the supplied labels", () => {
    const state = EditorState.create({
      doc: ONE,
      extensions: [conflictBlocks(), blockLabels.of({ ours: "main", theirs: "feature" })],
    });
    expect(state.facet(blockLabels)).toEqual({ ours: "main", theirs: "feature" });
  });
});
