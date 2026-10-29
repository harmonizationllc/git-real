import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkedWorktree } from "../../lib/ipc";
import { linkedWorktree } from "../../test/worktreeFixtures";
import { WorktreeRow } from "./WorktreeRow";

const onOpen = vi.fn();
const onContextMenu = vi.fn();

const linked = (over: Partial<LinkedWorktree> = {}) =>
  linkedWorktree({
    name: "a",
    path: "/repos/app-feat-a",
    head: { kind: "branch", name: "feat/a" },
    isMain: false,
    isCurrent: false,
    ...over,
  });

function renderRow(worktree: LinkedWorktree) {
  render(
    <ul>
      <WorktreeRow worktree={worktree} onOpen={onOpen} onContextMenu={onContextMenu} />
    </ul>,
  );
  return screen.getByRole("button");
}

beforeEach(() => {
  vi.resetAllMocks();
});

// Contract: a row shows the folder, its full path as title, the head text and its badges.
describe("WorktreeRow rendering", () => {
  it("should show the folder name with the full path as title and the head text", () => {
    const row = renderRow(linked());
    expect(row).toHaveAttribute("title", "/repos/app-feat-a");
    expect(within(row).getByText("app-feat-a")).toBeInTheDocument();
    expect(within(row).getByText("feat/a")).toBeInTheDocument();
  });

  it("should show no badge for a plain linked worktree", () => {
    const row = renderRow(linked());
    for (const badge of ["main", "current", "missing", "locked"])
      expect(within(row).queryByText(badge)).toBeNull();
  });

  it("should badge the main and current worktree", () => {
    const row = renderRow(linkedWorktree({ head: { kind: "branch", name: "trunk" } }));
    expect(within(row).getByText("main")).toBeInTheDocument();
    expect(within(row).getByText("current")).toBeInTheDocument();
  });

  it("should mark the current row", () => {
    expect(renderRow(linkedWorktree())).toHaveAttribute("aria-current", "true");
  });

  it("should not mark another row current", () => {
    expect(renderRow(linked())).not.toHaveAttribute("aria-current");
  });

  it("should badge a missing worktree", () => {
    expect(within(renderRow(linked({ missing: true }))).getByText("missing")).toBeInTheDocument();
  });

  it("should badge a locked worktree with its reason as title", () => {
    const row = renderRow(linked({ locked: "on a USB disk" }));
    expect(within(row).getByText("locked")).toHaveAttribute("title", "on a USB disk");
  });

  it("should title a locked badge Locked when there is no reason", () => {
    const row = renderRow(linked({ locked: "" }));
    expect(within(row).getByText("locked")).toHaveAttribute("title", "Locked");
  });

  it("should show unknown HEAD when the head is null", () => {
    expect(within(renderRow(linked({ head: null }))).getByText("unknown HEAD")).toBeInTheDocument();
  });
});

// Contract: double-click and Enter open; Shift+F10, the ContextMenu key and right-click open the menu.
describe("WorktreeRow interaction", () => {
  it("should open on double-click", async () => {
    const row = renderRow(linked());
    await userEvent.dblClick(row);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("should open on Enter", () => {
    fireEvent.keyDown(renderRow(linked()), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("should not open on a single click", async () => {
    await userEvent.click(renderRow(linked()));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("should open the menu on Shift+F10 at the row's corner", () => {
    fireEvent.keyDown(renderRow(linked()), { key: "F10", shiftKey: true });
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(0, 0);
  });

  it("should open the menu on the ContextMenu key", () => {
    fireEvent.keyDown(renderRow(linked()), { key: "ContextMenu" });
    expect(onContextMenu).toHaveBeenCalledOnce();
  });

  it("should ignore F10 without Shift and other keys", () => {
    const row = renderRow(linked());
    fireEvent.keyDown(row, { key: "F10" });
    fireEvent.keyDown(row, { key: "a" });
    expect([onOpen, onContextMenu].map((f) => f.mock.calls.length)).toEqual([0, 0]);
  });

  it("should open the menu on right-click at the pointer", () => {
    fireEvent.contextMenu(renderRow(linked()), { clientX: 10, clientY: 20 });
    expect(onContextMenu).toHaveBeenCalledExactlyOnceWith(10, 20);
  });
});
