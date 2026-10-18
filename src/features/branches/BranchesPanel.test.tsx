import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkoutBranch,
  checkoutRemoteBranch,
  createBranch,
  deleteBranch,
  deleteRemoteBranch,
  listBranches,
  renameBranch,
} from "../../lib/ipc";
import type { AppError, BranchList, HeadState, LocalBranch } from "../../lib/ipc";
import { renderWithProviders } from "../../test/renderWithProviders";
import { BranchesPanel } from "./BranchesPanel";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listBranches: vi.fn(),
  createBranch: vi.fn(),
  renameBranch: vi.fn(),
  deleteBranch: vi.fn(),
  checkoutBranch: vi.fn(),
  checkoutRemoteBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
}));

const oid = (c: string) => c.repeat(40);
const localBranch = (name: string, isHead = false): LocalBranch => ({
  name,
  oid: oid("a"),
  isHead,
  tracking: null,
});
const list = (over: Partial<BranchList> = {}): BranchList => ({
  head: { kind: "branch", name: "main" },
  local: [localBranch("main", true), localBranch("feature")],
  remotes: [
    {
      remote: "origin",
      branches: [
        { remote: "origin", name: "main", oid: oid("a") },
        { remote: "origin", name: "other", oid: oid("b") },
      ],
    },
  ],
  ...over,
});

const notMerged: AppError = { kind: "branchNotMerged", message: "not fully merged" };
const checkoutFailed: AppError = {
  kind: "checkoutFailed",
  message: "error: Your local changes would be overwritten",
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<undefined>((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listBranches).mockResolvedValue(list());
  vi.mocked(createBranch).mockResolvedValue(localBranch("topic"));
  vi.mocked(renameBranch).mockResolvedValue(undefined);
  vi.mocked(deleteBranch).mockResolvedValue(undefined);
  vi.mocked(checkoutBranch).mockResolvedValue(undefined);
  vi.mocked(checkoutRemoteBranch).mockResolvedValue(undefined);
  vi.mocked(deleteRemoteBranch).mockResolvedValue(undefined);
});

async function renderPanel(data: BranchList = list()) {
  vi.mocked(listBranches).mockResolvedValue(data);
  const view = renderWithProviders(<BranchesPanel repoId={1} />);
  await screen.findByRole("region", { name: "Branches" });
  await screen.findByRole("heading", { name: "Local" });
  return view;
}

const localRow = (name: string) => screen.getByTitle(`refs/heads/${name}`);
const remoteRow = (remote: string, name: string) =>
  screen.getByTitle(`refs/remotes/${remote}/${name}`);
const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 40, clientY: 60 });
const itemLabels = () => screen.getAllByRole("menuitem").map((i) => i.textContent);
const menuItem = (name: string) => screen.getByRole("menuitem", { name });
const dialogNamed = (name: string) => screen.findByRole("dialog", { name });

// Contract: groups, current marker and region.
describe("BranchesPanel rendering", () => {
  it("should render the Branches region", async () => {
    await renderPanel();
    expect(screen.getByRole("region", { name: "Branches" })).toBeInTheDocument();
  });

  it("should render a Local group and a group per remote", async () => {
    await renderPanel();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Local",
      "origin",
    ]);
  });

  it("should list the local and remote branches", async () => {
    await renderPanel();
    expect(localRow("feature")).toBeInTheDocument();
    expect(remoteRow("origin", "other")).toBeInTheDocument();
  });

  it("should mark the HEAD branch as current", async () => {
    await renderPanel();
    expect(localRow("main")).toHaveAttribute("aria-current", "true");
  });

  it("should not mark other branches as current", async () => {
    await renderPanel();
    expect(localRow("feature")).not.toHaveAttribute("aria-current");
    expect(remoteRow("origin", "main")).not.toHaveAttribute("aria-current");
  });

  it("should request the branch list for the repo id", async () => {
    await renderPanel();
    expect(listBranches).toHaveBeenCalledWith(1);
  });

  it("should show No branches in an empty remote group", async () => {
    await renderPanel(list({ remotes: [{ remote: "origin", branches: [] }] }));
    expect(screen.getByText("No branches")).toBeInTheDocument();
  });

  it("should not be busy when idle", async () => {
    await renderPanel();
    expect(screen.getByRole("region", { name: "Branches" })).not.toHaveAttribute("aria-busy");
  });
});

// Contract: the filter narrows rows, keeps empty groups, and Escape clears it.
describe("BranchesPanel filter", () => {
  const filter = () => screen.getByRole("searchbox", { name: "Filter branches" });

  it("should have a filter input with the placeholder Filter branches", async () => {
    await renderPanel();
    expect(filter()).toHaveAttribute("placeholder", "Filter branches");
  });

  it("should narrow the rows to the matches", async () => {
    const { user } = await renderPanel();
    await user.type(filter(), "oth");
    expect(remoteRow("origin", "other")).toBeInTheDocument();
    expect(screen.queryByTitle("refs/remotes/origin/main")).toBeNull();
    expect(screen.queryByTitle("refs/heads/main")).toBeNull();
  });

  it("should show No matches in a group with no matches", async () => {
    const { user } = await renderPanel();
    await user.type(filter(), "oth");
    const local = screen.getByRole("region", { name: "Local" });
    expect(within(local).getByText("No matches")).toBeInTheDocument();
  });

  it("should match remote branches by their remote prefix", async () => {
    const { user } = await renderPanel();
    await user.type(filter(), "origin/o");
    expect(remoteRow("origin", "other")).toBeInTheDocument();
    expect(screen.queryByTitle("refs/remotes/origin/main")).toBeNull();
  });

  it("should match case-insensitively", async () => {
    const { user } = await renderPanel();
    await user.type(filter(), "FEAT");
    expect(localRow("feature")).toBeInTheDocument();
  });

  it("should clear the filter on Escape", async () => {
    const { user } = await renderPanel();
    await user.type(filter(), "oth");
    await user.keyboard("{Escape}");
    expect(filter()).toHaveValue("");
    expect(localRow("main")).toBeInTheDocument();
  });

  it("should not refetch while filtering", async () => {
    const { user } = await renderPanel();
    await user.type(filter(), "oth");
    expect(listBranches).toHaveBeenCalledTimes(1);
  });
});

// Contract: double-click or Enter checks out; the current branch is ignored.
describe("BranchesPanel activation", () => {
  it("should check out a local branch on double-click", async () => {
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    expect(checkoutBranch).toHaveBeenCalledExactlyOnceWith(1, "feature");
  });

  it("should check out a local branch on Enter", async () => {
    const { user } = await renderPanel();
    localRow("feature").focus();
    await user.keyboard("{Enter}");
    expect(checkoutBranch).toHaveBeenCalledExactlyOnceWith(1, "feature");
  });

  it("should not check out the current branch on double-click", async () => {
    const { user } = await renderPanel();
    await user.dblClick(localRow("main"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("should not check out the current branch on Enter", async () => {
    const { user } = await renderPanel();
    localRow("main").focus();
    await user.keyboard("{Enter}");
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("should check out a remote branch on double-click", async () => {
    const { user } = await renderPanel();
    await user.dblClick(remoteRow("origin", "other"));
    expect(checkoutRemoteBranch).toHaveBeenCalledExactlyOnceWith(1, "origin", "other");
  });

  it("should not call checkoutBranch for a remote double-click", async () => {
    const { user } = await renderPanel();
    await user.dblClick(remoteRow("origin", "other"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("should not check out on a single click", async () => {
    const { user } = await renderPanel();
    await user.click(localRow("feature"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("should show a checkout failure as an alert with its message", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue(checkoutFailed);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    expect(await screen.findByRole("alert")).toHaveTextContent(checkoutFailed.message);
  });

  it("should clear the failure alert on Dismiss", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue(checkoutFailed);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should show a remote checkout failure as an alert", async () => {
    vi.mocked(checkoutRemoteBranch).mockRejectedValue(checkoutFailed);
    const { user } = await renderPanel();
    await user.dblClick(remoteRow("origin", "other"));
    expect(await screen.findByRole("alert")).toHaveTextContent(checkoutFailed.message);
  });
});

// Contract: context menu items per row type.
describe("BranchesPanel context menu", () => {
  it("should offer Checkout, Create, Rename and Delete on a local branch", async () => {
    await renderPanel();
    rightClick(localRow("feature"));
    expect(itemLabels()).toEqual(["Checkout", "Create branch here…", "Rename…", "Delete…"]);
  });

  it("should enable every item on a non-current local branch", async () => {
    await renderPanel();
    rightClick(localRow("feature"));
    for (const item of screen.getAllByRole("menuitem")) expect(item).toBeEnabled();
  });

  it("should disable Checkout on the current branch", async () => {
    await renderPanel();
    rightClick(localRow("main"));
    expect(menuItem("Checkout")).toBeDisabled();
  });

  it("should disable Delete on the current branch", async () => {
    await renderPanel();
    rightClick(localRow("main"));
    expect(menuItem("Delete…")).toBeDisabled();
  });

  it("should keep Create and Rename enabled on the current branch", async () => {
    await renderPanel();
    rightClick(localRow("main"));
    expect(menuItem("Create branch here…")).toBeEnabled();
    expect(menuItem("Rename…")).toBeEnabled();
  });

  it("should give Checkout no title on a local branch", async () => {
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem("Checkout")).not.toHaveAttribute("title");
  });

  it("should offer Checkout and Delete on origin… on a remote branch", async () => {
    await renderPanel();
    rightClick(remoteRow("origin", "other"));
    expect(itemLabels()).toEqual(["Checkout", "Delete on origin…"]);
  });

  it("should explain that remote Checkout creates a tracking branch when no local exists", async () => {
    await renderPanel();
    rightClick(remoteRow("origin", "other"));
    expect(menuItem("Checkout")).toHaveAttribute(
      "title",
      "Creates a local branch tracking origin/other",
    );
  });

  it("should give remote Checkout no title when a local branch of that name exists", async () => {
    await renderPanel();
    rightClick(remoteRow("origin", "main"));
    expect(menuItem("Checkout")).not.toHaveAttribute("title");
  });

  it("should check out the local branch from the menu", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Checkout"));
    expect(checkoutBranch).toHaveBeenCalledExactlyOnceWith(1, "feature");
  });

  it("should check out the remote branch from the menu", async () => {
    const { user } = await renderPanel();
    rightClick(remoteRow("origin", "other"));
    await user.click(menuItem("Checkout"));
    expect(checkoutRemoteBranch).toHaveBeenCalledExactlyOnceWith(1, "origin", "other");
  });

  it("should close the menu after Checkout", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Checkout"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should open the menu from the keyboard with Shift+F10", async () => {
    await renderPanel();
    fireEvent.keyDown(localRow("feature"), { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("should show no menu until a row is right-clicked", async () => {
    await renderPanel();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

// Contract: create dialog from the header button and from the row menu.
describe("BranchesPanel create", () => {
  it("should open the New branch dialog from the New branch… button", async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    expect(await dialogNamed("New branch")).toBeInTheDocument();
  });

  it("should label the field Name and default Switch to new branch to checked", async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const dialog = await dialogNamed("New branch");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("");
    expect(within(dialog).getByLabelText("Switch to new branch")).toBeChecked();
  });

  it("should create from HEAD and switch when confirmed", async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const dialog = await dialogNamed("New branch");
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createBranch).toHaveBeenCalledExactlyOnceWith(1, "topic", null, true);
  });

  it("should close the dialog when creation succeeds", async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const dialog = await dialogNamed("New branch");
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("should open New branch from <name> with that start point from the menu", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Create branch here…"));
    const dialog = await dialogNamed("New branch from feature");
    await user.type(within(dialog).getByLabelText("Name"), "x");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createBranch).toHaveBeenCalledExactlyOnceWith(1, "x", "feature", true);
  });

  it("should create without switching when the checkbox is unchecked", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Create branch here…"));
    const dialog = await dialogNamed("New branch from feature");
    await user.type(within(dialog).getByLabelText("Name"), "x");
    await user.click(within(dialog).getByLabelText("Switch to new branch"));
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createBranch).toHaveBeenCalledExactlyOnceWith(1, "x", "feature", false);
  });

  it("should keep the dialog open and show the error inline when creation fails", async () => {
    vi.mocked(createBranch).mockRejectedValue({ kind: "branchExists", message: "taken" });
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const dialog = await dialogNamed("New branch");
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("taken");
  });

  it("should show the creation error only once, not also in the panel", async () => {
    vi.mocked(createBranch).mockRejectedValue({ kind: "branchExists", message: "taken" });
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const dialog = await dialogNamed("New branch");
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await within(dialog).findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("should clear the error and show no alert when the dialog is cancelled", async () => {
    vi.mocked(createBranch).mockRejectedValue({ kind: "branchExists", message: "taken" });
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const dialog = await dialogNamed("New branch");
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await within(dialog).findByRole("alert");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should not show an earlier action error inside a newly opened dialog", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue(checkoutFailed);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    await dialogNamed("New branch");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should disable New branch… with a Make a commit first title on an unborn HEAD", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      list({ head: { kind: "unborn", name: "main" }, local: [] }),
    );
    renderWithProviders(<BranchesPanel repoId={1} />);
    const button = await screen.findByRole("button", { name: "New branch…" });
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute("title", "Make a commit first");
  });

  it("should enable New branch… with no title on a born HEAD", async () => {
    await renderPanel();
    const button = screen.getByRole("button", { name: "New branch…" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("title");
  });
});

// Contract: rename dialog.
describe("BranchesPanel rename", () => {
  it("should open Rename <name> with the current name as the initial value", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Rename…"));
    const dialog = await dialogNamed("Rename feature");
    expect(within(dialog).getByLabelText("New name")).toHaveValue("feature");
  });

  it("should rename to the typed name when confirmed", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Rename…"));
    const dialog = await dialogNamed("Rename feature");
    const input = within(dialog).getByLabelText("New name");
    await user.clear(input);
    await user.type(input, "topic");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(renameBranch).toHaveBeenCalledExactlyOnceWith(1, "feature", "topic");
  });

  it("should close the dialog when the rename succeeds", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Rename…"));
    const dialog = await dialogNamed("Rename feature");
    const input = within(dialog).getByLabelText("New name");
    await user.clear(input);
    await user.type(input, "topic");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("should keep the dialog open with the error inline when the rename fails", async () => {
    vi.mocked(renameBranch).mockRejectedValue({ kind: "branchExists", message: "taken" });
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Rename…"));
    const dialog = await dialogNamed("Rename feature");
    const input = within(dialog).getByLabelText("New name");
    await user.clear(input);
    await user.type(input, "main");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("taken");
  });
});

// Contract: local delete, then the force-delete hand-off on branchNotMerged.
describe("BranchesPanel delete", () => {
  async function openDelete(user: Awaited<ReturnType<typeof renderPanel>>["user"]) {
    rightClick(localRow("feature"));
    await user.click(menuItem("Delete…"));
    return dialogNamed("Delete branch feature?");
  }

  it("should ask for confirmation with the merged copy", async () => {
    const { user } = await renderPanel();
    const dialog = await openDelete(user);
    expect(dialog).toHaveTextContent("The branch is merged into the current branch.");
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it("should delete without force when confirmed", async () => {
    const { user } = await renderPanel();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(deleteBranch).toHaveBeenCalledExactlyOnceWith(1, "feature", false);
  });

  it("should close the dialog when the delete succeeds", async () => {
    const { user } = await renderPanel();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("should not delete when cancelled", async () => {
    const { user } = await renderPanel();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deleteBranch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should open the force-delete dialog on branchNotMerged", async () => {
    vi.mocked(deleteBranch).mockRejectedValueOnce(notMerged);
    const { user } = await renderPanel();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    const force = await dialogNamed("Force delete feature?");
    expect(force).toHaveTextContent(
      "feature has commits that are not merged into the current branch. Deleting it loses them unless another ref points at them.",
    );
  });

  it("should replace the first dialog and show no alert while the force dialog is open", async () => {
    vi.mocked(deleteBranch).mockRejectedValueOnce(notMerged);
    const { user } = await renderPanel();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await dialogNamed("Force delete feature?");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should delete with force when the force dialog is confirmed", async () => {
    vi.mocked(deleteBranch).mockRejectedValueOnce(notMerged);
    const { user } = await renderPanel();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    const force = await dialogNamed("Force delete feature?");
    await user.click(within(force).getByRole("button", { name: "Force delete" }));
    expect(deleteBranch).toHaveBeenLastCalledWith(1, "feature", true);
  });

  it("should close the force dialog when the forced delete succeeds", async () => {
    vi.mocked(deleteBranch).mockRejectedValueOnce(notMerged);
    const { user } = await renderPanel();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    const force = await dialogNamed("Force delete feature?");
    await user.click(within(force).getByRole("button", { name: "Force delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("should clear the error when the force dialog is cancelled", async () => {
    vi.mocked(deleteBranch).mockRejectedValueOnce(notMerged);
    const { user } = await renderPanel();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    const force = await dialogNamed("Force delete feature?");
    await user.click(within(force).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should close the dialog and show the error in the panel on another failure", async () => {
    vi.mocked(deleteBranch).mockRejectedValue({ kind: "io", message: "disk exploded" });
    const { user } = await renderPanel();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk exploded");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should close the force dialog and show the error when the forced delete fails", async () => {
    vi.mocked(deleteBranch)
      .mockRejectedValueOnce(notMerged)
      .mockRejectedValueOnce({ kind: "io", message: "disk exploded" });
    const { user } = await renderPanel();
    const dialog = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    const force = await dialogNamed("Force delete feature?");
    await user.click(within(force).getByRole("button", { name: "Force delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk exploded");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// Contract: remote delete.
describe("BranchesPanel delete on remote", () => {
  async function openRemoteDelete(user: Awaited<ReturnType<typeof renderPanel>>["user"]) {
    rightClick(remoteRow("origin", "other"));
    await user.click(menuItem("Delete on origin…"));
    return dialogNamed("Delete origin/other on origin?");
  }

  it("should warn that the branch is removed for everyone", async () => {
    const { user } = await renderPanel();
    const dialog = await openRemoteDelete(user);
    expect(dialog).toHaveTextContent("This removes the branch from the remote for everyone.");
    expect(deleteRemoteBranch).not.toHaveBeenCalled();
  });

  it("should delete on the remote when confirmed", async () => {
    const { user } = await renderPanel();
    const dialog = await openRemoteDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete on origin" }));
    expect(deleteRemoteBranch).toHaveBeenCalledExactlyOnceWith(1, "origin", "other");
  });

  it("should close the dialog when the remote delete succeeds", async () => {
    const { user } = await renderPanel();
    const dialog = await openRemoteDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete on origin" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("should close the dialog and show the push error in the panel when it fails", async () => {
    vi.mocked(deleteRemoteBranch).mockRejectedValue({
      kind: "pushFailed",
      message: "remote: permission denied",
    });
    const { user } = await renderPanel();
    const dialog = await openRemoteDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Delete on origin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("remote: permission denied");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should not delete when cancelled", async () => {
    const { user } = await renderPanel();
    const dialog = await openRemoteDelete(user);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(deleteRemoteBranch).not.toHaveBeenCalled();
  });
});

// Contract: head states render a non-interactive row; unborn disables creation.
describe("BranchesPanel head states", () => {
  const detached: HeadState = { kind: "detached", oid: "0123abcdef".padEnd(40, "0") };

  it("should show Detached at <7 hex> in the Local group", async () => {
    await renderPanel(list({ head: detached }));
    const local = screen.getByRole("region", { name: "Local" });
    expect(within(local).getByText("Detached at 0123abc")).toBeInTheDocument();
  });

  it("should mark the detached row as current", async () => {
    await renderPanel(list({ head: detached }));
    expect(screen.getByText("Detached at 0123abc").closest("[aria-current]")).not.toBeNull();
  });

  it("should render the detached row without an interactive button", async () => {
    await renderPanel(list({ head: detached }));
    expect(screen.queryByRole("button", { name: /Detached at/ })).toBeNull();
  });

  it("should show the detached row before the local branches", async () => {
    await renderPanel(list({ head: detached, local: [localBranch("feature")] }));
    const row = screen.getByText("Detached at 0123abc");
    expect(row.compareDocumentPosition(localRow("feature"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("should show <name> (no commits yet) on an unborn HEAD", async () => {
    await renderPanel(list({ head: { kind: "unborn", name: "main" }, local: [] }));
    expect(screen.getByText("main (no commits yet)")).toBeInTheDocument();
  });

  it("should mark the unborn row as current and non-interactive", async () => {
    await renderPanel(list({ head: { kind: "unborn", name: "main" }, local: [] }));
    expect(screen.getByText("main (no commits yet)").closest("[aria-current]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /no commits yet/ })).toBeNull();
  });

  it("should show no head-state row on a normal branch", async () => {
    await renderPanel();
    expect(screen.queryByText(/Detached at/)).toBeNull();
    expect(screen.queryByText(/no commits yet/)).toBeNull();
  });
});

// Contract: query errors show a RepoError with Retry.
describe("BranchesPanel query errors", () => {
  it("should show the list error with its message", async () => {
    vi.mocked(listBranches).mockRejectedValueOnce({ kind: "io", message: "list exploded" });
    renderWithProviders(<BranchesPanel repoId={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("list exploded");
  });

  it("should list the branches again when Retry is clicked", async () => {
    vi.mocked(listBranches)
      .mockRejectedValueOnce({ kind: "io", message: "list exploded" })
      .mockResolvedValue(list());
    const { user } = renderWithProviders(<BranchesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(listBranches).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("heading", { name: "Local" })).toBeInTheDocument();
  });

  it("should not render branch rows while the list is in error", async () => {
    vi.mocked(listBranches).mockRejectedValueOnce({ kind: "io", message: "list exploded" });
    renderWithProviders(<BranchesPanel repoId={1} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("list")).toBeNull();
  });
});

// Contract: while an action runs the panel is busy, menus are disabled and dialogs cannot close.
describe("BranchesPanel pending", () => {
  it("should set aria-busy on the region while an action is pending", async () => {
    const d = deferred();
    vi.mocked(checkoutBranch).mockReturnValue(d.promise);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Branches" })).toHaveAttribute("aria-busy", "true"),
    );
    d.resolve();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Branches" })).not.toHaveAttribute("aria-busy"),
    );
  });

  it("should disable the menu items while an action is pending", async () => {
    vi.mocked(checkoutBranch).mockReturnValue(new Promise<void>(() => {}));
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Branches" })).toHaveAttribute("aria-busy", "true"),
    );
    rightClick(localRow("feature"));
    for (const item of screen.getAllByRole("menuitem")) expect(item).toBeDisabled();
  });

  async function openPendingCreate() {
    const d = deferred();
    vi.mocked(createBranch).mockReturnValue(d.promise.then(() => localBranch("topic")));
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const dialog = await dialogNamed("New branch");
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Working…" })).toBeDisabled(),
    );
    return { d, dialog, user };
  }

  it("should show Working… on the prompt confirm while the create is pending", async () => {
    const { dialog } = await openPendingCreate();
    expect(within(dialog).getByRole("button", { name: "Working…" })).toBeDisabled();
  });

  it("should keep the prompt dialog open when Cancel is clicked while pending", async () => {
    const { dialog, user } = await openPendingCreate();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "New branch" })).toBeInTheDocument();
  });

  it("should keep the prompt dialog open on Escape while pending", async () => {
    const { dialog } = await openPendingCreate();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "New branch" })).toBeInTheDocument();
  });

  it("should keep the prompt dialog open on a backdrop click while pending", async () => {
    const { dialog } = await openPendingCreate();
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(screen.getByRole("dialog", { name: "New branch" })).toBeInTheDocument();
  });

  it("should close the prompt dialog once the pending create succeeds", async () => {
    const { d } = await openPendingCreate();
    d.resolve();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  async function openPendingDelete() {
    const d = deferred();
    vi.mocked(deleteBranch).mockReturnValue(d.promise);
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Delete…"));
    const dialog = await dialogNamed("Delete branch feature?");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Working…" })).toBeDisabled(),
    );
    return { d, dialog, user };
  }

  it("should show Working… on the confirm button while the delete is pending", async () => {
    const { dialog } = await openPendingDelete();
    expect(within(dialog).getByRole("button", { name: "Working…" })).toBeDisabled();
  });

  it("should keep the confirm dialog open when Cancel is clicked while pending", async () => {
    const { dialog, user } = await openPendingDelete();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Delete branch feature?" })).toBeInTheDocument();
  });

  it("should keep the confirm dialog open on Escape while pending", async () => {
    const { dialog } = await openPendingDelete();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Delete branch feature?" })).toBeInTheDocument();
  });

  it("should keep the confirm dialog open on a backdrop click while pending", async () => {
    const { dialog } = await openPendingDelete();
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(screen.getByRole("dialog", { name: "Delete branch feature?" })).toBeInTheDocument();
  });

  it("should not call deleteBranch twice when the pending confirm is clicked again", async () => {
    const { dialog, user } = await openPendingDelete();
    await user.click(within(dialog).getByRole("button", { name: "Working…" }));
    expect(deleteBranch).toHaveBeenCalledOnce();
  });

  it("should close the confirm dialog once the pending delete succeeds", async () => {
    const { d } = await openPendingDelete();
    d.resolve();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("should let Escape close an idle confirm dialog", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Delete…"));
    await dialogNamed("Delete branch feature?");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
