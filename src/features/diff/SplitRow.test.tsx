import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import type { HighlightMap } from "./model/highlight";
import { buildRows, type DiffRow } from "./model/rows";
import { SplitRow } from "./SplitRow";
import type { RowTint } from "./useTextRange";
import lineStyles from "./LineContent.module.css";

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
  over: { highlight?: HighlightMap | null; tint?: RowTint | null } = {},
) {
  const row = rows.find(
    (r): r is Extract<DiffRow, { kind: "split" }> =>
      r.kind === "split" && r.old === oldIndex && r.new === newIndex,
  )!;
  const view = render(
    <SplitRow diff={diff} row={row} highlight={over.highlight ?? null} tint={over.tint ?? null} />,
  );
  const cells = Array.from(
    view.container.querySelectorAll<HTMLElement>(
      '[data-kind="context"], [data-kind="deletion"], [data-kind="addition"], [data-kind="empty"]',
    ),
  );
  return { ...view, cells, left: cells[0], right: cells[1] };
}

const marked = (el: HTMLElement) =>
  Array.from(el.querySelectorAll("mark"))
    .map((m) => m.textContent)
    .join("");

const selectedText = (el: HTMLElement) =>
  Array.from(el.querySelectorAll(`.${lineStyles.selected}`))
    .map((e) => e.textContent)
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

// Contract: the gutters are plain cells; nothing in a split row is a control.
describe("SplitRow plain gutters", () => {
  it.each<[number | null, number | null]>([
    [0, 0],
    [1, 2],
    [null, 3],
    [5, null],
  ])("should render no button for the row (%s, %s)", (oldIndex, newIndex) => {
    setup(oldIndex, newIndex);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should render each cell's gutter as a span", () => {
    const { left, right } = setup(1, 2);
    expect(left.children[0].tagName).toBe("SPAN");
    expect(right.children[0].tagName).toBe("SPAN");
  });
});

// Contract: every cell carries data-side, old on the left and new on the right, empty or not.
describe("SplitRow data-side", () => {
  it("should mark the left cell old and the right cell new", () => {
    const { left, right } = setup(1, 2);
    expect(left).toHaveAttribute("data-side", "old");
    expect(right).toHaveAttribute("data-side", "new");
  });

  it("should mark an empty left cell old", () => {
    expect(setup(null, 3).left).toHaveAttribute("data-side", "old");
  });

  it("should mark an empty right cell new", () => {
    expect(setup(5, null).right).toHaveAttribute("data-side", "new");
  });
});

// Contract: only the cell on tint.side is tinted, as { start: from ?? 0, end: to ?? text.length },
// and only that cell carries data-selected.
describe("SplitRow tint", () => {
  it("should select the new cell from the tint's from to the end", () => {
    const { right } = setup(1, 2, { tint: { side: "new", from: 6, to: null } });
    expect(selectedText(right)).toBe("b = 1");
  });

  it("should leave the old cell unselected when the tint is on the new side", () => {
    const { left } = setup(1, 2, { tint: { side: "new", from: 6, to: null } });
    expect(left.querySelector(`.${lineStyles.selected}`)).toBeNull();
    expect(left).not.toHaveAttribute("data-selected");
  });

  it("should mark only the new cell data-selected for a new-side tint", () => {
    const { right } = setup(1, 2, { tint: { side: "new", from: 6, to: null } });
    expect(right).toHaveAttribute("data-selected", "true");
  });

  it("should select the old cell from the start to the tint's to", () => {
    const { left, right } = setup(1, 2, { tint: { side: "old", from: null, to: 5 } });
    expect(selectedText(left)).toBe("const");
    expect(right.querySelector(`.${lineStyles.selected}`)).toBeNull();
  });

  it("should mark only the old cell data-selected for an old-side tint", () => {
    const { left, right } = setup(1, 2, { tint: { side: "old", from: null, to: 5 } });
    expect(left).toHaveAttribute("data-selected", "true");
    expect(right).not.toHaveAttribute("data-selected");
  });

  it("should select the whole line when from and to are both null", () => {
    const { left } = setup(4, 4, { tint: { side: "old", from: null, to: null } });
    expect(selectedText(left)).toBe("more");
  });

  it("should select between from and to on a context cell", () => {
    const { left, right } = setup(0, 0, { tint: { side: "new", from: 1, to: 3 } });
    expect(selectedText(right)).toBe("ee");
    expect(left.querySelector(`.${lineStyles.selected}`)).toBeNull();
  });

  it("should mark the empty cell on the tint's side data-selected", () => {
    const { left, right } = setup(5, null, { tint: { side: "new", from: null, to: null } });
    expect(right).toHaveAttribute("data-kind", "empty");
    expect(right).toHaveAttribute("data-selected", "true");
    expect(left).not.toHaveAttribute("data-selected");
  });

  it("should not mark an empty cell off the tint's side data-selected", () => {
    const { left } = setup(null, 3, { tint: { side: "new", from: null, to: null } });
    expect(left).toHaveAttribute("data-kind", "empty");
    expect(left).not.toHaveAttribute("data-selected");
  });

  it("should not mark either cell data-selected without a tint", () => {
    const { left, right } = setup(1, 2);
    expect(left).not.toHaveAttribute("data-selected");
    expect(right).not.toHaveAttribute("data-selected");
  });

  it("should select nothing without a tint", () => {
    expect(setup(1, 2).container.querySelector(`.${lineStyles.selected}`)).toBeNull();
  });
});
