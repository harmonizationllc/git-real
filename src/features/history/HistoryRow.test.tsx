import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { historyEntry } from "../../test/historyFixtures";
import { fullDate } from "../graph/model/relativeTime";
import { HISTORY_ROW_HEIGHT, HistoryRow, RENAME_LINE_HEIGHT, historyRowHeight } from "./HistoryRow";

// Unix seconds, passed as the `now` prop; the row never reads the clock itself.
const NOW = 1_700_000_000;

function renderRow(over: Partial<React.ComponentProps<typeof HistoryRow>> = {}) {
  const props = {
    entry: historyEntry(0, { authorTime: NOW - 3 * 3600 }),
    now: NOW,
    selected: false,
    id: "history-row-0",
    onSelect: vi.fn(),
    ...over,
  };
  render(<HistoryRow {...props} />);
  return props;
}

// Contract: an option carrying badge, subject, author and relative date.
describe("HistoryRow content", () => {
  it("should render as an option with the given id", () => {
    renderRow({ id: "history-row-7" });
    expect(screen.getByRole("option")).toHaveAttribute("id", "history-row-7");
  });

  it("should show the subject", () => {
    renderRow({ entry: historyEntry(0, { subject: "Fix the parser" }) });
    expect(screen.getByRole("option")).toHaveTextContent("Fix the parser");
  });

  it("should show a badge for the kind of change", () => {
    renderRow({ entry: historyEntry(0, { change: "added" }) });
    expect(screen.getByRole("img", { name: "added" })).toBeInTheDocument();
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
});

// Contract: a renamed entry shows "old → new" under the subject; others do not.
describe("HistoryRow rename", () => {
  it("should show old → new for a renamed entry", () => {
    renderRow({ entry: historyEntry(0, { path: "src/new.ts", oldPath: "src/old.ts" }) });
    expect(screen.getByText("src/old.ts → src/new.ts")).toBeInTheDocument();
  });

  it("should show no arrow when the entry was not renamed", () => {
    renderRow({ entry: historyEntry(0, { oldPath: null }) });
    expect(screen.getByRole("option")).not.toHaveTextContent("→");
  });
});

// Contract: selection state is exposed through aria-selected; a click selects.
describe("HistoryRow selection", () => {
  it('should set aria-selected="true" when selected', () => {
    renderRow({ selected: true });
    expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "true");
  });

  it('should set aria-selected="false" when not selected', () => {
    renderRow({ selected: false });
    expect(screen.getByRole("option")).toHaveAttribute("aria-selected", "false");
  });

  it("should call onSelect when clicked", () => {
    const { onSelect } = renderRow();
    fireEvent.click(screen.getByRole("option"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("should not call onSelect before a click", () => {
    const { onSelect } = renderRow();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// Contract: a row is two lines tall, plus one line for a rename.
describe("historyRowHeight", () => {
  it("should be HISTORY_ROW_HEIGHT for a plain entry", () => {
    expect(historyRowHeight(historyEntry(0))).toBe(HISTORY_ROW_HEIGHT);
  });

  it("should add RENAME_LINE_HEIGHT for a renamed entry", () => {
    expect(historyRowHeight(historyEntry(0, { oldPath: "old.ts" }))).toBe(
      HISTORY_ROW_HEIGHT + RENAME_LINE_HEIGHT,
    );
  });

  it("should use 44 and 16 as the line heights", () => {
    expect([HISTORY_ROW_HEIGHT, RENAME_LINE_HEIGHT]).toEqual([44, 16]);
  });
});
