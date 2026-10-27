import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeRow, oidOf, ref } from "../../test/graphFixtures";
import { GraphRow } from "./GraphRow";
import { gutterWidth } from "./model/edges";
import { fullDate } from "./model/relativeTime";

// Unix seconds, passed as the `now` prop; the row never reads the clock itself.
const NOW = 1_700_000_000;

function renderRow(over: Partial<React.ComponentProps<typeof GraphRow>> = {}) {
  const props = {
    row: makeRow(0, { authorTime: NOW - 3 * 3600 }),
    now: NOW,
    maxLanes: 3,
    selected: false,
    matched: false,
    id: "row-0",
    onSelect: vi.fn(),
    onContextMenu: vi.fn(),
    ...over,
  };
  render(<GraphRow {...props} />);
  return props;
}

// Contract: an option carrying the subject, author and relative date.
describe("GraphRow content", () => {
  it("should render as an option with the given id", () => {
    renderRow({ id: "graph-row-7" });
    expect(screen.getByRole("option")).toHaveAttribute("id", "graph-row-7");
  });

  it("should show the subject", () => {
    renderRow({ row: makeRow(0, { subject: "Fix the parser" }) });
    expect(screen.getByRole("option")).toHaveTextContent("Fix the parser");
  });

  it("should show the author name with the email as its title", () => {
    renderRow();
    expect(screen.getByText("Alice")).toHaveAttribute("title", "alice@x.io");
  });

  it("should show the relative date text", () => {
    renderRow();
    expect(screen.getByText("3 hours ago")).toBeInTheDocument();
  });

  it("should title the date with the full date", () => {
    renderRow();
    expect(screen.getByText("3 hours ago")).toHaveAttribute("title", fullDate(NOW - 3 * 3600));
  });

  it("should compute the relative date from the now prop", () => {
    renderRow({ now: NOW + 2 * 86400 });
    expect(screen.getByText("2 days ago")).toBeInTheDocument();
  });

  it("should render the lane graph sized for maxLanes", () => {
    renderRow({ maxLanes: 3 });
    const svg = screen.getByRole("option").querySelector("svg");
    expect(svg?.getAttribute("width")).toBe(String(gutterWidth(3)));
  });

  it("should render the ref labels of the row", () => {
    renderRow({ row: makeRow(0, { refs: [ref("branch", "main", true), ref("tag", "v1")] }) });
    expect(screen.getByTitle("main")).toBeInTheDocument();
    expect(screen.getByTitle("v1")).toBeInTheDocument();
  });

  it("should give the message cell an inline 6px gap and no CSS gap", () => {
    renderRow();
    const cell = screen.getByText("Subject 0").parentElement as HTMLElement;
    expect(cell.style.gap).toBe("6px");
    const css = readFileSync("src/features/graph/GraphRow.module.css", "utf8");
    const message = /(?:^|\n)\.message\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(message).not.toMatch(/gap:/);
  });

  it("should render no ref labels for a row without refs", () => {
    renderRow({ row: makeRow(0, { refs: [] }) });
    expect(screen.queryByTitle("main")).toBeNull();
  });
});

// Contract: selection state is exposed through aria-selected.
describe("GraphRow selection", () => {
  it('should set aria-selected="true" when selected', () => {
    renderRow({ selected: true });
    expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "true");
  });

  it('should set aria-selected="false" when not selected', () => {
    renderRow({ selected: false });
    expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "false");
  });
});

// Contract: a search match carries the matched class.
describe("GraphRow match highlight", () => {
  it("should add the matched class when matched", () => {
    renderRow({ matched: true });
    expect(screen.getByRole("option").className).toMatch(/matched/);
  });

  it("should not add the matched class when not matched", () => {
    renderRow({ matched: false });
    expect(screen.getByRole("option").className).not.toMatch(/matched/);
  });
});

// Contract: click selects, contextmenu reports its coordinates.
describe("GraphRow interaction", () => {
  it("should call onSelect once when clicked", () => {
    const props = renderRow({ row: makeRow(3) });
    fireEvent.click(screen.getByRole("option"));
    expect(props.onSelect).toHaveBeenCalledOnce();
  });

  it("should not call onSelect before any click", () => {
    const props = renderRow();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("should call onContextMenu with the pointer coordinates", () => {
    const props = renderRow();
    fireEvent.contextMenu(screen.getByRole("option"), { clientX: 40, clientY: 60 });
    expect(props.onContextMenu).toHaveBeenCalledExactlyOnceWith(40, 60);
  });

  it("should prevent the browser's own context menu", () => {
    renderRow();
    const allowed = fireEvent.contextMenu(screen.getByRole("option"), { clientX: 1, clientY: 2 });
    expect(allowed).toBe(false);
  });

  it("should not call onContextMenu for a plain click", () => {
    const props = renderRow({ row: makeRow(5, { oid: oidOf(5) }) });
    fireEvent.click(screen.getByRole("option"));
    expect(props.onContextMenu).not.toHaveBeenCalled();
  });
});
