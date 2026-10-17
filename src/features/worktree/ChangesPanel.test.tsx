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
import type { ChangeKind, StatusEntry, WorkingTreeStatus } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { renderWithProviders } from "../../test/renderWithProviders";
import { ChangesPanel } from "./ChangesPanel";

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

beforeEach(() => {
  vi.resetAllMocks();
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
    expect(itemLabels()).toEqual(["Stage", "Add to .gitignore", "Delete…"]);
  });

  it("should offer Stage and Discard… for a tracked unstaged row", async () => {
    await renderPanel(unstaged("a.txt"));
    rightClick(btn("modified a.txt"));
    expect(itemLabels()).toEqual(["Stage", "Discard…"]);
  });

  it("should offer Unstage for a staged row", async () => {
    await renderPanel(staged("a.txt"));
    rightClick(btn("modified a.txt"));
    expect(itemLabels()).toEqual(["Unstage"]);
  });

  it("should offer Mark resolved (stage) for a conflicts row", async () => {
    await renderPanel(conflict("c.txt"));
    rightClick(btn("conflicted c.txt"));
    expect(itemLabels()).toEqual(["Mark resolved (stage)"]);
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

  it("should disable every context menu item while pending", async () => {
    await startPending();
    rightClick(btn("modified a.txt"));
    expect(screen.getAllByRole("menuitem").every((i) => (i as HTMLButtonElement).disabled)).toBe(
      true,
    );
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
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    const calls = vi.mocked(getStatus).mock.calls.length;
    await new Promise((r) => setTimeout(r, 0));
    expect(vi.mocked(getStatus).mock.calls.length).toBe(calls);
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
