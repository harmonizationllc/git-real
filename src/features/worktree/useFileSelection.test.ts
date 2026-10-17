import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFileSelection } from "./useFileSelection";

const plain = { ctrl: false, shift: false };
const ctrl = { ctrl: true, shift: false };
const shift = { ctrl: false, shift: true };

const paths = ["a", "b", "c", "d", "e"];

function setup(initial: string[] = paths) {
  return renderHook(({ list }) => useFileSelection(list), { initialProps: { list: initial } });
}

const sorted = (s: ReadonlySet<string>): string[] => [...s].sort();

describe("useFileSelection initial state", () => {
  it("should start with nothing selected", () => {
    const { result } = setup();
    expect(result.current.selected.size).toBe(0);
  });

  it("should report isSelected false for any path initially", () => {
    const { result } = setup();
    expect(result.current.isSelected("a")).toBe(false);
  });
});

// Contract: a plain click selects only the clicked path.
describe("useFileSelection plain click", () => {
  it("should select only the clicked path", () => {
    const { result } = setup();
    act(() => result.current.click("b", plain));
    expect(sorted(result.current.selected)).toEqual(["b"]);
  });

  it("should replace the previous selection", () => {
    const { result } = setup();
    act(() => result.current.click("b", plain));
    act(() => result.current.click("d", plain));
    expect(sorted(result.current.selected)).toEqual(["d"]);
  });

  it("should make isSelected true for the clicked path only", () => {
    const { result } = setup();
    act(() => result.current.click("b", plain));
    expect(result.current.isSelected("b")).toBe(true);
    expect(result.current.isSelected("a")).toBe(false);
  });

  it("should collapse a multi-selection to the clicked path", () => {
    const { result } = setup();
    act(() => result.current.click("a", plain));
    act(() => result.current.click("c", ctrl));
    act(() => result.current.click("e", plain));
    expect(sorted(result.current.selected)).toEqual(["e"]);
  });
});

// Contract: ctrl-click toggles one path without disturbing the rest.
describe("useFileSelection ctrl click", () => {
  it("should add an unselected path to the selection", () => {
    const { result } = setup();
    act(() => result.current.click("a", plain));
    act(() => result.current.click("c", ctrl));
    expect(sorted(result.current.selected)).toEqual(["a", "c"]);
  });

  it("should remove an already selected path", () => {
    const { result } = setup();
    act(() => result.current.click("a", plain));
    act(() => result.current.click("c", ctrl));
    act(() => result.current.click("c", ctrl));
    expect(sorted(result.current.selected)).toEqual(["a"]);
  });

  it("should select a path when nothing was selected", () => {
    const { result } = setup();
    act(() => result.current.click("b", ctrl));
    expect(sorted(result.current.selected)).toEqual(["b"]);
  });

  it("should move the shift anchor to the ctrl-clicked path", () => {
    const { result } = setup();
    act(() => result.current.click("a", plain));
    act(() => result.current.click("e", ctrl));
    act(() => result.current.click("c", shift));
    expect(sorted(result.current.selected)).toEqual(["c", "d", "e"]);
  });

  it("should do nothing when the clicked path is not in the list", () => {
    const { result } = setup();
    act(() => result.current.click("a", plain));
    act(() => result.current.click("zzz", ctrl));
    expect(sorted(result.current.selected)).toEqual(["a"]);
  });
});

// Contract: shift-click selects the range from the anchor (last plain click) in list order.
describe("useFileSelection shift click", () => {
  it("should select the range from the anchor down to the clicked path", () => {
    const { result } = setup();
    act(() => result.current.click("b", plain));
    act(() => result.current.click("d", shift));
    expect(sorted(result.current.selected)).toEqual(["b", "c", "d"]);
  });

  it("should select the range when the clicked path is above the anchor", () => {
    const { result } = setup();
    act(() => result.current.click("d", plain));
    act(() => result.current.click("b", shift));
    expect(sorted(result.current.selected)).toEqual(["b", "c", "d"]);
  });

  it("should select just the anchor when shift-clicking the anchor itself", () => {
    const { result } = setup();
    act(() => result.current.click("c", plain));
    act(() => result.current.click("c", shift));
    expect(sorted(result.current.selected)).toEqual(["c"]);
  });

  it("should replace a previous range when shifting to a new endpoint", () => {
    const { result } = setup();
    act(() => result.current.click("a", plain));
    act(() => result.current.click("d", shift));
    act(() => result.current.click("b", shift));
    expect(sorted(result.current.selected)).toEqual(["a", "b"]);
  });

  it("should follow the order of the list rather than alphabetical order", () => {
    const { result } = setup(["z", "m", "a", "k"]);
    act(() => result.current.click("z", plain));
    act(() => result.current.click("a", shift));
    expect(sorted(result.current.selected)).toEqual(["a", "m", "z"]);
  });

  it("should select only the clicked path when there is no anchor", () => {
    const { result } = setup();
    act(() => result.current.click("c", shift));
    expect(sorted(result.current.selected)).toEqual(["c"]);
  });

  it("should select the range when shift and ctrl are both held", () => {
    const { result } = setup();
    act(() => result.current.click("b", plain));
    act(() => result.current.click("d", { ctrl: true, shift: true }));
    expect(sorted(result.current.selected)).toEqual(["b", "c", "d"]);
  });

  it("should use the latest plain click as the new anchor", () => {
    const { result } = setup();
    act(() => result.current.click("a", plain));
    act(() => result.current.click("d", plain));
    act(() => result.current.click("e", shift));
    expect(sorted(result.current.selected)).toEqual(["d", "e"]);
  });

  it("should select only the clicked path when the anchor left the list", () => {
    const { result, rerender } = setup();
    act(() => result.current.click("b", plain));
    rerender({ list: ["a", "c", "d", "e"] });
    act(() => result.current.click("d", shift));
    expect(sorted(result.current.selected)).toEqual(["d"]);
  });
});

// Contract: paths that disappear from the ordered list are pruned from the selection.
describe("useFileSelection pruning", () => {
  it("should drop selected paths that are no longer in the list", () => {
    const { result, rerender } = setup();
    act(() => result.current.click("a", plain));
    act(() => result.current.click("c", ctrl));
    rerender({ list: ["a", "b", "d"] });
    expect(sorted(result.current.selected)).toEqual(["a"]);
  });

  it("should keep the selection when the list still contains every selected path", () => {
    const { result, rerender } = setup();
    act(() => result.current.click("a", plain));
    act(() => result.current.click("c", ctrl));
    rerender({ list: ["c", "a", "x"] });
    expect(sorted(result.current.selected)).toEqual(["a", "c"]);
  });

  it("should empty the selection when the list becomes empty", () => {
    const { result, rerender } = setup();
    act(() => result.current.click("a", plain));
    rerender({ list: [] });
    expect(result.current.selected.size).toBe(0);
  });

  it("should not reselect a pruned path when it reappears in the list", () => {
    const { result, rerender } = setup();
    act(() => result.current.click("b", plain));
    rerender({ list: ["a", "c"] });
    rerender({ list: paths });
    expect(result.current.selected.size).toBe(0);
  });

  it("should keep selected referentially equal when the list is a new array with equal content", () => {
    const { result, rerender } = setup();
    act(() => result.current.click("b", plain));
    const before = result.current.selected;
    rerender({ list: [...paths] });
    expect(result.current.selected).toBe(before);
  });

  it("should report isSelected false for a pruned path", () => {
    const { result, rerender } = setup();
    act(() => result.current.click("b", plain));
    rerender({ list: ["a", "c"] });
    expect(result.current.isSelected("b")).toBe(false);
  });
});

describe("useFileSelection clear", () => {
  it("should empty the selection", () => {
    const { result } = setup();
    act(() => result.current.click("a", plain));
    act(() => result.current.click("c", ctrl));
    act(() => result.current.clear());
    expect(result.current.selected.size).toBe(0);
  });

  it("should reset the anchor so a following shift-click selects only that path", () => {
    const { result } = setup();
    act(() => result.current.click("a", plain));
    act(() => result.current.clear());
    act(() => result.current.click("d", shift));
    expect(sorted(result.current.selected)).toEqual(["d"]);
  });

  it("should not throw when nothing is selected", () => {
    const { result } = setup();
    expect(() => act(() => result.current.clear())).not.toThrow();
  });
});

// Contract: keys are opaque, so equal paths in different sections never collide.
describe("useFileSelection section keys", () => {
  const keys = ["staged:a", "staged:b", "unstaged:a", "unstaged:b"];

  it("should select only the clicked section's entry for a shared path", () => {
    const { result } = setup(keys);
    act(() => result.current.click("staged:a", plain));
    expect(result.current.isSelected("staged:a")).toBe(true);
    expect(result.current.isSelected("unstaged:a")).toBe(false);
  });

  it("should toggle same-path entries in different sections independently", () => {
    const { result } = setup(keys);
    act(() => result.current.click("staged:a", plain));
    act(() => result.current.click("unstaged:a", ctrl));
    act(() => result.current.click("staged:a", ctrl));
    expect(sorted(result.current.selected)).toEqual(["unstaged:a"]);
  });

  it("should range across the section boundary in list order", () => {
    const { result } = setup(keys);
    act(() => result.current.click("staged:b", plain));
    act(() => result.current.click("unstaged:a", shift));
    expect(sorted(result.current.selected)).toEqual(["staged:b", "unstaged:a"]);
  });

  it("should prune only the entry whose section lost the path", () => {
    const { result, rerender } = setup(keys);
    act(() => result.current.click("staged:a", plain));
    act(() => result.current.click("unstaged:a", ctrl));
    rerender({ list: ["staged:a", "staged:b", "unstaged:b"] });
    expect(sorted(result.current.selected)).toEqual(["staged:a"]);
  });
});

// Contract: pins how the anchor behaves around deselection and pruning.
describe("useFileSelection anchor edges", () => {
  it("should range from a ctrl-deselected anchor, since ctrl moves the anchor to that key", () => {
    const { result } = setup();
    act(() => result.current.click("b", plain));
    act(() => result.current.click("b", ctrl));
    expect(result.current.selected.size).toBe(0);
    act(() => result.current.click("d", shift));
    expect(sorted(result.current.selected)).toEqual(["b", "c", "d"]);
  });

  it("should drop a pruned anchor so shift selects only the clicked key, keeping nothing stale", () => {
    const { result, rerender } = setup();
    act(() => result.current.click("b", plain));
    act(() => result.current.click("c", ctrl));
    rerender({ list: ["a", "b", "d", "e"] });
    expect(sorted(result.current.selected)).toEqual(["b"]);
    act(() => result.current.click("e", shift));
    expect(sorted(result.current.selected)).toEqual(["e"]);
  });

  it("should keep the anchor when an unrelated entry is pruned", () => {
    const { result, rerender } = setup();
    act(() => result.current.click("b", plain));
    rerender({ list: ["a", "b", "c", "d"] });
    act(() => result.current.click("d", shift));
    expect(sorted(result.current.selected)).toEqual(["b", "c", "d"]);
  });
});
