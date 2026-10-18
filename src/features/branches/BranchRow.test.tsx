import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LocalBranch, RemoteBranch, Tracking } from "../../lib/ipc";
import { BranchRow } from "./BranchRow";
import type { BranchRowProps, BranchTarget } from "./BranchRow";

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
