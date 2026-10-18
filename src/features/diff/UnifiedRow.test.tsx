import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import { buildRows, type DiffRow } from "./model/rows";
import type { HighlightMap } from "./model/highlight";
import { UnifiedRow } from "./UnifiedRow";
import type { UseLineSelection } from "./useLineSelection";

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
  over: {
    highlight?: HighlightMap | null;
    selection?: UseLineSelection;
    onGutterClick?: ((hunk: number, line: number, shift: boolean) => void) | null;
  } = {},
) {
  const row = rows.find(
    (r): r is Extract<DiffRow, { kind: "unified" }> =>
      r.kind === "unified" && r.lineIndex === lineIndex,
  )!;
  const onGutterClick = over.onGutterClick === null ? undefined : (over.onGutterClick ?? vi.fn());
  const view = render(
    <UnifiedRow
      diff={diff}
      row={row}
      highlight={over.highlight ?? null}
      selection={over.selection}
      onGutterClick={onGutterClick}
    />,
  );
  const root = view.container.firstElementChild as HTMLElement;
  return { ...view, root, onGutterClick };
}

const selecting = (hunkIndex: number | null, ...lines: number[]): UseLineSelection => ({
  selected: new Set(lines),
  hunkIndex,
  click: vi.fn(),
  clear: vi.fn(),
});

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

// Contract: only changed lines are selectable, one control per line, on the gutter showing its number.
describe("UnifiedRow selection controls", () => {
  it("should render a deletion gutter as an unpressed button named for the removed line", () => {
    setup(1);
    expect(screen.getByRole("button", { name: "Select removed line 2" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("should render an addition gutter as an unpressed button named for the added line", () => {
    setup(2);
    expect(screen.getByRole("button", { name: "Select added line 2" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("should put a deletion's button in the first gutter", () => {
    const { root } = setup(1);
    expect(within(root.children[0] as HTMLElement).getByRole("button")).toBeInTheDocument();
  });

  it("should put an addition's button in the second gutter", () => {
    const { root } = setup(2);
    expect(within(root.children[1] as HTMLElement).getByRole("button")).toBeInTheDocument();
  });

  it("should render exactly one button per changed line", () => {
    setup(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("should render no button for a context line", () => {
    setup(0);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should render no button when onGutterClick is absent", () => {
    setup(1, { onGutterClick: null });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should still show the line number when onGutterClick is absent", () => {
    expect(setup(1, { onGutterClick: null }).root.children[0]).toHaveTextContent(/^2$/);
  });
});

// Contract: clicking a gutter reports hunk index, line index and the shift state.
describe("UnifiedRow gutter clicks", () => {
  it("should call onGutterClick with the hunk, line and shift false when clicked", () => {
    const { onGutterClick } = setup(1);
    fireEvent.click(screen.getByRole("button", { name: "Select removed line 2" }));
    expect(onGutterClick).toHaveBeenCalledWith(0, 1, false);
  });

  it("should call onGutterClick with shift true when clicked with shift held", () => {
    const { onGutterClick } = setup(2);
    fireEvent.click(screen.getByRole("button", { name: "Select added line 2" }), {
      shiftKey: true,
    });
    expect(onGutterClick).toHaveBeenCalledWith(0, 2, true);
  });

  it("should call onGutterClick once per click", () => {
    const { onGutterClick } = setup(1);
    fireEvent.click(screen.getByRole("button"));
    expect(onGutterClick).toHaveBeenCalledTimes(1);
  });
});

// Contract: a line in the selection of its own hunk is pressed and marked selected.
describe("UnifiedRow selected state", () => {
  it("should press the button when the line is selected in this hunk", () => {
    setup(1, { selection: selecting(0, 1) });
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("should mark the row data-selected when the line is selected", () => {
    expect(setup(1, { selection: selecting(0, 1) }).root).toHaveAttribute("data-selected", "true");
  });

  it("should not press the button when another line is selected", () => {
    setup(1, { selection: selecting(0, 2) });
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "false");
  });

  it("should not mark the row selected when the selection is in another hunk", () => {
    expect(setup(1, { selection: selecting(1, 1) }).root).not.toHaveAttribute("data-selected");
  });

  it("should not mark the row selected when nothing is selected", () => {
    expect(setup(1, { selection: selecting(null) }).root).not.toHaveAttribute("data-selected");
  });

  it("should not mark the row selected when there is no selection prop", () => {
    expect(setup(1).root).not.toHaveAttribute("data-selected");
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
