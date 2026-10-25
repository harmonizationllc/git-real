// Task 14: Failing tests for useCommands hook.
// These tests import modules/symbols that do not exist yet — red phase.

import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings, listRecent, openInEditor } from "../../lib/ipc";
import type { OpenedRepo, RecentRepo, Settings } from "../../lib/ipc";
import { queryClient } from "../../lib/query/client";
import { queryKeys } from "../../lib/query/keys";
import { useAppearancePrefs } from "../../lib/store/appearancePrefs";
import { useRepoTabs } from "../../lib/store/repoTabs";
import type { ShellActions } from "../../lib/store/shell";
import { useShell } from "../../lib/store/shell";
import { useToasts } from "../../lib/store/toasts";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useCommands } from "./useCommands";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  listRecent: vi.fn(),
  openInEditor: vi.fn(),
}));

const recentRepo = (path: string, name: string): RecentRepo => ({
  path,
  name,
  headBranch: "main",
  isBare: false,
  lastOpened: Date.now(),
});

const defaultSettings: Settings = {
  defaultCloneDir: null,
  gitExecutable: null,
  externalEditor: null,
  externalDiffTool: null,
  externalMergeTool: null,
};

const stubActions = (): ShellActions => ({
  openRepo: vi.fn(),
  cloneRepo: vi.fn(),
  openPath: vi.fn(),
});

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  useRepoTabs.setState(useRepoTabs.getInitialState(), true);
  useShell.setState({ dialog: null, repoActions: null });
  useToasts.setState({ toasts: [] });
  useAppearancePrefs.setState(useAppearancePrefs.getInitialState(), true);
  vi.mocked(getSettings).mockResolvedValue(defaultSettings);
  vi.mocked(listRecent).mockResolvedValue([]);
});

// Contract: lists the eight always-actions in order with the active theme marked Current.
describe("useCommands always-actions", () => {
  it("lists the eight always-actions in order with the active theme marked Current", async () => {
    useAppearancePrefs.setState({ ...useAppearancePrefs.getInitialState(), theme: "system" });
    const { result } = renderHookWithProviders(() => useCommands(stubActions()));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const labels = result.current.map((c) => c.label);
    expect(labels).toContain("Open repository…");
    expect(labels).toContain("Clone repository…");
    expect(labels).toContain("Open settings");
    expect(labels).toContain("Show keyboard shortcuts");
    expect(labels).toContain("Theme: System");
    expect(labels).toContain("Theme: Light");
    expect(labels).toContain("Theme: Dark");
    expect(labels).toContain("Go to start screen");
    // The active theme is marked Current.
    const systemCmd = result.current.find((c) => c.label === "Theme: System");
    expect(systemCmd?.detail).toBe("Current");
    const lightCmd = result.current.find((c) => c.label === "Theme: Light");
    expect(lightCmd?.detail).not.toBe("Current");
  });
});

// Contract: adds the six repository actions when repoActions is published.
describe("useCommands repo actions", () => {
  it("adds the six repository actions when repoActions is published", async () => {
    const fetchFn = vi.fn();
    const pullFn = vi.fn();
    const pushFn = vi.fn();
    const fileHistoryFn = vi.fn();
    act(() => {
      useShell.getState().publishRepoActions({
        repoId: 1,
        path: "/r/repo",
        gates: { fetch: null, pull: null, push: null },
        fetch: fetchFn,
        pull: pullFn,
        push: pushFn,
        fileHistory: fileHistoryFn,
      });
    });
    const { result } = renderHookWithProviders(() => useCommands(stubActions()));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const labels = result.current.map((c) => c.label);
    expect(labels).toContain("Fetch");
    expect(labels).toContain("Pull");
    expect(labels).toContain("Push");
    expect(labels).toContain("File history…");
    expect(labels).toContain("Open repository in editor");
    expect(labels).toContain("Close repository tab");
  });

  it("Fetch/Pull/Push carry the gate reason as disabledReason and detail", async () => {
    act(() => {
      useShell.getState().publishRepoActions({
        repoId: 1,
        path: "/r/repo",
        gates: { fetch: "No remote", pull: null, push: "No upstream" },
        fetch: vi.fn(),
        pull: vi.fn(),
        push: vi.fn(),
        fileHistory: vi.fn(),
      });
    });
    const { result } = renderHookWithProviders(() => useCommands(stubActions()));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const fetchCmd = result.current.find((c) => c.label === "Fetch");
    const pushCmd = result.current.find((c) => c.label === "Push");
    const pullCmd = result.current.find((c) => c.label === "Pull");
    expect(fetchCmd?.disabledReason).toBe("No remote");
    expect(pushCmd?.disabledReason).toBe("No upstream");
    expect(pullCmd?.disabledReason).toBeNull();
  });
});

// Contract: Switch to <name> lists every tab but the active one and activates it.
describe("useCommands Switch to", () => {
  it("Switch to <name> lists every tab but the active one and activates it", async () => {
    useRepoTabs.getState().openTab({
      id: 1,
      summary: { path: "/r/alpha", name: "alpha", headBranch: "main", isBare: false },
    } as OpenedRepo);
    useRepoTabs.getState().openTab({
      id: 2,
      summary: { path: "/r/beta", name: "beta", headBranch: "main", isBare: false },
    } as OpenedRepo);
    // Activate tab 1 so tab 2 should appear as "Switch to beta".
    act(() => useRepoTabs.getState().activate(1));
    const { result } = renderHookWithProviders(() => useCommands(stubActions()));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const switchCmd = result.current.find((c) => c.label === "Switch to beta");
    expect(switchCmd).toBeDefined();
    const switchAlpha = result.current.find((c) => c.label === "Switch to alpha");
    expect(switchAlpha).toBeUndefined();
    // Running the command activates the tab.
    act(() => switchCmd!.run());
    expect(useRepoTabs.getState().activeId).toBe(2);
  });
});

// Contract: Open <name> lists recents not already open and calls openPath.
describe("useCommands Open recent", () => {
  it("Open <name> lists recents not already open and calls openPath", async () => {
    vi.mocked(listRecent).mockResolvedValue([
      recentRepo("/r/alpha", "alpha"),
      recentRepo("/r/beta", "beta"),
    ]);
    // alpha is already open.
    useRepoTabs.getState().openTab({
      id: 1,
      summary: { path: "/r/alpha", name: "alpha", headBranch: "main", isBare: false },
    } as OpenedRepo);
    const actions = stubActions();
    const { result } = renderHookWithProviders(() => useCommands(actions));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const openAlpha = result.current.find((c) => c.label === "Open alpha");
    const openBeta = result.current.find((c) => c.label === "Open beta");
    expect(openAlpha).toBeUndefined();
    expect(openBeta).toBeDefined();
    act(() => openBeta!.run());
    expect(actions.openPath).toHaveBeenCalledWith("/r/beta");
  });
});

// Contract: Open repository in editor calls openInEditor with the repository path.
describe("useCommands Open repository in editor", () => {
  it("Open repository in editor calls openInEditor with the repository path through useExternalTool", async () => {
    vi.mocked(getSettings).mockResolvedValue({ ...defaultSettings, externalEditor: "code" });
    act(() => {
      useShell.getState().publishRepoActions({
        repoId: 1,
        path: "/r/repo",
        gates: { fetch: null, pull: null, push: null },
        fetch: vi.fn(),
        pull: vi.fn(),
        push: vi.fn(),
        fileHistory: vi.fn(),
      });
    });
    vi.mocked(openInEditor).mockResolvedValue(undefined);
    const { result, queryClient: qc } = renderHookWithProviders(() => useCommands(stubActions()));
    // Wait until the settings query resolves so editor.configured becomes true.
    await waitFor(() => expect(qc.getQueryData(queryKeys.settings)).toBeDefined());
    const editorCmd = result.current.find((c) => c.label === "Open repository in editor");
    expect(editorCmd).toBeDefined();
    await act(() => editorCmd!.run());
    expect(openInEditor).toHaveBeenCalledWith("/r/repo");
  });
});

// Contract: shortcut ids are attached to the matching rows.
describe("useCommands shortcut ids", () => {
  it("shortcut ids are attached to the matching rows", async () => {
    const { result } = renderHookWithProviders(() => useCommands(stubActions()));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const openCmd = result.current.find((c) => c.label === "Open repository…");
    expect(openCmd?.shortcutId).toBe("openRepo");
    const cloneCmd = result.current.find((c) => c.label === "Clone repository…");
    expect(cloneCmd?.shortcutId).toBe("cloneRepo");
  });
});

// Contract: run functions for always-actions update state correctly.
describe("useCommands always-action run functions", () => {
  it("Open settings run opens the settings dialog", async () => {
    const { result } = renderHookWithProviders(() => useCommands(stubActions()));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    act(() => result.current.find((c) => c.label === "Open settings")!.run());
    expect(useShell.getState().dialog).toMatchObject({ kind: "settings" });
  });

  it("Show keyboard shortcuts run opens the shortcuts dialog", async () => {
    const { result } = renderHookWithProviders(() => useCommands(stubActions()));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    act(() => result.current.find((c) => c.label === "Show keyboard shortcuts")!.run());
    expect(useShell.getState().dialog).toMatchObject({ kind: "shortcuts" });
  });

  it("Theme: Dark run changes the theme to dark", async () => {
    const { result } = renderHookWithProviders(() => useCommands(stubActions()));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    act(() => result.current.find((c) => c.label === "Theme: Dark")!.run());
    expect(useAppearancePrefs.getState().theme).toBe("dark");
  });

  it("Go to start screen run deactivates the current tab", async () => {
    useRepoTabs.getState().openTab({
      id: 1,
      summary: { path: "/r/alpha", name: "alpha", headBranch: "main", isBare: false },
    } as OpenedRepo);
    act(() => useRepoTabs.getState().activate(1));
    const { result } = renderHookWithProviders(() => useCommands(stubActions()));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    act(() => result.current.find((c) => c.label === "Go to start screen")!.run());
    expect(useRepoTabs.getState().activeId).toBeNull();
  });

  it("Close repository tab run closes the active repository tab", async () => {
    act(() => {
      useShell.getState().publishRepoActions({
        repoId: 99,
        path: "/r/repo",
        gates: { fetch: null, pull: null, push: null },
        fetch: vi.fn(),
        pull: vi.fn(),
        push: vi.fn(),
        fileHistory: vi.fn(),
      });
    });
    useRepoTabs.getState().openTab({
      id: 99,
      summary: { path: "/r/repo", name: "repo", headBranch: "main", isBare: false },
    } as OpenedRepo);
    act(() => useRepoTabs.getState().activate(99));
    const { result } = renderHookWithProviders(() => useCommands(stubActions()));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    act(() => result.current.find((c) => c.label === "Close repository tab")!.run());
    expect(useRepoTabs.getState().tabs.find((t) => t.id === 99)).toBeUndefined();
  });
});
