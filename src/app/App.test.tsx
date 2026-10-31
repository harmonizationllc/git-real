import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useShell } from "../lib/store/shell";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../lib/query/client";
import {
  checkGitCli,
  cloneRepo,
  closeRepo,
  fetchAll,
  getCommitConfig,
  getHeadMessage,
  getLogSummary,
  getStatus,
  listBranches,
  listRecent,
  listRemotes,
  onCloneProgress,
  onRepoChanged,
  openRepo,
  pickFolder,
  pullDefaultMode,
} from "../lib/ipc";
import type { OpenedRepo } from "../lib/ipc";
import { useCommitDraft } from "../lib/store/commitDraft";
import { useRepoTabs } from "../lib/store/repoTabs";
import { useToasts } from "../lib/store/toasts";
import { useWorkspace } from "../lib/store/workspace";
import { networkError, remoteInfo } from "../test/remoteFixtures";
import App from "./App";

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  openRepo: vi.fn(),
  initRepo: vi.fn(),
  cloneRepo: vi.fn(),
  closeRepo: vi.fn(),
  listRecent: vi.fn(),
  removeRecent: vi.fn(),
  pickFolder: vi.fn(),
  checkGitCli: vi.fn(),
  onCloneProgress: vi.fn(),
  getCommitConfig: vi.fn(),
  getHeadMessage: vi.fn(),
  getLogSummary: vi.fn(),
  getStatus: vi.fn(),
  listBranches: vi.fn(),
  listRemotes: vi.fn(),
  pullDefaultMode: vi.fn(),
  fetchAll: vi.fn(),
  onRepoChanged: vi.fn(),
}));

const repo = (id: number, name: string, headBranch: string | null = "main"): OpenedRepo => ({
  id,
  summary: { path: `/r/${name}`, name, headBranch, isBare: false },
});

const startHeading = { level: 1, name: "Git Real" };
const heading = (name: string) => ({ level: 1, name });

beforeEach(() => {
  vi.resetAllMocks();
  useRepoTabs.setState(useRepoTabs.getInitialState(), true);
  useWorkspace.setState(useWorkspace.getInitialState(), true);
  useCommitDraft.setState({ drafts: {} });
  useToasts.setState({ toasts: [] });
  useShell.setState({ dialog: null, repoActions: null });
  queryClient.clear();
  vi.mocked(listRecent).mockResolvedValue([]);
  vi.mocked(closeRepo).mockResolvedValue(undefined);
  vi.mocked(checkGitCli).mockResolvedValue({
    available: true,
    path: "/usr/bin/git",
    version: "2.43.0",
    error: null,
  });
  vi.mocked(onCloneProgress).mockResolvedValue(vi.fn());
  vi.mocked(getStatus).mockResolvedValue({ entries: [], headUnborn: false });
  vi.mocked(listBranches).mockResolvedValue({
    head: { kind: "branch", name: "main" },
    local: [],
    remotes: [],
  });
  vi.mocked(listRemotes).mockResolvedValue([remoteInfo("origin")]);
  vi.mocked(pullDefaultMode).mockResolvedValue("merge");
  vi.mocked(fetchAll).mockResolvedValue(undefined);
  vi.mocked(onRepoChanged).mockResolvedValue(vi.fn());
  vi.mocked(getCommitConfig).mockResolvedValue({ name: "A", email: "a@b.c", signing: null });
  vi.mocked(getHeadMessage).mockResolvedValue(null);
  vi.mocked(getLogSummary).mockResolvedValue({
    generation: 1,
    total: 0,
    maxLanes: 1,
    complete: true,
    refreshing: false,
  });
});

function renderApp(...seed: OpenedRepo[]) {
  for (const r of seed) useRepoTabs.getState().openTab(r);
  return { user: userEvent.setup(), ...render(<App />) };
}

// Contract: start screen shows when no tab is active.
describe("App start screen", () => {
  it("shows start screen with no tabs", async () => {
    renderApp();
    expect(screen.getByRole("heading", startHeading)).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    await screen.findByText("No recent repositories");
  });

  it('"+" from a repo pane shows the start screen while tabs remain', async () => {
    const { user } = renderApp(repo(1, "alpha"));
    await user.click(screen.getByRole("button", { name: "Start screen" }));
    expect(screen.getByRole("heading", startHeading)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "alpha" })).toHaveAttribute("aria-selected", "false");
    await user.click(screen.getByRole("tab", { name: "alpha" }));
    expect(screen.getByRole("heading", heading("alpha"))).toBeInTheDocument();
  });
});

// Contract: repo pane header shows name, path and branch.
describe("App repo pane", () => {
  it("opening a repo shows its pane with name and branch", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/r/alpha");
    vi.mocked(openRepo).mockResolvedValue(repo(1, "alpha"));
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "Open repository" }));
    expect(await screen.findByRole("heading", heading("alpha"))).toBeInTheDocument();
    expect(screen.getByText("/r/alpha")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "alpha" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("heading", startHeading)).toBeNull();
  });

  it("switching tabs changes pane", async () => {
    const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"));
    await user.click(screen.getByRole("tab", { name: "alpha" }));
    expect(screen.getByRole("heading", heading("alpha"))).toBeInTheDocument();
    expect(screen.queryByRole("heading", heading("beta"))).toBeNull();
  });

  it('detached head renders "detached HEAD"', () => {
    renderApp(repo(1, "alpha", null));
    expect(screen.getByText("detached HEAD")).toBeInTheDocument();
  });
});

// Contract: the repo pane hosts the changes panel and the commit history.
describe("App changes panel", () => {
  it("renders the changes panel for the active repo", async () => {
    renderApp(repo(1, "alpha"));
    expect(await screen.findByRole("region", { name: "Changes" })).toBeInTheDocument();
    expect(getStatus).toHaveBeenCalledWith(1);
  });

  it("renders the commit history region next to the panel", async () => {
    renderApp(repo(1, "alpha"));
    const history = screen.getByRole("region", { name: "History" });
    expect(await within(history).findByText("No commits yet")).toBeInTheDocument();
    await screen.findByRole("region", { name: "Changes" });
  });
});

// Contract: closing a tab calls closeRepo, falls back to a neighbour or the start screen.
describe("App closing tabs", () => {
  it("closing the active tab calls closeRepo and returns to the neighbour", async () => {
    const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"));
    await user.click(screen.getByRole("button", { name: "Close beta" }));
    expect(closeRepo).toHaveBeenCalledExactlyOnceWith(2);
    expect(screen.queryByRole("tab", { name: "beta" })).toBeNull();
    expect(screen.getByRole("heading", heading("alpha"))).toBeInTheDocument();
  });

  it("closing the active first tab activates the right neighbour", async () => {
    const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"), repo(3, "gamma"));
    await user.click(screen.getByRole("tab", { name: "alpha" }));
    await user.click(screen.getByRole("button", { name: "Close alpha" }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["beta", "gamma"]);
    expect(screen.getByRole("heading", heading("beta"))).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "beta" })).toHaveAttribute("aria-selected", "true");
  });

  it("closing the active middle tab activates the left neighbour", async () => {
    const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"), repo(3, "gamma"));
    await user.click(screen.getByRole("tab", { name: "beta" }));
    await user.click(screen.getByRole("button", { name: "Close beta" }));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["alpha", "gamma"]);
    expect(screen.getByRole("heading", heading("alpha"))).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "alpha" })).toHaveAttribute("aria-selected", "true");
  });

  it("closing the last tab returns to the start screen", async () => {
    const { user } = renderApp(repo(1, "alpha"));
    await user.click(screen.getByRole("button", { name: "Close alpha" }));
    expect(closeRepo).toHaveBeenCalledExactlyOnceWith(1);
    expect(screen.getByRole("heading", startHeading)).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("closing a non-active tab keeps the active pane", async () => {
    const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"));
    await user.click(screen.getByRole("button", { name: "Close alpha" }));
    expect(closeRepo).toHaveBeenCalledExactlyOnceWith(1);
    expect(screen.getByRole("heading", heading("beta"))).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "beta" })).toHaveAttribute("aria-selected", "true");
  });

  it("closing a tab clears that repo's workspace selection", async () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "unstaged" });
    const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"));
    await user.click(screen.getByRole("button", { name: "Close alpha" }));
    expect(useWorkspace.getState().selected).not.toHaveProperty("1");
  });

  it("closing a tab keeps other repos' workspace selections", async () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "unstaged" });
    useWorkspace.getState().select(2, { path: "b.txt", scope: "staged" });
    const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"));
    await user.click(screen.getByRole("button", { name: "Close alpha" }));
    expect(useWorkspace.getState().selected[2]).toEqual({ path: "b.txt", scope: "staged" });
  });

  it("closing a tab clears that repo's commit draft and keeps the others", async () => {
    useCommitDraft.getState().setSubject(1, "alpha draft");
    useCommitDraft.getState().setSubject(2, "beta draft");
    const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"));
    await user.click(screen.getByRole("button", { name: "Close alpha" }));
    expect(useCommitDraft.getState().drafts).not.toHaveProperty("1");
    expect(useCommitDraft.getState().drafts[2]).toMatchObject({ subject: "beta draft" });
  });

  it("closeRepo rejection with unknownRepo still closes the tab and logs nothing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(closeRepo).mockRejectedValue({ kind: "unknownRepo", message: "unknown repo 1" });
    const { user } = renderApp(repo(1, "alpha"));
    await user.click(screen.getByRole("button", { name: "Close alpha" }));
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByRole("heading", startHeading)).toBeInTheDocument();
    await waitFor(() => expect(closeRepo).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it.each([
    ["an io AppError", { kind: "io", message: "boom" }],
    ["a plain Error", new Error("ipc down")],
  ])(
    "other closeRepo rejections still close the tab and are logged (%s)",
    async (_n, rejection) => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(closeRepo).mockRejectedValue(rejection);
      const { user } = renderApp(repo(1, "alpha"));
      await user.click(screen.getByRole("button", { name: "Close alpha" }));
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
      await waitFor(() => expect(err).toHaveBeenCalledWith("close_repo failed", rejection));
      err.mockRestore();
    },
  );
});

// Contract: App owns the clone dialog open state.
describe("App clone dialog", () => {
  it("Clone button opens CloneDialog", async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "Clone repository" }));
    expect(await screen.findByRole("dialog", { name: "Clone repository" })).toBeInTheDocument();
  });

  it("cancelling CloneDialog closes it", async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "Clone repository" }));
    await screen.findByLabelText("Repository URL");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", startHeading)).toBeInTheDocument();
  });

  it("successful clone closes the dialog and activates the new tab", async () => {
    const url = "https://github.com/octocat/Hello-World.git";
    vi.mocked(pickFolder).mockResolvedValue("/home/u/src");
    vi.mocked(cloneRepo).mockResolvedValue(repo(7, "Hello-World"));
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "Clone repository" }));
    await user.type(await screen.findByLabelText("Repository URL"), url);
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    await screen.findByText("Destination: /home/u/src/Hello-World");
    await user.click(screen.getByRole("button", { name: "Clone" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cloneRepo).toHaveBeenCalledWith(url, "/home/u/src/Hello-World", expect.any(Number));
    expect(screen.getByRole("heading", heading("Hello-World"))).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Hello-World" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

// Contract: each tab owns its sync state; a message shown on one tab is gone on another.
describe("App sync state per tab", () => {
  it("should not show a sync message from tab A after switching to tab B", async () => {
    vi.mocked(fetchAll).mockRejectedValue(networkError("hostUnreachable", { verb: "fetch" }));
    const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"));
    await user.click(screen.getByRole("tab", { name: "alpha" }));
    const fetchButton = await screen.findByRole("button", { name: "Fetch" });
    await waitFor(() => expect(fetchButton).toBeEnabled());
    await user.click(fetchButton);
    expect(await screen.findByText("Could not reach the remote")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "beta" }));
    await screen.findByRole("heading", heading("beta"));
    expect(screen.queryByText("Could not reach the remote")).toBeNull();
  });
});

// Contract: one toast region is mounted for the whole app, whatever the active pane.
describe("App toasts", () => {
  it("should render a shown toast in a status region", () => {
    renderApp();
    act(() => {
      useToasts.getState().show("Hi");
    });
    expect(screen.getByText("Hi").closest('[role="status"]')).not.toBeNull();
  });

  it("should render a shown toast over a repo pane too", async () => {
    renderApp(repo(1, "alpha"));
    await screen.findByRole("region", { name: "Changes" });
    act(() => {
      useToasts.getState().show("Hi");
    });
    expect(screen.getAllByText("Hi")).toHaveLength(1);
  });
});

// Contract (GR-14): global shortcuts and shell dialogs from the App root.
describe("App global shortcuts (GR-14)", () => {
  it("Ctrl+/ opens the shortcuts dialog and Escape returns focus to the app root", async () => {
    const { user } = renderApp();
    const appRoot = document.querySelector("[data-focus-target]") as HTMLElement | null;
    if (appRoot) appRoot.focus();
    await user.keyboard("{Control>}/{/Control}");
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  // CommandPalette component arrives in Cycle 3. This test asserts the shell store state
  // (per plan: useGlobalShortcuts tests assert the store) rather than a DOM dialog.
  it("Ctrl+K sets the palette dialog on the shell store and Ctrl+, switches to settings", async () => {
    const { user } = renderApp();
    await user.keyboard("{Control>}k{/Control}");
    expect(useShell.getState().dialog).toEqual({ kind: "palette" });
    // Opening settings must close the palette (single-slot rule).
    await user.keyboard("{Control>},{/Control}");
    expect(useShell.getState().dialog).toMatchObject({ kind: "settings" });
  });
});

// Coverage: App.tsx lines 42 (openRepo pickFolder branch) and 47 (openPath failure branch).
describe("App openRepo and openPath actions (GR-14)", () => {
  it("Ctrl+O calls the folder picker and skips openRepo when it returns null", async () => {
    vi.mocked(pickFolder).mockResolvedValue(null);
    const { user } = renderApp();
    await user.keyboard("{Control>}o{/Control}");
    await waitFor(() => expect(pickFolder).toHaveBeenCalledWith("Open repository"));
    expect(openRepo).not.toHaveBeenCalled();
  });

  it("Ctrl+O opens the repo when the folder picker returns a path", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/r/new");
    vi.mocked(openRepo).mockResolvedValue(repo(99, "new"));
    const { user } = renderApp();
    await user.keyboard("{Control>}o{/Control}");
    await waitFor(() => expect(useRepoTabs.getState().tabs.map((t) => t.id)).toContain(99));
  });

  it("openPath deactivates the active tab when opener.open returns false", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/r/bad");
    vi.mocked(openRepo).mockRejectedValue({ kind: "notARepository", message: "not a repo" });
    const { user } = renderApp(repo(1, "existing"));
    expect(useRepoTabs.getState().activeId).toBe(1);
    await user.keyboard("{Control>}o{/Control}");
    await waitFor(() => expect(useRepoTabs.getState().activeId).toBeNull());
  });
});

// Task 15: App mounts SettingsDialog and CommandPalette from the shell store.
describe("App shell dialogs (GR-14 Cycle 3)", () => {
  it("Ctrl+, opens Settings dialog and Escape returns focus to the app root", async () => {
    const { user } = renderApp();
    await user.keyboard("{Control>},{/Control}");
    // SettingsDialog must mount (requires App to render it on dialog.kind === "settings").
    await screen.findByRole("dialog", { name: "Settings" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    // Focus should be on the app root (data-focus-target).
    const appRoot = document.querySelector("[data-focus-target]") as HTMLElement | null;
    if (appRoot) expect(document.activeElement).toBe(appRoot);
  });

  it("Ctrl+K opens the palette and opening Settings from it closes the palette", async () => {
    const { user } = renderApp();
    await user.keyboard("{Control>}k{/Control}");
    // CommandPalette must mount (requires App to render it on dialog.kind === "palette").
    await screen.findByRole("dialog", { name: "Command palette" });
    // Now open settings via shortcut; single-slot rule means palette closes.
    await user.keyboard("{Control>},{/Control}");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    await screen.findByRole("dialog", { name: "Settings" });
  });
});
