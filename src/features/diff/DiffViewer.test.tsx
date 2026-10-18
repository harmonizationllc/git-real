import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DiffScope } from "../../lib/ipc";
import type { DiffMode } from "../../lib/store/diffPrefs";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import { DiffViewer } from "./DiffViewer";
import type { HighlightMap } from "./model/highlight";
import { buildRows } from "./model/rows";
import type { UseLineSelection } from "./useLineSelection";

vi.mock("@tanstack/react-virtual", () => import("../../test/mockVirtualizer"));

// Hunk 0: context, deletion, addition (an edited pair). Hunk 1: lone addition, context.
const lines0 = [
  L("context", "keep", 1, 1),
  L("deletion", "old text", 2, null),
  L("addition", "new text", null, 2),
];
const lines1 = [L("addition", "tail", null, 10), L("context", "end", 10, 11)];
const diffOf = (scope: DiffScope = "unstaged") =>
  fileDiff([hunk(lines0, "@@ -1,2 +1,2 @@"), hunk(lines1, "@@ -10,1 +10,2 @@")], { scope });
const diff = diffOf();

const selecting = (hunkIndex: number | null, ...lines: number[]): UseLineSelection => ({
  selected: new Set(lines),
  hunkIndex,
  click: vi.fn(),
  clear: vi.fn(),
});

function setup(
  over: {
    mode?: DiffMode;
    highlight?: HighlightMap | null;
    selection?: UseLineSelection;
    hunkAction?: boolean;
    reason?: string;
    diff?: ReturnType<typeof diffOf>;
  } = {},
) {
  const onHunkAction = vi.fn();
  const view = render(
    <DiffViewer
      diff={over.diff ?? diff}
      mode={over.mode ?? "unified"}
      highlight={over.highlight ?? null}
      selection={over.selection}
      onHunkAction={over.hunkAction === false ? undefined : onHunkAction}
      actionsDisabledReason={over.reason}
    />,
  );
  return { ...view, onHunkAction };
}

const kinds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("[data-kind]")).map((e) => e.getAttribute("data-kind"));

// Contract: every row of buildRows is rendered in order, unified or split by mode.
describe("DiffViewer rows", () => {
  it("should render headers then lines in order in unified mode", () => {
    const { container } = setup({ mode: "unified" });
    expect(kinds(container)).toEqual([
      "header",
      "context",
      "deletion",
      "addition",
      "header",
      "addition",
      "context",
    ]);
  });

  it("should render one row element per buildRows row in unified mode", () => {
    const { container } = setup({ mode: "unified" });
    expect(kinds(container)).toHaveLength(buildRows(diff, "unified").length);
  });

  it("should render side by side cells in split mode", () => {
    const { container } = setup({ mode: "split" });
    expect(kinds(container)).toEqual([
      "header",
      "context",
      "context",
      "deletion",
      "addition",
      "header",
      "empty",
      "addition",
      "context",
      "context",
    ]);
  });

  it("should render an empty cell only in split mode", () => {
    const { container } = setup({ mode: "unified" });
    expect(container.querySelector('[data-kind="empty"]')).toBeNull();
  });

  it("should render every line's text", () => {
    setup({ mode: "unified" });
    for (const text of ["keep", "tail", "end"]) expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("should render the header text of every hunk", () => {
    setup();
    expect(screen.getByText("@@ -1,2 +1,2 @@")).toBeInTheDocument();
    expect(screen.getByText("@@ -10,1 +10,2 @@")).toBeInTheDocument();
  });

  it("should render a diff without hunks as no rows", () => {
    const { container } = setup({ diff: fileDiff([]) });
    expect(kinds(container)).toEqual([]);
  });

  it("should not use the row role", () => {
    setup();
    expect(screen.queryByRole("row")).toBeNull();
  });
});

// Contract: the viewer is a named region with a scroll container.
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
});

// Contract: gutter clicks route to selection.click and need a selection to be live.
describe("DiffViewer gutters", () => {
  it("should route a gutter click to selection.click", () => {
    const selection = selecting(null);
    setup({ selection });
    fireEvent.click(screen.getByRole("button", { name: "Select removed line 2" }));
    expect(selection.click).toHaveBeenCalledWith(0, 1, false);
  });

  it("should pass shift through to selection.click", () => {
    const selection = selecting(null);
    setup({ selection });
    fireEvent.click(screen.getByRole("button", { name: "Select added line 2" }), {
      shiftKey: true,
    });
    expect(selection.click).toHaveBeenCalledWith(0, 2, true);
  });

  it("should route a click in a later hunk with that hunk's index", () => {
    const selection = selecting(null);
    setup({ selection });
    fireEvent.click(screen.getByRole("button", { name: "Select added line 10" }));
    expect(selection.click).toHaveBeenCalledWith(1, 0, false);
  });

  it("should route split gutter clicks to selection.click", () => {
    const selection = selecting(null);
    setup({ selection, mode: "split" });
    fireEvent.click(screen.getByRole("button", { name: "Select removed line 2" }));
    expect(selection.click).toHaveBeenCalledWith(0, 1, false);
  });

  it("should press the gutter of a selected line", () => {
    setup({ selection: selecting(0, 1) });
    expect(screen.getByRole("button", { name: "Select removed line 2" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("should render no gutter buttons without a selection", () => {
    setup({ hunkAction: false });
    expect(screen.queryByRole("button")).toBeNull();
  });
});

// Contract: hunk buttons send the hunk index and the sorted selected lines of that hunk only.
describe("DiffViewer hunk actions", () => {
  it("should send the whole first hunk when Stage hunk is clicked there", () => {
    const { onHunkAction } = setup();
    fireEvent.click(screen.getAllByRole("button", { name: "Stage hunk" })[0]);
    expect(onHunkAction).toHaveBeenCalledWith("stage", { hunkIndex: 0, lines: null });
  });

  it("should send the second hunk's index from its own header", () => {
    const { onHunkAction } = setup();
    fireEvent.click(screen.getAllByRole("button", { name: "Stage hunk" })[1]);
    expect(onHunkAction).toHaveBeenCalledWith("stage", { hunkIndex: 1, lines: null });
  });

  it("should send the selected lines sorted ascending", () => {
    const { onHunkAction } = setup({ selection: selecting(0, 2, 1) });
    fireEvent.click(screen.getByRole("button", { name: "Stage 2 lines" }));
    expect(onHunkAction).toHaveBeenCalledWith("stage", { hunkIndex: 0, lines: [1, 2] });
  });

  it("should send discard with the selected lines", () => {
    const { onHunkAction } = setup({ selection: selecting(0, 1) });
    fireEvent.click(screen.getByRole("button", { name: "Discard 1 line…" }));
    expect(onHunkAction).toHaveBeenCalledWith("discard", { hunkIndex: 0, lines: [1] });
  });

  it("should send unstage for a staged diff", () => {
    const { onHunkAction } = setup({ diff: diffOf("staged") });
    fireEvent.click(screen.getAllByRole("button", { name: "Unstage hunk" })[0]);
    expect(onHunkAction).toHaveBeenCalledWith("unstage", { hunkIndex: 0, lines: null });
  });

  it("should keep the whole-hunk labels on hunks without the selection", () => {
    setup({ selection: selecting(0, 1, 2) });
    expect(screen.getAllByRole("button", { name: "Stage hunk" })).toHaveLength(1);
  });

  it("should not apply a selection in another hunk to this hunk's buttons", () => {
    const { onHunkAction } = setup({ selection: selecting(1, 0) });
    fireEvent.click(screen.getAllByRole("button", { name: "Stage hunk" })[0]);
    expect(onHunkAction).toHaveBeenCalledWith("stage", { hunkIndex: 0, lines: null });
  });

  it("should treat an empty selection in the hunk as the whole hunk", () => {
    const { onHunkAction } = setup({ selection: selecting(0) });
    fireEvent.click(screen.getAllByRole("button", { name: "Stage hunk" })[0]);
    expect(onHunkAction).toHaveBeenCalledWith("stage", { hunkIndex: 0, lines: null });
  });

  it("should send the whole hunk when no selection is given", () => {
    const { onHunkAction } = setup({ selection: undefined });
    fireEvent.click(screen.getAllByRole("button", { name: "Discard hunk…" })[1]);
    expect(onHunkAction).toHaveBeenCalledWith("discard", { hunkIndex: 1, lines: null });
  });
});

// Contract: actionsDisabledReason reaches every header's buttons.
describe("DiffViewer disabled actions", () => {
  it("should disable every hunk button when a reason is given", () => {
    setup({ reason: "Not now" });
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(4);
    for (const b of buttons) expect(b).toBeDisabled();
  });

  it("should set the reason as the title of every hunk button", () => {
    setup({ reason: "Not now" });
    for (const b of screen.getAllByRole("button")) expect(b).toHaveAttribute("title", "Not now");
  });

  it("should leave the buttons enabled without a reason", () => {
    setup();
    for (const b of screen.getAllByRole("button")) expect(b).toBeEnabled();
  });
});

// Contract: without onHunkAction the viewer is read-only for hunks.
describe("DiffViewer read-only", () => {
  it("should render no hunk buttons without onHunkAction", () => {
    setup({ hunkAction: false });
    expect(screen.queryByRole("button", { name: /hunk/ })).toBeNull();
  });

  it("should still render gutter buttons when a selection is given", () => {
    setup({ hunkAction: false, selection: selecting(null) });
    expect(screen.getByRole("button", { name: "Select removed line 2" })).toBeInTheDocument();
  });

  it("should render the rows without onHunkAction", () => {
    setup({ hunkAction: false });
    expect(screen.getByText("keep")).toBeInTheDocument();
  });
});

// Contract: highlight tokens reach the rows.
describe("DiffViewer highlighting", () => {
  it("should render token classes from the highlight map", () => {
    const highlight: HighlightMap = new Map([
      [1, [[{ text: "tail", className: "tok-number" }], null]],
    ]);
    setup({ highlight });
    expect(screen.getByText("tail")).toHaveClass("tok-number");
  });

  it("should render plain text when the highlight map is null", () => {
    const { container } = setup({ highlight: null });
    expect(container.querySelector("[class*='tok-']")).toBeNull();
  });
});
