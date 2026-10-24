import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "../../lib/ipc";
import { issue } from "../../test/hostingFixtures";
import { fullDate } from "../graph/model/relativeTime";
import { IssueRow } from "./IssueRow";

const onOpen = vi.fn();
const onContextMenu = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
});

function renderRow(i: Issue = issue(7)) {
  render(
    <ul>
      <IssueRow issue={i} onOpen={onOpen} onContextMenu={onContextMenu} />
    </ul>,
  );
  const item = screen.getByRole("listitem");
  return { item, row: within(item).getByRole("button", { name: /^#\d+/ }) };
}

const openButton = (n = 7) => screen.getByRole("button", { name: `Open #${n} in browser` });

// Contract: number, title, author and one badge per label.
describe("IssueRow content", () => {
  it("shows the number, the title and the author", () => {
    const { item } = renderRow();
    expect(within(item).getByText("#7")).toBeInTheDocument();
    expect(within(item).getByText("Issue 7")).toBeInTheDocument();
    expect(within(item).getByText("alice")).toBeInTheDocument();
  });

  it("shows one badge per label", () => {
    const { item } = renderRow(issue(7, { labels: ["bug", "help wanted", "ui"] }));
    for (const label of ["bug", "help wanted", "ui"]) {
      expect(within(item).getByText(label)).toBeInTheDocument();
    }
  });

  it("shows no badge for an issue without labels", () => {
    const { item } = renderRow(issue(7, { labels: [] }));
    expect(within(item).queryByText("bug")).toBeNull();
  });

  it("renders the title as text, not markup", () => {
    const { item } = renderRow(issue(1, { title: "<img src=x onerror=alert(1)>" }));
    expect(item.querySelector("img")).toBeNull();
    expect(within(item).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });

  it("titles the row button with the full updated-at date", () => {
    const { row } = renderRow();
    expect(row).toHaveAttribute("title", fullDate(1792497600));
  });
});

// Contract: the sibling open button opens the issue in the browser and does nothing else.
describe("IssueRow open button", () => {
  it("is named Open #n in browser and calls onOpen on click", async () => {
    renderRow();
    await userEvent.setup().click(openButton());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it("is a sibling of the row button, not inside it", () => {
    const { row } = renderRow();
    expect(row).not.toContainElement(openButton());
  });
});

// Contract: right-click and the keyboard open the context menu; a plain click or Enter do not.
describe("IssueRow context menu", () => {
  it("right-click calls onContextMenu with the pointer position", () => {
    const { row } = renderRow();
    fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(10, 20);
  });

  it("right-click prevents the native menu", () => {
    const { row } = renderRow();
    expect(fireEvent.contextMenu(row, { clientX: 1, clientY: 2 })).toBe(false);
  });

  it("Shift+F10 calls onContextMenu at the row's bottom-left and prevents the default", () => {
    const { row } = renderRow();
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ left: 5, bottom: 30 } as DOMRect);
    expect(fireEvent.keyDown(row, { key: "F10", shiftKey: true })).toBe(false);
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(5, 30);
  });

  it("the ContextMenu key calls onContextMenu and prevents the default", () => {
    const { row } = renderRow();
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ left: 5, bottom: 30 } as DOMRect);
    expect(fireEvent.keyDown(row, { key: "ContextMenu" })).toBe(false);
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(5, 30);
  });

  it("F10 without Shift does nothing", () => {
    const { row } = renderRow();
    fireEvent.keyDown(row, { key: "F10" });
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it("a click on the row calls neither callback", async () => {
    const { row } = renderRow();
    await userEvent.setup().click(row);
    expect([onOpen, onContextMenu].map((f) => f.mock.calls.length)).toEqual([0, 0]);
  });
});
