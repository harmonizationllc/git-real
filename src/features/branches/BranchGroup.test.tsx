import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
