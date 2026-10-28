import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addLinkedWorktree,
  closeRepo,
  isLinkedWorktreeDirty,
  listBranches,
  listLinkedWorktrees,
  openRepo,
  pruneLinkedWorktrees,
  removeLinkedWorktree,
  updateSettings,
} from "../../lib/ipc";
import type { AppError, BranchList, LinkedWorktree, OpenedRepo } from "../../lib/ipc";
import { useCommitDraft } from "../../lib/store/commitDraft";
import { useRepoTabs } from "../../lib/store/repoTabs";
import { useSettings } from "../../lib/store/settings";
import { oidOf } from "../../test/graphFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { resetSettings, seedSettings } from "../../test/settingsStore";
import { linkedWorktree } from "../../test/worktreeFixtures";
import { WorktreesPanel } from "./WorktreesPanel";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  updateSettings: vi.fn(),
  listLinkedWorktrees: vi.fn(),
  addLinkedWorktree: vi.fn(),
  removeLinkedWorktree: vi.fn(),
  pruneLinkedWorktrees: vi.fn(),
  listBranches: vi.fn(),
  openRepo: vi.fn(),
  closeRepo: vi.fn(),
  isLinkedWorktreeDirty: vi.fn(),
}));

const main = linkedWorktree();
const a = linkedWorktree({
  name: "a",
  path: "/repos/app-feat-a",
  head: { kind: "branch", name: "feat/a" },
  isMain: false,
  isCurrent: false,
});
const stale = linkedWorktree({
  name: "gone",
  path: "/repos/app-gone",
  head: { kind: "branch", name: "gone" },
  isMain: false,
  isCurrent: false,
  missing: true,
});

const branches = (): BranchList => ({
  head: { kind: "branch", name: "main" },
  local: [
    { name: "main", oid: oidOf(0), isHead: true, tracking: null, worktree: null },
    { name: "feat/a", oid: oidOf(1), isHead: false, tracking: null, worktree: a.path },
  ],
  remotes: [],
});

const opened = (id: number, path: string): OpenedRepo => ({
  id,
  summary: { path, name: path.split("/").at(-1) as string, headBranch: "main", isBare: false },
});

beforeEach(async () => {
  vi.resetAllMocks();
  await resetSettings();
  useRepoTabs.setState({ tabs: [], activeId: null });
  vi.mocked(listLinkedWorktrees).mockResolvedValue([main, a]);
  vi.mocked(listBranches).mockResolvedValue(branches());
  vi.mocked(addLinkedWorktree).mockResolvedValue(undefined);
  vi.mocked(removeLinkedWorktree).mockResolvedValue(undefined);
  vi.mocked(pruneLinkedWorktrees).mockResolvedValue({ paths: [] });
  vi.mocked(openRepo).mockImplementation(async (path) => opened(9, path));
  vi.mocked(closeRepo).mockResolvedValue(undefined);
  vi.mocked(isLinkedWorktreeDirty).mockResolvedValue(false);
  useCommitDraft.setState({ drafts: {} });
});

async function renderPanel() {
  const view = renderWithProviders(<WorktreesPanel repoId={1} />);
  await screen.findByRole("list", { name: "Worktree list" });
  return view;
}

const list = () => screen.getByRole("list", { name: "Worktree list" });
const row = (folder: string) =>
  within(list()).getByText(folder).closest("button") as HTMLButtonElement;
const toggle = () => screen.getByRole("button", { name: /^Worktrees( \(|$)/ });
const plus = () => screen.getByRole("button", { name: "Add worktree…" });
const pruneButton = () => screen.getByRole("button", { name: "Prune stale worktrees" });
const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0] as number;
const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 10, clientY: 20 });
const menuItem = (name: string) => screen.getByRole("menuitem", { name });

async function chooseRemove(folder: string) {
  rightClick(row(folder));
  fireEvent.click(menuItem("Remove…"));
  return screen.findByRole("dialog", { name: `Remove worktree ${folder}?` });
}

// Contract: the section lists every worktree under a counted, collapsible heading.
describe("WorktreesPanel list", () => {
  it("should list the worktrees with the heading count", async () => {
    await renderPanel();
    expect(toggle()).toHaveTextContent("Worktrees (2)");
    const rows = within(list()).getAllByRole("button");
    expect(rows.map((r) => r.getAttribute("title"))).toEqual(["/repos/app", "/repos/app-feat-a"]);
  });

  it("should label the region by the heading", async () => {
    await renderPanel();
    expect(screen.getByRole("region", { name: "Worktrees (2)" })).not.toHaveAttribute("aria-busy");
  });

  it("should show a loading line until the list arrives", () => {
    vi.mocked(listLinkedWorktrees).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<WorktreesPanel repoId={1} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading worktrees…");
  });

  it("should show Worktrees without a count while loading", () => {
    vi.mocked(listLinkedWorktrees).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<WorktreesPanel repoId={1} />);
    expect(toggle()).toHaveTextContent(/^Worktrees$/);
  });

  it("should show the bare message for an empty list", async () => {
    vi.mocked(listLinkedWorktrees).mockResolvedValue([]);
    renderWithProviders(<WorktreesPanel repoId={1} />);
    expect(await screen.findByText("Not available for bare repositories")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add worktree…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Prune stale worktrees" })).toBeNull();
  });

  it("should show a list error with Retry", async () => {
    vi.mocked(listLinkedWorktrees).mockRejectedValueOnce({ kind: "git", message: "broken" });
    const { user } = renderWithProviders(<WorktreesPanel repoId={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("broken");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Worktree list" })).toBeInTheDocument();
  });

  it("should collapse and expand with the stored preference", async () => {
    const { user } = await renderPanel();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle());
    expect(screen.queryByRole("list", { name: "Worktree list" })).toBeNull();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(useSettings.getState().settings.layout.worktreesCollapsed).toBe(true);
    await user.click(toggle());
    expect(await screen.findByRole("list", { name: "Worktree list" })).toBeInTheDocument();
    expect(useSettings.getState().settings.layout.worktreesCollapsed).toBe(false);
  });

  it("should start collapsed when the stored preference is collapsed", async () => {
    await seedSettings({ layout: { worktreesCollapsed: true } });
    renderWithProviders(<WorktreesPanel repoId={1} />);
    await waitFor(() => expect(toggle()).toHaveTextContent("Worktrees (2)"));
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Worktree list" })).toBeNull();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("the heading is a programmatic focus target", async () => {
    await renderPanel();
    const heading = screen.getByRole("heading", { name: /^Worktrees/ });
    expect(heading).toHaveAttribute("data-focus-target");
    expect(heading).toHaveAttribute("tabindex", "-1");
  });
});

// Contract: double-click, Enter and Open open the worktree as a tab; the current and missing ones cannot.
describe("WorktreesPanel open", () => {
  it("should open a worktree on double-click and Enter", async () => {
    const { user } = await renderPanel();
    await user.dblClick(row("app-feat-a"));
    await waitFor(() => expect(openRepo).toHaveBeenCalledExactlyOnceWith("/repos/app-feat-a"));
    fireEvent.keyDown(row("app-feat-a"), { key: "Enter" });
    await waitFor(() => expect(openRepo).toHaveBeenCalledTimes(2));
    expect(useRepoTabs.getState().tabs.map((t) => t.summary.path)).toEqual(["/repos/app-feat-a"]);
  });

  it("should open a worktree from the menu", async () => {
    await renderPanel();
    rightClick(row("app-feat-a"));
    expect(menuItem("Open")).toBeEnabled();
    fireEvent.click(menuItem("Open"));
    await waitFor(() => expect(openRepo).toHaveBeenCalledExactlyOnceWith("/repos/app-feat-a"));
  });

  it("should not open the current worktree and disable Open with Already open in this tab", async () => {
    const { user } = await renderPanel();
    await user.dblClick(row("app"));
    fireEvent.keyDown(row("app"), { key: "Enter" });
    rightClick(row("app"));
    expect(menuItem("Open")).toBeDisabled();
    expect(menuItem("Open")).toHaveAttribute("title", "Already open in this tab");
    expect(openRepo).not.toHaveBeenCalled();
  });

  it("should disable Open for a missing worktree with Folder not found", async () => {
    vi.mocked(listLinkedWorktrees).mockResolvedValue([main, stale]);
    const { user } = await renderPanel();
    await user.dblClick(row("app-gone"));
    rightClick(row("app-gone"));
    expect(menuItem("Open")).toBeDisabled();
    expect(menuItem("Open")).toHaveAttribute("title", "Folder not found");
    expect(openRepo).not.toHaveBeenCalled();
  });

  it("should show an open failure inline", async () => {
    vi.mocked(openRepo).mockRejectedValue({ kind: "notARepository", message: "not a repo" });
    const { user } = await renderPanel();
    await user.dblClick(row("app-feat-a"));
    expect(await screen.findByRole("alert")).toHaveTextContent("not a repo");
    expect(screen.queryByRole("button", { name: "Initialize repository here" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should close the menu on Escape without acting", async () => {
    const { user } = await renderPanel();
    rightClick(row("app-feat-a"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(openRepo).not.toHaveBeenCalled();
  });
});

// Contract: Remove… confirms once, and again with force when the worktree is dirty.
describe("WorktreesPanel remove", () => {
  it("should disable Remove… for main, current and locked rows with their titles", async () => {
    const locked = { ...a, locked: "on a USB disk" };
    const lockedBare = { ...stale, missing: false, locked: "" };
    const notCurrentMain = { ...main, isCurrent: false };
    const current = { ...a, name: "c", path: "/repos/app-c", isCurrent: true };
    vi.mocked(listLinkedWorktrees).mockResolvedValue([notCurrentMain, current, locked, lockedBare]);
    await renderPanel();
    const cases: Array<[LinkedWorktree, string]> = [
      [notCurrentMain, "The main worktree cannot be removed"],
      [current, "Close this tab and remove it from another worktree"],
      [locked, "Locked: on a USB disk"],
      [lockedBare, "Locked"],
    ];
    for (const [w, title] of cases) {
      rightClick(within(list()).getByTitle(w.path));
      expect(menuItem("Remove…")).toBeDisabled();
      expect(menuItem("Remove…")).toHaveAttribute("title", title);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    }
  });

  it("should confirm, then remove without force", async () => {
    const { user } = await renderPanel();
    const dialog = await chooseRemove("app-feat-a");
    expect(dialog).toHaveTextContent(
      "The folder and its contents are deleted. The branch is kept.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(removeLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-feat-a", false),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should cancel the first step without removing", async () => {
    const { user } = await renderPanel();
    const dialog = await chooseRemove("app-feat-a");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(removeLinkedWorktree).not.toHaveBeenCalled();
  });

  it("should check dirtiness before closing the tab and skip the force step when clean", async () => {
    useRepoTabs.getState().openTab(opened(5, a.path));
    const { user } = await renderPanel();
    await user.click(
      within(await chooseRemove("app-feat-a")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() =>
      expect(removeLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-feat-a", false),
    );
    expect(isLinkedWorktreeDirty).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-feat-a");
    expect(closeRepo).toHaveBeenCalledExactlyOnceWith(5);
    expect(order(isLinkedWorktreeDirty)).toBeLessThan(order(closeRepo));
    expect(order(closeRepo)).toBeLessThan(order(removeLinkedWorktree));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should show the force step from the dirty check without closing the tab", async () => {
    vi.mocked(isLinkedWorktreeDirty).mockResolvedValue(true);
    useRepoTabs.getState().openTab(opened(5, a.path));
    const { user } = await renderPanel();
    await user.click(
      within(await chooseRemove("app-feat-a")).getByRole("button", { name: "Remove" }),
    );
    const force = await screen.findByRole("dialog", { name: "app-feat-a has uncommitted changes" });
    expect(force).toHaveTextContent("Removing it discards them. This can't be undone.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(closeRepo).not.toHaveBeenCalled();
    expect(removeLinkedWorktree).not.toHaveBeenCalled();
    expect(useRepoTabs.getState().tabs.map((t) => t.id)).toEqual([5]);
  });

  it("should keep the tab and draft when the force step is cancelled", async () => {
    vi.mocked(isLinkedWorktreeDirty).mockResolvedValue(true);
    useRepoTabs.getState().openTab(opened(5, a.path));
    useCommitDraft.getState().setSubject(5, "wip subject");
    const { user } = await renderPanel();
    await user.click(
      within(await chooseRemove("app-feat-a")).getByRole("button", { name: "Remove" }),
    );
    const force = await screen.findByRole("dialog", { name: "app-feat-a has uncommitted changes" });
    await user.click(within(force).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(removeLinkedWorktree).not.toHaveBeenCalled();
    expect(closeRepo).not.toHaveBeenCalled();
    expect(useRepoTabs.getState().tabs.map((t) => t.id)).toEqual([5]);
    expect(useCommitDraft.getState().drafts[5]?.subject).toBe("wip subject");
  });

  it("should close the tab and remove with force on Remove anyway", async () => {
    vi.mocked(isLinkedWorktreeDirty).mockResolvedValue(true);
    useRepoTabs.getState().openTab(opened(5, a.path));
    const { user } = await renderPanel();
    await user.click(
      within(await chooseRemove("app-feat-a")).getByRole("button", { name: "Remove" }),
    );
    const force = await screen.findByRole("dialog", { name: "app-feat-a has uncommitted changes" });
    await user.click(within(force).getByRole("button", { name: "Remove anyway" }));
    await waitFor(() =>
      expect(removeLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-feat-a", true),
    );
    expect(closeRepo).toHaveBeenCalledExactlyOnceWith(5);
    expect(order(closeRepo)).toBeLessThan(order(removeLinkedWorktree));
    expect(useRepoTabs.getState().tabs).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should show a dirty-check error inline", async () => {
    vi.mocked(isLinkedWorktreeDirty).mockRejectedValue({ kind: "git", message: "status broke" });
    useRepoTabs.getState().openTab(opened(5, a.path));
    const { user } = await renderPanel();
    await user.click(
      within(await chooseRemove("app-feat-a")).getByRole("button", { name: "Remove" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("status broke");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(closeRepo).not.toHaveBeenCalled();
    expect(removeLinkedWorktree).not.toHaveBeenCalled();
    expect(useRepoTabs.getState().tabs.map((t) => t.id)).toEqual([5]);
  });

  it("should reopen the force step on worktreeDirty from the remove itself", async () => {
    vi.mocked(removeLinkedWorktree).mockRejectedValueOnce({
      kind: "worktreeDirty",
      message: "`/repos/app-feat-a` has uncommitted changes",
    });
    const { user } = await renderPanel();
    await user.click(
      within(await chooseRemove("app-feat-a")).getByRole("button", { name: "Remove" }),
    );
    const force = await screen.findByRole("dialog", { name: "app-feat-a has uncommitted changes" });
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(within(force).getByRole("button", { name: "Remove anyway" }));
    await waitFor(() =>
      expect(removeLinkedWorktree).toHaveBeenLastCalledWith(1, "/repos/app-feat-a", true),
    );
    expect(removeLinkedWorktree).toHaveBeenCalledTimes(2);
    expect(isLinkedWorktreeDirty).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should show worktreeNotFound inline and refetch the list", async () => {
    const notFound: AppError = {
      kind: "worktreeNotFound",
      message: "`/repos/app-feat-a` is not a worktree of this repository",
    };
    vi.mocked(removeLinkedWorktree).mockRejectedValueOnce(notFound);
    const { user } = await renderPanel();
    expect(listLinkedWorktrees).toHaveBeenCalledOnce();
    vi.mocked(listLinkedWorktrees).mockResolvedValue([main]);
    await user.click(
      within(await chooseRemove("app-feat-a")).getByRole("button", { name: "Remove" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(notFound.message);
    await waitFor(() => expect(toggle()).toHaveTextContent("Worktrees (1)"));
    // Fetched again by the remove's settle invalidation.
    expect(listLinkedWorktrees).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should show another remove failure inline without a force step", async () => {
    vi.mocked(removeLinkedWorktree).mockRejectedValueOnce({
      kind: "worktreeLocked",
      message: "the worktree is locked",
    });
    const { user } = await renderPanel();
    await user.click(
      within(await chooseRemove("app-feat-a")).getByRole("button", { name: "Remove" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("the worktree is locked");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(removeLinkedWorktree).toHaveBeenCalledOnce();
  });

  it("should be busy and disable the buttons while a remove runs", async () => {
    let finish!: () => void;
    vi.mocked(removeLinkedWorktree).mockReturnValue(
      new Promise((res) => {
        finish = () => res(undefined);
      }),
    );
    vi.mocked(listLinkedWorktrees).mockResolvedValue([main, a, stale]);
    const { user } = await renderPanel();
    await user.click(
      within(await chooseRemove("app-feat-a")).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() => expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true"));
    expect(plus()).toBeDisabled();
    expect(pruneButton()).toBeDisabled();
    rightClick(row("app-gone"));
    expect(menuItem("Remove…")).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    finish();
    await waitFor(() => expect(plus()).toBeEnabled());
  });
});

// Contract: Prune is enabled only when a missing, unlocked worktree exists, and closes its tabs.
describe("WorktreesPanel prune", () => {
  it("should show Prune as a text button named Prune stale worktrees", async () => {
    await renderPanel();
    expect(pruneButton()).toHaveTextContent(/^Prune$/);
  });

  it("should enable Prune only when a stale unlocked row exists", async () => {
    await renderPanel();
    expect(pruneButton()).toBeDisabled();
    expect(pruneButton()).toHaveAttribute("title", "No stale worktrees");
  });

  it("should keep Prune disabled for a missing but locked row", async () => {
    vi.mocked(listLinkedWorktrees).mockResolvedValue([main, { ...stale, locked: "usb" }]);
    await renderPanel();
    expect(pruneButton()).toBeDisabled();
    expect(pruneButton()).toHaveAttribute("title", "No stale worktrees");
  });

  it("should prune the stale paths", async () => {
    vi.mocked(listLinkedWorktrees).mockResolvedValue([main, a, stale]);
    useRepoTabs.getState().openTab(opened(4, stale.path));
    useRepoTabs.getState().openTab(opened(5, a.path));
    const { user } = await renderPanel();
    expect(pruneButton()).toBeEnabled();
    expect(pruneButton()).not.toHaveAttribute("title");
    await user.click(pruneButton());
    await waitFor(() => expect(pruneLinkedWorktrees).toHaveBeenCalledExactlyOnceWith(1));
    expect(closeRepo).toHaveBeenCalledExactlyOnceWith(4);
    expect(useRepoTabs.getState().tabs.map((t) => t.id)).toEqual([5]);
  });

  it("should show a prune failure inline", async () => {
    vi.mocked(listLinkedWorktrees).mockResolvedValue([main, stale]);
    vi.mocked(pruneLinkedWorktrees).mockRejectedValue({
      kind: "operationFailed",
      message: "worktree prune failed",
    });
    const { user } = await renderPanel();
    await user.click(pruneButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("worktree prune failed");
  });
});

// Contract: + opens the add dialog; a successful add opens the new worktree as a tab.
describe("WorktreesPanel add", () => {
  it("should open the add dialog from + and open the new worktree on success", async () => {
    const { user } = await renderPanel();
    await user.click(plus());
    const dialog = await screen.findByRole("dialog", { name: "Add worktree" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "feat/x");
    expect(within(dialog).getByRole("textbox", { name: "Folder" })).toHaveValue(
      "/repos/app-feat-x",
    );
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(openRepo).toHaveBeenCalledExactlyOnceWith("/repos/app-feat-x"));
    expect(addLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-feat-x", {
      kind: "new",
      name: "feat/x",
      start: null,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should close the add dialog on Cancel without adding", async () => {
    const { user } = await renderPanel();
    await user.click(plus());
    const dialog = await screen.findByRole("dialog", { name: "Add worktree" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(addLinkedWorktree).not.toHaveBeenCalled();
  });
});
