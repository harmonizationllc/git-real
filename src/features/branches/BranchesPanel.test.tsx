import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkoutBranch,
  checkoutRemoteBranch,
  createBranch,
  deleteBranch,
  deleteRemoteBranch,
  listBranches,
  rebasePlan,
  renameBranch,
} from "../../lib/ipc";
import type {
  AppError,
  BranchList,
  FastForwardCheck,
  HeadState,
  LocalBranch,
  OperationState,
  RebaseCommit,
} from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { renderWithProviders } from "../../test/renderWithProviders";
import { IN_PROGRESS_TITLE } from "../merge/operationCopy";
import { useCanFastForward } from "../merge/useCanFastForward";
import { useIntegrationActions } from "../merge/useIntegrationActions";
import type { UseIntegrationActions } from "../merge/useIntegrationActions";
import { useOperationState } from "../merge/useOperationState";
import { BranchesPanel } from "./BranchesPanel";

vi.mock("../merge/useOperationState", () => ({ useOperationState: vi.fn() }));
vi.mock("../merge/useIntegrationActions", () => ({ useIntegrationActions: vi.fn() }));
vi.mock("../merge/useCanFastForward", () => ({ useCanFastForward: vi.fn() }));

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listBranches: vi.fn(),
  createBranch: vi.fn(),
  renameBranch: vi.fn(),
  deleteBranch: vi.fn(),
  checkoutBranch: vi.fn(),
  checkoutRemoteBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
  rebasePlan: vi.fn(),
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

const integrationRun = vi.fn<UseIntegrationActions["run"]>();
const integrationClear = vi.fn();

/** Drives the three merge hooks; defaults model a clean repository where fast-forward is possible. */
function provideMerge(
  opts: {
    state?: OperationState | undefined;
    check?: FastForwardCheck | undefined;
    checking?: boolean;
    pending?: boolean;
    error?: AppError | null;
  } = {},
) {
  const { check = "possible", checking = false } = opts;
  const state = "state" in opts ? opts.state : ({ kind: "none" } as const);
  vi.mocked(useOperationState).mockReturnValue({ state, error: null, refetch: vi.fn() });
  vi.mocked(useCanFastForward).mockReturnValue({ check, isLoading: checking });
  vi.mocked(useIntegrationActions).mockReturnValue({
    run: integrationRun,
    pending: opts.pending ?? false,
    error: opts.error ?? null,
    clearError: integrationClear,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspace.setState({ refsFilter: {} });
  integrationRun.mockResolvedValue(null);
  provideMerge();
  vi.mocked(listBranches).mockResolvedValue(list());
  vi.mocked(createBranch).mockResolvedValue(localBranch("topic"));
  vi.mocked(renameBranch).mockResolvedValue(undefined);
  vi.mocked(deleteBranch).mockResolvedValue(undefined);
  vi.mocked(checkoutBranch).mockResolvedValue(undefined);
  vi.mocked(checkoutRemoteBranch).mockResolvedValue(undefined);
  vi.mocked(deleteRemoteBranch).mockResolvedValue(undefined);
  vi.mocked(rebasePlan).mockResolvedValue([]);
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
  const filter = () => screen.getByRole("searchbox", { name: "Filter branches and tags" });

  it("should have a filter input labelled and placeholdered Filter branches and tags", async () => {
    await renderPanel();
    expect(filter()).toHaveAttribute("placeholder", "Filter branches and tags");
  });

  it("should write the filter text to the workspace store for the repo", async () => {
    const { user } = await renderPanel();
    await user.type(filter(), "fe");
    expect(useWorkspace.getState().refsFilter[1]).toBe("fe");
  });

  it("should show the stored filter text on mount and filter by it", async () => {
    useWorkspace.getState().setRefsFilter(1, "feat");
    await renderPanel();
    expect(filter()).toHaveValue("feat");
    expect(localRow("feature")).toBeInTheDocument();
    expect(screen.queryByTitle("refs/heads/main")).toBeNull();
  });

  it("should clear the stored filter text on Escape", async () => {
    const { user } = await renderPanel();
    await user.type(filter(), "oth");
    await user.keyboard("{Escape}");
    expect(useWorkspace.getState().refsFilter[1]).toBe("");
  });

  it("should not read the filter text of another repo", async () => {
    useWorkspace.getState().setRefsFilter(2, "feat");
    await renderPanel();
    expect(filter()).toHaveValue("");
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
    expect(itemLabels()).toEqual([
      "Checkout",
      "Merge feature into main",
      "Fast-forward main to feature",
      "Rebase main onto feature",
      "Rebase main onto feature interactively…",
      "Create branch here…",
      "Rename…",
      "Delete…",
    ]);
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
    expect(itemLabels()).toEqual([
      "Checkout",
      "Merge origin/other into main",
      "Fast-forward main to origin/other",
      "Rebase main onto origin/other",
      "Rebase main onto origin/other interactively…",
      "Delete on origin…",
    ]);
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

  it("should focus the Branches region when the menu closes and nothing held focus", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("region", { name: "Branches" })).toHaveFocus();
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

  it("should keep focus in the Rename dialog when the menu item that opened it is activated", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Rename…"));
    const dialog = await dialogNamed("Rename feature");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
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

// Contract (architect 4): each confirm kind is its own dialog, so the force dialog focuses Cancel.
describe("BranchesPanel force dialog focus", () => {
  it("should focus Cancel in the force dialog after branchNotMerged", async () => {
    vi.mocked(deleteBranch).mockRejectedValueOnce(notMerged);
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Delete…"));
    const dialog = await dialogNamed("Delete branch feature?");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    const force = await dialogNamed("Force delete feature?");
    await waitFor(() =>
      expect(within(force).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
  });
});

// Contract (architect 5): opening a dialog clears an earlier panel error.
describe("BranchesPanel error cleared on dialog open", () => {
  it("should hide the earlier panel error while a dialog is open", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue(checkoutFailed);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    await dialogNamed("New branch");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should show no alert after that dialog is cancelled", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue(checkoutFailed);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const dialog = await dialogNamed("New branch");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should not show an earlier error in a rename dialog opened from the menu", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue(checkoutFailed);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await screen.findByRole("alert");
    rightClick(localRow("feature"));
    await user.click(menuItem("Rename…"));
    await dialogNamed("Rename feature");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract (architect 6): the switch checkbox is checked again on every open.
describe("BranchesPanel switch checkbox reset", () => {
  it("should check Switch to new branch again after uncheck, cancel and reopen", async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const first = await dialogNamed("New branch");
    await user.click(within(first).getByLabelText("Switch to new branch"));
    expect(within(first).getByLabelText("Switch to new branch")).not.toBeChecked();
    await user.click(within(first).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const second = await dialogNamed("New branch");
    expect(within(second).getByLabelText("Switch to new branch")).toBeChecked();
  });

  it("should check the box again when a different create dialog opens next", async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const first = await dialogNamed("New branch");
    await user.click(within(first).getByLabelText("Switch to new branch"));
    await user.click(within(first).getByRole("button", { name: "Cancel" }));
    rightClick(localRow("feature"));
    await user.click(menuItem("Create branch here…"));
    const second = await dialogNamed("New branch from feature");
    expect(within(second).getByLabelText("Switch to new branch")).toBeChecked();
  });
});

// Contract (architect 7): activation does nothing while an action is pending.
describe("BranchesPanel activation while pending", () => {
  async function startPendingCheckout() {
    vi.mocked(checkoutBranch).mockReturnValue(new Promise<void>(() => {}));
    const view = await renderPanel();
    await view.user.dblClick(localRow("feature"));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Branches" })).toHaveAttribute("aria-busy", "true"),
    );
    return view;
  }

  it("should ignore Enter on a branch while an action is pending", async () => {
    const { user } = await startPendingCheckout();
    localRow("feature").focus();
    await user.keyboard("{Enter}{Enter}");
    expect(checkoutBranch).toHaveBeenCalledOnce();
  });

  it("should ignore a second double-click while an action is pending", async () => {
    const { user } = await startPendingCheckout();
    await user.dblClick(localRow("feature"));
    expect(checkoutBranch).toHaveBeenCalledOnce();
  });

  it("should ignore a remote double-click while an action is pending", async () => {
    const { user } = await startPendingCheckout();
    await user.dblClick(remoteRow("origin", "other"));
    expect(checkoutRemoteBranch).not.toHaveBeenCalled();
  });
});

// Contract (architect 8): the remote Checkout title uses the unfiltered local list.
describe("BranchesPanel remote checkout title with a filter", () => {
  it("should give remote Checkout no title when its local twin is filtered out", async () => {
    const data = list({
      remotes: [
        { remote: "origin", branches: [{ remote: "origin", name: "feature", oid: oid("b") }] },
      ],
    });
    const { user } = await renderPanel(data);
    await user.type(
      screen.getByRole("searchbox", { name: "Filter branches and tags" }),
      "origin/f",
    );
    expect(screen.queryByTitle("refs/heads/feature")).toBeNull();
    rightClick(remoteRow("origin", "feature"));
    expect(menuItem("Checkout")).not.toHaveAttribute("title");
  });
});

// Contract (architect 9): body states follow ChangesPanel.
describe("BranchesPanel body states", () => {
  it("should show a Loading branches… status while the list is pending", () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<BranchesPanel repoId={1} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading branches…");
  });

  it("should show no status once the list has loaded", async () => {
    await renderPanel();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("should label the lists Local branches and <remote> branches", async () => {
    await renderPanel();
    expect(screen.getByRole("list", { name: "Local branches" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "origin branches" })).toBeInTheDocument();
  });

  it("should show only the error, without filter or New branch…, when the list fails", async () => {
    vi.mocked(listBranches).mockRejectedValueOnce({ kind: "io", message: "list exploded" });
    renderWithProviders(<BranchesPanel repoId={1} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "New branch…" })).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("should refetch the list when the query error is dismissed", async () => {
    vi.mocked(listBranches)
      .mockRejectedValueOnce({ kind: "io", message: "list exploded" })
      .mockResolvedValue(list());
    const { user } = renderWithProviders(<BranchesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(listBranches).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("heading", { name: "Local" })).toBeInTheDocument();
  });

  it("should show no empty copy under the unborn row", async () => {
    await renderPanel(list({ head: { kind: "unborn", name: "main" }, local: [] }));
    expect(screen.getByText("main (no commits yet)")).toBeInTheDocument();
    expect(screen.queryByText("No branches")).toBeNull();
  });
});

// Contract: the detached/unborn leading row is informational only.
describe("BranchesPanel leading row", () => {
  it("should open no context menu on a right-click of the detached row", async () => {
    await renderPanel(list({ head: { kind: "detached", oid: "0123abcdef".padEnd(40, "0") } }));
    rightClick(screen.getByText("Detached at 0123abc"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should open no context menu on a right-click of the unborn row", async () => {
    await renderPanel(list({ head: { kind: "unborn", name: "main" }, local: [] }));
    rightClick(screen.getByText("main (no commits yet)"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

// Contract: names are passed to the backend verbatim; its validation errors stay in the dialog.
describe("BranchesPanel dialog name handling", () => {
  it("should create a branch whose name contains a slash with the name unchanged", async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const dialog = await dialogNamed("New branch");
    await user.type(within(dialog).getByLabelText("Name"), "feature/login");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createBranch).toHaveBeenCalledExactlyOnceWith(1, "feature/login", null, true);
  });

  it("should keep the create dialog open with the invalid-name message and the typed value", async () => {
    vi.mocked(createBranch).mockRejectedValue({
      kind: "invalidBranchName",
      message: "'a..b' is not a valid branch name",
    });
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    const dialog = await dialogNamed("New branch");
    await user.type(within(dialog).getByLabelText("Name"), "a..b");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "'a..b' is not a valid branch name",
    );
    expect(screen.getByRole("dialog", { name: "New branch" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("a..b");
    expect(within(dialog).getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it("should keep the rename dialog open with the invalid-name message", async () => {
    vi.mocked(renameBranch).mockRejectedValue({
      kind: "invalidBranchName",
      message: "'bad name' is not a valid branch name",
    });
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Rename…"));
    const dialog = await dialogNamed("Rename feature");
    const input = within(dialog).getByLabelText("New name");
    await user.clear(input);
    await user.type(input, "bad name");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("not a valid branch name");
    expect(input).toHaveValue("bad name");
  });

  it("should send the unchanged name to the backend and surface its refusal inline", async () => {
    vi.mocked(renameBranch).mockRejectedValue({ kind: "branchExists", message: "already exists" });
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Rename…"));
    const dialog = await dialogNamed("Rename feature");
    await user.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect(renameBranch).toHaveBeenCalledExactlyOnceWith(1, "feature", "feature");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already exists");
  });
});

// Contract: cancelling the force dialog changes nothing.
describe("BranchesPanel cancelled force delete", () => {
  it("should leave the branch listed and not retry the delete", async () => {
    vi.mocked(deleteBranch).mockRejectedValueOnce(notMerged);
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Delete…"));
    const first = await dialogNamed("Delete branch feature?");
    await user.click(within(first).getByRole("button", { name: "Delete" }));
    const force = await dialogNamed("Force delete feature?");
    await user.click(within(force).getByRole("button", { name: "Cancel" }));
    expect(localRow("feature")).toBeInTheDocument();
    expect(deleteBranch).toHaveBeenCalledExactlyOnceWith(1, "feature", false);
  });
});

// Contract: the filter is local view state and survives a list refetch.
describe("BranchesPanel filter across refetch", () => {
  it("should keep the query and the narrowed rows after the list is refetched", async () => {
    const { user } = await renderPanel();
    const filter = screen.getByRole("searchbox", { name: "Filter branches and tags" });
    await user.type(filter, "feat");
    await user.dblClick(localRow("feature"));
    await waitFor(() => expect(listBranches).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Branches" })).not.toHaveAttribute("aria-busy"),
    );
    expect(filter).toHaveValue("feat");
    expect(localRow("feature")).toBeInTheDocument();
    expect(screen.queryByTitle("refs/heads/main")).toBeNull();
  });
});

// Contract: busy state follows the action, including a failed one.
describe("BranchesPanel busy state after failure", () => {
  it("should clear aria-busy once a failed action has settled", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue(checkoutFailed);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Branches" })).not.toHaveAttribute("aria-busy"),
    );
  });

  it("should disable every item of a remote branch's menu while an action is pending", async () => {
    vi.mocked(checkoutBranch).mockReturnValue(new Promise<void>(() => {}));
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Branches" })).toHaveAttribute("aria-busy", "true"),
    );
    rightClick(remoteRow("origin", "other"));
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "Checkout",
      "Merge origin/other into main",
      "Fast-forward main to origin/other",
      "Rebase main onto origin/other",
      "Rebase main onto origin/other interactively…",
      "Delete on origin…",
    ]);
    for (const item of items) expect(item).toBeDisabled();
  });
});

// Contract: New branch… is unavailable while any action is pending, and on an unborn HEAD.
describe("BranchesPanel New branch… while pending", () => {
  const busy = () => screen.getByRole("region", { name: "Branches" });

  it("should disable New branch… while an action is pending and enable it once it settles", async () => {
    const d = deferred();
    vi.mocked(checkoutBranch).mockReturnValue(d.promise);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await waitFor(() => expect(busy()).toHaveAttribute("aria-busy", "true"));
    expect(screen.getByRole("button", { name: "New branch…" })).toBeDisabled();
    d.resolve();
    await waitFor(() => expect(busy()).not.toHaveAttribute("aria-busy"));
    expect(screen.getByRole("button", { name: "New branch…" })).toBeEnabled();
  });

  it("should keep New branch… disabled with its title on an unborn HEAD", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      list({ head: { kind: "unborn", name: "main" }, local: [] }),
    );
    renderWithProviders(<BranchesPanel repoId={1} />);
    const button = await screen.findByRole("button", { name: "New branch…" });
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute("title", "Make a commit first");
  });
});

// Contract (spec 5.4): merge, fast-forward and rebase items on non-HEAD local and remote rows.
describe("BranchesPanel integration menu items", () => {
  const INTEGRATION = [
    "Merge feature into main",
    "Fast-forward main to feature",
    "Rebase main onto feature",
  ];
  const mergeState: OperationState = {
    kind: "merge",
    head: oid("a"),
    branch: "feature",
    message: { subject: "Merge branch 'feature'", body: "" },
  };
  const detachedList = () =>
    list({ head: { kind: "detached", oid: oid("a") }, local: [localBranch("feature")] });

  it("should offer Merge, Fast-forward and Rebase after Checkout on a non-HEAD local row", async () => {
    await renderPanel();
    rightClick(localRow("feature"));
    expect(itemLabels().slice(0, 4)).toEqual(["Checkout", ...INTEGRATION]);
  });

  it("should offer no integration items on the HEAD row", async () => {
    await renderPanel();
    rightClick(localRow("main"));
    expect(itemLabels().filter((l) => /^(Merge|Fast-forward|Rebase) /.test(l ?? ""))).toEqual([]);
  });

  it("should name the remote branch with its remote on a remote row", async () => {
    await renderPanel();
    rightClick(remoteRow("origin", "other"));
    expect(itemLabels().slice(1, 4)).toEqual([
      "Merge origin/other into main",
      "Fast-forward main to origin/other",
      "Rebase main onto origin/other",
    ]);
  });

  it("should enable all three items when the repository is idle and fast-forward is possible", async () => {
    await renderPanel();
    rightClick(localRow("feature"));
    for (const label of INTEGRATION) expect(menuItem(label)).toBeEnabled();
  });

  it("should give the enabled integration items no title", async () => {
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem("Merge feature into main")).not.toHaveAttribute("title");
  });

  // Contract: fast-forward is driven by useCanFastForward for the menu's target.
  it("should disable Fast-forward with title Checking… while the check loads", async () => {
    provideMerge({ check: undefined, checking: true });
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem("Fast-forward main to feature")).toBeDisabled();
    expect(menuItem("Fast-forward main to feature")).toHaveAttribute("title", "Checking…");
  });

  it("should keep Merge enabled while the fast-forward check loads", async () => {
    provideMerge({ check: undefined, checking: true });
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem("Merge feature into main")).toBeEnabled();
  });

  it("should disable Fast-forward with title Already up to date when the branch is merged", async () => {
    provideMerge({ check: "upToDate" });
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem("Fast-forward main to feature")).toBeDisabled();
    expect(menuItem("Fast-forward main to feature")).toHaveAttribute("title", "Already up to date");
  });

  it("should disable Fast-forward with a diverged title when the histories have diverged", async () => {
    provideMerge({ check: "diverged" });
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem("Fast-forward main to feature")).toBeDisabled();
    expect(menuItem("Fast-forward main to feature")).toHaveAttribute(
      "title",
      "main and feature have diverged",
    );
  });

  it("should keep Merge and Rebase enabled when fast-forward is not possible", async () => {
    provideMerge({ check: "diverged" });
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem("Merge feature into main")).toBeEnabled();
    expect(menuItem("Rebase main onto feature")).toBeEnabled();
  });

  it("should ask the fast-forward check about the menu target branch", async () => {
    await renderPanel();
    rightClick(localRow("feature"));
    expect(useCanFastForward).toHaveBeenLastCalledWith(1, "feature");
  });

  it("should ask the fast-forward check about remote/name for a remote row", async () => {
    await renderPanel();
    rightClick(remoteRow("origin", "other"));
    expect(useCanFastForward).toHaveBeenLastCalledWith(1, "origin/other");
  });

  it("should ask the fast-forward check about nothing while no menu is open", async () => {
    await renderPanel();
    expect(useCanFastForward).toHaveBeenLastCalledWith(1, null);
  });

  it("should ask the fast-forward check about nothing for the HEAD row", async () => {
    await renderPanel();
    rightClick(localRow("main"));
    expect(useCanFastForward).toHaveBeenLastCalledWith(1, null);
  });

  // Contract: an operation in progress disables all three with the shared title.
  it("should disable all three items with the in-progress title during a merge", async () => {
    provideMerge({ state: mergeState });
    await renderPanel();
    rightClick(localRow("feature"));
    for (const label of INTEGRATION) {
      expect(menuItem(label)).toBeDisabled();
      expect(menuItem(label)).toHaveAttribute("title", IN_PROGRESS_TITLE);
    }
  });

  it("should prefer the in-progress title over the fast-forward reason", async () => {
    provideMerge({ state: mergeState, check: "upToDate" });
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem("Fast-forward main to feature")).toHaveAttribute("title", IN_PROGRESS_TITLE);
  });

  it("should disable the items on a remote row during an operation", async () => {
    provideMerge({ state: mergeState });
    await renderPanel();
    rightClick(remoteRow("origin", "other"));
    expect(menuItem("Merge origin/other into main")).toBeDisabled();
  });

  it("should disable the items while the operation state is still unknown", async () => {
    provideMerge({ state: undefined });
    await renderPanel();
    rightClick(localRow("feature"));
    for (const label of INTEGRATION) expect(menuItem(label)).toBeDisabled();
  });

  // Contract: a HEAD that is not on a branch cannot merge, fast-forward or rebase.
  it("should disable the items with Check out a branch first on a detached HEAD", async () => {
    await renderPanel(detachedList());
    rightClick(localRow("feature"));
    const items = screen
      .getAllByRole("menuitem")
      .filter((i) => /Merge|Fast-forward|Rebase/.test(i.textContent ?? ""));
    expect(items.map((i) => i.getAttribute("title"))).toEqual([
      "Check out a branch first",
      "Check out a branch first",
      "Check out a branch first",
      "Check out a branch first",
    ]);
  });

  it("should disable the items on a detached HEAD", async () => {
    await renderPanel(detachedList());
    rightClick(localRow("feature"));
    const items = screen
      .getAllByRole("menuitem")
      .filter((i) => /Merge|Fast-forward|Rebase/.test(i.textContent ?? ""));
    expect(items.map((i) => (i as HTMLButtonElement).disabled)).toEqual([true, true, true, true]);
  });

  // Contract: a pending action (branch or integration) disables the items.
  it("should disable the items while an integration action is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel();
    rightClick(localRow("feature"));
    for (const label of INTEGRATION) expect(menuItem(label)).toBeDisabled();
  });

  it("should disable the items while a branch action is pending", async () => {
    vi.mocked(checkoutBranch).mockReturnValue(new Promise<void>(() => {}));
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Branches" })).toHaveAttribute("aria-busy", "true"),
    );
    rightClick(localRow("feature"));
    for (const label of INTEGRATION) expect(menuItem(label)).toBeDisabled();
  });

  // Contract: selecting an item runs the matching integration request and closes the menu.
  it("should run a merge of the branch when Merge is selected", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Merge feature into main"));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({ action: "merge", branch: "feature" });
  });

  it("should run a fast-forward of the branch when Fast-forward is selected", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Fast-forward main to feature"));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "fastForward",
      branch: "feature",
    });
  });

  it("should run a rebase onto the branch when Rebase is selected", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Rebase main onto feature"));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({ action: "rebase", onto: "feature" });
  });

  it("should merge origin/other by its remote-qualified name", async () => {
    const { user } = await renderPanel();
    rightClick(remoteRow("origin", "other"));
    await user.click(menuItem("Merge origin/other into main"));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "merge",
      branch: "origin/other",
    });
  });

  it("should rebase onto origin/other by its remote-qualified name", async () => {
    const { user } = await renderPanel();
    rightClick(remoteRow("origin", "other"));
    await user.click(menuItem("Rebase main onto origin/other"));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "rebase",
      onto: "origin/other",
    });
  });

  it("should close the menu after Merge", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Merge feature into main"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should clear an earlier branch action error when an integration item is chosen", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue(checkoutFailed);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await screen.findByText(checkoutFailed.message);
    rightClick(localRow("feature"));
    await user.click(menuItem("Merge feature into main"));
    expect(screen.queryByText(checkoutFailed.message)).toBeNull();
    expect(integrationRun).toHaveBeenCalledTimes(1);
  });

  it("should disable Checkout while only the integration action is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem("Checkout")).toBeDisabled();
  });

  it("should disable New branch… while only the integration action is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel();
    expect(screen.getByRole("button", { name: "New branch…" })).toBeDisabled();
  });

  it("should not run anything when a disabled item is clicked", async () => {
    provideMerge({ state: mergeState });
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Merge feature into main"));
    expect(integrationRun).not.toHaveBeenCalled();
  });
});

// Contract: integration errors share the panel's error slot, Dismiss clears both sources.
describe("BranchesPanel integration errors", () => {
  const dirty: AppError = {
    kind: "operationFailed",
    message: "error: Your local changes would be overwritten by merge",
  };

  it("should show an integration error as an alert with its message", async () => {
    provideMerge({ error: dirty });
    await renderPanel();
    expect(screen.getByRole("alert")).toHaveTextContent(dirty.message);
  });

  it("should show no alert when the integration has no error", async () => {
    await renderPanel();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should clear the integration error on Dismiss", async () => {
    provideMerge({ error: dirty });
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(integrationClear).toHaveBeenCalledTimes(1);
  });

  it("should clear the branch action error on Dismiss when both sources have errors", async () => {
    provideMerge({ error: dirty });
    vi.mocked(checkoutBranch).mockRejectedValue(checkoutFailed);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await screen.findByText(checkoutFailed.message);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(checkoutFailed.message)).toBeNull();
  });

  it("should prefer the branch action error over the integration error", async () => {
    provideMerge({ error: dirty });
    vi.mocked(checkoutBranch).mockRejectedValue(checkoutFailed);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    expect(await screen.findByRole("alert")).toHaveTextContent(checkoutFailed.message);
  });

  it("should clear both error sources when Dismiss is pressed", async () => {
    provideMerge({ error: dirty });
    vi.mocked(checkoutBranch).mockRejectedValue(checkoutFailed);
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await screen.findByText(checkoutFailed.message);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(integrationClear).toHaveBeenCalledTimes(1);
  });
});

// Contract: the region is busy while an integration action is pending.
describe("BranchesPanel integration pending", () => {
  it("should set aria-busy on the region while an integration action is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel();
    expect(screen.getByRole("region", { name: "Branches" })).toHaveAttribute("aria-busy", "true");
  });

  it("should not be busy when the integration is idle", async () => {
    await renderPanel();
    expect(screen.getByRole("region", { name: "Branches" })).not.toHaveAttribute("aria-busy");
  });
});

// Coverage audit: states the first pass left unpinned (HEAD kinds, shared pending, error hygiene).
describe("BranchesPanel integration gaps", () => {
  const integrationItems = () =>
    screen
      .getAllByRole("menuitem")
      .filter((i) => /^(Merge|Fast-forward|Rebase) /.test(i.textContent ?? ""));
  const unbornList = () => list({ head: { kind: "unborn", name: "main" }, local: [] });
  const detached = () =>
    list({ head: { kind: "detached", oid: oid("a") }, local: [localBranch("feature")] });
  const dirty: AppError = { kind: "operationFailed", message: "error: merge exploded" };

  it("should name the current branch HEAD in the labels when HEAD is detached", async () => {
    await renderPanel(detached());
    rightClick(localRow("feature"));
    expect(integrationItems().map((i) => i.textContent)).toEqual([
      "Merge feature into HEAD",
      "Fast-forward HEAD to feature",
      "Rebase HEAD onto feature",
      "Rebase HEAD onto feature interactively…",
    ]);
  });

  it("should disable the items of a remote row on a detached HEAD with the checkout-first title", async () => {
    await renderPanel(detached());
    rightClick(remoteRow("origin", "other"));
    for (const item of integrationItems()) {
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("title", "Check out a branch first");
    }
    expect(integrationItems()).toHaveLength(4);
  });

  it("should disable the items of a remote row on an unborn HEAD with the checkout-first title", async () => {
    await renderPanel(unbornList());
    rightClick(remoteRow("origin", "other"));
    expect(integrationItems().map((i) => i.textContent)).toEqual([
      "Merge origin/other into HEAD",
      "Fast-forward HEAD to origin/other",
      "Rebase HEAD onto origin/other",
      "Rebase HEAD onto origin/other interactively…",
    ]);
    for (const item of integrationItems()) {
      expect(item).toBeDisabled();
      expect(item).toHaveAttribute("title", "Check out a branch first");
    }
  });

  it("should prefer the checkout-first title over the fast-forward reason on a detached HEAD", async () => {
    provideMerge({ check: "upToDate" });
    await renderPanel(detached());
    rightClick(localRow("feature"));
    expect(menuItem("Fast-forward HEAD to feature")).toHaveAttribute(
      "title",
      "Check out a branch first",
    );
  });

  it("should prefer the checkout-first title over Checking… on a detached HEAD", async () => {
    provideMerge({ check: undefined, checking: true });
    await renderPanel(detached());
    rightClick(localRow("feature"));
    expect(menuItem("Fast-forward HEAD to feature")).toHaveAttribute(
      "title",
      "Check out a branch first",
    );
  });

  it("should prefer the in-progress title over the checkout-first title on a detached HEAD", async () => {
    provideMerge({
      state: { kind: "merge", head: oid("a"), branch: "x", message: { subject: "s", body: "" } },
    });
    await renderPanel(detached());
    rightClick(localRow("feature"));
    for (const item of integrationItems()) {
      expect(item).toHaveAttribute("title", IN_PROGRESS_TITLE);
    }
  });

  it("should use the remote-qualified name in the diverged title of a remote row", async () => {
    provideMerge({ check: "diverged" });
    await renderPanel();
    rightClick(remoteRow("origin", "other"));
    expect(menuItem("Fast-forward main to origin/other")).toHaveAttribute(
      "title",
      "main and origin/other have diverged",
    );
  });

  it("should disable Fast-forward on a remote row that is already merged", async () => {
    provideMerge({ check: "upToDate" });
    await renderPanel();
    rightClick(remoteRow("origin", "other"));
    expect(menuItem("Fast-forward main to origin/other")).toHaveAttribute(
      "title",
      "Already up to date",
    );
  });

  it("should leave the remote-row items enabled when fast-forward is possible", async () => {
    await renderPanel();
    rightClick(remoteRow("origin", "other"));
    for (const item of integrationItems()) expect(item).toBeEnabled();
  });

  // Contract: `pending` is shared, so an integration run locks every other control too.
  it("should disable every item of a remote row's menu while only the integration is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel();
    rightClick(remoteRow("origin", "other"));
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(6);
    for (const item of items) expect(item).toBeDisabled();
  });

  it("should disable the local row's create, rename and delete items while only the integration is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel();
    rightClick(localRow("feature"));
    for (const item of screen.getAllByRole("menuitem")) expect(item).toBeDisabled();
  });

  it("should ignore a local double-click while only the integration is pending", async () => {
    provideMerge({ pending: true });
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("should ignore Enter on a branch while only the integration is pending", async () => {
    provideMerge({ pending: true });
    const { user } = await renderPanel();
    localRow("feature").focus();
    await user.keyboard("{Enter}");
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it("should ignore a remote double-click while only the integration is pending", async () => {
    provideMerge({ pending: true });
    const { user } = await renderPanel();
    await user.dblClick(remoteRow("origin", "other"));
    expect(checkoutRemoteBranch).not.toHaveBeenCalled();
  });

  // Contract: a new failure must not hide behind an older one, and dialogs open clean.
  it("should clear the integration error before running an integration item", async () => {
    provideMerge({ error: dirty });
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Rebase main onto feature"));
    expect(integrationClear).toHaveBeenCalledTimes(1);
    expect(integrationClear.mock.invocationCallOrder[0]).toBeLessThan(
      integrationRun.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("should clear the integration error when the New branch dialog opens", async () => {
    provideMerge({ error: dirty });
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    await dialogNamed("New branch");
    expect(integrationClear).toHaveBeenCalled();
  });

  it("should hide the panel error while a dialog is open", async () => {
    provideMerge({ error: dirty });
    const { user } = await renderPanel();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    await dialogNamed("New branch");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should clear the integration error when a dialog is cancelled", async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "New branch…" }));
    await dialogNamed("New branch");
    integrationClear.mockClear();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(integrationClear).toHaveBeenCalledTimes(1);
  });

  it("should not run an item that is disabled by a pending integration", async () => {
    provideMerge({ pending: true });
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Merge feature into main"));
    expect(integrationRun).not.toHaveBeenCalled();
  });
});

const rowItem = (el: HTMLElement) => el.closest("li") as HTMLElement;
const dataTransfer = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });
const draggableRows = () => document.querySelectorAll('li[draggable="true"]');
const pickUp = (el: HTMLElement) =>
  fireEvent.dragStart(rowItem(el), { dataTransfer: dataTransfer() });
const hover = (el: HTMLElement) => fireEvent.dragEnter(rowItem(el));
const dropOn = (el: HTMLElement, x = 5, y = 6) =>
  fireEvent.drop(rowItem(el), { clientX: x, clientY: y, dataTransfer: dataTransfer() });
const rebaseCommit = (c: string): RebaseCommit => ({
  oid: c.repeat(40),
  subject: `commit ${c}`,
  author: { name: "Ann", email: "ann@example.com", time: 1 },
});

// Contract (spec 4.6): an interactive rebase item follows the Rebase item and opens the plan dialog.
describe("BranchesPanel interactive rebase item", () => {
  const mergeState: OperationState = {
    kind: "merge",
    head: oid("a"),
    branch: "feature",
    message: { subject: "Merge branch 'feature'", body: "" },
  };
  const detachedList = () =>
    list({ head: { kind: "detached", oid: oid("a") }, local: [localBranch("feature")] });
  const ITEM = "Rebase main onto feature interactively…";

  it("should enable the item with no title when the repository is idle", async () => {
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem(ITEM)).toBeEnabled();
    expect(menuItem(ITEM)).not.toHaveAttribute("title");
  });

  it("should offer no interactive item on the current branch row", async () => {
    await renderPanel();
    rightClick(localRow("main"));
    expect(itemLabels().filter((l) => /interactively/.test(l ?? ""))).toEqual([]);
  });

  it("should stay enabled when fast-forward is not possible", async () => {
    provideMerge({ check: "diverged" });
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem(ITEM)).toBeEnabled();
  });

  it("should disable the item with the in-progress title during an operation", async () => {
    provideMerge({ state: mergeState });
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem(ITEM)).toBeDisabled();
    expect(menuItem(ITEM)).toHaveAttribute("title", IN_PROGRESS_TITLE);
  });

  it("should disable the item with the checkout-first title on a detached HEAD", async () => {
    await renderPanel(detachedList());
    rightClick(localRow("feature"));
    expect(menuItem("Rebase HEAD onto feature interactively…")).toBeDisabled();
    expect(menuItem("Rebase HEAD onto feature interactively…")).toHaveAttribute(
      "title",
      "Check out a branch first",
    );
  });

  it("should disable the item while an integration is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel();
    rightClick(localRow("feature"));
    expect(menuItem(ITEM)).toBeDisabled();
  });

  it("should not open a dialog when the disabled item is clicked", async () => {
    provideMerge({ state: mergeState });
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem(ITEM));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rebasePlan).not.toHaveBeenCalled();
  });

  it("should open the rebase dialog for the branch when selected", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem(ITEM));
    expect(await dialogNamed("Rebase main onto feature interactively")).toBeInTheDocument();
    expect(rebasePlan).toHaveBeenCalledExactlyOnceWith(1, "feature");
  });

  it("should close the menu when the item is selected", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem(ITEM));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should not run an integration action when the item is selected", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem(ITEM));
    await dialogNamed("Rebase main onto feature interactively");
    expect(integrationRun).not.toHaveBeenCalled();
  });

  it("should open the dialog for a remote branch by its qualified name", async () => {
    const { user } = await renderPanel();
    rightClick(remoteRow("origin", "other"));
    await user.click(menuItem("Rebase main onto origin/other interactively…"));
    expect(await dialogNamed("Rebase main onto origin/other interactively")).toBeInTheDocument();
    expect(rebasePlan).toHaveBeenCalledExactlyOnceWith(1, "origin/other");
  });

  it("should close the dialog when Cancel is clicked", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem(ITEM));
    await dialogNamed("Rebase main onto feature interactively");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should start the rebase through the panel's integration run with the plan", async () => {
    vi.mocked(rebasePlan).mockResolvedValue([rebaseCommit("a"), rebaseCommit("b")]);
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem(ITEM));
    await user.click(await screen.findByRole("button", { name: "Start rebase" }));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "rebaseInteractive",
      base: "feature",
      steps: [
        { action: "pick", oid: oid("a") },
        { action: "pick", oid: oid("b") },
      ],
    });
  });

  it("should close the dialog once the run succeeds", async () => {
    vi.mocked(rebasePlan).mockResolvedValue([rebaseCommit("a")]);
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem(ITEM));
    await user.click(await screen.findByRole("button", { name: "Start rebase" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("should open the dialog clean by clearing an earlier integration error", async () => {
    provideMerge({ error: { kind: "operationFailed", message: "earlier failure" } });
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem(ITEM));
    await dialogNamed("Rebase main onto feature interactively");
    expect(integrationClear).toHaveBeenCalled();
  });
});

// Contract (spec 4.7): drag a branch onto the current branch to open the integration menu.
describe("BranchesPanel drag-to-merge", () => {
  const mergeState: OperationState = {
    kind: "merge",
    head: oid("a"),
    branch: "feature",
    message: { subject: "Merge branch 'feature'", body: "" },
  };
  const DROP_ITEMS = [
    "Merge feature into main",
    "Fast-forward main to feature",
    "Rebase main onto feature",
  ];

  // Draggable flags.
  it("should make every non-current branch draggable and the current one not", async () => {
    await renderPanel();
    expect(rowItem(localRow("feature"))).toHaveAttribute("draggable", "true");
    expect(rowItem(remoteRow("origin", "other"))).toHaveAttribute("draggable", "true");
    expect(rowItem(remoteRow("origin", "main"))).toHaveAttribute("draggable", "true");
    expect(rowItem(localRow("main"))).not.toHaveAttribute("draggable", "true");
    expect(draggableRows()).toHaveLength(3);
  });

  // Highlight.
  it("should highlight the current branch while a branch is dragged over it", async () => {
    await renderPanel();
    pickUp(localRow("feature"));
    hover(localRow("main"));
    expect(rowItem(localRow("main"))).toHaveAttribute("data-drop-over", "true");
  });

  it("should not highlight the current branch before any drag", async () => {
    await renderPanel();
    hover(localRow("main"));
    expect(rowItem(localRow("main"))).not.toHaveAttribute("data-drop-over");
  });

  it("should keep the highlight while the pointer moves between the row's children", async () => {
    await renderPanel();
    pickUp(localRow("feature"));
    hover(localRow("main"));
    hover(localRow("main"));
    fireEvent.dragLeave(rowItem(localRow("main")));
    expect(rowItem(localRow("main"))).toHaveAttribute("data-drop-over", "true");
  });

  it("should keep the highlight while the pointer moves from the row onto its button", async () => {
    await renderPanel();
    pickUp(localRow("feature"));
    hover(rowItem(localRow("main")));
    fireEvent.dragEnter(localRow("main"));
    fireEvent.dragLeave(rowItem(localRow("main")));
    expect(rowItem(localRow("main"))).toHaveAttribute("data-drop-over", "true");
    fireEvent.dragLeave(localRow("main"));
    expect(rowItem(localRow("main"))).not.toHaveAttribute("data-drop-over");
  });

  it("should not start a drag from the current branch row", async () => {
    await renderPanel();
    pickUp(localRow("main"));
    hover(localRow("main"));
    dropOn(localRow("main"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should remove the highlight once the pointer has left the row", async () => {
    await renderPanel();
    pickUp(localRow("feature"));
    hover(localRow("main"));
    fireEvent.dragLeave(rowItem(localRow("main")));
    expect(rowItem(localRow("main"))).not.toHaveAttribute("data-drop-over");
  });

  it("should not highlight any row other than the current branch", async () => {
    await renderPanel();
    pickUp(localRow("feature"));
    hover(remoteRow("origin", "other"));
    hover(localRow("feature"));
    expect(document.querySelectorAll("[data-drop-over]")).toHaveLength(0);
  });

  // Drop opens the menu.
  it("should open a menu with exactly Merge, Fast-forward and Rebase on drop", async () => {
    await renderPanel();
    pickUp(localRow("feature"));
    hover(localRow("main"));
    dropOn(localRow("main"));
    expect(itemLabels()).toEqual(DROP_ITEMS);
  });

  it("should offer no checkout, rename, delete or interactive item in the drop menu", async () => {
    await renderPanel();
    pickUp(localRow("feature"));
    hover(localRow("main"));
    dropOn(localRow("main"));
    expect(screen.getAllByRole("menuitem")).toHaveLength(3);
  });

  it("should merge the dragged branch when Merge is chosen", async () => {
    const { user } = await renderPanel();
    pickUp(localRow("feature"));
    hover(localRow("main"));
    dropOn(localRow("main"));
    await user.click(menuItem("Merge feature into main"));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({ action: "merge", branch: "feature" });
  });

  it("should rebase onto the dragged branch when Rebase is chosen", async () => {
    const { user } = await renderPanel();
    pickUp(localRow("feature"));
    hover(localRow("main"));
    dropOn(localRow("main"));
    await user.click(menuItem("Rebase main onto feature"));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({ action: "rebase", onto: "feature" });
  });

  it("should drive the Fast-forward gate from the dragged branch", async () => {
    provideMerge({ check: "diverged" });
    await renderPanel();
    pickUp(localRow("feature"));
    hover(localRow("main"));
    dropOn(localRow("main"));
    expect(menuItem("Fast-forward main to feature")).toBeDisabled();
    expect(menuItem("Fast-forward main to feature")).toHaveAttribute(
      "title",
      "main and feature have diverged",
    );
  });

  it("should clear the highlight after the drop", async () => {
    await renderPanel();
    pickUp(localRow("feature"));
    hover(localRow("main"));
    dropOn(localRow("main"));
    expect(rowItem(localRow("main"))).not.toHaveAttribute("data-drop-over");
  });

  it("should open no menu on a drop that follows no drag start", async () => {
    await renderPanel();
    dropOn(localRow("main"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // Remote branches.
  it("should make a remote branch draggable and name it with its remote in the drop menu", async () => {
    await renderPanel();
    pickUp(remoteRow("origin", "other"));
    hover(localRow("main"));
    dropOn(localRow("main"));
    expect(itemLabels()).toEqual([
      "Merge origin/other into main",
      "Fast-forward main to origin/other",
      "Rebase main onto origin/other",
    ]);
  });

  it("should merge the dragged remote branch by its qualified name", async () => {
    const { user } = await renderPanel();
    pickUp(remoteRow("origin", "other"));
    hover(localRow("main"));
    dropOn(localRow("main"));
    await user.click(menuItem("Merge origin/other into main"));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "merge",
      branch: "origin/other",
    });
  });

  // Cancelling.
  it("should clear the highlight and open no menu when the drag ends without a drop", async () => {
    await renderPanel();
    pickUp(localRow("feature"));
    hover(localRow("main"));
    fireEvent.dragEnd(rowItem(localRow("feature")));
    expect(rowItem(localRow("main"))).not.toHaveAttribute("data-drop-over");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should accept no drop on the current branch after the drag ended", async () => {
    await renderPanel();
    pickUp(localRow("feature"));
    fireEvent.dragEnd(rowItem(localRow("feature")));
    expect(fireEvent.dragOver(rowItem(localRow("main")), { dataTransfer: dataTransfer() })).toBe(
      true,
    );
    dropOn(localRow("main"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // Review Focus: only the current branch is a drop target.
  it("ignores a drop on a non-current row", async () => {
    await renderPanel();
    pickUp(localRow("feature"));
    hover(remoteRow("origin", "other"));
    const notPrevented = fireEvent.dragOver(rowItem(remoteRow("origin", "other")), {
      dataTransfer: dataTransfer(),
    });
    dropOn(remoteRow("origin", "other"));
    expect(notPrevented).toBe(true);
    expect(rowItem(remoteRow("origin", "other"))).not.toHaveAttribute("data-drop-over");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(integrationRun).not.toHaveBeenCalled();
  });

  it("should ignore a drop of a branch onto itself", async () => {
    await renderPanel();
    pickUp(localRow("feature"));
    dropOn(localRow("feature"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should accept a dragover on the current branch only while dragging", async () => {
    await renderPanel();
    expect(fireEvent.dragOver(rowItem(localRow("main")), { dataTransfer: dataTransfer() })).toBe(
      true,
    );
    pickUp(localRow("feature"));
    expect(fireEvent.dragOver(rowItem(localRow("main")), { dataTransfer: dataTransfer() })).toBe(
      false,
    );
  });

  // Review Focus: no dragging while an operation is in progress, HEAD is not a branch, or pending.
  it("disables dragging during an operation", async () => {
    provideMerge({ state: mergeState });
    await renderPanel();
    expect(draggableRows()).toHaveLength(0);
  });

  it("should disable dragging on a detached HEAD", async () => {
    await renderPanel(
      list({ head: { kind: "detached", oid: oid("a") }, local: [localBranch("feature")] }),
    );
    expect(draggableRows()).toHaveLength(0);
  });

  it("should disable dragging on an unborn HEAD", async () => {
    await renderPanel(list({ head: { kind: "unborn", name: "main" }, local: [] }));
    expect(draggableRows()).toHaveLength(0);
  });

  it("should disable dragging while an integration is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel();
    expect(draggableRows()).toHaveLength(0);
  });

  it("should disable dragging while a branch action is pending", async () => {
    vi.mocked(checkoutBranch).mockReturnValue(new Promise<void>(() => {}));
    const { user } = await renderPanel();
    await user.dblClick(localRow("feature"));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Branches" })).toHaveAttribute("aria-busy", "true"),
    );
    expect(draggableRows()).toHaveLength(0);
  });

  it("should disable dragging while the operation state is still unknown", async () => {
    provideMerge({ state: undefined });
    await renderPanel();
    expect(draggableRows()).toHaveLength(0);
  });
});

// Contract: when a dialog closes and its opener cannot take focus, the Branches region does.
describe("BranchesPanel focus fallback", () => {
  it("should focus the Branches region when New branch is cancelled and its opener never had focus", async () => {
    const { user } = await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "New branch…" }));
    await user.click(
      within(await dialogNamed("New branch")).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.getByRole("region", { name: "Branches" })).toHaveFocus();
  });

  it("should focus the Branches region when a dialog opened from the menu is cancelled", async () => {
    const { user } = await renderPanel();
    rightClick(localRow("feature"));
    await user.click(menuItem("Rename…"));
    const rename = await dialogNamed("Rename feature");
    expect(within(rename).getByRole("textbox")).toHaveFocus();
    await user.click(within(rename).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("region", { name: "Branches" })).toHaveFocus();
  });

  it("should mark the Branches region as a programmatic focus target", async () => {
    await renderPanel();
    const target = screen.getByRole("region", { name: "Branches" });
    expect(target).toHaveAttribute("data-focus-target");
    expect(target).toHaveAttribute("tabindex", "-1");
  });
});
