import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { BlockBarWidget } from "./blockBar";
import { blocksOf, conflictBlocks, type TrackedBlock } from "./blocks";

const DOC = "pre\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\npost\n";
const LABELS = { ours: "main", theirs: "feature" };

function setup(state: TrackedBlock["state"] = "unresolved") {
  const editor = EditorState.create({ doc: DOC, extensions: [conflictBlocks()] });
  const block: TrackedBlock = { ...blocksOf(editor)[0], state };
  const onPick = vi.fn();
  const view = { state: editor } as unknown as EditorView;
  return { block, view, onPick };
}

const render = (block: TrackedBlock, view: EditorView, index = 2, onPick = vi.fn()) =>
  new BlockBarWidget(block, index, LABELS, onPick).toDOM(view);
const labels = (el: HTMLElement) => [...el.querySelectorAll("button")].map((b) => b.textContent);

// Contract: an unresolved block offers three choices inside an accessibly named group.
describe("BlockBarWidget unresolved", () => {
  it("should render a group named for its conflict number", () => {
    const { block, view } = setup();
    const el = render(block, view, 2);
    expect([el.getAttribute("role"), el.getAttribute("aria-label")]).toEqual([
      "group",
      "Conflict 2",
    ]);
  });
  it("should render three buttons for an unresolved block", () => {
    const { block, view } = setup();
    expect(labels(render(block, view))).toEqual(["Keep main", "Take feature", "Keep both"]);
  });
  it("should carry the cm-conflict-bar class", () => {
    const { block, view } = setup();
    expect(render(block, view).classList.contains("cm-conflict-bar")).toBe(true);
  });
});

// Contract: a resolved block shows what happened and an Undo button.
describe("BlockBarWidget resolved", () => {
  it.each([
    ["ours", "Kept main"],
    ["theirs", "Took feature"],
    ["both", "Kept both"],
    ["custom", "Edited"],
  ] as const)("should render the %s state as %s", (state, text) => {
    const { block, view } = setup(state);
    expect(render(block, view).textContent).toContain(text);
  });
  it.each(["ours", "theirs", "both", "custom"] as const)(
    "should render only an Undo button for %s",
    (state) => {
      const { block, view } = setup(state);
      expect(labels(render(block, view))).toEqual(["Undo"]);
    },
  );
});

// Contract: eq lets CodeMirror reuse the DOM only when nothing visible changed.
describe("BlockBarWidget eq", () => {
  const { block } = setup();
  const widget = (b: TrackedBlock, index = 2, l = LABELS) =>
    new BlockBarWidget(b, index, l, vi.fn());

  it("should be true for the same id, state, index and labels", () => {
    expect(widget(block).eq(widget({ ...block }))).toBe(true);
  });
  it.each([
    ["id", widget({ ...block, id: 9 })],
    ["state", widget({ ...block, state: "ours" })],
    ["index", widget(block, 3)],
    ["ours label", widget(block, 2, { ...LABELS, ours: "other" })],
    ["theirs label", widget(block, 2, { ...LABELS, theirs: "other" })],
  ])("should be false when the %s differs", (_name, other) => {
    expect(widget(block).eq(other)).toBe(false);
  });
  it("should tell CodeMirror to leave events to the buttons", () => {
    expect(widget(block).ignoreEvent()).toBe(true);
  });
});

// Contract: each button reports (view, block id, choice) to the injected onPick callback.
describe("BlockBarWidget clicks", () => {
  it.each([
    [0, "ours"],
    [1, "theirs"],
    [2, "both"],
  ] as const)("should call onPick for button %i with %s", (n, choice) => {
    const { block, view, onPick } = setup();
    render(block, view, 2, onPick).querySelectorAll("button")[n].click();
    expect(onPick).toHaveBeenCalledWith(view, block.id, choice);
  });
  it.each(["ours", "theirs", "both", "custom"] as const)(
    "should call onPick with restore when Undo is clicked for %s",
    (state) => {
      const { block, view, onPick } = setup(state);
      render(block, view, 2, onPick).querySelector("button")?.click();
      expect(onPick).toHaveBeenCalledWith(view, block.id, "restore");
    },
  );
  it("should call onPick exactly once per click", () => {
    const { block, view, onPick } = setup();
    render(block, view, 2, onPick).querySelector("button")?.click();
    expect(onPick).toHaveBeenCalledOnce();
  });
});
