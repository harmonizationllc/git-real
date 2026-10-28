import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addLinkedWorktree, listBranches, listLinkedWorktrees, pickFolder } from "../../lib/ipc";
import type { AppError, BranchList, WorktreeBranch } from "../../lib/ipc";
import { oidOf } from "../../test/graphFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { linkedWorktree } from "../../test/worktreeFixtures";
import { AddWorktreeDialog } from "./AddWorktreeDialog";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  addLinkedWorktree: vi.fn(),
  listBranches: vi.fn(),
  listLinkedWorktrees: vi.fn(),
  pickFolder: vi.fn(),
}));

const onClose = vi.fn();
const onAdded = vi.fn();

const main = linkedWorktree();
const a = linkedWorktree({
  name: "a",
  path: "/repos/app-feat-a",
  head: { kind: "branch", name: "feat/a" },
  isMain: false,
  isCurrent: false,
});

const branches = (): BranchList => ({
  head: { kind: "branch", name: "main" },
  local: [
    { name: "main", oid: oidOf(0), isHead: true, tracking: null, worktree: null },
    { name: "feat/a", oid: oidOf(1), isHead: false, tracking: null, worktree: a.path },
    { name: "free", oid: oidOf(2), isHead: false, tracking: null, worktree: null },
    { name: "other", oid: oidOf(3), isHead: false, tracking: null, worktree: null },
  ],
  remotes: [],
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listLinkedWorktrees).mockResolvedValue([main, a]);
  vi.mocked(listBranches).mockResolvedValue(branches());
  vi.mocked(addLinkedWorktree).mockResolvedValue(undefined);
  vi.mocked(pickFolder).mockResolvedValue(null);
});

async function renderDialog(initial?: WorktreeBranch, open = true) {
  const view = renderWithProviders(
    <AddWorktreeDialog
      repoId={1}
      open={open}
      initial={initial}
      onClose={onClose}
      onAdded={onAdded}
    />,
  );
  // The folder fills once the main worktree is known.
  if (open) await waitFor(() => expect(folder()).not.toHaveValue(""));
  return view;
}

const radio = (name: string) => screen.getByRole("radio", { name });
const nameField = () => screen.getByRole("textbox", { name: "Name" });
const commitField = () => screen.getByRole("textbox", { name: "Commit" });
const folder = () => screen.getByRole("textbox", { name: "Folder" });
const branchSelect = () => screen.getByRole("combobox", { name: "Branch" });
const option = (name: string) => screen.getByRole("option", { name }) as HTMLOptionElement;
const addButton = () => screen.getByRole("button", { name: "Add" });
const NO_FREE_BRANCH = "Every branch is checked out in a worktree. Create a new one.";

// Contract: nothing renders while closed; open it is the Add worktree modal.
describe("AddWorktreeDialog rendering", () => {
  it("should render nothing when closed", async () => {
    await renderDialog(undefined, false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should show a modal dialog titled Add worktree", async () => {
    await renderDialog();
    expect(screen.getByRole("dialog", { name: "Add worktree" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
  });

  it("should start in New branch mode with the folder tracking the name", async () => {
    const { user } = await renderDialog();
    expect(radio("New branch")).toBeChecked();
    expect(radio("Current HEAD")).toBeChecked();
    expect(nameField()).toHaveFocus();
    expect(folder()).toHaveValue("/repos/app-worktree");
    await user.type(nameField(), "feat/x");
    expect(folder()).toHaveValue("/repos/app-feat-x");
    await user.clear(nameField());
    expect(folder()).toHaveValue("/repos/app-worktree");
  });

  it("should use the current worktree as base when there is no main row", async () => {
    vi.mocked(listLinkedWorktrees).mockResolvedValue([{ ...a, isCurrent: true }]);
    await renderDialog();
    expect(folder()).toHaveValue("/repos/app-feat-a-worktree");
  });

  it("should leave the folder empty while no base worktree is known", () => {
    vi.mocked(listLinkedWorktrees).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<AddWorktreeDialog repoId={1} open onClose={onClose} onAdded={onAdded} />);
    expect(folder()).toHaveValue("");
  });

  it("should stop tracking once the folder was edited", async () => {
    const { user } = await renderDialog();
    await user.clear(folder());
    await user.type(folder(), "/elsewhere");
    await user.type(nameField(), "x");
    expect(folder()).toHaveValue("/elsewhere");
  });
});

// Contract: Existing mode lists the local branches; the current and checked-out ones are disabled.
describe("AddWorktreeDialog existing branch", () => {
  it("should list local branches in Existing mode and disable current and checked-out ones", async () => {
    const { user } = await renderDialog();
    await user.click(radio("Existing branch"));
    await waitFor(() => expect(option("free")).toBeInTheDocument());
    expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Current HEAD" })).toBeNull();
    expect(option("main (current)").disabled).toBe(true);
    expect(option("feat/a (checked out in app-feat-a)").disabled).toBe(true);
    expect(option("free").disabled).toBe(false);
    expect(branchSelect()).toHaveValue("free");
    expect(folder()).toHaveValue("/repos/app-free");
    await user.selectOptions(branchSelect(), "other");
    expect(folder()).toHaveValue("/repos/app-other");
  });

  it("should switch back to New branch with the typed name kept", async () => {
    const { user } = await renderDialog();
    await user.type(nameField(), "keep");
    await user.click(radio("Existing branch"));
    await user.click(radio("New branch"));
    expect(nameField()).toHaveValue("keep");
    expect(folder()).toHaveValue("/repos/app-keep");
  });

  it("should disable Add when no branch is free", async () => {
    vi.mocked(listBranches).mockResolvedValue({
      ...branches(),
      local: branches().local.slice(0, 2),
    });
    const { user } = await renderDialog();
    await user.click(radio("Existing branch"));
    await waitFor(() => expect(option("main (current)")).toBeInTheDocument());
    expect(addButton()).toBeDisabled();
  });

  it("should explain when no branch is free in Existing mode", async () => {
    vi.mocked(listBranches).mockResolvedValue({
      ...branches(),
      local: branches().local.slice(0, 2),
    });
    const { user } = await renderDialog();
    expect(screen.queryByText(NO_FREE_BRANCH)).toBeNull();
    await user.click(radio("Existing branch"));
    const hint = await screen.findByText(NO_FREE_BRANCH);
    expect(hint).not.toHaveRole("alert");
    expect(branchSelect()).toHaveAccessibleDescription(NO_FREE_BRANCH);
    expect(addButton()).toBeDisabled();
  });

  it("should not explain while a branch is free", async () => {
    const { user } = await renderDialog();
    await user.click(radio("Existing branch"));
    await waitFor(() => expect(branchSelect()).toHaveValue("free"));
    expect(screen.queryByText(NO_FREE_BRANCH)).toBeNull();
  });

  it("should list nothing until the branches load", async () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => undefined));
    const { user } = await renderDialog();
    await user.click(radio("Existing branch"));
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(screen.queryByText(NO_FREE_BRANCH)).toBeNull();
  });

  it("should submit an existing branch", async () => {
    const { user } = await renderDialog();
    await user.click(radio("Existing branch"));
    await waitFor(() => expect(branchSelect()).toHaveValue("free"));
    await user.click(addButton());
    await waitFor(() =>
      expect(addLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-free", {
        kind: "existing",
        name: "free",
      }),
    );
    expect(onAdded).toHaveBeenCalledExactlyOnceWith("/repos/app-free");
  });
});

// Contract: submit builds the WorktreeBranch, closes, then reports the folder.
describe("AddWorktreeDialog submit", () => {
  it("should submit a new branch at HEAD", async () => {
    const { user } = await renderDialog();
    await user.type(nameField(), "feat/x");
    await user.click(addButton());
    await waitFor(() => expect(onAdded).toHaveBeenCalledExactlyOnceWith("/repos/app-feat-x"));
    expect(addLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-feat-x", {
      kind: "new",
      name: "feat/x",
      start: null,
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      onAdded.mock.invocationCallOrder[0] as number,
    );
  });

  it("should submit a new branch at a commit", async () => {
    const { user } = await renderDialog();
    await user.type(nameField(), "fix");
    await user.click(radio("Commit"));
    expect(commitField()).toHaveFocus();
    await user.type(commitField(), "abc123");
    await user.click(addButton());
    await waitFor(() =>
      expect(addLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-fix", {
        kind: "new",
        name: "fix",
        start: "abc123",
      }),
    );
  });

  it("should trim the name, commit and folder", async () => {
    const { user } = await renderDialog();
    await user.type(nameField(), " fix ");
    await user.click(radio("Commit"));
    await user.type(commitField(), " abc ");
    await user.type(folder(), " ");
    await user.click(addButton());
    await waitFor(() =>
      expect(addLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-fix", {
        kind: "new",
        name: "fix",
        start: "abc",
      }),
    );
  });

  it("should go back to Current HEAD and hide the commit field", async () => {
    const { user } = await renderDialog();
    await user.click(radio("Commit"));
    await user.click(radio("Current HEAD"));
    expect(screen.queryByRole("textbox", { name: "Commit" })).toBeNull();
  });

  it("should prefill an existing initial branch", async () => {
    await renderDialog({ kind: "existing", name: "other" });
    expect(radio("Existing branch")).toBeChecked();
    await waitFor(() => expect(branchSelect()).toHaveValue("other"));
    expect(folder()).toHaveValue("/repos/app-other");
  });

  it("should prefill a new initial branch with a start", async () => {
    await renderDialog({ kind: "new", name: "feat/r", start: "origin/feat/r" });
    expect(radio("New branch")).toBeChecked();
    expect(nameField()).toHaveValue("feat/r");
    expect(radio("Commit")).toBeChecked();
    expect(commitField()).toHaveValue("origin/feat/r");
    expect(folder()).toHaveValue("/repos/app-feat-r");
  });

  it("should prefill a new initial branch at HEAD", async () => {
    await renderDialog({ kind: "new", name: "n", start: null });
    expect(radio("Current HEAD")).toBeChecked();
    expect(nameField()).toHaveValue("n");
  });

  it("should disable Add while the name or folder is blank or while pending", async () => {
    let finish!: () => void;
    vi.mocked(addLinkedWorktree).mockReturnValue(
      new Promise((res) => {
        finish = () => res(undefined);
      }),
    );
    const { user } = await renderDialog();
    expect(addButton()).toBeDisabled();
    await user.type(nameField(), "x");
    expect(addButton()).toBeEnabled();
    await user.click(radio("Commit"));
    expect(addButton()).toBeDisabled();
    await user.type(commitField(), "abc");
    expect(addButton()).toBeEnabled();
    await user.clear(folder());
    expect(addButton()).toBeDisabled();
    await user.type(folder(), "/w/x");
    await user.click(addButton());
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("dialog")).toHaveFocus();
    expect(nameField()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});

// Contract: a refused add shows the Rust message inline, keeps the dialog open and refocuses.
describe("AddWorktreeDialog errors", () => {
  const cases: Array<[string, AppError, string]> = [
    [
      "pathExists",
      { kind: "pathExists", message: "`/repos/app-x` already exists and is not empty" },
      "Folder",
    ],
    [
      "pathNotAbsolute",
      { kind: "pathNotAbsolute", message: "~/app-x is not an absolute path" },
      "Folder",
    ],
    [
      "branchExists",
      { kind: "branchExists", message: "a branch named `x` already exists" },
      "Name",
    ],
    [
      "invalidBranchName",
      { kind: "invalidBranchName", message: "`x` is not a valid branch name" },
      "Name",
    ],
    [
      "revisionNotFound",
      { kind: "revisionNotFound", message: "revision `nope` not found" },
      "Commit",
    ],
  ];

  it.each(cases)("should show %s inline and stay open", async (_kind, error, field) => {
    vi.mocked(addLinkedWorktree).mockRejectedValueOnce(error);
    const { user } = await renderDialog();
    await user.type(nameField(), "x");
    await user.click(radio("Commit"));
    await user.type(commitField(), "nope");
    await user.click(addButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(error.message);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect([onClose, onAdded].map((f) => f.mock.calls.length)).toEqual([0, 0]);
    expect(screen.getByRole("textbox", { name: field })).toHaveFocus();
  });

  it("should focus the branch select for an existing-branch error", async () => {
    vi.mocked(addLinkedWorktree).mockRejectedValueOnce({
      kind: "branchCheckedOut",
      message: "`free` is checked out in worktree `w`",
    });
    const { user } = await renderDialog({ kind: "existing", name: "free" });
    await waitFor(() => expect(branchSelect()).toHaveValue("free"));
    await user.click(addButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("checked out in worktree");
    expect(branchSelect()).toHaveFocus();
  });

  it("should clear the error on the next submit and on Dismiss", async () => {
    vi.mocked(addLinkedWorktree)
      .mockRejectedValueOnce({ kind: "branchExists", message: "exists" })
      .mockRejectedValueOnce({ kind: "branchExists", message: "again" });
    const { user } = await renderDialog();
    await user.type(nameField(), "x");
    await user.click(addButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("exists");
    await user.click(addButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("again");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: Browse… picks a folder starting in the main worktree's parent.
describe("AddWorktreeDialog browse", () => {
  it("should browse for a folder", async () => {
    vi.mocked(pickFolder).mockResolvedValueOnce("/picked/dir");
    const { user } = await renderDialog();
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    expect(pickFolder).toHaveBeenCalledExactlyOnceWith("Choose worktree folder", "/repos");
    await waitFor(() => expect(folder()).toHaveValue("/picked/dir"));
    await user.type(nameField(), "x");
    expect(folder()).toHaveValue("/picked/dir");
  });

  it("should change nothing when the pick is cancelled", async () => {
    const { user } = await renderDialog();
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(pickFolder).toHaveBeenCalledOnce());
    await user.type(nameField(), "x");
    expect(folder()).toHaveValue("/repos/app-x");
  });

  it("should browse without a default folder while no base is known", async () => {
    vi.mocked(listLinkedWorktrees).mockReturnValue(new Promise(() => undefined));
    const { user } = renderWithProviders(
      <AddWorktreeDialog repoId={1} open onClose={onClose} onAdded={onAdded} />,
    );
    await user.click(screen.getByRole("button", { name: "Browse…" }));
    expect(pickFolder).toHaveBeenCalledExactlyOnceWith("Choose worktree folder", undefined);
  });
});

// Contract: Escape, Cancel and a backdrop click close the dialog.
describe("AddWorktreeDialog cancel", () => {
  it("should cancel with Escape and the Cancel button", async () => {
    const { user } = await renderDialog();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(addLinkedWorktree).not.toHaveBeenCalled();
  });

  it("should ignore other keys", async () => {
    await renderDialog();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should close on a backdrop click but not on a click inside", async () => {
    await renderDialog();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
