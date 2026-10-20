import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addToGitignore,
  discardPaths,
  getStatus,
  onRepoChanged,
  stageAll,
  stagePaths,
  unstageAll,
  unstagePaths,
} from "../../lib/ipc";
import type {
  AppError,
  BranchList,
  ChangeKind,
  OperationState,
  StatusEntry,
  WorkingTreeStatus,
} from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { renderWithProviders } from "../../test/renderWithProviders";
import { useBranches } from "../branches/useBranches";
import { useIntegrationActions } from "../merge/useIntegrationActions";
import type { UseIntegrationActions } from "../merge/useIntegrationActions";
import { useOperationState } from "../merge/useOperationState";
import { ChangesPanel } from "./ChangesPanel";

vi.mock("../branches/useBranches", () => ({ useBranches: vi.fn() }));
vi.mock("../merge/useOperationState", () => ({ useOperationState: vi.fn() }));
vi.mock("../merge/useIntegrationActions", () => ({ useIntegrationActions: vi.fn() }));

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getStatus: vi.fn(),
  onRepoChanged: vi.fn(),
  stagePaths: vi.fn(),
  unstagePaths: vi.fn(),
  stageAll: vi.fn(),
  unstageAll: vi.fn(),
  discardPaths: vi.fn(),
  addToGitignore: vi.fn(),
}));

const entry = (over: Partial<StatusEntry> & { path: string }): StatusEntry => ({
  oldPath: null,
  index: null,
  worktree: null,
  conflicted: false,
  ...over,
});
const unstaged = (path: string, worktree: ChangeKind = "modified") => entry({ path, worktree });
const staged = (path: string, index: ChangeKind = "modified") => entry({ path, index });
const conflict = (path: string) => entry({ path, worktree: "conflicted", conflicted: true });
const status = (...entries: StatusEntry[]): WorkingTreeStatus => ({ entries, headUnborn: false });

const integrationRun = vi.fn<UseIntegrationActions["run"]>();
const integrationClear = vi.fn();

/** Drives the merge and branch hooks; defaults model HEAD on main with no operation. */
function provideMerge(
  opts: {
    state?: OperationState | undefined;
    head?: BranchList["head"];
    pending?: boolean;
    error?: AppError | null;
  } = {},
) {
  const { head = { kind: "branch", name: "main" } } = opts;
  const state = "state" in opts ? opts.state : ({ kind: "none" } as const);
  vi.mocked(useOperationState).mockReturnValue({ state, error: null, refetch: vi.fn() });
  vi.mocked(useBranches).mockReturnValue({
    branches: { head, local: [], remotes: [] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  vi.mocked(useIntegrationActions).mockReturnValue({
    run: integrationRun,
    pending: opts.pending ?? false,
    error: opts.error ?? null,
    clearError: integrationClear,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  integrationRun.mockResolvedValue(null);
  provideMerge();
  vi.mocked(onRepoChanged).mockResolvedValue(vi.fn());
  vi.mocked(getStatus).mockResolvedValue(status());
  vi.mocked(stagePaths).mockResolvedValue(undefined);
  vi.mocked(unstagePaths).mockResolvedValue(undefined);
  vi.mocked(stageAll).mockResolvedValue(undefined);
  vi.mocked(unstageAll).mockResolvedValue(undefined);
  vi.mocked(discardPaths).mockResolvedValue(undefined);
  vi.mocked(addToGitignore).mockResolvedValue("a.log");
  useWorkspace.setState(useWorkspace.getInitialState(), true);
});

async function renderPanel(...entries: StatusEntry[]) {
  vi.mocked(getStatus).mockResolvedValue(status(...entries));
  const view = renderWithProviders(<ChangesPanel repoId={1} />);
  await screen.findByRole("region", { name: "Changes" });
  await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  return view;
}

const list = (name: string) => screen.getByRole("list", { name });
const btn = (name: string) => screen.getByRole("button", { name });
const inList = (listName: string, name: string) =>
  within(list(listName)).getByRole("button", { name });

async function modClick(user: UserEvent, el: HTMLElement, key: "Control" | "Shift" | "Meta") {
  await user.keyboard(`{${key}>}`);
  await user.click(el);
  await user.keyboard(`{/${key}}`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<undefined>((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
}

const itemLabels = () => screen.getAllByRole("menuitem").map((i) => i.textContent);
const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 40, clientY: 60 });

// Contract: loading, empty and error states.
describe("ChangesPanel states", () => {
  it("should show a loading status while the status is pending", () => {
    vi.mocked(getStatus).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<ChangesPanel repoId={1} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading changes…");
  });

  it("should show No changes when the status has no entries", async () => {
    await renderPanel();
    expect(screen.getByText("No changes")).toBeInTheDocument();
  });

  it("should render no section headings when there are no entries", async () => {
    await renderPanel();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("should render the changes region when there are entries", async () => {
    await renderPanel(unstaged("a.txt"));
    expect(screen.getByRole("region", { name: "Changes" })).toBeInTheDocument();
  });

  it("should show a status error with its message", async () => {
    vi.mocked(getStatus).mockRejectedValueOnce({ kind: "io", message: "status exploded" });
    renderWithProviders(<ChangesPanel repoId={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("status exploded");
  });

  it("should not render the lists while the status query is in error", async () => {
    vi.mocked(getStatus).mockRejectedValueOnce({ kind: "io", message: "status exploded" });
    renderWithProviders(<ChangesPanel repoId={1} />);
    await screen.findByRole("alert");
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("should refetch the status and show the lists when the status error is dismissed", async () => {
    vi.mocked(getStatus)
      .mockRejectedValueOnce({ kind: "io", message: "status exploded" })
      .mockResolvedValue(status(unstaged("a.txt")));
    const { user } = renderWithProviders(<ChangesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(await screen.findByRole("list", { name: "Unstaged changes" })).toBeInTheDocument();
  });
});

// Contract: sections in order Conflicts, Staged, Unstaged with counts; empty sections hidden.
describe("ChangesPanel sections", () => {
  it("should show a heading with the count for each non-empty section", async () => {
    await renderPanel(conflict("c.txt"), staged("s1.txt"), staged("s2.txt"), unstaged("u.txt"));
    expect(screen.getAllByRole("heading").map((h) => h.textContent)).toEqual([
      "Conflicts (1)",
      "Staged (2)",
      "Unstaged (1)",
    ]);
  });

  it("should label each list by section", async () => {
    await renderPanel(conflict("c.txt"), staged("s.txt"), unstaged("u.txt"));
    expect(screen.getAllByRole("list").map((l) => l.getAttribute("aria-label"))).toEqual([
      "Conflicts",
      "Staged changes",
      "Unstaged changes",
    ]);
  });

  it("should not render empty sections", async () => {
    await renderPanel(unstaged("u.txt"));
    expect(screen.queryByRole("heading", { name: /^Staged/ })).toBeNull();
  });

  it("should not render the conflicts section when there are no conflicts", async () => {
    await renderPanel(staged("s.txt"));
    expect(screen.queryByRole("list", { name: "Conflicts" })).toBeNull();
  });

  it("should list a conflicted entry only under Conflicts", async () => {
    await renderPanel(conflict("c.txt"));
    expect(screen.getAllByRole("list")).toHaveLength(1);
  });

  it("should show the conflicted badge on a conflicts row", async () => {
    await renderPanel(conflict("c.txt"));
    expect(within(list("Conflicts")).getByRole("img", { name: "conflicted" })).toBeInTheDocument();
  });

  it("should list an entry changed in both index and worktree in both sections", async () => {
    await renderPanel(entry({ path: "a.txt", index: "added", worktree: "modified" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("should use the index kind for the staged row and the worktree kind for the unstaged row", async () => {
    await renderPanel(entry({ path: "a.txt", index: "added", worktree: "modified" }));
    expect(inList("Staged changes", "added a.txt")).toBeInTheDocument();
    expect(inList("Unstaged changes", "modified a.txt")).toBeInTheDocument();
  });

  it("should show an untracked entry as an untracked unstaged row", async () => {
    await renderPanel(unstaged("new.txt", "untracked"));
    expect(inList("Unstaged changes", "untracked new.txt")).toBeInTheDocument();
  });

  it("should show the rename display for a staged rename", async () => {
    await renderPanel(entry({ path: "b.txt", oldPath: "a.txt", index: "renamed" }));
    expect(inList("Staged changes", "renamed a.txt → b.txt")).toBeInTheDocument();
  });

  it("should keep backend order within a section", async () => {
    await renderPanel(unstaged("a.txt"), unstaged("b.txt"), unstaged("c.txt"));
    const rows = within(list("Unstaged changes")).getAllByRole("listitem");
    expect(rows.map((r) => /[abc]\.txt/.exec(r.textContent)?.[0])).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
  });
});

// Contract: row buttons and header buttons by section.
describe("ChangesPanel buttons", () => {
  it("should offer Discard only on unstaged rows", async () => {
    await renderPanel(staged("s.txt"), unstaged("u.txt"), conflict("c.txt"));
    expect(
      screen.getAllByRole("button", { name: /^Discard / }).map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Discard u.txt"]);
  });

  it("should offer Stage all in the unstaged section", async () => {
    await renderPanel(unstaged("u.txt"));
    expect(btn("Stage all")).toBeInTheDocument();
  });

  it("should offer Unstage all in the staged section", async () => {
    await renderPanel(staged("s.txt"));
    expect(btn("Unstage all")).toBeInTheDocument();
  });

  it("should not offer Stage all or Unstage all in the conflicts section", async () => {
    await renderPanel(conflict("c.txt"));
    expect(screen.queryByRole("button", { name: /all$/ })).toBeNull();
  });

  it("should call stageAll when Stage all is clicked", async () => {
    const { user } = await renderPanel(unstaged("u.txt"));
    await user.click(btn("Stage all"));
    expect(stageAll).toHaveBeenCalledWith(1);
  });

  it("should call unstageAll when Unstage all is clicked", async () => {
    const { user } = await renderPanel(staged("s.txt"));
    await user.click(btn("Unstage all"));
    expect(unstageAll).toHaveBeenCalledWith(1);
  });
});

// Contract: row actions target the clicked path, or the whole selection in that section.
describe("ChangesPanel stage and unstage", () => {
  it("should stage the single row path when Stage is clicked", async () => {
    const { user } = await renderPanel(unstaged("src/a.txt"));
    await user.click(btn("Stage src/a.txt"));
    expect(stagePaths).toHaveBeenCalledWith(1, ["src/a.txt"]);
  });

  it("should unstage the single row path when Unstage is clicked", async () => {
    const { user } = await renderPanel(staged("src/a.txt"));
    await user.click(btn("Unstage src/a.txt"));
    expect(unstagePaths).toHaveBeenCalledWith(1, ["src/a.txt"]);
  });

  it("should stage a conflicted path when its Stage button is clicked", async () => {
    const { user } = await renderPanel(conflict("c.txt"));
    await user.click(btn("Stage c.txt"));
    expect(stagePaths).toHaveBeenCalledWith(1, ["c.txt"]);
  });

  it("should stage all selected paths of the section when a selected row is staged", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"), unstaged("c.txt"));
    await user.click(btn("modified a.txt"));
    await modClick(user, btn("modified b.txt"), "Control");
    await user.click(btn("Stage a.txt"));
    expect(stagePaths).toHaveBeenCalledWith(1, ["a.txt", "b.txt"]);
  });

  it("should pass selected paths in display order when selected in reverse", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified b.txt"));
    await modClick(user, btn("modified a.txt"), "Control");
    await user.click(btn("Stage b.txt"));
    expect(stagePaths).toHaveBeenCalledWith(1, ["a.txt", "b.txt"]);
  });

  it("should unstage all selected paths when a selected staged row is unstaged", async () => {
    const { user } = await renderPanel(staged("a.txt"), staged("b.txt"));
    await user.click(btn("modified a.txt"));
    await modClick(user, btn("modified b.txt"), "Shift");
    await user.click(btn("Unstage b.txt"));
    expect(unstagePaths).toHaveBeenCalledWith(1, ["a.txt", "b.txt"]);
  });

  it("should act on the clicked row only when it is not part of the selection", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    await user.click(btn("Stage b.txt"));
    expect(stagePaths).toHaveBeenCalledWith(1, ["b.txt"]);
  });

  it("should keep the selection unchanged after acting on an unselected row", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    await user.click(btn("Stage b.txt"));
    expect(btn("modified a.txt")).toHaveAttribute("aria-pressed", "true");
  });

  it("should act on one path when nothing is selected", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("Stage a.txt"));
    expect(stagePaths).toHaveBeenCalledWith(1, ["a.txt"]);
  });

  it("should only include selected paths from the acted-on section", async () => {
    const { user } = await renderPanel(
      entry({ path: "a.txt", index: "modified", worktree: "modified" }),
    );
    await user.click(inList("Staged changes", "modified a.txt"));
    await modClick(user, inList("Unstaged changes", "modified a.txt"), "Control");
    await user.click(btn("Stage a.txt"));
    expect(stagePaths).toHaveBeenCalledExactlyOnceWith(1, ["a.txt"]);
  });
});

// Contract: selection with plain, ctrl, meta and shift clicks, independent per section.
describe("ChangesPanel selection", () => {
  it("should mark a row pressed when clicked", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    expect(btn("modified a.txt")).toHaveAttribute("aria-pressed", "true");
  });

  it("should replace the selection on a plain click", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    await user.click(btn("modified b.txt"));
    expect(btn("modified a.txt")).toHaveAttribute("aria-pressed", "false");
  });

  it("should add to the selection on a ctrl click", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    await modClick(user, btn("modified b.txt"), "Control");
    expect(btn("modified a.txt")).toHaveAttribute("aria-pressed", "true");
  });

  it("should add to the selection on a meta click", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    await modClick(user, btn("modified b.txt"), "Meta");
    expect(btn("modified b.txt")).toHaveAttribute("aria-pressed", "true");
  });

  it("should toggle a row off on a second ctrl click", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    await modClick(user, btn("modified a.txt"), "Control");
    expect(btn("modified a.txt")).toHaveAttribute("aria-pressed", "false");
  });

  it("should select the range from the anchor on a shift click", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"), unstaged("c.txt"));
    await user.click(btn("modified a.txt"));
    await modClick(user, btn("modified c.txt"), "Shift");
    expect(btn("modified b.txt")).toHaveAttribute("aria-pressed", "true");
  });

  it("should select the same file independently in Staged and Unstaged", async () => {
    const { user } = await renderPanel(
      entry({ path: "a.txt", index: "modified", worktree: "modified" }),
    );
    await user.click(inList("Staged changes", "modified a.txt"));
    expect(inList("Unstaged changes", "modified a.txt")).toHaveAttribute("aria-pressed", "false");
  });

  it("should record the staged scope in the workspace when a staged row is clicked", async () => {
    const { user } = await renderPanel(staged("a.txt"));
    await user.click(btn("modified a.txt"));
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "a.txt", scope: "staged" });
  });

  it("should record the unstaged scope in the workspace when an unstaged row is clicked", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("modified a.txt"));
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "a.txt", scope: "unstaged" });
  });

  it("should record the unstaged scope in the workspace when a conflicts row is clicked", async () => {
    const { user } = await renderPanel(conflict("c.txt"));
    await user.click(btn("conflicted c.txt"));
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "c.txt", scope: "unstaged" });
  });

  it("should record the clicked row in the workspace on a ctrl click", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    await modClick(user, btn("modified b.txt"), "Control");
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "b.txt", scope: "unstaged" });
  });

  it("should not touch the workspace selection when only an action button is clicked", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Stage a.txt"));
    expect(useWorkspace.getState().selected[1]).toBeUndefined();
  });

  it("should drop a row from the selection when it leaves the status", async () => {
    const { user, queryClient } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    vi.mocked(getStatus).mockResolvedValue(status(unstaged("b.txt")));
    await act(() => queryClient.invalidateQueries());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "modified a.txt" })).toBeNull(),
    );
    await user.click(btn("Stage b.txt"));
    expect(stagePaths).toHaveBeenCalledExactlyOnceWith(1, ["b.txt"]);
  });
});

// Contract: right click opens a per-row menu with actions that respect the selection.
describe("ChangesPanel context menu", () => {
  it("should offer Stage, Add to .gitignore and Delete… for an untracked row", async () => {
    await renderPanel(unstaged("new.txt", "untracked"));
    rightClick(btn("untracked new.txt"));
    expect(itemLabels()).toEqual(["Stage", "Add to .gitignore", "Delete…", "File history"]);
  });

  it("should offer Stage and Discard… for a tracked unstaged row", async () => {
    await renderPanel(unstaged("a.txt"));
    rightClick(btn("modified a.txt"));
    expect(itemLabels()).toEqual(["Stage", "Discard…", "File history"]);
  });

  it("should offer Unstage for a staged row", async () => {
    await renderPanel(staged("a.txt"));
    rightClick(btn("modified a.txt"));
    expect(itemLabels()).toEqual(["Unstage", "File history"]);
  });

  it("should offer Mark resolved (stage) for a conflicts row", async () => {
    await renderPanel(conflict("c.txt"));
    rightClick(btn("conflicted c.txt"));
    expect(itemLabels()).toEqual([
      "Keep ours",
      "Take theirs",
      "Mark resolved (stage)",
      "File history",
    ]);
  });

  it("should not show a menu until a row is right-clicked", async () => {
    await renderPanel(unstaged("a.txt"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should stage the row path from the Stage item", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    rightClick(btn("modified a.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Stage" }));
    expect(stagePaths).toHaveBeenCalledWith(1, ["a.txt"]);
  });

  it("should stage an untracked path from the Stage item", async () => {
    const { user } = await renderPanel(unstaged("new.txt", "untracked"));
    rightClick(btn("untracked new.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Stage" }));
    expect(stagePaths).toHaveBeenCalledWith(1, ["new.txt"]);
  });

  it("should unstage the row path from the Unstage item", async () => {
    const { user } = await renderPanel(staged("a.txt"));
    rightClick(btn("modified a.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Unstage" }));
    expect(unstagePaths).toHaveBeenCalledWith(1, ["a.txt"]);
  });

  it("should stage the conflicted path from Mark resolved (stage)", async () => {
    const { user } = await renderPanel(conflict("c.txt"));
    rightClick(btn("conflicted c.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Mark resolved (stage)" }));
    expect(stagePaths).toHaveBeenCalledWith(1, ["c.txt"]);
  });

  it("should stage the whole selection from the menu when the row is selected", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    await modClick(user, btn("modified b.txt"), "Control");
    rightClick(btn("modified b.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Stage" }));
    expect(stagePaths).toHaveBeenCalledWith(1, ["a.txt", "b.txt"]);
  });

  it("should call addToGitignore with the row path from Add to .gitignore", async () => {
    const { user } = await renderPanel(unstaged("a.log", "untracked"));
    rightClick(btn("untracked a.log"));
    await user.click(screen.getByRole("menuitem", { name: "Add to .gitignore" }));
    expect(addToGitignore).toHaveBeenCalledExactlyOnceWith(1, "a.log");
  });

  it("should add only the clicked row to .gitignore when several rows are selected", async () => {
    const { user } = await renderPanel(
      unstaged("a.log", "untracked"),
      unstaged("b.log", "untracked"),
    );
    await user.click(btn("untracked a.log"));
    await modClick(user, btn("untracked b.log"), "Control");
    rightClick(btn("untracked b.log"));
    await user.click(screen.getByRole("menuitem", { name: "Add to .gitignore" }));
    expect(addToGitignore).toHaveBeenCalledExactlyOnceWith(1, "b.log");
  });

  it("should close the menu after Add to .gitignore", async () => {
    const { user } = await renderPanel(unstaged("a.log", "untracked"));
    rightClick(btn("untracked a.log"));
    await user.click(screen.getByRole("menuitem", { name: "Add to .gitignore" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should close the menu after Stage", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    rightClick(btn("modified a.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Stage" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should close the menu and open the confirm dialog from Delete…", async () => {
    const { user } = await renderPanel(unstaged("new.txt", "untracked"));
    rightClick(btn("untracked new.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should move focus to Cancel when Delete… opens the dialog", async () => {
    const { user } = await renderPanel(unstaged("new.txt", "untracked"));
    rightClick(btn("untracked new.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(await screen.findByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("should open the confirm dialog from Discard…", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    rightClick(btn("modified a.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Discard…" }));
    expect(
      await screen.findByRole("dialog", { name: "Discard changes to a.txt?" }),
    ).toBeInTheDocument();
  });

  it("should discard the selection when Discard… is chosen on a selected row", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    await modClick(user, btn("modified b.txt"), "Control");
    rightClick(btn("modified a.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Discard…" }));
    expect(
      await screen.findByRole("dialog", { name: "Discard changes to 2 files?" }),
    ).toBeInTheDocument();
  });
});

// Contract: discard goes through a confirm dialog with copy that depends on the targets.
describe("ChangesPanel discard confirmation", () => {
  it("should open a confirm dialog titled with the path when Discard is clicked", async () => {
    const { user } = await renderPanel(unstaged("src/a.txt"));
    await user.click(btn("Discard src/a.txt"));
    expect(
      await screen.findByRole("dialog", { name: "Discard changes to src/a.txt?" }),
    ).toBeInTheDocument();
  });

  it("should describe a tracked discard as irreversible", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Discard a.txt"));
    expect(await screen.findByRole("dialog")).toHaveAccessibleDescription("This cannot be undone.");
  });

  it("should not call discardPaths before the dialog is confirmed", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Discard a.txt"));
    await screen.findByRole("dialog");
    expect(discardPaths).not.toHaveBeenCalled();
  });

  it("should call discardPaths with the path when Discard is confirmed", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Discard a.txt"));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(discardPaths).toHaveBeenCalledExactlyOnceWith(1, ["a.txt"]);
  });

  it("should close the dialog after confirming", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Discard a.txt"));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should close the dialog without discarding when cancelled", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Discard a.txt"));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should not call discardPaths when cancelled", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Discard a.txt"));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(discardPaths).not.toHaveBeenCalled();
  });

  it("should use delete copy for a single untracked file", async () => {
    const { user } = await renderPanel(unstaged("new.txt", "untracked"));
    await user.click(btn("Discard new.txt"));
    expect(
      await screen.findByRole("dialog", { name: "Delete untracked file new.txt?" }),
    ).toHaveAccessibleDescription("This cannot be undone.");
  });

  it("should label the confirm button Delete for a single untracked file", async () => {
    const { user } = await renderPanel(unstaged("new.txt", "untracked"));
    await user.click(btn("Discard new.txt"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(discardPaths).toHaveBeenCalledExactlyOnceWith(1, ["new.txt"]);
  });

  it("should title a multi-file discard with the count", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"), unstaged("c.txt"));
    await user.click(btn("modified a.txt"));
    await modClick(user, btn("modified c.txt"), "Shift");
    await user.click(btn("Discard b.txt"));
    expect(
      await screen.findByRole("dialog", { name: "Discard changes to 3 files?" }),
    ).toHaveAccessibleDescription("This cannot be undone.");
  });

  it("should discard every selected path of the section when confirmed", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    await modClick(user, btn("modified b.txt"), "Control");
    await user.click(btn("Discard a.txt"));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(discardPaths).toHaveBeenCalledWith(1, ["a.txt", "b.txt"]);
  });

  it("should warn that untracked files will be deleted when a mixed selection is discarded", async () => {
    const { user } = await renderPanel(unstaged("new.txt", "untracked"), unstaged("src/a.txt"));
    await user.click(btn("untracked new.txt"));
    await modClick(user, btn("modified src/a.txt"), "Control");
    await user.click(btn("Discard new.txt"));
    expect(
      await screen.findByRole("dialog", { name: "Discard changes to 2 files?" }),
    ).toHaveAccessibleDescription("Untracked files will be deleted. This cannot be undone.");
  });

  it("should discard both paths of a mixed selection in display order", async () => {
    const { user } = await renderPanel(unstaged("new.txt", "untracked"), unstaged("src/a.txt"));
    await user.click(btn("untracked new.txt"));
    await modClick(user, btn("modified src/a.txt"), "Control");
    await user.click(btn("Discard src/a.txt"));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(discardPaths).toHaveBeenCalledWith(1, ["new.txt", "src/a.txt"]);
  });

  it("should keep the snapshotted paths when the status changes while the dialog is open", async () => {
    const { user, queryClient } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("Discard a.txt"));
    await screen.findByRole("dialog");
    vi.mocked(getStatus).mockResolvedValue(status(unstaged("b.txt")));
    await act(() => queryClient.invalidateQueries());
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(discardPaths).toHaveBeenCalledExactlyOnceWith(1, ["a.txt"]);
  });
});

// Contract: while an action is pending, actions are disabled but selection still works.
describe("ChangesPanel pending", () => {
  const entries = () => [unstaged("a.txt"), staged("s.txt")];

  async function startPending() {
    const gate = deferred();
    vi.mocked(stagePaths).mockReturnValue(gate.promise);
    const view = await renderPanel(...entries());
    await view.user.click(btn("Stage a.txt"));
    await waitFor(() => expect(btn("Stage a.txt")).toBeDisabled());
    return { ...view, gate };
  }

  it("should disable the row Stage button while pending", async () => {
    await startPending();
    expect(btn("Stage a.txt")).toBeDisabled();
  });

  it("should disable the row Discard button while pending", async () => {
    await startPending();
    expect(btn("Discard a.txt")).toBeDisabled();
  });

  it("should disable the row Unstage button while pending", async () => {
    await startPending();
    expect(btn("Unstage s.txt")).toBeDisabled();
  });

  it("should disable Stage all while pending", async () => {
    await startPending();
    expect(btn("Stage all")).toBeDisabled();
  });

  it("should disable Unstage all while pending", async () => {
    await startPending();
    expect(btn("Unstage all")).toBeDisabled();
  });

  it("should keep row buttons enabled while pending", async () => {
    await startPending();
    expect(btn("modified a.txt")).toBeEnabled();
  });

  it("should disable every context menu item except File history while pending", async () => {
    await startPending();
    rightClick(btn("modified a.txt"));
    const others = screen.getAllByRole("menuitem").filter((i) => i.textContent !== "File history");
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((i) => (i as HTMLButtonElement).disabled)).toBe(true);
  });

  it("should keep File history enabled while pending", async () => {
    await startPending();
    rightClick(btn("modified a.txt"));
    expect(screen.getByRole("menuitem", { name: "File history" })).toBeEnabled();
  });

  it("should re-enable the buttons when the action settles", async () => {
    const { gate } = await startPending();
    await act(async () => gate.resolve());
    await waitFor(() => expect(btn("Stage a.txt")).toBeEnabled());
  });

  it("should leave the buttons enabled before any action", async () => {
    await renderPanel(...entries());
    expect(btn("Stage all")).toBeEnabled();
  });
});

// Contract: action failures show an alert above the lists and can be dismissed.
describe("ChangesPanel action errors", () => {
  const failure = { kind: "noChanges", message: "nothing to do" };

  it("should show the action error message", async () => {
    vi.mocked(stagePaths).mockRejectedValue(failure);
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Stage a.txt"));
    expect(await screen.findByRole("alert")).toHaveTextContent("nothing to do");
  });

  it("should keep the lists visible when an action fails", async () => {
    vi.mocked(stagePaths).mockRejectedValue(failure);
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Stage a.txt"));
    await screen.findByRole("alert");
    expect(list("Unstaged changes")).toBeInTheDocument();
  });

  it("should remove the alert when Dismiss is clicked", async () => {
    vi.mocked(stagePaths).mockRejectedValue(failure);
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Stage a.txt"));
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should not refetch the status when an action error is dismissed", async () => {
    vi.mocked(stagePaths).mockRejectedValue(failure);
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Stage a.txt"));
    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    // The failed action's own invalidation refetches once; wait for that to settle first.
    await waitFor(() => expect(btn("Stage a.txt")).toBeEnabled());
    const before = vi.mocked(getStatus).mock.calls.length;
    await user.click(dismiss);
    expect(vi.mocked(getStatus)).toHaveBeenCalledTimes(before);
  });

  it("should show an alert when a discard fails", async () => {
    vi.mocked(discardPaths).mockRejectedValue({ kind: "io", message: "disk said no" });
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Discard a.txt"));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk said no");
  });

  it("should show no alert when nothing has failed", async () => {
    await renderPanel(unstaged("a.txt"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: a shift range follows the global display order, but actions stay within the row's section.
describe("ChangesPanel cross-section behaviour", () => {
  const crossEntries = () => [
    staged("s1.txt"),
    staged("s2.txt"),
    unstaged("u1.txt"),
    unstaged("u2.txt"),
  ];

  async function selectAcrossBoundary() {
    const view = await renderPanel(...crossEntries());
    await view.user.click(btn("modified s1.txt"));
    await modClick(view.user, btn("modified u1.txt"), "Shift");
    return view;
  }

  it("should extend a shift range across the section boundary in display order", async () => {
    await selectAcrossBoundary();
    const pressed = ["s1.txt", "s2.txt", "u1.txt", "u2.txt"].map((p) =>
      screen.getAllByRole("button", { name: `modified ${p}` })[0].getAttribute("aria-pressed"),
    );
    expect(pressed).toEqual(["true", "true", "true", "false"]);
  });

  it("should stage only the unstaged part of a cross-section selection", async () => {
    const { user } = await selectAcrossBoundary();
    await user.click(btn("Stage u1.txt"));
    expect(stagePaths).toHaveBeenCalledExactlyOnceWith(1, ["u1.txt"]);
  });

  it("should unstage only the staged part of a cross-section selection", async () => {
    const { user } = await selectAcrossBoundary();
    await user.click(btn("Unstage s1.txt"));
    expect(unstagePaths).toHaveBeenCalledExactlyOnceWith(1, ["s1.txt", "s2.txt"]);
  });
});

// Contract: header buttons act on the whole repo and ignore the selection.
describe("ChangesPanel header buttons with a selection", () => {
  it("should call stageAll with the repo id only even when a row is selected", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    await user.click(btn("Stage all"));
    expect(stageAll).toHaveBeenCalledExactlyOnceWith(1);
    expect(stagePaths).not.toHaveBeenCalled();
  });

  it("should call unstageAll with the repo id only even when a row is selected", async () => {
    const { user } = await renderPanel(staged("a.txt"), staged("b.txt"));
    await user.click(btn("modified a.txt"));
    await user.click(btn("Unstage all"));
    expect(unstageAll).toHaveBeenCalledExactlyOnceWith(1);
    expect(unstagePaths).not.toHaveBeenCalled();
  });
});

// Contract: menu items use the same selection-aware targets as the row buttons.
describe("ChangesPanel menu targets", () => {
  it("should unstage the whole selection from the menu when the row is selected", async () => {
    const { user } = await renderPanel(staged("a.txt"), staged("b.txt"), staged("c.txt"));
    await user.click(btn("modified a.txt"));
    await modClick(user, btn("modified b.txt"), "Control");
    rightClick(btn("modified b.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Unstage" }));
    expect(unstagePaths).toHaveBeenCalledExactlyOnceWith(1, ["a.txt", "b.txt"]);
  });

  it("should stage every selected conflict from Mark resolved (stage)", async () => {
    const { user } = await renderPanel(conflict("x.txt"), conflict("y.txt"));
    await user.click(btn("conflicted x.txt"));
    await modClick(user, btn("conflicted y.txt"), "Control");
    rightClick(btn("conflicted y.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Mark resolved (stage)" }));
    expect(stagePaths).toHaveBeenCalledExactlyOnceWith(1, ["x.txt", "y.txt"]);
  });

  it("should act on the right-clicked row alone when it is not selected", async () => {
    const { user } = await renderPanel(unstaged("a.txt"), unstaged("b.txt"));
    await user.click(btn("modified a.txt"));
    rightClick(btn("modified b.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Stage" }));
    expect(stagePaths).toHaveBeenCalledExactlyOnceWith(1, ["b.txt"]);
  });
});

// Contract: dismissing a status error retries the query.
describe("ChangesPanel status error retry", () => {
  it("should call getStatus a second time when the status error is dismissed", async () => {
    vi.mocked(getStatus)
      .mockRejectedValueOnce({ kind: "io", message: "status exploded" })
      .mockResolvedValue(status());
    const { user } = renderWithProviders(<ChangesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    await screen.findByText("No changes");
    expect(getStatus).toHaveBeenCalledTimes(2);
  });
});

// Contract (final review I1b): actions on a renamed row target the new path and then the old path.
describe("ChangesPanel rename targets", () => {
  const unstagedRename = () =>
    entry({ path: "DOC.md", oldPath: "README.md", index: null, worktree: "renamed" });
  const stagedRename = () =>
    entry({ path: "DOC.md", oldPath: "README.md", index: "renamed", worktree: null });

  it("should stage both the new and the old path when an unstaged rename is staged", async () => {
    const { user } = await renderPanel(unstagedRename());
    await user.click(btn("Stage DOC.md"));
    expect(stagePaths).toHaveBeenCalledExactlyOnceWith(1, ["DOC.md", "README.md"]);
  });

  it("should unstage both the new and the old path when a staged rename is unstaged", async () => {
    const { user } = await renderPanel(stagedRename());
    await user.click(btn("Unstage DOC.md"));
    expect(unstagePaths).toHaveBeenCalledExactlyOnceWith(1, ["DOC.md", "README.md"]);
  });

  it("should discard both the new and the old path when an unstaged rename is discarded", async () => {
    const { user } = await renderPanel(unstagedRename());
    await user.click(btn("Discard DOC.md"));
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(discardPaths).toHaveBeenCalledExactlyOnceWith(1, ["DOC.md", "README.md"]);
  });

  it("should warn that the new file will be deleted when an unstaged rename is discarded", async () => {
    const { user } = await renderPanel(unstagedRename());
    await user.click(btn("Discard DOC.md"));
    expect(await screen.findByRole("dialog")).toHaveAccessibleDescription(
      "This cannot be undone. The new file DOC.md will be deleted.",
    );
  });

  it("should stage both paths of a rename from the context menu Stage item", async () => {
    const { user } = await renderPanel(unstagedRename());
    rightClick(btn("renamed README.md → DOC.md"));
    await user.click(screen.getByRole("menuitem", { name: "Stage" }));
    expect(stagePaths).toHaveBeenCalledExactlyOnceWith(1, ["DOC.md", "README.md"]);
  });

  it("should not add an old path for a non-renamed row", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Stage a.txt"));
    expect(stagePaths).toHaveBeenCalledExactlyOnceWith(1, ["a.txt"]);
  });
});

// Contract (final review C1): an untracked folder row says "folder", and a refused discard is shown.
describe("ChangesPanel untracked folder", () => {
  const folder = () => unstaged("vendor/lib/", "untracked");

  it("should title the delete dialog as an untracked folder when the path ends with a slash", async () => {
    const { user } = await renderPanel(folder());
    await user.click(btn("Discard vendor/lib/"));
    expect(
      await screen.findByRole("dialog", { name: "Delete untracked folder vendor/lib/?" }),
    ).toBeInTheDocument();
  });

  it("should keep the untracked file title for a path without a trailing slash", async () => {
    const { user } = await renderPanel(unstaged("vendor/lib", "untracked"));
    await user.click(btn("Discard vendor/lib"));
    expect(
      await screen.findByRole("dialog", { name: "Delete untracked file vendor/lib?" }),
    ).toBeInTheDocument();
  });

  it("should add an untracked folder to .gitignore from the context menu", async () => {
    const { user } = await renderPanel(folder());
    rightClick(btn("untracked vendor/lib/"));
    await user.click(screen.getByRole("menuitem", { name: "Add to .gitignore" }));
    expect(addToGitignore).toHaveBeenCalledExactlyOnceWith(1, "vendor/lib/");
  });

  it("should show a bad selection error from discarding a nested repository", async () => {
    vi.mocked(discardPaths).mockRejectedValue({
      kind: "badSelection",
      message: "the selection does not match the file's changes",
    });
    const { user } = await renderPanel(folder());
    await user.click(btn("Discard vendor/lib/"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "the selection does not match the file's changes",
    );
  });
});

// Contract: every row's menu ends with File history, which opens that file's history.
describe("ChangesPanel File history menu item", () => {
  const history = () => screen.getByRole("menuitem", { name: "File history" });
  const last = () => screen.getAllByRole("menuitem").at(-1);

  it("should offer File history last for a staged row", async () => {
    await renderPanel(staged("a.txt"));
    rightClick(btn("modified a.txt"));
    expect(last()).toBe(history());
  });

  it("should offer File history last for an unstaged row", async () => {
    await renderPanel(unstaged("a.txt"));
    rightClick(btn("modified a.txt"));
    expect(last()).toBe(history());
  });

  it("should offer File history last for an untracked row", async () => {
    await renderPanel(unstaged("new.txt", "untracked"));
    rightClick(btn("untracked new.txt"));
    expect(last()).toBe(history());
  });

  it("should offer File history last for a conflicted row", async () => {
    await renderPanel(conflict("c.txt"));
    rightClick(btn("conflicted c.txt"));
    expect(last()).toBe(history());
  });

  it("should show the file's history for a staged row", async () => {
    const { user } = await renderPanel(staged("s.txt"));
    rightClick(btn("modified s.txt"));
    await user.click(history());
    expect(useWorkspace.getState().historyPath[1]).toBe("s.txt");
  });

  it("should show the file's history for an unstaged row", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    rightClick(btn("modified a.txt"));
    await user.click(history());
    expect(useWorkspace.getState().historyPath[1]).toBe("a.txt");
  });

  it("should show the file's history for an untracked row", async () => {
    const { user } = await renderPanel(unstaged("new.txt", "untracked"));
    rightClick(btn("untracked new.txt"));
    await user.click(history());
    expect(useWorkspace.getState().historyPath[1]).toBe("new.txt");
  });

  it("should show the file's history for a conflicted row", async () => {
    const { user } = await renderPanel(conflict("c.txt"));
    rightClick(btn("conflicted c.txt"));
    await user.click(history());
    expect(useWorkspace.getState().historyPath[1]).toBe("c.txt");
  });

  it("should show a renamed file's history under its new path", async () => {
    const { user } = await renderPanel(
      entry({ path: "new.txt", oldPath: "old.txt", index: "renamed" }),
    );
    rightClick(btn("renamed old.txt → new.txt"));
    await user.click(history());
    expect(useWorkspace.getState().historyPath[1]).toBe("new.txt");
  });

  it("should not stage, unstage or discard anything from File history", async () => {
    const { user } = await renderPanel(unstaged("a.txt"));
    rightClick(btn("modified a.txt"));
    await user.click(history());
    expect(stagePaths).not.toHaveBeenCalled();
    expect(discardPaths).not.toHaveBeenCalled();
  });

  it("should show no history before the item is chosen", async () => {
    await renderPanel(unstaged("a.txt"));
    rightClick(btn("modified a.txt"));
    expect(useWorkspace.getState().historyPath[1]).toBeUndefined();
  });
});

// Contract (spec 5.4): conflict rows offer Keep/Take with side names from the operation.
describe("ChangesPanel conflict sides", () => {
  const message = { subject: "s", body: "" };
  const oid = (c: string) => c.repeat(40);
  const mergeState: OperationState = {
    kind: "merge",
    head: oid("a"),
    branch: "feature",
    message,
  };
  const rebaseState: OperationState = {
    kind: "rebase",
    onto: oid("b"),
    ontoName: "develop",
    branch: "topic",
    step: 1,
    total: 3,
  };
  const dirty: AppError = { kind: "unresolvedConflicts", message: "still conflicted" };

  const menuLabels = () => itemLabels().slice(0, 3);

  it("should offer Keep main, Take feature and Mark resolved for a merge with branch feature", async () => {
    provideMerge({ state: mergeState });
    await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    expect(menuLabels()).toEqual(["Keep main", "Take feature", "Mark resolved (stage)"]);
  });

  it("should label rebase sides with the onto name and the rebased branch", async () => {
    provideMerge({ state: rebaseState });
    await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    expect(menuLabels()).toEqual(["Keep develop", "Take topic", "Mark resolved (stage)"]);
  });

  it("should label cherry-pick sides with the head branch and the short oid", async () => {
    provideMerge({ state: { kind: "cherryPick", oid: oid("c"), message } });
    await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    expect(menuLabels()).toEqual(["Keep main", "Take ccccccc", "Mark resolved (stage)"]);
  });

  it("should label revert sides with the head branch and the short oid", async () => {
    provideMerge({ state: { kind: "revert", oid: oid("d"), message } });
    await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    expect(menuLabels()).toEqual(["Keep main", "Take ddddddd", "Mark resolved (stage)"]);
  });

  it("should use HEAD as the ours label when HEAD is detached during a merge", async () => {
    provideMerge({ state: mergeState, head: { kind: "detached", oid: oid("a") } });
    await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    expect(menuLabels()).toEqual(["Keep HEAD", "Take feature", "Mark resolved (stage)"]);
  });

  it("should fall back to ours and theirs without an operation", async () => {
    await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    expect(menuLabels()).toEqual(["Keep ours", "Take theirs", "Mark resolved (stage)"]);
  });

  it("should fall back to ours and theirs while the operation state is unknown", async () => {
    provideMerge({ state: undefined });
    await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    expect(menuLabels()).toEqual(["Keep ours", "Take theirs", "Mark resolved (stage)"]);
  });

  it("should not offer Keep or Take on unstaged or staged rows", async () => {
    provideMerge({ state: mergeState });
    await renderPanel(unstaged("a.txt"), staged("s.txt"));
    rightClick(btn("modified a.txt"));
    expect(itemLabels()).toEqual(["Stage", "Discard…", "File history"]);
  });

  // Contract: Keep and Take resolve the targeted paths with the matching side.
  it("should resolve the row path keeping ours from the Keep item", async () => {
    provideMerge({ state: mergeState });
    const { user } = await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    await user.click(screen.getByRole("menuitem", { name: "Keep main" }));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "resolve",
      paths: ["README.md"],
      side: "ours",
    });
  });

  it("should resolve the row path taking theirs from the Take item", async () => {
    provideMerge({ state: mergeState });
    const { user } = await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    await user.click(screen.getByRole("menuitem", { name: "Take feature" }));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "resolve",
      paths: ["README.md"],
      side: "theirs",
    });
  });

  it("should resolve every selected conflict when the row is part of the selection", async () => {
    provideMerge({ state: mergeState });
    const { user } = await renderPanel(conflict("x.txt"), conflict("y.txt"));
    await user.click(btn("conflicted x.txt"));
    await modClick(user, btn("conflicted y.txt"), "Control");
    rightClick(btn("conflicted y.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Take feature" }));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "resolve",
      paths: ["x.txt", "y.txt"],
      side: "theirs",
    });
  });

  it("should resolve only the right-clicked row when it is not selected", async () => {
    provideMerge({ state: mergeState });
    const { user } = await renderPanel(conflict("x.txt"), conflict("y.txt"));
    await user.click(btn("conflicted x.txt"));
    rightClick(btn("conflicted y.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Keep main" }));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "resolve",
      paths: ["y.txt"],
      side: "ours",
    });
  });

  it("should keep Mark resolved on the staging action, not the integration run", async () => {
    provideMerge({ state: mergeState });
    const { user } = await renderPanel(conflict("c.txt"));
    rightClick(btn("conflicted c.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Mark resolved (stage)" }));
    expect(integrationRun).not.toHaveBeenCalled();
  });

  // Contract: items are disabled while either hook is pending.
  it("should disable Keep and Take while an integration action is pending", async () => {
    provideMerge({ state: mergeState, pending: true });
    await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    expect(screen.getByRole("menuitem", { name: "Keep main" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Take feature" })).toBeDisabled();
  });

  it("should disable Mark resolved while an integration action is pending", async () => {
    provideMerge({ state: mergeState, pending: true });
    await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    expect(screen.getByRole("menuitem", { name: "Mark resolved (stage)" })).toBeDisabled();
  });

  it("should keep Keep and Take enabled when nothing is pending", async () => {
    provideMerge({ state: mergeState });
    await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    expect(screen.getByRole("menuitem", { name: "Keep main" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Take feature" })).toBeEnabled();
  });

  it("should keep File history enabled while an integration action is pending", async () => {
    provideMerge({ state: mergeState, pending: true });
    await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    expect(screen.getByRole("menuitem", { name: "File history" })).toBeEnabled();
  });

  it("should disable the row buttons while an integration action is pending", async () => {
    provideMerge({ state: mergeState, pending: true });
    await renderPanel(conflict("README.md"), unstaged("a.txt"));
    expect(btn("Stage README.md")).toBeDisabled();
    expect(btn("Stage a.txt")).toBeDisabled();
  });

  it("should disable Stage all and Unstage all while only the integration is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel(unstaged("a.txt"), staged("s.txt"));
    expect(btn("Stage all")).toBeDisabled();
    expect(btn("Unstage all")).toBeDisabled();
  });

  it("should clear an earlier staging error when Keep or Take is chosen", async () => {
    vi.mocked(stagePaths).mockRejectedValue({ kind: "io", message: "stage exploded" });
    const { user } = await renderPanel(unstaged("a.txt"), conflict("README.md"));
    await user.click(btn("Stage a.txt"));
    await screen.findByText(/stage exploded/);
    rightClick(btn("conflicted README.md"));
    await user.click(screen.getByRole("menuitem", { name: "Keep ours" }));
    expect(screen.queryByText(/stage exploded/)).toBeNull();
    expect(integrationRun).toHaveBeenCalledTimes(1);
  });

  it("should keep the row buttons enabled when the integration is idle", async () => {
    await renderPanel(conflict("README.md"));
    expect(btn("Stage README.md")).toBeEnabled();
  });

  // Contract: integration errors share the panel's error slot.
  it("should show an integration error as an alert with its message", async () => {
    provideMerge({ error: dirty });
    await renderPanel(conflict("README.md"));
    expect(screen.getByRole("alert")).toHaveTextContent(dirty.message);
  });

  it("should show no alert when the integration has no error", async () => {
    await renderPanel(conflict("README.md"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should clear the integration error on Dismiss", async () => {
    provideMerge({ error: dirty });
    const { user } = await renderPanel(conflict("README.md"));
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(integrationClear).toHaveBeenCalledTimes(1);
  });

  it("should show a staging error before the integration error", async () => {
    provideMerge({ error: dirty });
    vi.mocked(stagePaths).mockRejectedValue({ kind: "io", message: "stage exploded" });
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Stage a.txt"));
    expect(await screen.findByRole("alert")).toHaveTextContent("stage exploded");
  });
});

// Coverage audit: dismiss hygiene, loading branches and multi-select on both sides.
describe("ChangesPanel conflict sides gaps", () => {
  const message = { subject: "s", body: "" };
  const mergeState: OperationState = {
    kind: "merge",
    head: "a".repeat(40),
    branch: "feature",
    message,
  };
  const dirty: AppError = { kind: "unresolvedConflicts", message: "still conflicted" };
  const stageFailed = { kind: "io", message: "stage exploded" };

  it("should name the ours side HEAD while the branch list is still loading", async () => {
    provideMerge({ state: mergeState });
    vi.mocked(useBranches).mockReturnValue({
      branches: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });
    await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    expect(itemLabels().slice(0, 2)).toEqual(["Keep HEAD", "Take feature"]);
  });

  it("should clear the staging error too when Dismiss is pressed", async () => {
    provideMerge({ error: dirty });
    vi.mocked(stagePaths).mockRejectedValue(stageFailed);
    const { user } = await renderPanel(unstaged("a.txt"));
    await user.click(btn("Stage a.txt"));
    await screen.findByText(/stage exploded/);
    await user.click(btn("Dismiss"));
    expect(screen.queryByText(/stage exploded/)).toBeNull();
    expect(integrationClear).toHaveBeenCalledTimes(1);
  });

  it("should clear the integration error before running Keep", async () => {
    provideMerge({ state: mergeState, error: dirty });
    const { user } = await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    await user.click(screen.getByRole("menuitem", { name: "Keep main" }));
    expect(integrationClear).toHaveBeenCalledTimes(1);
    expect(integrationClear.mock.invocationCallOrder[0]).toBeLessThan(
      integrationRun.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("should keep every selected conflict path when Keep is chosen on a multi-selection", async () => {
    provideMerge({ state: mergeState });
    const { user } = await renderPanel(conflict("x.txt"), conflict("y.txt"), conflict("z.txt"));
    await user.click(btn("conflicted x.txt"));
    await modClick(user, btn("conflicted z.txt"), "Control");
    rightClick(btn("conflicted x.txt"));
    await user.click(screen.getByRole("menuitem", { name: "Keep main" }));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "resolve",
      paths: ["x.txt", "z.txt"],
      side: "ours",
    });
  });

  it("should not run anything when a pending Keep item is clicked", async () => {
    provideMerge({ state: mergeState, pending: true });
    const { user } = await renderPanel(conflict("README.md"));
    rightClick(btn("conflicted README.md"));
    await user.click(screen.getByRole("menuitem", { name: "Keep main" }));
    expect(integrationRun).not.toHaveBeenCalled();
  });

  it("should offer Keep and Take for a conflict next to staged and unstaged rows", async () => {
    provideMerge({ state: mergeState });
    await renderPanel(conflict("c.txt"), unstaged("a.txt"), staged("s.txt"));
    rightClick(btn("conflicted c.txt"));
    expect(itemLabels()).toEqual([
      "Keep main",
      "Take feature",
      "Mark resolved (stage)",
      "File history",
    ]);
  });

  it("should disable the untracked, staged and unstaged menus while only the integration is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel(unstaged("a.txt"), staged("s.txt"));
    rightClick(btn("modified a.txt"));
    const staging = screen.getAllByRole("menuitem").filter((i) => i.textContent !== "File history");
    for (const item of staging) expect(item).toBeDisabled();
    expect(staging.length).toBeGreaterThan(0);
  });
});

// Contract (spec 4.11): the Conflicts header offers Resolve all… with Keep/Take for every conflicted path.
describe("ChangesPanel Resolve all", () => {
  const message = { subject: "s", body: "" };
  const mergeState: OperationState = {
    kind: "merge",
    head: "a".repeat(40),
    branch: "feature",
    message,
  };
  const conflictsSection = () => screen.getByRole("region", { name: /^Conflicts/ });
  const resolveAll = () => within(conflictsSection()).getByRole("button", { name: "Resolve all…" });
  const openMenu = async (user: UserEvent) => {
    await user.click(resolveAll());
  };

  it("Conflicts header shows Resolve all… and no Stage all", async () => {
    await renderPanel(conflict("a.txt"));
    expect(resolveAll()).toBeInTheDocument();
    expect(within(conflictsSection()).queryByRole("button", { name: "Stage all" })).toBeNull();
  });

  it("does not show Resolve all… in the Staged or Unstaged sections", async () => {
    await renderPanel(conflict("a.txt"), staged("s.txt"), unstaged("u.txt"));
    expect(screen.getAllByRole("button", { name: "Resolve all…" })).toHaveLength(1);
  });

  it("does not show Resolve all… without conflicts", async () => {
    await renderPanel(unstaged("u.txt"));
    expect(screen.queryByRole("button", { name: "Resolve all…" })).toBeNull();
  });

  it("does not open the menu before the button is clicked", async () => {
    await renderPanel(conflict("a.txt"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Resolve all… opens a menu with Keep {ours} for all files and Take {theirs} for all files", async () => {
    provideMerge({ state: mergeState });
    const { user } = await renderPanel(conflict("a.txt"), conflict("b.txt"));
    await openMenu(user);
    expect(itemLabels()).toEqual(["Keep main for all files", "Take feature for all files"]);
  });

  it("falls back to ours and theirs in the Resolve all… menu without an operation", async () => {
    const { user } = await renderPanel(conflict("a.txt"));
    await openMenu(user);
    expect(itemLabels()).toEqual(["Keep ours for all files", "Take theirs for all files"]);
  });

  it("Keep … for all files resolves every conflicted path with ours", async () => {
    provideMerge({ state: mergeState });
    const { user } = await renderPanel(conflict("a.txt"), conflict("b.txt"), unstaged("u.txt"));
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Keep main for all files" }));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "resolve",
      paths: ["a.txt", "b.txt"],
      side: "ours",
    });
  });

  it("Take … for all files resolves every conflicted path with theirs", async () => {
    provideMerge({ state: mergeState });
    const { user } = await renderPanel(conflict("a.txt"), conflict("b.txt"), staged("s.txt"));
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Take feature for all files" }));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "resolve",
      paths: ["a.txt", "b.txt"],
      side: "theirs",
    });
  });

  it("closes the menu after an item is chosen", async () => {
    const { user } = await renderPanel(conflict("a.txt"));
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Keep ours for all files" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Resolve all… is disabled while an action is pending", async () => {
    provideMerge({ state: mergeState, pending: true });
    await renderPanel(conflict("a.txt"));
    expect(resolveAll()).toBeDisabled();
  });

  it("a failure shows in the panel error slot", async () => {
    provideMerge({
      state: mergeState,
      error: { kind: "operationFailed", message: "could not resolve" },
    });
    await renderPanel(conflict("a.txt"));
    expect(screen.getByRole("alert")).toHaveTextContent("could not resolve");
  });

  it("Escape closes the menu", async () => {
    const { user } = await renderPanel(conflict("a.txt"));
    await openMenu(user);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not run an integration action when the menu is dismissed", async () => {
    const { user } = await renderPanel(conflict("a.txt"));
    await openMenu(user);
    await user.keyboard("{Escape}");
    expect(integrationRun).not.toHaveBeenCalled();
  });
  it("opens from the keyboard with the first item focused and returns focus to the button on close", async () => {
    const { user } = await renderPanel(conflict("a.txt"));
    resolveAll().focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Keep ours for all files" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(resolveAll()).toHaveFocus();
  });

  it("chooses Take … for all files with ArrowDown and Enter", async () => {
    provideMerge({ state: mergeState });
    const { user } = await renderPanel(conflict("a.txt"), conflict("b.txt"));
    resolveAll().focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "resolve",
      paths: ["a.txt", "b.txt"],
      side: "theirs",
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the menu after Take … for all files is chosen", async () => {
    const { user } = await renderPanel(conflict("a.txt"));
    await openMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Take theirs for all files" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("anchors the menu under the Resolve all… button", async () => {
    const { user } = await renderPanel(conflict("a.txt"));
    vi.spyOn(resolveAll(), "getBoundingClientRect").mockReturnValue({
      left: 30,
      bottom: 70,
      top: 50,
      right: 130,
      width: 100,
      height: 20,
      x: 30,
      y: 50,
      toJSON: () => ({}),
    });
    await openMenu(user);
    expect(screen.getByRole("menu")).toHaveStyle({ left: "30px", top: "70px" });
  });

  it("a row's context menu replaces the open Resolve all… menu", async () => {
    const { user } = await renderPanel(conflict("a.txt"));
    await openMenu(user);
    rightClick(btn("conflicted a.txt"));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(itemLabels()).not.toContain("Keep ours for all files");
    expect(itemLabels()).toContain("Mark resolved (stage)");
  });

  it("Resolve all… after a row's context menu shows only the bulk items", async () => {
    const { user } = await renderPanel(conflict("a.txt"));
    rightClick(btn("conflicted a.txt"));
    await user.keyboard("{Escape}");
    await openMenu(user);
    expect(itemLabels()).toEqual(["Keep ours for all files", "Take theirs for all files"]);
  });
});
