import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import type { HighlightMap } from "./model/highlight";
import { buildRows, type DiffRow } from "./model/rows";
import { SplitRow } from "./SplitRow";
import type { UseLineSelection } from "./useLineSelection";

// Line indices: 0 context, 1 deletion, 2 addition, 3 lone addition, 4 context, 5 lone deletion.
// Split rows: (0,0) (1,2) (null,3) (4,4) (5,null).
const diff = fileDiff([
  hunk([
    L("context", "keep", 1, 1),
    L("deletion", "const a = 1", 2, null),
    L("addition", "const b = 1", null, 2),
    L("addition", "tail", null, 3),
    L("context", "more", 3, 4),
    L("deletion", "gone", 4, null),
  ]),
]);
const rows = buildRows(diff, "split");

function setup(
  oldIndex: number | null,
  newIndex: number | null,
  over: {
    highlight?: HighlightMap | null;
    selection?: UseLineSelection;
    onGutterClick?: ((hunk: number, line: number, shift: boolean) => void) | null;
  } = {},
) {
  const row = rows.find(
    (r): r is Extract<DiffRow, { kind: "split" }> =>
      r.kind === "split" && r.old === oldIndex && r.new === newIndex,
  )!;
  const onGutterClick = over.onGutterClick === null ? undefined : (over.onGutterClick ?? vi.fn());
  const view = render(
    <SplitRow
      diff={diff}
      row={row}
      highlight={over.highlight ?? null}
      selection={over.selection}
      onGutterClick={onGutterClick}
    />,
  );
  const cells = Array.from(
    view.container.querySelectorAll<HTMLElement>(
      '[data-kind="context"], [data-kind="deletion"], [data-kind="addition"], [data-kind="empty"]',
    ),
  );
  return { ...view, cells, left: cells[0], right: cells[1], onGutterClick };
}

const selecting = (hunkIndex: number | null, ...lines: number[]): UseLineSelection => ({
  selected: new Set(lines),
  hunkIndex,
  click: vi.fn(),
  clear: vi.fn(),
});

const marked = (el: HTMLElement) =>
  Array.from(el.querySelectorAll("mark"))
    .map((m) => m.textContent)
    .join("");

// Contract: each side is its own cell, with its own line number and kind.
describe("SplitRow cells", () => {
  it("should render a left and a right cell", () => {
    expect(setup(1, 2).cells).toHaveLength(2);
  });

  it("should mark a changed pair as deletion on the left and addition on the right", () => {
    const { left, right } = setup(1, 2);
    expect(left).toHaveAttribute("data-kind", "deletion");
    expect(right).toHaveAttribute("data-kind", "addition");
  });

  it("should show the old number on the left and the new number on the right", () => {
    const { left, right } = setup(1, 2);
    expect(left).toHaveTextContent(/^2\s*−?\s*const a = 1/);
    expect(right).toHaveTextContent(/^2\s*\+?\s*const b = 1/);
  });

  it("should use each side's own line number when the numbers differ", () => {
    const { left, right } = setup(4, 4);
    expect(left).toHaveTextContent(/^3\s*more/);
    expect(right).toHaveTextContent(/^4\s*more/);
  });

  it("should mark both cells as context for a context pair", () => {
    const { left, right } = setup(0, 0);
    expect(left).toHaveAttribute("data-kind", "context");
    expect(right).toHaveAttribute("data-kind", "context");
  });

  it("should render an empty left cell when there is no old line", () => {
    const { left, right } = setup(null, 3);
    expect(left).toHaveAttribute("data-kind", "empty");
    expect(right).toHaveAttribute("data-kind", "addition");
  });

  it("should render an empty right cell when there is no new line", () => {
    const { left, right } = setup(5, null);
    expect(left).toHaveAttribute("data-kind", "deletion");
    expect(right).toHaveAttribute("data-kind", "empty");
  });

  it("should leave an empty cell without text", () => {
    expect(setup(null, 3).left).toHaveTextContent(/^$/);
  });

  it("should not use the row role", () => {
    setup(1, 2);
    expect(screen.queryByRole("row")).toBeNull();
  });
});

// Contract: only changed lines get a button, labelled by side, never on the empty or context side.
describe("SplitRow selection controls", () => {
  it("should render a button named for the removed line in the left cell", () => {
    const { left } = setup(1, 2);
    expect(within(left).getByRole("button", { name: "Select removed line 2" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("should render a button named for the added line in the right cell", () => {
    const { right } = setup(1, 2);
    expect(within(right).getByRole("button", { name: "Select added line 2" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("should render only one button for a lone addition", () => {
    setup(null, 3);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("should render only one button for a lone deletion", () => {
    setup(5, null);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("should render no button for a context pair", () => {
    setup(0, 0);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should render no button when onGutterClick is absent", () => {
    setup(1, 2, { onGutterClick: null });
    expect(screen.queryByRole("button")).toBeNull();
  });
});

// Contract: clicking a gutter reports hunk index, the line index on that side and the shift state.
describe("SplitRow gutter clicks", () => {
  it("should report the old line index when the left gutter is clicked", () => {
    const { onGutterClick } = setup(1, 2);
    fireEvent.click(screen.getByRole("button", { name: "Select removed line 2" }));
    expect(onGutterClick).toHaveBeenCalledWith(0, 1, false);
  });

  it("should report the new line index when the right gutter is clicked", () => {
    const { onGutterClick } = setup(1, 2);
    fireEvent.click(screen.getByRole("button", { name: "Select added line 2" }));
    expect(onGutterClick).toHaveBeenCalledWith(0, 2, false);
  });

  it("should report shift true when clicked with shift held", () => {
    const { onGutterClick } = setup(null, 3);
    fireEvent.click(screen.getByRole("button"), { shiftKey: true });
    expect(onGutterClick).toHaveBeenCalledWith(0, 3, true);
  });
});

// Contract: each cell is pressed and selected on its own line index, in its own hunk.
describe("SplitRow selected state", () => {
  it("should press only the left button when the old line is selected", () => {
    const { left, right } = setup(1, 2, { selection: selecting(0, 1) });
    expect(within(left).getByRole("button")).toHaveAttribute("aria-pressed", "true");
    expect(within(right).getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });

  it("should press only the right button when the new line is selected", () => {
    const { left, right } = setup(1, 2, { selection: selecting(0, 2) });
    expect(within(left).getByRole("button")).toHaveAttribute("aria-pressed", "false");
    expect(within(right).getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("should mark the selected cell data-selected", () => {
    const { left } = setup(1, 2, { selection: selecting(0, 1) });
    expect(left).toHaveAttribute("data-selected", "true");
  });

  it("should not mark the other cell data-selected", () => {
    const { right } = setup(1, 2, { selection: selecting(0, 1) });
    expect(right).not.toHaveAttribute("data-selected");
  });

  it("should not mark a cell selected when the selection is in another hunk", () => {
    const { left } = setup(1, 2, { selection: selecting(1, 1) });
    expect(left).not.toHaveAttribute("data-selected");
  });

  it("should not mark a cell selected without a selection prop", () => {
    expect(setup(1, 2).left).not.toHaveAttribute("data-selected");
  });
});

// Contract: word diff marks both sides of an edited pair and nothing else.
describe("SplitRow word diff", () => {
  it("should mark the changed old text on the left of an edited pair", () => {
    expect(marked(setup(1, 2).left)).toBe("a");
  });

  it("should mark the changed new text on the right of an edited pair", () => {
    expect(marked(setup(1, 2).right)).toBe("b");
  });

  it("should render no mark for a context pair", () => {
    expect(setup(0, 0).container.querySelector("mark")).toBeNull();
  });

  it("should render no mark for a lone addition", () => {
    expect(setup(null, 3).container.querySelector("mark")).toBeNull();
  });

  it("should render no mark for a lone deletion", () => {
    expect(setup(5, null).container.querySelector("mark")).toBeNull();
  });
});

// Contract: highlight tokens are looked up by each side's own line index.
describe("SplitRow highlighting", () => {
  it("should render a token span for a lone deletion from the old index", () => {
    const highlight: HighlightMap = new Map([
      [0, [null, null, null, null, null, [{ text: "gone", className: "tok-number" }]]],
    ]);
    setup(5, null, { highlight });
    expect(screen.getByText("gone")).toHaveClass("tok-number");
  });

  it("should render a token span for a lone addition from the new index", () => {
    const highlight: HighlightMap = new Map([
      [0, [null, null, null, [{ text: "tail", className: "tok-string" }]]],
    ]);
    setup(null, 3, { highlight });
    expect(screen.getByText("tail")).toHaveClass("tok-string");
  });

  it("should take the right cell's tokens from the new index of a pair", () => {
    const highlight: HighlightMap = new Map([
      [0, [null, null, [{ text: "const b = 1", className: "tok-string" }]]],
    ]);
    const { right } = setup(1, 2, { highlight });
    expect(right.querySelector("[class*='tok-']")).not.toBeNull();
  });

  it("should not give the left cell the tokens of the new index", () => {
    const highlight: HighlightMap = new Map([
      [0, [null, null, [{ text: "const b = 1", className: "tok-string" }]]],
    ]);
    const { left } = setup(1, 2, { highlight });
    expect(left.querySelector("[class*='tok-']")).toBeNull();
  });

  it("should render plain text when the highlight map is null", () => {
    const { container } = setup(0, 0, { highlight: null });
    expect(container.querySelector("[class*='tok-']")).toBeNull();
  });

  it("should render plain text when the map has no entry for the hunk", () => {
    const { container } = setup(0, 0, { highlight: new Map() });
    expect(container.querySelector("[class*='tok-']")).toBeNull();
  });
});

// Contract: a context pair is never selectable and never word-marked, even when selected.
describe("SplitRow context pair", () => {
  it("should render no button on either side when the selection names the context line", () => {
    setup(0, 0, { selection: selecting(0, 0) });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should show no marks on either side of a context pair", () => {
    const { left, right } = setup(4, 4);
    expect(marked(left)).toBe("");
    expect(marked(right)).toBe("");
  });

  it("should not call onGutterClick for a context pair", () => {
    const { onGutterClick, left, right } = setup(0, 0);
    fireEvent.click(left);
    fireEvent.click(right);
    expect(onGutterClick).not.toHaveBeenCalled();
  });

  it("should render no button on the empty side or the context side of a lone deletion", () => {
    const { right } = setup(5, null);
    expect(within(right).queryByRole("button")).toBeNull();
  });
});

// Contract: tokens are per side; a side without tokens renders plain while the other is highlighted.
describe("SplitRow asymmetric highlighting", () => {
  it("should highlight the left cell only when only the old index has tokens", () => {
    const highlight: HighlightMap = new Map([
      [0, [null, [{ text: "const a = 1", className: "tok-keyword" }], null]],
    ]);
    const { left, right } = setup(1, 2, { highlight });
    expect(left.querySelector(".tok-keyword")).not.toBeNull();
    expect(right.querySelector("[class*='tok-']")).toBeNull();
  });

  it("should keep the word marks on a highlighted side", () => {
    const highlight: HighlightMap = new Map([
      [0, [null, [{ text: "const a = 1", className: "tok-keyword" }], null]],
    ]);
    const { left } = setup(1, 2, { highlight });
    expect(marked(left)).toBe("a");
  });

  it("should leave the right cell's text intact when only the left has tokens", () => {
    const highlight: HighlightMap = new Map([
      [0, [null, [{ text: "const a = 1", className: "tok-keyword" }], null]],
    ]);
    expect(setup(1, 2, { highlight }).right).toHaveTextContent(/const b = 1/);
  });
});
