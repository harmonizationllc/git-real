import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BranchGroup } from "./BranchGroup";
import type { BranchGroupProps } from "./BranchGroup";

function renderGroup(over: Partial<BranchGroupProps> = {}) {
  const props: BranchGroupProps = {
    heading: "Local",
    listLabel: "Local branches",
    filtered: false,
    count: 2,
    children: [<li key="a">alpha</li>, <li key="b">beta</li>],
    ...over,
  };
  return render(<BranchGroup {...props} />);
}

// Contract: the heading is an h2 and the rows sit in a labelled list.
describe("BranchGroup structure", () => {
  it("should render the heading as a level 2 heading", () => {
    renderGroup({ heading: "origin" });
    expect(screen.getByRole("heading", { level: 2, name: "origin" })).toBeInTheDocument();
  });

  it("should render the children in a list with the given label", () => {
    renderGroup({ listLabel: "origin branches" });
    expect(screen.getByRole("list", { name: "origin branches" })).toHaveTextContent("alphabeta");
  });

  it("should name the group region by its heading", () => {
    renderGroup({ heading: "Local" });
    expect(screen.getByRole("region", { name: "Local" })).toBeInTheDocument();
  });

  it("should render no empty copy when there are rows", () => {
    renderGroup();
    expect(screen.queryByText("No branches")).toBeNull();
    expect(screen.queryByText("No matches")).toBeNull();
  });
});

// Contract: an empty group says why it is empty and renders no list.
describe("BranchGroup empty states", () => {
  it("should show No branches when empty and not filtered", () => {
    renderGroup({ count: 0, children: null, filtered: false });
    expect(screen.getByText("No branches")).toBeInTheDocument();
  });

  it("should show No matches when empty and filtered", () => {
    renderGroup({ count: 0, children: null, filtered: true });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("should not show No branches when empty and filtered", () => {
    renderGroup({ count: 0, children: null, filtered: true });
    expect(screen.queryByText("No branches")).toBeNull();
  });

  it("should render no list when empty", () => {
    renderGroup({ count: 0, children: null });
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("should not show No matches when filtered but rows remain", () => {
    renderGroup({ filtered: true, count: 1, children: <li>alpha</li> });
    expect(screen.queryByText("No matches")).toBeNull();
  });
});

// Contract: leading content renders before the list.
describe("BranchGroup leading", () => {
  it("should render the leading node before the list", () => {
    renderGroup({ leading: <p>Detached at 0123abc</p> });
    const lead = screen.getByText("Detached at 0123abc");
    const list = screen.getByRole("list");
    expect(lead.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("should render the leading node even when the list is empty", () => {
    renderGroup({ count: 0, children: null, leading: <p>Detached at 0123abc</p> });
    expect(screen.getByText("Detached at 0123abc")).toBeInTheDocument();
  });

  it("should render nothing extra when leading is omitted", () => {
    renderGroup();
    expect(screen.queryByText("Detached at 0123abc")).toBeNull();
  });
});

// Contract: a leading row with no list needs no empty copy unless the filter hid rows.
describe("BranchGroup empty copy with leading", () => {
  it("should show no empty copy when empty, not filtered and leading is present", () => {
    renderGroup({
      count: 0,
      children: null,
      filtered: false,
      leading: <p>main (no commits yet)</p>,
    });
    expect(screen.queryByText("No branches")).toBeNull();
    expect(screen.queryByText("No matches")).toBeNull();
  });

  it("should still show No matches when empty, filtered and leading is present", () => {
    renderGroup({
      count: 0,
      children: null,
      filtered: true,
      leading: <p>main (no commits yet)</p>,
    });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });
});

// Contract: without onHeadingContextMenu the heading is plain; with it, the heading opens a menu by mouse or keyboard.
describe("BranchGroup heading context menu", () => {
  const heading = () => screen.getByRole("heading", { level: 2 });

  it("without onHeadingContextMenu the heading is not focusable and has no menu", () => {
    renderGroup();
    expect(heading()).not.toHaveAttribute("tabindex");
    expect(fireEvent.contextMenu(heading(), { clientX: 1, clientY: 2 })).toBe(true);
  });

  it("without onHeadingContextMenu Shift+F10 is not prevented", () => {
    renderGroup();
    expect(fireEvent.keyDown(heading(), { key: "F10", shiftKey: true })).toBe(true);
  });

  it("with it, the heading is focusable", () => {
    renderGroup({ onHeadingContextMenu: vi.fn() });
    expect(heading()).toHaveAttribute("tabindex", "0");
  });

  it("a right-click calls it with the pointer position", () => {
    const onHeadingContextMenu = vi.fn();
    renderGroup({ onHeadingContextMenu });
    fireEvent.contextMenu(heading(), { clientX: 12, clientY: 34 });
    expect(onHeadingContextMenu).toHaveBeenCalledExactlyOnceWith(12, 34);
  });

  it("a right-click prevents the browser menu", () => {
    renderGroup({ onHeadingContextMenu: vi.fn() });
    expect(fireEvent.contextMenu(heading(), { clientX: 1, clientY: 2 })).toBe(false);
  });

  it("Shift+F10 calls it at the heading's bottom-left", () => {
    const onHeadingContextMenu = vi.fn();
    renderGroup({ onHeadingContextMenu });
    vi.spyOn(heading(), "getBoundingClientRect").mockReturnValue({
      left: 7,
      bottom: 19,
    } as DOMRect);
    fireEvent.keyDown(heading(), { key: "F10", shiftKey: true });
    expect(onHeadingContextMenu).toHaveBeenCalledExactlyOnceWith(7, 19);
  });

  it("the ContextMenu key calls it at the heading's bottom-left", () => {
    const onHeadingContextMenu = vi.fn();
    renderGroup({ onHeadingContextMenu });
    vi.spyOn(heading(), "getBoundingClientRect").mockReturnValue({
      left: 3,
      bottom: 8,
    } as DOMRect);
    fireEvent.keyDown(heading(), { key: "ContextMenu" });
    expect(onHeadingContextMenu).toHaveBeenCalledExactlyOnceWith(3, 8);
  });

  it("the keyboard shortcuts prevent the default action", () => {
    renderGroup({ onHeadingContextMenu: vi.fn() });
    expect(fireEvent.keyDown(heading(), { key: "F10", shiftKey: true })).toBe(false);
    expect(fireEvent.keyDown(heading(), { key: "ContextMenu" })).toBe(false);
  });

  it("F10 without Shift and other keys do not open the menu", () => {
    const onHeadingContextMenu = vi.fn();
    renderGroup({ onHeadingContextMenu });
    fireEvent.keyDown(heading(), { key: "F10" });
    fireEvent.keyDown(heading(), { key: "Enter" });
    expect(onHeadingContextMenu).not.toHaveBeenCalled();
  });

  it("an unrelated key is not prevented", () => {
    renderGroup({ onHeadingContextMenu: vi.fn() });
    expect(fireEvent.keyDown(heading(), { key: "a" })).toBe(true);
  });
});
