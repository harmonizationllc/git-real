import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import { buildRows, type DiffRow } from "./model/rows";
import type { HighlightMap } from "./model/highlight";
import { UnifiedRow } from "./UnifiedRow";
import type { RowTint } from "./useTextRange";
import lineStyles from "./LineContent.module.css";

// Line indices: 0 context, 1 deletion (partner 2), 2 addition (partner 1), 3 lone addition.
const diff = fileDiff([
  hunk([
    L("context", "keep", 1, 1),
    L("deletion", "const a = 1", 2, null),
    L("addition", "const b = 1", null, 2),
    { ...L("addition", "tail", null, 3), noNewlineAtEof: true },
  ]),
]);
const rows = buildRows(diff, "unified");

function setup(
  lineIndex: number,
  over: { highlight?: HighlightMap | null; tint?: RowTint | null } = {},
) {
  const row = rows.find(
    (r): r is Extract<DiffRow, { kind: "unified" }> =>
      r.kind === "unified" && r.lineIndex === lineIndex,
  )!;
  const view = render(
    <UnifiedRow
      diff={diff}
      row={row}
      highlight={over.highlight ?? null}
      tint={over.tint ?? null}
    />,
  );
  const root = view.container.firstElementChild as HTMLElement;
  return { ...view, root };
}

const selectedText = (el: HTMLElement) =>
  Array.from(el.querySelectorAll(`.${lineStyles.selected}`))
    .map((e) => e.textContent)
    .join("");

// Contract: gutters show the old and new line numbers that apply to the line.
describe("UnifiedRow gutters", () => {
  it("should mark a deletion row with data-kind deletion", () => {
    expect(setup(1).root).toHaveAttribute("data-kind", "deletion");
  });

  it("should show the old number in the first gutter of a deletion", () => {
    expect(setup(1).root.children[0]).toHaveTextContent(/^2$/);
  });

  it("should leave the second gutter of a deletion empty", () => {
    expect(setup(1).root.children[1]).toHaveTextContent(/^$/);
  });

  it("should leave the first gutter of an addition empty", () => {
    expect(setup(2).root.children[0]).toHaveTextContent(/^$/);
  });

  it("should show the new number in the second gutter of an addition", () => {
    expect(setup(2).root.children[1]).toHaveTextContent(/^2$/);
  });

  it("should mark an addition row with data-kind addition", () => {
    expect(setup(2).root).toHaveAttribute("data-kind", "addition");
  });

  it("should show both numbers for a context line", () => {
    const { root } = setup(0);
    expect(root.children[0]).toHaveTextContent(/^1$/);
    expect(root.children[1]).toHaveTextContent(/^1$/);
  });

  it("should mark a context row with data-kind context", () => {
    expect(setup(0).root).toHaveAttribute("data-kind", "context");
  });

  it("should not use the row role", () => {
    setup(1);
    expect(screen.queryByRole("row")).toBeNull();
  });
});

// Contract: word diff marks the changed words only where the line has a partner.
describe("UnifiedRow word diff", () => {
  const marked = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("mark"))
      .map((m) => m.textContent)
      .join("");

  it("should mark the changed old text in a deletion with a partner", () => {
    expect(marked(setup(1).container)).toBe("a");
  });

  it("should mark the changed new text in an addition with a partner", () => {
    expect(marked(setup(2).container)).toBe("b");
  });

  it("should render no mark when the row has no partner", () => {
    expect(setup(3).container.querySelector("mark")).toBeNull();
  });

  it("should render no mark for a context line", () => {
    expect(setup(0).container.querySelector("mark")).toBeNull();
  });
});

// Contract: highlight tokens for this line are passed through to the content.
describe("UnifiedRow highlighting", () => {
  it("should render a token span when the highlight map has tokens for the line", () => {
    const highlight: HighlightMap = new Map([
      [0, [null, null, null, [{ text: "tail", className: "tok-number" }]]],
    ]);
    setup(3, { highlight });
    expect(screen.getByText("tail")).toHaveClass("tok-number");
  });

  it("should render plain text when the highlight map is null", () => {
    const { container } = setup(3, { highlight: null });
    expect(container.querySelector("[class*='tok-']")).toBeNull();
  });

  it("should render plain text when the map has no entry for the hunk", () => {
    const { container } = setup(3, { highlight: new Map() });
    expect(container.querySelector("[class*='tok-']")).toBeNull();
  });

  it("should render plain text when the map has null tokens for the line", () => {
    const { container } = setup(3, { highlight: new Map([[0, [null, null, null, null]]]) });
    expect(container.querySelector("[class*='tok-']")).toBeNull();
  });
});

// Contract: the line text and the sign are shown, with the no-newline marker when flagged.
describe("UnifiedRow content", () => {
  it("should show the line text", () => {
    setup(0);
    expect(screen.getByText("keep")).toBeInTheDocument();
  });

  it("should show a no newline marker when the line has noNewlineAtEof", () => {
    setup(3);
    expect(screen.getByTitle("No newline at end of file")).toBeInTheDocument();
  });

  it("should show no marker when the line ends with a newline", () => {
    setup(0);
    expect(screen.queryByTitle("No newline at end of file")).toBeNull();
  });
});

// Contract: the gutters are plain cells; nothing in a row is a control.
describe("UnifiedRow plain gutters", () => {
  it.each([0, 1, 2, 3])("should render no button for line %i", (lineIndex) => {
    setup(lineIndex);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should render both gutters as spans", () => {
    const { root } = setup(1);
    expect(root.children[0].tagName).toBe("SPAN");
    expect(root.children[1].tagName).toBe("SPAN");
  });
});

// Contract: the row element carries data-side, old for a deletion and new for everything else.
describe("UnifiedRow data-side", () => {
  it("should mark a deletion row as the old side", () => {
    expect(setup(1).root).toHaveAttribute("data-side", "old");
  });

  it("should mark an addition row as the new side", () => {
    expect(setup(2).root).toHaveAttribute("data-side", "new");
  });

  it("should mark a context row as the new side", () => {
    expect(setup(0).root).toHaveAttribute("data-side", "new");
  });
});

// Contract: the tint reaches LineContent as { start: from ?? 0, end: to ?? text.length }, and a
// tinted row carries data-selected.
describe("UnifiedRow tint", () => {
  it("should select from the tint's from to the end of the line when to is null", () => {
    const { root } = setup(2, { tint: { side: "new", from: 3, to: null } });
    expect(selectedText(root)).toBe("st b = 1");
  });

  it("should select from the start of the line to the tint's to when from is null", () => {
    const { root } = setup(2, { tint: { side: "new", from: null, to: 4 } });
    expect(selectedText(root)).toBe("cons");
  });

  it("should select between from and to when both are set", () => {
    const { root } = setup(2, { tint: { side: "new", from: 6, to: 7 } });
    expect(selectedText(root)).toBe("b");
  });

  it("should select the whole line when from and to are both null", () => {
    const { root } = setup(2, { tint: { side: "new", from: null, to: null } });
    expect(selectedText(root)).toBe("const b = 1");
  });

  it("should apply the offsets on a deletion row tinted on the old side", () => {
    const { root } = setup(1, { tint: { side: "old", from: 6, to: null } });
    expect(selectedText(root)).toBe("a = 1");
  });

  it("should apply the offsets on a context row whatever the side", () => {
    const { root } = setup(0, { tint: { side: "old", from: 1, to: null } });
    expect(selectedText(root)).toBe("eep");
  });

  it("should tint a deletion row whole when the range is on the new side", () => {
    const { root } = setup(1, { tint: { side: "new", from: 6, to: null } });
    expect(selectedText(root)).toBe("const a = 1");
  });

  it("should tint an addition row whole when the range is on the old side", () => {
    const { root } = setup(2, { tint: { side: "old", from: null, to: 4 } });
    expect(selectedText(root)).toBe("const b = 1");
  });

  it("should mark a tinted row data-selected", () => {
    expect(setup(2, { tint: { side: "new", from: 3, to: null } }).root).toHaveAttribute(
      "data-selected",
      "true",
    );
  });

  it("should not mark an untinted row data-selected", () => {
    expect(setup(2).root).not.toHaveAttribute("data-selected");
  });

  it("should select nothing without a tint", () => {
    expect(setup(2).root.querySelector(`.${lineStyles.selected}`)).toBeNull();
  });
});
