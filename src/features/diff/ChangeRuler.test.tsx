import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { declarationsOf } from "../../test/cssRules";
import { ChangeRuler } from "./ChangeRuler";
import type { ChangeBlock } from "./model/changes";

const blocks: ChangeBlock[] = [
  { hunkIndex: 0, firstRow: 2, lastRow: 4, kind: "modified" },
  { hunkIndex: 1, firstRow: 7, lastRow: 7, kind: "added" },
  { hunkIndex: 2, firstRow: 9, lastRow: 9, kind: "removed" },
];

function setup(over: { blocks?: ChangeBlock[]; current?: number | null } = {}) {
  const onSelect = vi.fn<(index: number) => void>();
  const view = render(
    <ChangeRuler
      blocks={over.blocks ?? blocks}
      rowCount={10}
      current={over.current ?? null}
      onSelect={onSelect}
    />,
  );
  return { ...view, onSelect };
}

const marks = () => screen.getAllByRole("button");

// Contract: one mark per block, labelled with its position and kind, placed by row range.
describe("ChangeRuler", () => {
  it("should render one mark per block, labelled with its position and kind", () => {
    setup();
    const names = ["Change 1 of 3: modified", "Change 2 of 3: added", "Change 3 of 3: removed"];
    expect(marks().map((m) => m.getAttribute("aria-label"))).toEqual(names);
    marks().forEach((m, i) => {
      expect(m).toHaveAttribute("data-kind", blocks[i]!.kind);
      expect(m).toHaveAttribute("title", names[i]);
    });
  });

  it("should place a mark by its row range as a percentage of all rows", () => {
    setup();
    expect(marks()[0]!.style.top).toBe("20%");
    expect(marks()[0]!.style.height).toBe("30%");
    expect(marks()[1]!.style.top).toBe("70%");
    expect(marks()[1]!.style.height).toBe("10%");
  });

  it("should stretch a block covering every row to the whole strip", () => {
    setup({ blocks: [{ hunkIndex: 0, firstRow: 0, lastRow: 9, kind: "added" }] });
    expect(marks()[0]!.style.top).toBe("0%");
    expect(marks()[0]!.style.height).toBe("100%");
  });

  it("should call onSelect with the mark's index on click", () => {
    const { onSelect } = setup();
    fireEvent.click(marks()[1]!);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("should mark only the current block with aria-current", () => {
    setup({ current: 1 });
    expect(marks()[1]).toHaveAttribute("aria-current", "true");
    expect(marks()[0]).not.toHaveAttribute("aria-current");
    expect(marks()[2]).not.toHaveAttribute("aria-current");
  });

  it("should keep marks out of the tab order", () => {
    setup();
    for (const m of marks()) expect(m.tabIndex).toBe(-1);
  });

  it("should merge blocks that share a strip cell into one mark that selects the first", () => {
    const merged: ChangeBlock[] = [
      { hunkIndex: 0, firstRow: 10, lastRow: 12, kind: "added" },
      { hunkIndex: 0, firstRow: 14, lastRow: 14, kind: "removed" },
      { hunkIndex: 1, firstRow: 30000, lastRow: 30000, kind: "added" },
    ];
    const onSelect = vi.fn<(index: number) => void>();
    const { rerender } = render(
      <ChangeRuler blocks={merged} rowCount={100000} current={null} onSelect={onSelect} />,
    );
    expect(marks()).toHaveLength(2);
    expect(marks()[0]).toHaveAccessibleName("Changes 1–2 of 3: modified");
    fireEvent.click(marks()[0]!);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(0);
    rerender(<ChangeRuler blocks={merged} rowCount={100000} current={1} onSelect={onSelect} />);
    expect(marks()[0]).toHaveAttribute("aria-current", "true");
  });

  it("should expose the strip as a labelled group", () => {
    setup();
    expect(screen.getByRole("group", { name: "Change ruler" })).toBe(
      screen.getByTestId("change-ruler"),
    );
  });

  it("should not take focus on mouse down", () => {
    setup();
    expect(fireEvent.mouseDown(marks()[0]!)).toBe(false);
  });

  it("should render nothing without blocks", () => {
    const { container } = setup({ blocks: [] });
    expect(container.firstChild).toBeNull();
  });
});

describe("ChangeRuler styles", () => {
  const css = readFileSync("src/features/diff/ChangeRuler.module.css", "utf8");

  it("should give a mark a minimum visible height", () => {
    expect(declarationsOf(css, "mark")).toContain("min-height: 2px");
  });

  it("should position marks inside a relative strip", () => {
    expect(declarationsOf(css, "ruler")).toContain("position: relative");
    expect(declarationsOf(css, "mark")).toContain("position: absolute");
  });

  it("should color marks by kind from the diff tokens", () => {
    for (const kind of ["added", "removed", "modified"]) {
      expect(css).toMatch(
        new RegExp(`\\.mark\\[data-kind="${kind}"\\]\\s*\\{[^}]*var\\(--color-${kind}\\)`),
      );
    }
  });

  it("should clip the strip and reserve room for a minimum-height mark at the bottom", () => {
    expect(declarationsOf(css, "ruler")).toContain("overflow: hidden");
    expect(declarationsOf(css, "track")).toContain("bottom: 2px");
    expect(declarationsOf(css, "track")).toContain("position: absolute");
  });

  it("should leave room for the current outline at the pane edge", () => {
    expect(declarationsOf(css, "mark")).toContain("right: 2px");
  });

  it("should outline the current mark", () => {
    expect(css).toMatch(
      /\.mark\[aria-current="true"\]\s*\{[^}]*outline:\s*1px solid var\(--color-accent\)/,
    );
  });
});
