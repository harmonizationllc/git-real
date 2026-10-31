import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GraphToolbar } from "./GraphToolbar";

function renderToolbar(over: Partial<React.ComponentProps<typeof GraphToolbar>> = {}) {
  const props = {
    query: "fix",
    onQueryChange: vi.fn(),
    matchCount: 5,
    current: 1,
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    total: 1200,
    complete: true,
    refreshing: false,
    ...over,
  };
  render(<GraphToolbar {...props} />);
  return props;
}

const input = () => screen.getByRole("searchbox", { name: "Search commits" });

// Contract: a search input labelled and placeholdered "Search commits".
describe("GraphToolbar input", () => {
  it('should render a type="search" input labelled Search commits', () => {
    renderToolbar();
    expect(input()).toHaveAttribute("type", "search");
  });

  it("should use Search commits as the placeholder", () => {
    renderToolbar();
    expect(input()).toHaveAttribute("placeholder", "Search commits");
  });

  it("should show the query as its value", () => {
    renderToolbar({ query: "needle" });
    expect(input()).toHaveValue("needle");
  });

  it("should report typed text through onQueryChange", () => {
    const props = renderToolbar({ query: "" });
    fireEvent.change(input(), { target: { value: "x" } });
    expect(props.onQueryChange).toHaveBeenCalledExactlyOnceWith("x");
  });
});

// Contract: the counter reads "<current> of <n>" (current is a zero-based index), "No matches", or nothing.
describe("GraphToolbar counter", () => {
  it("should read 2 of 5 for the second of five matches", () => {
    renderToolbar({ matchCount: 5, current: 1 });
    expect(screen.getByText("2 of 5")).toBeInTheDocument();
  });

  it("should read 1 of 1 for a single match", () => {
    renderToolbar({ matchCount: 1, current: 0 });
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });

  it("should read No matches when the query has no matches", () => {
    renderToolbar({ query: "zzz", matchCount: 0, current: 0 });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("should show neither a counter nor No matches while the search is in flight", () => {
    renderToolbar({ query: "fix", matchCount: null, current: 0 });
    expect(screen.queryByText("No matches")).toBeNull();
    expect(screen.queryByText(/ of /)).toBeNull();
  });

  it("should disable Previous and Next while the search is in flight", () => {
    renderToolbar({ query: "fix", matchCount: null, current: 0 });
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  });

  it("should show nothing when the query is empty", () => {
    renderToolbar({ query: "", matchCount: 0, current: 0 });
    expect(screen.queryByText("No matches")).toBeNull();
    expect(screen.queryByText(/ of /)).toBeNull();
  });

  it("should not read No matches while there are matches", () => {
    renderToolbar({ matchCount: 3, current: 0 });
    expect(screen.queryByText("No matches")).toBeNull();
  });
});

// Contract: Previous and Next buttons, disabled without matches.
describe("GraphToolbar buttons", () => {
  it("should disable Previous and Next when there are no matches", () => {
    renderToolbar({ matchCount: 0, current: 0 });
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("should enable Previous and Next when there are matches", () => {
    renderToolbar({ matchCount: 2, current: 0 });
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("should call onNext when Next is clicked", () => {
    const props = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(props.onPrevious).not.toHaveBeenCalled();
  });

  it("should call onPrevious when Previous is clicked", () => {
    const props = renderToolbar();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(props.onPrevious).toHaveBeenCalledOnce();
    expect(props.onNext).not.toHaveBeenCalled();
  });
});

// Contract: Enter goes to the next match, Shift+Enter to the previous, Escape clears the query.
describe("GraphToolbar keyboard", () => {
  it("should call onNext on Enter", () => {
    const props = renderToolbar();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(props.onNext).toHaveBeenCalledOnce();
    expect(props.onPrevious).not.toHaveBeenCalled();
  });

  it("should call onPrevious on Shift+Enter", () => {
    const props = renderToolbar();
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    expect(props.onPrevious).toHaveBeenCalledOnce();
    expect(props.onNext).not.toHaveBeenCalled();
  });

  it("should clear the query on Escape", () => {
    const props = renderToolbar();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(props.onQueryChange).toHaveBeenCalledExactlyOnceWith("");
  });

  it("should ignore other keys", () => {
    const props = renderToolbar();
    fireEvent.keyDown(input(), { key: "a" });
    expect(props.onNext).not.toHaveBeenCalled();
    expect(props.onPrevious).not.toHaveBeenCalled();
    expect(props.onQueryChange).not.toHaveBeenCalled();
  });
});

// Contract: the count element reads "Loading… n commits" while incomplete, "Updating… n
// commits" while refreshing and the plain count otherwise; it is a status region that is
// not live, and an incomplete graph holds the search counter at "Loading…".
describe("GraphToolbar count", () => {
  const count = () => screen.getByRole("status");

  it("should show 'Loading… 1,000 commits' while incomplete", () => {
    renderToolbar({ total: 1000, complete: false });
    expect(count()).toHaveTextContent(`Loading… ${(1000).toLocaleString()} commits`);
  });

  it("should show 'Updating… 1,200 commits' while refreshing", () => {
    renderToolbar({ total: 1200, refreshing: true });
    expect(count()).toHaveTextContent(`Updating… ${(1200).toLocaleString()} commits`);
  });

  it("should show the plain count when complete", () => {
    renderToolbar({ total: 1200 });
    expect(count().textContent).toBe(`${(1200).toLocaleString()} commits`);
  });

  it("should say '1 commit' for a single commit", () => {
    renderToolbar({ total: 1 });
    expect(count().textContent).toBe("1 commit");
  });

  it("should read Loading… in the counter when a query is typed on an incomplete graph", () => {
    renderToolbar({ query: "fix", matchCount: null, complete: false });
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("should show no counter for an empty query on an incomplete graph", () => {
    renderToolbar({ query: "", matchCount: null, complete: false });
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("should disable Previous and Next while incomplete", () => {
    renderToolbar({ matchCount: 5, complete: false });
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("should mark the count as a status region that is not live", () => {
    renderToolbar();
    expect(count()).toHaveAttribute("aria-live", "off");
  });
});
