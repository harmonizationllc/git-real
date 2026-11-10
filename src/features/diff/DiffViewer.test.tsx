import { useVirtualizer } from "@tanstack/react-virtual";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { createRef, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyText, type DiffMode, type FileDiff } from "../../lib/ipc";
import { fileDiff, hunk, L, threePairDiff } from "../../test/diffFixtures";
import { mockWindow, scrollToIndex } from "../../test/mockVirtualizer";
import { useSettings } from "../../lib/store/settings";
import { useToasts } from "../../lib/store/toasts";
import { declarationsOf } from "../../test/cssRules";
import type { CaretHit, CaretResolver } from "./caretResolver";
import { DiffViewer, type DiffViewerHandle } from "./DiffViewer";
import lineStyles from "./LineContent.module.css";
import type { HighlightMap } from "./model/highlight";
import { buildRows, type DiffRow } from "./model/rows";
import type { MenuTarget } from "./model/selection";

// Wrapped in a spy so tests can read the options DiffViewer hands the virtualizer.
// Copy goes through the IPC clipboard seam, the front end's one mock point.
vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  copyText: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", async () => {
  const fake = await import("../../test/mockVirtualizer");
  return { useVirtualizer: vi.fn(fake.useVirtualizer) };
});

// Hunk 0: context, deletion, addition (an edited pair). Hunk 1: lone addition, context.
const twoHunks = fileDiff([
  hunk(
    [
      L("context", "keep", 1, 1),
      L("deletion", "old text", 2, null),
      L("addition", "new text", null, 2),
    ],
    "@@ -1,2 +1,2 @@",
  ),
  hunk([L("addition", "tail", null, 10), L("context", "end", 10, 11)], "@@ -10,1 +10,2 @@"),
]);

// Unified rows: ctx0, del1 "one two three", del2 "four five six", del3 "seven eight nine",
// add4 "one two THREE", add5 "FOUR FIVE SIX", add6 "SEVEN eight NINE", ctx7.
// Split rows: ctx0, {1,4}, {2,5}, {3,6}, ctx4.
const three = threePairDiff();

// The scripted resolver answers by clientX only.
const hits = new Map<number, CaretHit>();
const resolveCaret = vi.fn<CaretResolver>((x) => hits.get(x) ?? null);

const copy = vi.mocked(copyText);

beforeEach(() => {
  hits.clear();
  resolveCaret.mockClear();
  scrollToIndex.mockClear();
  mockWindow.size = Infinity;
  mockWindow.start = 0;
  mockWindow.visibleStart = null;
  copy.mockReset();
  copy.mockResolvedValue(undefined);
});

interface Over {
  diff?: FileDiff;
  rows?: DiffRow[];
  mode?: DiffMode;
  highlight?: HighlightMap | null;
  onContextMenu?: ((target: MenuTarget, x: number, y: number) => void) | null;
  onMounted?: () => void;
  onUserScroll?: () => void;
  aside?: ReactNode;
}

function setup(over: Over = {}) {
  const diff = over.diff ?? three;
  const mode = over.mode ?? "unified";
  const rows = over.rows ?? buildRows(diff, mode);
  const onContextMenu = over.onContextMenu === null ? undefined : (over.onContextMenu ?? vi.fn());
  const ref = createRef<DiffViewerHandle>();
  const view = render(
    <DiffViewer
      ref={ref}
      diff={diff}
      rows={rows}
      mode={mode}
      highlight={over.highlight ?? null}
      onContextMenu={onContextMenu}
      onMounted={over.onMounted}
      onUserScroll={over.onUserScroll}
      resolveCaret={resolveCaret}
      aside={over.aside}
    />,
  );
  const scroll = screen.getByTestId("diff-scroll");
  const rect = {
    top: 0,
    bottom: 1000,
    left: 0,
    right: 1000,
    width: 1000,
    height: 1000,
    x: 0,
    y: 0,
  };
  scroll.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect }) as DOMRect;
  scroll.setPointerCapture = vi.fn();
  scroll.releasePointerCapture = vi.fn();
  scroll.scrollBy = vi.fn() as unknown as typeof scroll.scrollBy;
  return { ...view, ref, rows, scroll, onContextMenu };
}

/** The row element (unified row or split row) inside the virtual item for `index`. */
const rowEl = (container: HTMLElement, index: number) =>
  container.querySelector<HTMLElement>(`[data-index="${index}"]`)!.firstElementChild as HTMLElement;

/** A pointer event init; `buttons` is what is held (1 primary, 2 secondary, 0 none). */
const pointer = (button = 0, x = 0, buttons = button === 2 ? 2 : 1) => ({
  button,
  buttons,
  clientX: x,
  clientY: 50,
  pointerId: 1,
});

/** Drags from the hit scripted at x 10 to the hit scripted at x 20. */
function drag(scroll: HTMLElement, from: CaretHit, to: CaretHit) {
  hits.set(10, from);
  hits.set(20, to);
  fireEvent.pointerDown(scroll, pointer(0, 10));
  fireEvent.pointerMove(scroll, pointer(-1, 20, 1));
  fireEvent.pointerUp(scroll, pointer(0, 20, 0));
}

const kinds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-kind]")).map((e) => e.getAttribute("data-kind"));

const selectedRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-index]"))
    .filter((w) => w.querySelector("[data-selected]") !== null)
    .map((w) => Number(w.getAttribute("data-index")));

// Contract: the viewer renders exactly the rows it is given, in order, with no hunk headers.
describe("DiffViewer rows", () => {
  it("should render lines in order with no header rows in unified mode", () => {
    const { container } = setup({ diff: twoHunks });
    expect(kinds(container)).toEqual(["context", "deletion", "addition", "addition", "context"]);
  });

  it("should render side by side cells with no header rows in split mode", () => {
    const { container } = setup({ diff: twoHunks, mode: "split" });
    expect(kinds(container)).toEqual([
      "context",
      "context",
      "deletion",
      "addition",
      "empty",
      "addition",
      "context",
      "context",
    ]);
  });

  it("should not render hunk header text", () => {
    setup({ diff: twoHunks });
    expect(screen.queryByText("@@ -1,2 +1,2 @@")).toBeNull();
    expect(screen.queryByText("@@ -10,1 +10,2 @@")).toBeNull();
  });

  it("should render only the rows it is given", () => {
    const rows = buildRows(twoHunks, "unified").slice(0, 2);
    const { container } = setup({ diff: twoHunks, rows });
    expect(kinds(container)).toEqual(["context", "deletion"]);
  });

  it("should give each virtual item its row index", () => {
    const { container } = setup();
    const indices = Array.from(container.querySelectorAll("[data-index]")).map((e) =>
      e.getAttribute("data-index"),
    );
    expect(indices).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
  });

  it("should render no rows for an empty rows list", () => {
    const { container } = setup({ diff: fileDiff([]), rows: [] });
    expect(kinds(container)).toEqual([]);
  });

  it("should render every line's text", () => {
    setup({ diff: twoHunks });
    // The edited pair's words are split by word marks, so only unpaired lines are whole text nodes.
    for (const text of ["keep", "tail", "end"]) expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("should render no buttons", () => {
    setup({ diff: twoHunks });
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("should not use the row role", () => {
    setup();
    expect(screen.queryByRole("row")).toBeNull();
  });
});

// Contract: the viewer is a named region with a focusable (tabIndex -1) scroll container.
describe("DiffViewer landmarks", () => {
  it("should expose a region named Diff", () => {
    setup();
    expect(screen.getByRole("region", { name: "Diff" })).toBeInTheDocument();
  });

  it("should contain the scroll container with the diff-scroll test id", () => {
    setup();
    const region = screen.getByRole("region", { name: "Diff" });
    expect(within(region).getByTestId("diff-scroll")).toBeInTheDocument();
  });

  it("should give the scroll container tabIndex -1", () => {
    const { scroll } = setup();
    expect(scroll).toHaveAttribute("tabindex", "-1");
  });
});

// Contract: a primary-button drag on the scroll container focuses it, captures the pointer and
// tints the rows of the range; Escape or new rows clear it.
describe("DiffViewer text range", () => {
  it("should focus the scroll container on pointerdown", () => {
    const { scroll } = setup();
    hits.set(10, { row: 1, side: "old", offset: 4 });
    fireEvent.pointerDown(scroll, pointer(0, 10));
    expect(document.activeElement).toBe(scroll);
  });

  it("should capture the pointer on the scroll container", () => {
    const { scroll } = setup();
    hits.set(10, { row: 1, side: "old", offset: 4 });
    fireEvent.pointerDown(scroll, pointer(0, 10));
    expect(scroll.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("should mark the rows of the range data-selected", () => {
    const { container, scroll } = setup();
    drag(scroll, { row: 1, side: "old", offset: 4 }, { row: 3, side: "old", offset: 5 });
    expect(selectedRows(container)).toEqual([1, 2, 3]);
  });

  it("should tint the first row from its offset, the interior whole and the last to its offset", () => {
    const { container, scroll } = setup();
    drag(scroll, { row: 1, side: "old", offset: 4 }, { row: 3, side: "old", offset: 5 });
    const tinted = (i: number) =>
      Array.from(rowEl(container, i).querySelectorAll(`.${lineStyles.selected}`))
        .map((e) => e.textContent)
        .join("");
    expect(tinted(1)).toBe("two three");
    expect(tinted(2)).toBe("four five six");
    expect(tinted(3)).toBe("seven");
    expect(tinted(0)).toBe("");
    expect(tinted(4)).toBe("");
  });

  it("should tint only the cells on the range's side in split mode", () => {
    const { container, scroll } = setup({ mode: "split" });
    drag(scroll, { row: 1, side: "new", offset: 4 }, { row: 2, side: "new", offset: 4 });
    const cells = container.querySelectorAll("[data-selected]");
    expect(Array.from(cells).map((c) => c.getAttribute("data-side"))).toEqual(["new", "new"]);
  });

  it("should clear the range on Escape", () => {
    const { container, scroll } = setup();
    drag(scroll, { row: 1, side: "old", offset: 4 }, { row: 3, side: "old", offset: 5 });
    fireEvent.keyDown(scroll, { key: "Escape" });
    expect(selectedRows(container)).toEqual([]);
  });

  it("should clear the range when new rows arrive", () => {
    const { container, scroll, rerender } = setup();
    drag(scroll, { row: 1, side: "old", offset: 4 }, { row: 3, side: "old", offset: 5 });
    rerender(
      <DiffViewer
        diff={three}
        rows={buildRows(three, "unified")}
        mode="unified"
        highlight={null}
        resolveCaret={resolveCaret}
      />,
    );
    expect(selectedRows(container)).toEqual([]);
  });

  it("should select the word under a double-click", () => {
    const { container, scroll } = setup();
    hits.set(10, { row: 4, side: "new", offset: 9 });
    fireEvent.doubleClick(scroll, { button: 0, clientX: 10, clientY: 50 });
    expect(selectedRows(container)).toEqual([4]);
    const tinted = Array.from(rowEl(container, 4).querySelectorAll(`.${lineStyles.selected}`))
      .map((e) => e.textContent)
      .join("");
    expect(tinted).toBe("THREE");
  });

  it("should leave no range after a click without a drag", () => {
    const { container, scroll } = setup();
    hits.set(10, { row: 1, side: "old", offset: 4 });
    fireEvent.pointerDown(scroll, pointer(0, 10));
    fireEvent.pointerUp(scroll, pointer(0, 10, 0));
    expect(selectedRows(container)).toEqual([]);
  });

  it.each(["pointerCancel", "lostPointerCapture"] as const)(
    "should end the drag on %s and keep the range",
    (kind) => {
      const { container, scroll } = setup();
      hits.set(10, { row: 1, side: "old", offset: 4 });
      hits.set(20, { row: 2, side: "old", offset: 2 });
      hits.set(30, { row: 3, side: "old", offset: 5 });
      fireEvent.pointerDown(scroll, pointer(0, 10));
      fireEvent.pointerMove(scroll, pointer(-1, 20, 1));
      fireEvent[kind](scroll, { pointerId: 1 });
      fireEvent.pointerMove(scroll, pointer(-1, 30, 1));
      expect(selectedRows(container)).toEqual([1, 2]);
    },
  );
});

// Contract: Ctrl+C or Cmd+C with a range copies exactly the covered text and prevents the
// default; with no range the key is left alone.
describe("DiffViewer copy", () => {
  it("should copy a unified range that crosses from an addition row into a deletion row", () => {
    const { scroll } = setup();
    // side new, anchor row 4 offset 8, focus row 2 offset 4: row 2 is a deletion, so on the new
    // side it is whole like row 3; row 4 is cut at 8.
    // "four five six" + "seven eight nine" + "one two THREE".slice(0, 8).
    drag(scroll, { row: 4, side: "new", offset: 8 }, { row: 2, side: "new", offset: 4 });
    const notPrevented = fireEvent.keyDown(scroll, { key: "c", ctrlKey: true });
    expect(copy).toHaveBeenCalledExactlyOnceWith("four five six\nseven eight nine\none two ");
    expect(notPrevented).toBe(false);
  });

  it("should copy with Cmd+C", () => {
    const { scroll } = setup();
    drag(scroll, { row: 1, side: "old", offset: 4 }, { row: 3, side: "old", offset: 5 });
    const notPrevented = fireEvent.keyDown(scroll, { key: "c", metaKey: true });
    expect(copy).toHaveBeenCalledExactlyOnceWith("two three\nfour five six\nseven");
    expect(notPrevented).toBe(false);
  });

  it("should copy the old side of a split range", () => {
    const { scroll } = setup({ mode: "split" });
    drag(scroll, { row: 1, side: "old", offset: 4 }, { row: 3, side: "old", offset: 5 });
    fireEvent.keyDown(scroll, { key: "c", ctrlKey: true });
    expect(copy).toHaveBeenCalledExactlyOnceWith("two three\nfour five six\nseven");
  });

  it("should copy the new side of a split range", () => {
    const { scroll } = setup({ mode: "split" });
    drag(scroll, { row: 2, side: "new", offset: 5 }, { row: 1, side: "new", offset: 8 });
    fireEvent.keyDown(scroll, { key: "c", ctrlKey: true });
    expect(copy).toHaveBeenCalledExactlyOnceWith("THREE\nFOUR ");
  });

  it("should neither copy nor prevent the default without a range", () => {
    const { scroll } = setup();
    const notPrevented = fireEvent.keyDown(scroll, { key: "c", ctrlKey: true });
    expect(copy).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("should not copy after Escape cleared the range", () => {
    const { scroll } = setup();
    drag(scroll, { row: 1, side: "old", offset: 4 }, { row: 3, side: "old", offset: 5 });
    fireEvent.keyDown(scroll, { key: "Escape" });
    const notPrevented = fireEvent.keyDown(scroll, { key: "c", ctrlKey: true });
    expect(copy).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("should not copy on a plain c", () => {
    const { scroll } = setup();
    drag(scroll, { row: 1, side: "old", offset: 4 }, { row: 3, side: "old", offset: 5 });
    const notPrevented = fireEvent.keyDown(scroll, { key: "c" });
    expect(copy).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("should report a rejected clipboard write to console.error instead of leaving it unhandled", async () => {
    const error = new Error("denied");
    copy.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { scroll } = setup();
    drag(scroll, { row: 1, side: "old", offset: 4 }, { row: 3, side: "old", offset: 5 });
    fireEvent.keyDown(scroll, { key: "c", ctrlKey: true });
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledOnce());
    expect(consoleError.mock.calls[0]).toContain(error);
    consoleError.mockRestore();
  });

  it("should show an error toast when the clipboard write is rejected", async () => {
    useToasts.setState({ toasts: [] });
    copy.mockRejectedValue(new Error("denied"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { scroll } = setup();
    drag(scroll, { row: 1, side: "old", offset: 4 }, { row: 3, side: "old", offset: 5 });
    fireEvent.keyDown(scroll, { key: "c", ctrlKey: true });
    await vi.waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    expect(useToasts.getState().toasts[0]).toMatchObject({
      text: "Couldn't copy the diff text",
      variant: "error",
    });
    consoleError.mockRestore();
    useToasts.setState({ toasts: [] });
  });
});

// Contract: a right-click reports the range when one exists, else the row under the pointer, with
// the pointer coordinates, and prevents the default; without onContextMenu it opens nothing but
// still prevents the default.
describe("DiffViewer context menu", () => {
  it("should report the row under the pointer when there is no range", () => {
    const { container, onContextMenu } = setup();
    const notPrevented = fireEvent.contextMenu(rowEl(container, 2), { clientX: 30, clientY: 40 });
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith({ kind: "row", row: 2 }, 30, 40);
    expect(notPrevented).toBe(false);
  });

  it("should report the row when the right-click lands on the line text", () => {
    const { container, onContextMenu } = setup();
    const code = rowEl(container, 5).querySelector("code")!;
    fireEvent.contextMenu(code, { clientX: 31, clientY: 41 });
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith({ kind: "row", row: 5 }, 31, 41);
  });

  it("should report a split row by its index", () => {
    const { container, onContextMenu } = setup({ mode: "split" });
    fireEvent.contextMenu(rowEl(container, 3), { clientX: 5, clientY: 6 });
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith({ kind: "row", row: 3 }, 5, 6);
  });

  it("should report the range when one exists, after the right button's pointerdown", () => {
    const { container, scroll, onContextMenu } = setup();
    drag(scroll, { row: 4, side: "new", offset: 8 }, { row: 2, side: "new", offset: 4 });
    hits.set(30, { row: 6, side: "new", offset: 1 });
    fireEvent.pointerDown(scroll, pointer(2, 30));
    const notPrevented = fireEvent.contextMenu(rowEl(container, 6), { clientX: 30, clientY: 50 });
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(
      {
        kind: "range",
        range: { side: "new", anchor: { row: 4, offset: 8 }, focus: { row: 2, offset: 4 } },
      },
      30,
      50,
    );
    expect(notPrevented).toBe(false);
  });

  it("should not report anything for a right-click outside every row without a range", () => {
    const { scroll, onContextMenu } = setup();
    fireEvent.contextMenu(scroll, { clientX: 1, clientY: 2 });
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it("should prevent the default without onContextMenu, opening nothing", () => {
    const { container } = setup({ onContextMenu: null });
    const notPrevented = fireEvent.contextMenu(rowEl(container, 2), { clientX: 30, clientY: 40 });
    expect(notPrevented).toBe(false);
  });

  it("should prevent the default without onContextMenu even with a range", () => {
    const { container, scroll } = setup({ onContextMenu: null });
    drag(scroll, { row: 1, side: "old", offset: 4 }, { row: 3, side: "old", offset: 5 });
    const notPrevented = fireEvent.contextMenu(rowEl(container, 2), { clientX: 30, clientY: 40 });
    expect(notPrevented).toBe(false);
  });
});

// Contract: the ref handle scrolls a row to the top and reports the first visible row.
describe("DiffViewer handle", () => {
  it("should scroll a row to the start on scrollToRow", () => {
    const { ref } = setup();
    ref.current!.scrollToRow(7);
    expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith(7, { align: "start" });
  });

  it("should report the virtualizer's first visible row", () => {
    mockWindow.visibleStart = 5;
    const { ref } = setup();
    expect(ref.current!.firstVisibleRow()).toBe(5);
  });

  it("should report row 0 when the list is at the top", () => {
    const { ref } = setup();
    expect(ref.current!.firstVisibleRow()).toBe(0);
  });

  it("should report row 0 when nothing is rendered", () => {
    const { ref } = setup({ diff: fileDiff([]), rows: [] });
    expect(ref.current!.firstVisibleRow()).toBe(0);
  });
});

// Contract: a scroll event is reported through onUserScroll only while a user gesture (wheel,
// pointerdown or keydown on the container) has happened since the last programmatic scroll.
// A gesture arms the intent, scrollToRow disarms it; the virtualizer's own position corrections
// after a jump are bare scroll events and are never reported.
describe("DiffViewer onUserScroll", () => {
  const wheel = (el: HTMLElement) => fireEvent.wheel(el, { deltaY: 100 });

  it("should not report bare scroll events after scrollToRow", () => {
    const onUserScroll = vi.fn();
    const { ref, scroll } = setup({ onUserScroll });
    ref.current!.scrollToRow(7);
    fireEvent.scroll(scroll);
    fireEvent.scroll(scroll);
    fireEvent.scroll(scroll);
    expect(onUserScroll).not.toHaveBeenCalled();
  });

  it("should not report a bare scroll when no gesture ever happened", () => {
    const onUserScroll = vi.fn();
    const { scroll } = setup({ onUserScroll });
    fireEvent.scroll(scroll);
    expect(onUserScroll).not.toHaveBeenCalled();
  });

  it("should report a scroll after a wheel once", () => {
    const onUserScroll = vi.fn();
    const { scroll } = setup({ onUserScroll });
    wheel(scroll);
    fireEvent.scroll(scroll);
    expect(onUserScroll).toHaveBeenCalledTimes(1);
  });

  it("should keep reporting scrolls after the same gesture until the next programmatic scroll", () => {
    const onUserScroll = vi.fn();
    const { scroll } = setup({ onUserScroll });
    wheel(scroll);
    fireEvent.scroll(scroll);
    fireEvent.scroll(scroll);
    expect(onUserScroll).toHaveBeenCalledTimes(2);
  });

  it("should stop reporting once scrollToRow disarms the intent", () => {
    const onUserScroll = vi.fn();
    const { ref, scroll } = setup({ onUserScroll });
    wheel(scroll);
    fireEvent.scroll(scroll);
    ref.current!.scrollToRow(2);
    fireEvent.scroll(scroll);
    expect(onUserScroll).toHaveBeenCalledTimes(1);
  });

  it("should report again after a new gesture following scrollToRow", () => {
    const onUserScroll = vi.fn();
    const { ref, scroll } = setup({ onUserScroll });
    ref.current!.scrollToRow(7);
    fireEvent.scroll(scroll);
    wheel(scroll);
    fireEvent.scroll(scroll);
    expect(onUserScroll).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (el: HTMLElement) => void]>([
    ["wheel", wheel],
    ["pointerdown", (el) => fireEvent.pointerDown(el, pointer(0, 0))],
    ["keydown", (el) => fireEvent.keyDown(el, { key: "PageDown" })],
  ])("should arm the user intent with a %s after scrollToRow", (_name, gesture) => {
    const onUserScroll = vi.fn();
    const { ref, scroll } = setup({ onUserScroll });
    ref.current!.scrollToRow(7);
    gesture(scroll);
    fireEvent.scroll(scroll);
    expect(onUserScroll).toHaveBeenCalledTimes(1);
  });

  it("should not throw on a scroll without the prop", () => {
    const { scroll } = setup();
    wheel(scroll);
    expect(() => fireEvent.scroll(scroll)).not.toThrow();
  });
});

// Contract: onMounted fires exactly once per mount, not on re-renders.
describe("DiffViewer onMounted", () => {
  it("should call onMounted once after the first render", () => {
    const onMounted = vi.fn();
    setup({ onMounted });
    expect(onMounted).toHaveBeenCalledTimes(1);
  });

  it("should not call onMounted again on a re-render", () => {
    const onMounted = vi.fn();
    const { rows, rerender } = setup({ onMounted });
    rerender(
      <DiffViewer
        diff={three}
        rows={rows}
        mode="unified"
        highlight={new Map()}
        onMounted={onMounted}
        resolveCaret={resolveCaret}
      />,
    );
    expect(onMounted).toHaveBeenCalledTimes(1);
  });

  it("should call onMounted again for a new mount", () => {
    const onMounted = vi.fn();
    setup({ onMounted }).unmount();
    setup({ onMounted });
    expect(onMounted).toHaveBeenCalledTimes(2);
  });
});

// Contract: highlight tokens reach the rows.
describe("DiffViewer highlighting", () => {
  it("should render token classes from the highlight map", () => {
    const highlight: HighlightMap = new Map([
      [1, [[{ text: "tail", className: "tok-number" }], null]],
    ]);
    setup({ diff: twoHunks, highlight });
    expect(screen.getByText("tail")).toHaveClass("tok-number");
  });

  it("should render plain text when the highlight map is null", () => {
    const { container } = setup({ diff: twoHunks, highlight: null });
    expect(container.querySelector("[class*='tok-']")).toBeNull();
  });
});

// Contract: the virtualizer counts the given rows and keys them by their own key, so measured
// heights follow rows.
describe("DiffViewer virtualizer options", () => {
  const lastOptions = () => {
    const calls = vi.mocked(useVirtualizer).mock.calls;
    const options = calls[calls.length - 1][0];
    const { getItemKey } = options;
    if (!getItemKey) throw new Error("DiffViewer passed no getItemKey");
    return { count: options.count, getItemKey, estimateSize: options.estimateSize };
  };

  it.each<DiffMode>(["unified", "split"])(
    "should key every %s row by the key buildRows gave it",
    (mode) => {
      const { rows } = setup({ diff: twoHunks, mode });
      const { getItemKey, count } = lastOptions();
      expect(count).toBe(rows.length);
      rows.forEach((row, i) => expect(getItemKey(i)).toBe(row.key));
    },
  );

  it("should key the new rows after the rows change", () => {
    const { rerender } = setup({ diff: twoHunks, mode: "unified" });
    const split = buildRows(twoHunks, "split");
    rerender(<DiffViewer diff={twoHunks} rows={split} mode="split" highlight={null} />);
    const { getItemKey, count } = lastOptions();
    expect(count).toBe(split.length);
    expect(getItemKey(1)).toBe(split[1].key);
  });

  it("should estimate rows from the diff font size", () => {
    const { unmount } = setup({ diff: twoHunks, mode: "unified" });
    expect(lastOptions().estimateSize(0)).toBe(18);
    unmount();
    const original = useSettings.getState().settings;
    useSettings.setState({
      settings: { ...original, appearance: { ...original.appearance, diffFontSize: 16 } },
    });
    try {
      setup({ diff: twoHunks, mode: "unified" });
      expect(lastOptions().estimateSize(0)).toBe(22);
    } finally {
      useSettings.setState({ settings: original });
    }
  });
});

// Contract: a vertical touch swipe pans the list; the viewer's own range takes mouse and pen drags.
describe("DiffViewer touch-action", () => {
  it("should let touch pan the scroll container vertically", () => {
    const css = readFileSync("src/features/diff/DiffViewer.module.css", "utf8");
    expect(declarationsOf(css, "scroll")).toMatch(/touch-action:\s*pan-y;/);
  });
});

// Contract: a text range is shown by the text tint alone; its rows carry no outline box.
describe("DiffRows range styling", () => {
  it("should draw a range as a text tint with no outline on rows or cells", () => {
    const rowCss = readFileSync("src/features/diff/DiffRows.module.css", "utf8");
    const lineCss = readFileSync("src/features/diff/LineContent.module.css", "utf8");
    expect(declarationsOf(rowCss, "row")).not.toMatch(/outline/);
    expect(declarationsOf(rowCss, "cell")).not.toMatch(/outline/);
    expect(declarationsOf(lineCss, "selected")).toMatch(
      /background:\s*var\(--color-line-selected\)/,
    );
  });
});

// Contract: an aside (the change ruler) sits beside the scroll container, in a row with it.
describe("DiffViewer aside", () => {
  it("should render the aside after the scroll container inside the Diff section", () => {
    setup({ aside: <div data-testid="aside" /> });
    const scroll = screen.getByTestId("diff-scroll");
    const aside = screen.getByTestId("aside");
    expect(aside.parentElement).toBe(scroll.parentElement);
    expect(scroll.nextElementSibling).toBe(aside);
  });

  it("should lay the scroll container and the aside out in a row", () => {
    const css = readFileSync("src/features/diff/DiffViewer.module.css", "utf8");
    expect(declarationsOf(css, "root")).toContain("flex-direction: row");
    expect(declarationsOf(css, "scroll")).toContain("min-width: 0");
  });
});
