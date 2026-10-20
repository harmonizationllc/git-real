import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockBarWidget, setPickHandler } from "./blockBar";
import { blocksOf, conflictBlocks, pick, pickBlock, type TrackedBlock } from "./blocks";

const DOC = "pre\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\npost\n";
const LABELS = { ours: "main", theirs: "feature" };

function setup(state: TrackedBlock["state"] = "unresolved") {
  const editor = EditorState.create({ doc: DOC, extensions: [conflictBlocks()] });
  const block: TrackedBlock = { ...blocksOf(editor)[0], state };
  const dispatch = vi.fn();
  const focus = vi.fn();
  const view = { state: editor, dispatch, focus } as unknown as EditorView;
  return { block, view, dispatch, focus };
}

const render = (block: TrackedBlock, view: EditorView, index = 2) =>
  new BlockBarWidget(block, index, LABELS).toDOM(view);
const labels = (el: HTMLElement) => [...el.querySelectorAll("button")].map((b) => b.textContent);

afterEach(() => {
  setPickHandler(pick);
});

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
  const widget = (b: TrackedBlock, index = 2, l = LABELS) => new BlockBarWidget(b, index, l);

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

// Contract: clicking a button picks that choice through the real pick handler.
describe("BlockBarWidget clicks", () => {
  it.each([
    ["Keep main", "x\n"],
    ["Take feature", "y\n"],
    ["Keep both", "x\ny\n"],
  ])("should insert the replacement when %s is clicked", (name, insert) => {
    const { block, view, dispatch } = setup();
    const button = [...render(block, view).querySelectorAll("button")].find(
      (b) => b.textContent === name,
    );
    button?.click();
    expect(dispatch.mock.calls[0][0].changes).toEqual({
      from: block.from,
      to: block.to,
      insert,
    });
  });
  it("should carry the pickBlock effect for the clicked block", () => {
    const { block, view, dispatch } = setup();
    render(block, view).querySelector("button")?.click();
    const effect = dispatch.mock.calls[0][0].effects;
    expect([effect.is(pickBlock), effect.value]).toEqual([true, { id: block.id, choice: "ours" }]);
  });
  it("should write the original text back when Undo is clicked", () => {
    const { block, view, dispatch } = setup("ours");
    render(block, view).querySelector("button")?.click();
    expect(dispatch.mock.calls[0][0].changes.insert).toBe(block.original);
  });
});

// Contract: the pick implementation is injected, so the bar can be tested with a spy.
describe("setPickHandler", () => {
  it("should route a click to the installed handler", () => {
    const { block, view } = setup();
    const spy = vi.fn();
    setPickHandler(spy);
    render(block, view).querySelectorAll("button")[1].click();
    expect(spy).toHaveBeenCalledWith(view, block.id, "theirs");
  });
  it("should route Undo to the handler as restore", () => {
    const { block, view } = setup("theirs");
    const spy = vi.fn();
    setPickHandler(spy);
    render(block, view).querySelector("button")?.click();
    expect(spy).toHaveBeenCalledWith(view, block.id, "restore");
  });
});
