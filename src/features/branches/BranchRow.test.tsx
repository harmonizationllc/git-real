import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LocalBranch, RemoteBranch, Tracking } from "../../lib/ipc";
import { BranchRow } from "./BranchRow";
import type { BranchDrag, BranchRowProps, BranchTarget } from "./BranchRow";

const local = (over: Partial<LocalBranch> = {}): BranchTarget => ({
  kind: "local",
  branch: { name: "main", oid: "a".repeat(40), isHead: false, tracking: null, ...over },
});
const remote = (over: Partial<RemoteBranch> = {}): BranchTarget => ({
  kind: "remote",
  branch: { remote: "origin", name: "main", oid: "a".repeat(40), ...over },
});
const tracking = (over: Partial<Tracking> = {}): Tracking => ({
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  ...over,
});

function renderRow(over: Partial<BranchRowProps> = {}) {
  const props: BranchRowProps = {
    target: local(),
    current: false,
    onActivate: vi.fn(),
    onContextMenu: vi.fn(),
    ...over,
  };
  render(
    <ul>
      <BranchRow {...props} />
    </ul>,
  );
  return props;
}

const rowButton = () => screen.getByRole("button");

// Contract: the row shows the branch name and marks the current branch.
describe("BranchRow name and current marker", () => {
  it("should show the local branch name", () => {
    renderRow({ target: local({ name: "feature/x" }) });
    expect(screen.getByText("feature/x")).toBeInTheDocument();
  });

  it("should show the short name of a remote branch", () => {
    renderRow({ target: remote({ name: "other" }) });
    expect(screen.getByText("other")).toBeInTheDocument();
  });

  it("should render as a list item containing a button", () => {
    renderRow();
    expect(screen.getByRole("listitem")).toContainElement(rowButton());
  });

  it("should set aria-current to true when current", () => {
    renderRow({ current: true });
    expect(rowButton()).toHaveAttribute("aria-current", "true");
  });

  it("should add the current class when current", () => {
    renderRow({ current: true });
    expect(rowButton().className).toMatch(/current/);
  });

  it("should omit aria-current when not current", () => {
    renderRow({ current: false });
    expect(rowButton()).not.toHaveAttribute("aria-current");
  });

  it("should not add the current class when not current", () => {
    renderRow({ current: false });
    expect(rowButton().className).not.toMatch(/current/);
  });
});

// Contract: the title carries the full ref name.
describe("BranchRow title", () => {
  it("should title a local row with refs/heads/<name>", () => {
    renderRow({ target: local({ name: "main" }) });
    expect(rowButton()).toHaveAttribute("title", "refs/heads/main");
  });

  it("should title a remote row with refs/remotes/<remote>/<name>", () => {
    renderRow({ target: remote({ remote: "origin", name: "main" }) });
    expect(rowButton()).toHaveAttribute("title", "refs/remotes/origin/main");
  });

  it("should keep slashes in a branch name in the title", () => {
    renderRow({ target: remote({ remote: "origin", name: "feature/x" }) });
    expect(rowButton()).toHaveAttribute("title", "refs/remotes/origin/feature/x");
  });
});

// Contract: the tracking badge shows ahead/behind, gone, or nothing.
describe("BranchRow tracking badge", () => {
  it("should show the ahead and behind counts", () => {
    renderRow({ target: local({ tracking: tracking({ ahead: 2, behind: 1 }) }) });
    expect(screen.getByText("↑2 ↓1")).toBeInTheDocument();
  });

  it("should label the badge with the counts in words", () => {
    renderRow({ target: local({ tracking: tracking({ ahead: 2, behind: 1 }) }) });
    expect(screen.getByLabelText("2 ahead, 1 behind")).toHaveTextContent("↑2 ↓1");
  });

  it("should show gone when both counts are null", () => {
    renderRow({ target: local({ tracking: tracking({ ahead: null, behind: null }) }) });
    expect(screen.getByText("gone")).toBeInTheDocument();
  });

  it("should not show a count badge when the upstream is gone", () => {
    renderRow({ target: local({ tracking: tracking({ ahead: null, behind: null }) }) });
    expect(screen.queryByText(/↑/)).toBeNull();
  });

  it("should show no badge when the branch has no tracking", () => {
    renderRow({ target: local({ tracking: null }) });
    expect(screen.queryByText("gone")).toBeNull();
    expect(screen.queryByText(/↑/)).toBeNull();
  });

  it("should show no badge on a remote row", () => {
    renderRow({ target: remote() });
    expect(screen.queryByText(/↑/)).toBeNull();
  });
});

// Contract: double-click or Enter activates; a single click does not.
describe("BranchRow activation", () => {
  it("should call onActivate on double-click", async () => {
    const props = renderRow();
    await userEvent.dblClick(rowButton());
    expect(props.onActivate).toHaveBeenCalledOnce();
  });

  it("should call onActivate when Enter is pressed", () => {
    const props = renderRow();
    fireEvent.keyDown(rowButton(), { key: "Enter" });
    expect(props.onActivate).toHaveBeenCalledOnce();
  });

  it("should not call onActivate on a single click", async () => {
    const props = renderRow();
    await userEvent.click(rowButton());
    expect(props.onActivate).not.toHaveBeenCalled();
  });

  it("should not call onActivate for an unrelated key", () => {
    const props = renderRow();
    fireEvent.keyDown(rowButton(), { key: "a" });
    expect(props.onActivate).not.toHaveBeenCalled();
  });

  it("should not open the context menu on double-click", async () => {
    const props = renderRow();
    await userEvent.dblClick(rowButton());
    expect(props.onContextMenu).not.toHaveBeenCalled();
  });
});

// Contract: right-click, Shift+F10 and the ContextMenu key open the menu.
describe("BranchRow context menu", () => {
  it("should call onContextMenu with the pointer position on right-click", () => {
    const props = renderRow();
    fireEvent.contextMenu(rowButton(), { clientX: 12, clientY: 34 });
    expect(props.onContextMenu).toHaveBeenCalledExactlyOnceWith(12, 34);
  });

  it("should prevent the native context menu on right-click", () => {
    renderRow();
    const notPrevented = fireEvent.contextMenu(rowButton(), { clientX: 1, clientY: 2 });
    expect(notPrevented).toBe(false);
  });

  it("should open the menu at the row's left and bottom on Shift+F10", () => {
    const props = renderRow();
    vi.spyOn(rowButton(), "getBoundingClientRect").mockReturnValue({
      left: 7,
      bottom: 19,
    } as DOMRect);
    fireEvent.keyDown(rowButton(), { key: "F10", shiftKey: true });
    expect(props.onContextMenu).toHaveBeenCalledExactlyOnceWith(7, 19);
  });

  it("should open the menu at the row's left and bottom on the ContextMenu key", () => {
    const props = renderRow();
    vi.spyOn(rowButton(), "getBoundingClientRect").mockReturnValue({
      left: 3,
      bottom: 8,
    } as DOMRect);
    fireEvent.keyDown(rowButton(), { key: "ContextMenu" });
    expect(props.onContextMenu).toHaveBeenCalledExactlyOnceWith(3, 8);
  });

  it("should not open the menu on F10 without Shift", () => {
    const props = renderRow();
    fireEvent.keyDown(rowButton(), { key: "F10" });
    expect(props.onContextMenu).not.toHaveBeenCalled();
  });

  it("should not activate the row on Shift+F10", () => {
    const props = renderRow();
    fireEvent.keyDown(rowButton(), { key: "F10", shiftKey: true });
    expect(props.onActivate).not.toHaveBeenCalled();
  });

  it("should not open the menu on Enter", () => {
    const props = renderRow();
    fireEvent.keyDown(rowButton(), { key: "Enter" });
    expect(props.onContextMenu).not.toHaveBeenCalled();
  });
});

// Contract: keyboard menu keys suppress the native contextmenu so the menu opens once.
describe("BranchRow keyboard default handling", () => {
  it("should prevent the default action on Shift+F10", () => {
    renderRow();
    const notPrevented = fireEvent.keyDown(rowButton(), { key: "F10", shiftKey: true });
    expect(notPrevented).toBe(false);
  });

  it("should prevent the default action on the ContextMenu key", () => {
    renderRow();
    const notPrevented = fireEvent.keyDown(rowButton(), { key: "ContextMenu" });
    expect(notPrevented).toBe(false);
  });

  it("should not prevent the default action on an unrelated key", () => {
    renderRow();
    const notPrevented = fireEvent.keyDown(rowButton(), { key: "a" });
    expect(notPrevented).toBe(true);
  });
});

// Contract: the badge always shows both counts unless the upstream is gone.
describe("BranchRow tracking badge counts", () => {
  it("should show an ahead-only branch as ↑3 ↓0 with a matching label", () => {
    renderRow({ target: local({ tracking: tracking({ ahead: 3, behind: 0 }) }) });
    expect(screen.getByLabelText("3 ahead, 0 behind")).toHaveTextContent("↑3 ↓0");
  });

  it("should show a behind-only branch as ↑0 ↓4 with a matching label", () => {
    renderRow({ target: local({ tracking: tracking({ ahead: 0, behind: 4 }) }) });
    expect(screen.getByLabelText("0 ahead, 4 behind")).toHaveTextContent("↑0 ↓4");
  });

  it("should show an in-sync branch as ↑0 ↓0 rather than gone", () => {
    renderRow({ target: local({ tracking: tracking({ ahead: 0, behind: 0 }) }) });
    expect(screen.getByText("↑0 ↓0")).toBeInTheDocument();
    expect(screen.queryByText("gone")).toBeNull();
  });

  it("should show gone when only one count is null", () => {
    renderRow({ target: local({ tracking: tracking({ ahead: null, behind: 2 }) }) });
    expect(screen.getByText("gone")).toBeInTheDocument();
    expect(screen.queryByText(/↑/)).toBeNull();
  });

  it("should not label the gone badge with counts", () => {
    renderRow({ target: local({ tracking: tracking({ ahead: null, behind: null }) }) });
    expect(screen.getByText("gone")).not.toHaveAttribute("aria-label");
  });
});

// Contract: the row reports Enter even when current; the panel decides whether to act.
describe("BranchRow Enter on the current branch", () => {
  it("should still call onActivate once so the container owns the current-branch rule", () => {
    const { onActivate } = renderRow({ target: local({ isHead: true }), current: true });
    fireEvent.keyDown(rowButton(), { key: "Enter" });
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

const dragProps = (over: Partial<BranchDrag> = {}): BranchDrag => ({
  draggable: true,
  target: false,
  over: false,
  onDragStart: vi.fn(),
  onDragEnd: vi.fn(),
  onDragEnter: vi.fn(),
  onDragLeave: vi.fn(),
  onDrop: vi.fn(),
  ...over,
});
const fakeTransfer = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });
const item = () => screen.getByRole("listitem");

// Contract: without the drag prop the row is inert to drag and drop.
describe("BranchRow without drag", () => {
  it("should not be draggable", () => {
    renderRow();
    expect(item()).not.toHaveAttribute("draggable");
  });

  it("should not prevent dragover", () => {
    renderRow();
    expect(fireEvent.dragOver(item())).toBe(true);
  });

  it("should not carry a drop-over marker", () => {
    renderRow();
    expect(item()).not.toHaveAttribute("data-drop-over");
  });
});

// Contract: a draggable row can be picked up and announces the branch id to the browser.
describe("BranchRow drag source", () => {
  it("should be draggable when drag.draggable is true", () => {
    renderRow({ drag: dragProps({ draggable: true }) });
    expect(item()).toHaveAttribute("draggable", "true");
  });

  it("should not be draggable when drag.draggable is false", () => {
    renderRow({ drag: dragProps({ draggable: false }) });
    expect(item()).not.toHaveAttribute("draggable", "true");
  });

  it("should call onDragStart on dragstart", () => {
    const drag = dragProps();
    renderRow({ drag });
    fireEvent.dragStart(item(), { dataTransfer: fakeTransfer() });
    expect(drag.onDragStart).toHaveBeenCalledOnce();
  });

  it("should set effectAllowed to move on dragstart", () => {
    const dataTransfer = fakeTransfer();
    renderRow({ drag: dragProps() });
    fireEvent.dragStart(item(), { dataTransfer });
    expect(dataTransfer.effectAllowed).toBe("move");
  });

  it("should set the local branch name as text/plain data on dragstart", () => {
    const dataTransfer = fakeTransfer();
    renderRow({ target: local({ name: "feature" }), drag: dragProps() });
    fireEvent.dragStart(item(), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledExactlyOnceWith("text/plain", "feature");
  });

  it("should set the remote-qualified name as text/plain data for a remote branch", () => {
    const dataTransfer = fakeTransfer();
    renderRow({ target: remote({ remote: "origin", name: "other" }), drag: dragProps() });
    fireEvent.dragStart(item(), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledExactlyOnceWith("text/plain", "origin/other");
  });

  it("should call onDragEnd on dragend", () => {
    const drag = dragProps();
    renderRow({ drag });
    fireEvent.dragEnd(item());
    expect(drag.onDragEnd).toHaveBeenCalledOnce();
  });

  it("should not call onDragStart before any drag", () => {
    const drag = dragProps();
    renderRow({ drag });
    expect(drag.onDragStart).not.toHaveBeenCalled();
  });
});

// Contract: only the drop target reacts to enter, leave, over and drop.
describe("BranchRow drop target", () => {
  it("should call onDragEnter on dragenter when it is the target", () => {
    const drag = dragProps({ target: true });
    renderRow({ drag });
    fireEvent.dragEnter(item());
    expect(drag.onDragEnter).toHaveBeenCalledOnce();
  });

  it("should call onDragLeave on dragleave when it is the target", () => {
    const drag = dragProps({ target: true });
    renderRow({ drag });
    fireEvent.dragLeave(item());
    expect(drag.onDragLeave).toHaveBeenCalledOnce();
  });

  it("should prevent the default action on dragover so the drop is accepted", () => {
    renderRow({ drag: dragProps({ target: true }) });
    expect(fireEvent.dragOver(item(), { dataTransfer: fakeTransfer() })).toBe(false);
  });

  it("should set dropEffect to move on dragover", () => {
    const dataTransfer = fakeTransfer();
    renderRow({ drag: dragProps({ target: true }) });
    fireEvent.dragOver(item(), { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("move");
  });

  it("should call onDrop with the pointer position on drop", () => {
    const drag = dragProps({ target: true });
    renderRow({ drag });
    fireEvent.drop(item(), { clientX: 10, clientY: 20 });
    expect(drag.onDrop).toHaveBeenCalledExactlyOnceWith(10, 20);
  });

  it("should prevent the default action on drop", () => {
    renderRow({ drag: dragProps({ target: true }) });
    expect(fireEvent.drop(item(), { clientX: 1, clientY: 2 })).toBe(false);
  });

  it("should mark the row with data-drop-over while over", () => {
    renderRow({ drag: dragProps({ target: true, over: true }) });
    expect(item()).toHaveAttribute("data-drop-over", "true");
  });

  it("should omit data-drop-over when not over", () => {
    renderRow({ drag: dragProps({ target: true, over: false }) });
    expect(item()).not.toHaveAttribute("data-drop-over");
  });
});

// Contract: a row that is not the target neither accepts nor reports a drop.
describe("BranchRow non-target", () => {
  it("should not prevent dragover", () => {
    renderRow({ drag: dragProps({ target: false }) });
    expect(fireEvent.dragOver(item(), { dataTransfer: fakeTransfer() })).toBe(true);
  });

  it("should not set dropEffect on dragover", () => {
    const dataTransfer = fakeTransfer();
    renderRow({ drag: dragProps({ target: false }) });
    fireEvent.dragOver(item(), { dataTransfer });
    expect(dataTransfer.dropEffect).toBe("");
  });

  it("should not call onDrop on drop", () => {
    const drag = dragProps({ target: false });
    renderRow({ drag });
    fireEvent.drop(item(), { clientX: 10, clientY: 20 });
    expect(drag.onDrop).not.toHaveBeenCalled();
  });

  it("should not prevent the default action on drop", () => {
    renderRow({ drag: dragProps({ target: false }) });
    expect(fireEvent.drop(item(), { clientX: 1, clientY: 2 })).toBe(true);
  });

  it("should not call onDragEnter on dragenter", () => {
    const drag = dragProps({ target: false });
    renderRow({ drag });
    fireEvent.dragEnter(item());
    expect(drag.onDragEnter).not.toHaveBeenCalled();
  });

  it("should not call onDragLeave on dragleave", () => {
    const drag = dragProps({ target: false });
    renderRow({ drag });
    fireEvent.dragLeave(item());
    expect(drag.onDragLeave).not.toHaveBeenCalled();
  });
});
