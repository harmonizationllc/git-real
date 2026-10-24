import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequest } from "../../lib/ipc";
import { pullRequest } from "../../test/hostingFixtures";
import { PullRequestRow } from "./PullRequestRow";

const onOpen = vi.fn();
const onContextMenu = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
});

function renderRow(pr: PullRequest = pullRequest(12)) {
  render(
    <ul>
      <PullRequestRow pr={pr} onOpen={onOpen} onContextMenu={onContextMenu} />
    </ul>,
  );
  const item = screen.getByRole("listitem");
  return { item, row: within(item).getByRole("button", { name: /^#\d+/ }) };
}

const openButton = (n = 12) => screen.getByRole("button", { name: `Open #${n} in browser` });

// Contract: number, title, author and branches, plus Draft and CI badges only where they apply.
describe("PullRequestRow content", () => {
  it("shows the number, the title and the author with the branches", () => {
    const { item } = renderRow();
    expect(within(item).getByText("#12")).toBeInTheDocument();
    expect(within(item).getByText("PR 12")).toBeInTheDocument();
    expect(within(item).getByText("alice · feature-12 → main")).toBeInTheDocument();
  });

  it("shows a Draft badge only for a draft", () => {
    renderRow(pullRequest(12, { draft: true }));
    expect(screen.getByText("Draft")).toBeInTheDocument();
  });

  it("shows no Draft badge for a ready pull request", () => {
    renderRow();
    expect(screen.queryByText("Draft")).toBeNull();
  });

  it.each([
    ["passing", "CI passing"],
    ["failing", "CI failing"],
    ["pending", "CI pending"],
  ] as const)("shows %s as %s", (ciState, text) => {
    renderRow(pullRequest(12, { ciState }));
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("shows no CI text when the state is none", () => {
    renderRow(pullRequest(12, { ciState: "none" }));
    expect(screen.queryByText(/^CI /)).toBeNull();
  });

  it("renders the title as text, not markup", () => {
    const { item } = renderRow(pullRequest(1, { title: "<img src=x onerror=alert(1)>" }));
    expect(item.querySelector("img")).toBeNull();
    expect(within(item).getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });

  it("titles the row button so it does not read as a dead control", () => {
    const { row } = renderRow();
    expect(row).toHaveAttribute("title");
  });
});

// Contract: the sibling open button opens the pull request in the browser and does nothing else.
describe("PullRequestRow open button", () => {
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

// Contract: right-click and the keyboard open the context menu; a click or Enter opens it too.
describe("PullRequestRow context menu", () => {
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

  it("other keys do nothing", () => {
    const { row } = renderRow();
    fireEvent.keyDown(row, { key: "a" });
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  // Fix wave 2 (F5), changed deliberately: the row button now backs aria-haspopup="menu", so a
  // click (and Enter, which browsers turn into a click) opens the menu at the button's bottom-left,
  // like Shift+F10. It still never opens the item.
  it("a click on the row opens the menu at its bottom-left and does not open the item", async () => {
    const { row } = renderRow();
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ left: 5, bottom: 30 } as DOMRect);
    await userEvent.setup().click(row);
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(5, 30);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("Enter on the row opens the menu once and does not open the item", async () => {
    const { row } = renderRow();
    row.focus();
    await userEvent.setup().keyboard("{Enter}");
    expect(onContextMenu).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("a click on the Open in browser button does not open the menu", async () => {
    renderRow();
    await userEvent.setup().click(openButton());
    expect(onContextMenu).not.toHaveBeenCalled();
  });
});

// Contract (fix wave 2, F5): the focus-stop button owns the context menu, so it says so; the
// Open in browser icon button does not.
describe("PullRequestRow menu semantics", () => {
  it("marks the row button as opening a menu", () => {
    const { row } = renderRow();
    expect(row).toHaveAttribute("aria-haspopup", "menu");
  });

  it("does not mark the Open in browser button as opening a menu", () => {
    renderRow();
    expect(openButton()).not.toHaveAttribute("aria-haspopup");
  });
});
