import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commit,
  fetchAll,
  getCommit,
  getCommitConfig,
  getCommitFiles,
  getFileDiff,
  getFileHistory,
  getHeadMessage,
  getLogPage,
  getLogSummary,
  getOperationState,
  getStatus,
  getStashFiles,
  listBranches,
  listRemotes,
  listStashes,
  listTags,
  listTrackedFiles,
  onRepoChanged,
  pull,
  pullDefaultMode,
  push,
  updateRemote,
} from "../lib/ipc";
import type { BranchList } from "../lib/ipc";
import { queryKeys } from "../lib/query/keys";
import type { RepoTab } from "../lib/store/repoTabs";
import { EMPTY_DRAFT, useCommitDraft } from "../lib/store/commitDraft";
import { useLayoutPrefs } from "../lib/store/layoutPrefs";
import { useWorkspace } from "../lib/store/workspace";
import { commitDetail, makeRow, oidOf, shortOf } from "../test/graphFixtures";
import { networkError, remoteInfo, trackedList } from "../test/remoteFixtures";
import { renderWithProviders } from "../test/renderWithProviders";
import { stashEntry, stashFiles } from "../test/stashFixtures";
import { FULL_DIFF_LINES } from "../features/diff/model/limits";
import { RepoPane } from "./RepoPane";

vi.mock("@tanstack/react-virtual", () => import("../test/mockVirtualizer"));

const bannerMounts = vi.hoisted<number[]>(() => []);

// A stand-in that exposes the repo id it received; built lazily so no import is hoisted above it.
vi.mock("../features/merge/OperationBanner", async () => {
  const { createElement, useEffect } = await import("react");
  return {
    OperationBanner: ({ repoId }: { repoId: number }) => {
      // Mount-only on purpose: a re-render with a new repoId must not look like a remount.
      useEffect(() => {
        bannerMounts.push(repoId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return createElement("div", {
        "data-testid": "operation-banner",
        "data-repo-id": String(repoId),
      });
    },
  };
});

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  commit: vi.fn(),
  fetchAll: vi.fn(),
  getCommit: vi.fn(),
  getCommitConfig: vi.fn(),
  getCommitFiles: vi.fn(),
  getFileDiff: vi.fn(),
  getFileHistory: vi.fn(),
  getHeadMessage: vi.fn(),
  getLogPage: vi.fn(),
  getLogSummary: vi.fn(),
  getOperationState: vi.fn(),
  getStatus: vi.fn(),
  getStashFiles: vi.fn(),
  listBranches: vi.fn(),
  listRemotes: vi.fn(),
  listStashes: vi.fn(),
  listTags: vi.fn(),
  listTrackedFiles: vi.fn(),
  onRepoChanged: vi.fn(),
  pull: vi.fn(),
  pullDefaultMode: vi.fn(),
  push: vi.fn(),
  updateRemote: vi.fn(),
}));

const tab = (id: number, headBranch: string | null = "main"): RepoTab => ({
  id,
  summary: { path: `/r/repo${id}`, name: `repo${id}`, headBranch, isBare: false },
});

const branchList = (over: Partial<BranchList> = {}): BranchList => ({
  head: { kind: "branch", name: "main" },
  local: [
    {
      name: "main",
      oid: "a".repeat(40),
      isHead: true,
      tracking: { upstream: "origin/main", ahead: 0, behind: 0 },
    },
  ],
  remotes: [],
  ...over,
});

// Stub that records every observer so a test can fire a resize and check the lifecycle.
class StubResizeObserver {
  static instances: StubResizeObserver[] = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) {
    StubResizeObserver.instances.push(this);
  }
  fire(width: number) {
    this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as never);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  StubResizeObserver.instances = [];
  bannerMounts.length = 0;
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  useLayoutPrefs.setState({ refsWidth: 240, sidebarWidth: 320, tagsCollapsed: true });
  vi.mocked(listBranches).mockResolvedValue(branchList());
  vi.mocked(listRemotes).mockResolvedValue([remoteInfo("origin")]);
  vi.mocked(pullDefaultMode).mockResolvedValue("merge");
  vi.mocked(fetchAll).mockResolvedValue(undefined);
  vi.mocked(pull).mockResolvedValue("completed");
  vi.mocked(push).mockResolvedValue(undefined);
  useWorkspace.setState({
    selected: {},
    selectedCommit: {},
    selectedStash: {},
    historyPath: {},
    centreView: {},
    refsFilter: {},
  });
  vi.mocked(listStashes).mockResolvedValue([]);
  vi.mocked(listTags).mockResolvedValue({ tags: [], remotes: [] });
  vi.mocked(getStashFiles).mockReturnValue(new Promise(() => undefined));
  vi.mocked(getLogSummary).mockResolvedValue({ generation: 1, total: 2, maxLanes: 1 });
  vi.mocked(getLogPage).mockResolvedValue({ start: 0, rows: [makeRow(0), makeRow(1)] });
  vi.mocked(getCommit).mockResolvedValue(commitDetail({ oid: oidOf(0) }));
  vi.mocked(getOperationState).mockResolvedValue({ kind: "none" });
  useCommitDraft.setState({ drafts: {} });
  vi.mocked(getFileDiff).mockReturnValue(new Promise(() => undefined));
  vi.mocked(onRepoChanged).mockResolvedValue(vi.fn());
  vi.mocked(getStatus).mockResolvedValue({ entries: [], headUnborn: false });
  vi.mocked(getCommitConfig).mockResolvedValue({ name: "A", email: "a@b.c", signing: null });
  vi.mocked(getHeadMessage).mockResolvedValue(null);
  vi.mocked(getCommitFiles).mockResolvedValue([]);
  vi.mocked(getFileHistory).mockResolvedValue([]);
  vi.mocked(listTrackedFiles).mockResolvedValue(["src/a.ts", "b.txt"]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Contract: header as before, then a body with the changes panel and the detail pane.
describe("RepoPane", () => {
  it("should render the repo name as the level 1 heading", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(screen.getByRole("heading", { level: 1, name: "repo1" })).toBeInTheDocument();
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should render the path and branch in the header", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(screen.getByText("/r/repo1")).toBeInTheDocument();
    expect(within(header()).getByText("main")).toBeInTheDocument();
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should render detached HEAD when there is no branch", async () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<RepoPane tab={tab(1, null)} />);
    expect(within(header()).getByText("detached HEAD")).toBeInTheDocument();
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should render the changes panel", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(await screen.findByRole("region", { name: "Changes" })).toBeInTheDocument();
  });

  it("should render the commit graph in the History region when no file is selected", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const history = screen.getByRole("region", { name: "History" });
    expect(await within(history).findByRole("listbox", { name: "Commits" })).toBeInTheDocument();
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should show the selected file's diff in the detail pane", async () => {
    vi.mocked(getStatus).mockResolvedValue({
      entries: [
        { path: "a.txt", oldPath: null, index: null, worktree: "modified", conflicted: false },
      ],
      headUnborn: false,
    });
    renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "modified a.txt" }));
    expect(screen.getByRole("region", { name: "History" })).toHaveTextContent("Loading diff…");
    expect(getFileDiff).toHaveBeenCalledWith(1, "a.txt", "unstaged", false, undefined);
  });

  it("should load the status for the tab's repo id", async () => {
    renderWithProviders(<RepoPane tab={tab(7)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(getStatus).toHaveBeenCalledWith(7);
  });

  it("should reload the status for the new repo when the tab changes", async () => {
    const { rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    rerender(<RepoPane tab={tab(2)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(getStatus).toHaveBeenCalledWith(2);
  });

  it("should reset panel-local state when the active tab changes", async () => {
    vi.mocked(getStatus).mockResolvedValue({
      entries: [
        { path: "a.txt", oldPath: null, index: null, worktree: "modified", conflicted: false },
      ],
      headUnborn: false,
    });
    const { rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    const row = await screen.findByRole("button", { name: "modified a.txt" });
    fireEvent.click(row);
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-pressed", "true");

    rerender(<RepoPane tab={tab(2)} />);
    const next = await screen.findByRole("button", { name: "modified a.txt" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(next).toHaveAttribute("aria-pressed", "false");
  });
});

// Contract: the detail pane is bound to the tab's repo id and starts fresh for another tab.
describe("RepoPane detail pane per tab", () => {
  const diffOf = () =>
    Promise.resolve({
      path: "a.txt",
      oldPath: null,
      scope: "unstaged" as const,
      change: "modified" as const,
      isBinary: false,
      hunks: [],
      truncated: true,
      oldEncoding: null,
      newEncoding: null,
    });

  it("should fetch the selected file's diff for the tab's own repo id", async () => {
    useWorkspace.getState().select(7, { path: "a.txt", scope: "unstaged" });
    renderWithProviders(<RepoPane tab={tab(7)} />);
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenCalledWith(7, "a.txt", "unstaged", false, undefined),
    );
  });

  it("should not show another repo's selection in the centre", async () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "unstaged" });
    renderWithProviders(<RepoPane tab={tab(2)} />);
    const history = screen.getByRole("region", { name: "History" });
    expect(await within(history).findByRole("listbox", { name: "Commits" })).toBeInTheDocument();
    expect(getFileDiff).not.toHaveBeenCalled();
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should not carry the lifted line cap to the next tab showing the same path", async () => {
    vi.mocked(getFileDiff).mockImplementation(diffOf);
    useWorkspace.getState().select(1, { path: "a.txt", scope: "unstaged" });
    useWorkspace.getState().select(2, { path: "a.txt", scope: "unstaged" });
    const { rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load full diff" }));
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenLastCalledWith(1, "a.txt", "unstaged", false, FULL_DIFF_LINES),
    );

    rerender(<RepoPane tab={tab(2)} />);
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenCalledWith(2, "a.txt", "unstaged", false, undefined),
    );
    expect(getFileDiff).not.toHaveBeenCalledWith(2, "a.txt", "unstaged", false, FULL_DIFF_LINES);
  });

  it("should render the commit box below the changes panel in the sidebar", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const changes = await screen.findByRole("region", { name: "Changes" });
    const commitBox = screen.getByRole("region", { name: "Commit" });
    expect(changes.parentElement).toBe(commitBox.parentElement);
    expect(
      changes.compareDocumentPosition(commitBox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("should show a different commit draft per tab", async () => {
    useCommitDraft.setState({ drafts: { 1: { ...EMPTY_DRAFT, subject: "one" } } });
    const { rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(screen.getByLabelText("Subject")).toHaveValue("one");
    rerender(<RepoPane tab={tab(2)} />);
    expect(screen.getByLabelText("Subject")).toHaveValue("");
    await screen.findByRole("region", { name: "Changes" });
  });
});

describe("RepoPane commit box state per tab", () => {
  it("does not carry a commit failure to another tab", async () => {
    vi.mocked(getStatus).mockResolvedValue({
      entries: [
        { path: "a.txt", oldPath: null, index: "modified", worktree: null, conflicted: false },
      ],
      headUnborn: false,
    });
    vi.mocked(commit).mockRejectedValue({ kind: "commitFailed", message: "hook says no" });
    const { rerender, user } = renderWithProviders(<RepoPane tab={tab(1)} />);
    const subject = screen.getByLabelText("Subject");
    await user.type(subject, "S");
    const commitButton = screen.getByRole("button", { name: "Commit" });
    await waitFor(() => expect(commitButton).toBeEnabled());
    await user.click(commitButton);
    expect(await screen.findByRole("alert")).toHaveTextContent("hook says no");
    rerender(<RepoPane tab={tab(2)} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Subject")).toHaveValue("");
  });
});

// Contract: RepoPane owns the single repo-changed subscription for its tab.
describe("RepoPane repo-changed subscription", () => {
  it("should subscribe to repo-changed once per tab", async () => {
    const { rerender } = renderWithProviders(<RepoPane tab={tab(5)} />);
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledOnce());
    rerender(<RepoPane tab={tab(5)} />);
    expect(onRepoChanged).toHaveBeenCalledOnce();
    expect(vi.mocked(onRepoChanged).mock.calls[0]?.[0]).toBe(5);
  });

  it("should invalidate the repo prefix when the captured handler fires", async () => {
    let handler: (() => void) | undefined;
    vi.mocked(onRepoChanged).mockImplementation(async (_id, h) => {
      handler = h;
      return vi.fn() as unknown as () => void;
    });
    const { queryClient } = renderWithProviders(<RepoPane tab={tab(5)} />);
    await waitFor(() => expect(handler).toBeDefined());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    handler?.();
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.repo(5) });
  });
});

const header = () => screen.getByRole("heading", { level: 1 }).parentElement as HTMLElement;
const handle = (name: string) => screen.getByRole("separator", { name });
const body = () => handle("Resize branches column").parentElement as HTMLElement;
const observer = () => StubResizeObserver.instances[0] as StubResizeObserver;
const follows = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

// Contract: three regions in a row, branches left of the history centre left of the changes sidebar.
describe("RepoPane columns", () => {
  it("should render the branches region left of the history region and that left of changes", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const branches = await screen.findByRole("region", { name: "Branches" });
    const history = screen.getByRole("region", { name: "History" });
    const changes = await screen.findByRole("region", { name: "Changes" });
    expect(follows(branches, history)).toBe(true);
    expect(follows(history, changes)).toBe(true);
  });

  it("should order the regions and separators branches, handle, history, handle, changes", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const els = [
      await screen.findByRole("region", { name: "Branches" }),
      handle("Resize branches column"),
      screen.getByRole("region", { name: "History" }),
      handle("Resize changes column"),
      await screen.findByRole("region", { name: "Changes" }),
    ];
    const ordered = els.every((el, i) => i === 0 || follows(els[i - 1] as Element, el));
    expect(ordered).toBe(true);
  });

  it("should place the history centre between the two handles", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const history = screen.getByRole("region", { name: "History" });
    expect(follows(handle("Resize branches column"), history)).toBe(true);
    expect(follows(history, handle("Resize changes column"))).toBe(true);
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should place the changes and commit sidebar after the second handle", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const changes = await screen.findByRole("region", { name: "Changes" });
    expect(follows(handle("Resize changes column"), changes)).toBe(true);
  });

  it("should load the branch list for the tab's repo id", async () => {
    renderWithProviders(<RepoPane tab={tab(7)} />);
    await screen.findByRole("region", { name: "Branches" });
    expect(listBranches).toHaveBeenCalledWith(7);
  });

  it("should keep each tab's filter text when switching tabs", async () => {
    const { rerender, user } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await user.type(
      await screen.findByRole("searchbox", { name: "Filter branches and tags" }),
      "zzz",
    );
    rerender(<RepoPane tab={tab(2)} />);
    expect(await screen.findByRole("searchbox", { name: "Filter branches and tags" })).toHaveValue(
      "",
    );
    rerender(<RepoPane tab={tab(1)} />);
    expect(await screen.findByRole("searchbox", { name: "Filter branches and tags" })).toHaveValue(
      "zzz",
    );
  });
});

// Contract: the header branch line comes from the live branch list with the snapshot as fallback.
describe("RepoPane live header", () => {
  it("should show the live head name from the branch list", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      branchList({ head: { kind: "branch", name: "feature" } }),
    );
    renderWithProviders(<RepoPane tab={tab(1, "main")} />);
    expect(await within(header()).findByText("feature")).toBeInTheDocument();
    expect(within(header()).queryByText("main")).toBeNull();
  });

  it("should show detached at the short oid", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      branchList({ head: { kind: "detached", oid: "0123abcdef".padEnd(40, "0") } }),
    );
    renderWithProviders(<RepoPane tab={tab(1, null)} />);
    expect(await within(header()).findByText("detached at 0123abc")).toBeInTheDocument();
  });

  it("should show the unborn name with no commits yet", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      branchList({ head: { kind: "unborn", name: "trunk" }, local: [] }),
    );
    renderWithProviders(<RepoPane tab={tab(1, null)} />);
    expect(await within(header()).findByText("trunk (no commits yet)")).toBeInTheDocument();
  });

  it("should fall back to the summary branch while the list loads", () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<RepoPane tab={tab(1, "dev")} />);
    expect(within(header()).getByText("dev")).toBeInTheDocument();
  });

  it("should fall back to detached HEAD while the list loads and the summary has no branch", () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<RepoPane tab={tab(1, null)} />);
    expect(within(header()).getByText("detached HEAD")).toBeInTheDocument();
  });

  it("should fall back to the summary branch when the list fails", async () => {
    vi.mocked(listBranches).mockRejectedValue({ kind: "io", message: "list exploded" });
    renderWithProviders(<RepoPane tab={tab(1, "dev")} />);
    await screen.findByText("list exploded");
    expect(within(header()).getByText("dev")).toBeInTheDocument();
  });
});

// Contract: the grid template follows the stored widths, clamped to the measured container.
describe("RepoPane grid template", () => {
  it("should set the grid template from the stored widths", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(body().style.gridTemplateColumns).toBe("240px auto 1fr auto 320px");
  });

  it("should follow widths changed in the store", async () => {
    useLayoutPrefs.setState({ refsWidth: 200, sidebarWidth: 280 });
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(body().style.gridTemplateColumns).toBe("200px auto 1fr auto 280px");
  });

  it("should use clamped widths after a resize observation", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    act(() => observer().fire(872));
    expect(body().style.gridTemplateColumns).toBe("240px auto 1fr auto 300px");
  });

  it("should keep the stored widths when the observation is wide enough", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    act(() => observer().fire(1600));
    expect(body().style.gridTemplateColumns).toBe("240px auto 1fr auto 320px");
  });

  it("should not change the stored widths when the display is clamped", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    act(() => observer().fire(872));
    expect(useLayoutPrefs.getState().sidebarWidth).toBe(320);
  });

  it("should give the handles the clamped value and maximum", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    act(() => observer().fire(872));
    expect(handle("Resize changes column")).toHaveAttribute("aria-valuenow", "300");
    expect(handle("Resize changes column")).toHaveAttribute("aria-valuemax", "300");
    expect(handle("Resize branches column")).toHaveAttribute("aria-valuenow", "240");
    expect(handle("Resize branches column")).toHaveAttribute("aria-valuemax", "240");
  });

  it("should give the handles their minimums", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(handle("Resize branches column")).toHaveAttribute("aria-valuemin", "160");
    expect(handle("Resize changes column")).toHaveAttribute("aria-valuemin", "240");
  });

  it("should leave the handle maximum unset before the container is measured", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(handle("Resize branches column")).not.toHaveAttribute("aria-valuemax");
  });
});

// Contract: handles persist to layoutPrefs and reset to the defaults.
describe("RepoPane handles", () => {
  it("should persist a keyboard resize of the branches column to layoutPrefs", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.keyDown(handle("Resize branches column"), { key: "ArrowRight" });
    expect(useLayoutPrefs.getState().refsWidth).toBe(256);
  });

  it("should leave the sidebar width alone when the branches column is resized", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.keyDown(handle("Resize branches column"), { key: "ArrowRight" });
    expect(useLayoutPrefs.getState().sidebarWidth).toBe(320);
  });

  it("should persist a keyboard resize of the changes column to layoutPrefs", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.keyDown(handle("Resize changes column"), { key: "ArrowLeft" });
    expect(useLayoutPrefs.getState().sidebarWidth).toBe(336);
  });

  it("should update the grid template after a resize", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.keyDown(handle("Resize branches column"), { key: "ArrowRight" });
    expect(body().style.gridTemplateColumns).toBe("256px auto 1fr auto 320px");
  });

  it("should reset the branches column on double-click", async () => {
    useLayoutPrefs.setState({ refsWidth: 300 });
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.doubleClick(handle("Resize branches column"));
    expect(useLayoutPrefs.getState().refsWidth).toBe(240);
  });

  it("should reset the changes column on double-click", async () => {
    useLayoutPrefs.setState({ sidebarWidth: 400 });
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.doubleClick(handle("Resize changes column"));
    expect(useLayoutPrefs.getState().sidebarWidth).toBe(320);
  });

  it("should not reset the other column on double-click", async () => {
    useLayoutPrefs.setState({ refsWidth: 300, sidebarWidth: 400 });
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.doubleClick(handle("Resize branches column"));
    expect(useLayoutPrefs.getState().sidebarWidth).toBe(400);
  });
});

// Contract: one ResizeObserver on the body, disconnected on unmount.
describe("RepoPane resize observer", () => {
  it("should observe the body element with one observer", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(StubResizeObserver.instances).toHaveLength(1);
    expect(observer().observe).toHaveBeenCalledExactlyOnceWith(body());
  });

  it("should keep the same observer across a tab change", async () => {
    const { rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    rerender(<RepoPane tab={tab(2)} />);
    expect(StubResizeObserver.instances).toHaveLength(1);
    expect(observer().disconnect).not.toHaveBeenCalled();
  });

  it("should disconnect the observer on unmount", async () => {
    const { unmount } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    unmount();
    expect(StubResizeObserver.instances.length).toBeGreaterThan(0);
    for (const o of StubResizeObserver.instances) expect(o.disconnect).toHaveBeenCalled();
  });

  it("should not disconnect the observer before unmount", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(observer().disconnect).not.toHaveBeenCalled();
  });
});

// Contract: stored widths below the minimums display clamped once the container is measured.
describe("RepoPane minimum widths", () => {
  it("should display the minimums after an observation when the stored widths are smaller", async () => {
    useLayoutPrefs.setState({ refsWidth: 100, sidebarWidth: 100 });
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    act(() => observer().fire(2000));
    expect(body().style.gridTemplateColumns).toBe("160px auto 1fr auto 240px");
    expect(handle("Resize branches column")).toHaveAttribute("aria-valuenow", "160");
    expect(handle("Resize changes column")).toHaveAttribute("aria-valuenow", "240");
  });

  it("should leave the stored widths untouched while displaying the minimums", async () => {
    useLayoutPrefs.setState({ refsWidth: 100, sidebarWidth: 100 });
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    act(() => observer().fire(2000));
    expect(useLayoutPrefs.getState().refsWidth).toBe(100);
    expect(useLayoutPrefs.getState().sidebarWidth).toBe(100);
  });
});

// Contract: each handle's maximum leaves the centre minimum and the other column's width.
describe("RepoPane handle maximums", () => {
  it("should set each maximum from the body width minus both handle tracks", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    act(() => observer().fire(1000));
    // available = 1000 - 12 = 988; centre minimum 320
    expect(handle("Resize branches column")).toHaveAttribute(
      "aria-valuemax",
      String(988 - 320 - 320),
    );
    expect(handle("Resize changes column")).toHaveAttribute(
      "aria-valuemax",
      String(988 - 320 - 240),
    );
  });

  it("should grow the branches maximum when the sidebar is narrower", async () => {
    useLayoutPrefs.setState({ refsWidth: 240, sidebarWidth: 260 });
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    act(() => observer().fire(1000));
    expect(handle("Resize branches column")).toHaveAttribute(
      "aria-valuemax",
      String(988 - 320 - 260),
    );
  });
});

// Contract: both handles move by the keyboard step in either direction.
describe("RepoPane handle step", () => {
  it("should narrow the changes column by 16 on ArrowRight because its handle is inverted", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.keyDown(handle("Resize changes column"), { key: "ArrowRight" });
    expect(useLayoutPrefs.getState().sidebarWidth).toBe(304);
  });

  it("should widen the changes column by 16 on ArrowLeft", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.keyDown(handle("Resize changes column"), { key: "ArrowLeft" });
    expect(useLayoutPrefs.getState().sidebarWidth).toBe(336);
  });

  it("should move the branches column left by 16", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.keyDown(handle("Resize branches column"), { key: "ArrowLeft" });
    expect(useLayoutPrefs.getState().refsWidth).toBe(224);
  });
});

const FILE = { path: "a.txt", scope: "unstaged" } as const;

// Contract: the centre shows the graph by default and the diff while a file is selected.
describe("RepoPane centre content", () => {
  it("should show the graph and no diff when no file is selected", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(await screen.findByRole("listbox", { name: "Commits" })).toBeInTheDocument();
    expect(screen.queryByText("Loading diff…")).toBeNull();
  });

  it("should request the graph for the tab's repo id", async () => {
    renderWithProviders(<RepoPane tab={tab(7)} />);
    await screen.findByRole("listbox", { name: "Commits" });
    expect(getLogSummary).toHaveBeenCalledWith(7);
  });

  it("should replace the graph with the diff once a file is selected", async () => {
    useWorkspace.getState().select(1, FILE);
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "History" })).toHaveTextContent("Loading diff…"),
    );
    expect(screen.queryByRole("listbox", { name: "Commits" })).toBeNull();
  });

  it("should unmount the graph when a file is selected later", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("listbox", { name: "Commits" });
    act(() => useWorkspace.getState().select(1, FILE));
    expect(screen.queryByRole("listbox", { name: "Commits" })).toBeNull();
  });

  it("should bring the graph back when the diff is closed", async () => {
    useWorkspace.getState().select(1, FILE);
    renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close diff" }));
    expect(await screen.findByRole("listbox", { name: "Commits" })).toBeInTheDocument();
  });
});

// Contract: the sidebar shows the commit summary while a commit is selected, else changes and commit box.
describe("RepoPane sidebar content", () => {
  it("should show Changes and Commit and no commit details by default", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(await screen.findByRole("region", { name: "Changes" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Commit" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Commit details" })).toBeNull();
  });

  it("should show the commit summary after a commit is selected", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    act(() => useWorkspace.getState().selectCommit(1, oidOf(0)));
    expect(await screen.findByRole("region", { name: "Commit details" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: `Commit ${shortOf(oidOf(0))}` }),
    ).toBeInTheDocument();
  });

  it("should request the selected commit for the tab's repo id", async () => {
    useWorkspace.getState().selectCommit(7, oidOf(0));
    renderWithProviders(<RepoPane tab={tab(7)} />);
    await screen.findByRole("region", { name: "Commit details" });
    expect(getCommit).toHaveBeenCalledWith(7, oidOf(0));
  });

  it("should remove the changes panel and commit box while a commit is selected", async () => {
    useWorkspace.getState().selectCommit(1, oidOf(0));
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Commit details" });
    expect(screen.queryByRole("region", { name: "Changes" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Commit" })).toBeNull();
  });

  it("should restore the changes panel and commit box when the summary is closed", async () => {
    useWorkspace.getState().selectCommit(1, oidOf(0));
    renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close commit details" }));
    expect(await screen.findByRole("region", { name: "Changes" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Commit" })).toBeInTheDocument();
  });

  it("should not show another repo's commit selection", async () => {
    useWorkspace.getState().selectCommit(1, oidOf(0));
    renderWithProviders(<RepoPane tab={tab(2)} />);
    expect(await screen.findByRole("region", { name: "Changes" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Commit details" })).toBeNull();
  });

  it("should keep the sidebar after the second handle while a commit is selected", async () => {
    useWorkspace.getState().selectCommit(1, oidOf(0));
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const details = await screen.findByRole("region", { name: "Commit details" });
    expect(follows(handle("Resize changes column"), details)).toBe(true);
  });
});

// Coverage audit: the centre and the sidebar swap independently of each other.
describe("RepoPane both selections", () => {
  it("should show the diff in the centre and the commit summary in the sidebar at once", async () => {
    useWorkspace.getState().select(1, FILE);
    useWorkspace.getState().selectCommit(1, oidOf(0));
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(await screen.findByRole("region", { name: "Commit details" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "History" })).toHaveTextContent("Loading diff…");
    expect(screen.queryByRole("listbox", { name: "Commits" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Changes" })).toBeNull();
  });

  it("should keep the commit summary when only the diff is closed", async () => {
    useWorkspace.getState().select(1, FILE);
    useWorkspace.getState().selectCommit(1, oidOf(0));
    renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close diff" }));
    expect(await screen.findByRole("listbox", { name: "Commits" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Commit details" })).toBeInTheDocument();
  });

  it("should keep the diff when only the commit summary is closed", async () => {
    useWorkspace.getState().select(1, FILE);
    useWorkspace.getState().selectCommit(1, oidOf(0));
    renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close commit details" }));
    expect(await screen.findByRole("region", { name: "Changes" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "History" })).toHaveTextContent("Loading diff…");
    expect(screen.queryByRole("listbox", { name: "Commits" })).toBeNull();
  });
});

// Contract: the second handle sizes the column after it, so its pointer and arrow directions are inverted.
describe("RepoPane handle sides", () => {
  it("should widen the branches column on ArrowRight", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.keyDown(handle("Resize branches column"), { key: "ArrowRight" });
    expect(useLayoutPrefs.getState().refsWidth).toBe(256);
  });

  it("should narrow the changes column on ArrowRight", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.keyDown(handle("Resize changes column"), { key: "ArrowRight" });
    expect(useLayoutPrefs.getState().sidebarWidth).toBe(304);
  });

  it("should show the narrowed width in the grid template after ArrowRight", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    fireEvent.keyDown(handle("Resize changes column"), { key: "ArrowRight" });
    expect(body().style.gridTemplateColumns).toBe("240px auto 1fr auto 304px");
  });
});

// Contract: the refs column shows the branches, or the file history while a history path is set.
describe("RepoPane history mode", () => {
  const PATH = "src/a.ts";

  it("should show the branches panel by default", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(await screen.findByRole("region", { name: "Branches" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "File history" })).toBeNull();
  });

  it("should show the file history panel instead of the branches when a history path is set", async () => {
    useWorkspace.getState().showHistory(1, PATH);
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(await screen.findByRole("region", { name: "File history" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Branches" })).toBeNull();
  });

  it("should pass the history path to the panel", async () => {
    useWorkspace.getState().showHistory(1, PATH);
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const panel = await screen.findByRole("region", { name: "File history" });
    expect(within(panel).getByText(PATH)).toBeInTheDocument();
    await waitFor(() => expect(getFileHistory).toHaveBeenCalledWith(1, 1, PATH));
  });

  it("should keep the commit graph in the History region in history mode", async () => {
    useWorkspace.getState().showHistory(1, PATH);
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const history = screen.getByRole("region", { name: "History" });
    expect(await within(history).findByRole("listbox", { name: "Commits" })).toBeInTheDocument();
  });

  it("should keep the resize handle label in history mode", async () => {
    useWorkspace.getState().showHistory(1, PATH);
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "File history" });
    expect(handle("Resize branches column")).toBeInTheDocument();
  });

  it("should return to the branches panel when the history path is cleared", async () => {
    useWorkspace.getState().showHistory(1, PATH);
    renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close file history" }));
    expect(await screen.findByRole("region", { name: "Branches" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "File history" })).toBeNull();
  });

  it("should show the history of only the tab's own repo", async () => {
    useWorkspace.getState().showHistory(1, PATH);
    renderWithProviders(<RepoPane tab={tab(2)} />);
    expect(await screen.findByRole("region", { name: "Branches" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "File history" })).toBeNull();
  });
});

// Contract: Ctrl+Shift+H (or Meta+Shift+H) opens the file picker unless a dialog is already open.
describe("RepoPane file history shortcut", () => {
  const openPicker = (init: KeyboardEventInit = { ctrlKey: true, shiftKey: true, key: "H" }) =>
    fireEvent.keyDown(window, init);
  const dialogs = () => screen.queryAllByRole("dialog");

  it("should open the file picker on Ctrl+Shift+H", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    openPicker();
    expect(await screen.findByRole("dialog", { name: "File history" })).toBeInTheDocument();
  });

  it("should open the file picker when the key is reported in lower case", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    openPicker({ ctrlKey: true, shiftKey: true, key: "h" });
    expect(await screen.findByRole("dialog", { name: "File history" })).toBeInTheDocument();
  });

  it("should open the file picker on Meta+Shift+H", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    openPicker({ metaKey: true, shiftKey: true, key: "H" });
    expect(await screen.findByRole("dialog", { name: "File history" })).toBeInTheDocument();
  });

  it("should prevent the default action when it opens the picker", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(openPicker()).toBe(false);
  });

  it("should not open the picker without Shift", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    openPicker({ ctrlKey: true, key: "h" });
    expect(dialogs()).toEqual([]);
  });

  it("should not open the picker without Ctrl or Meta", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    openPicker({ shiftKey: true, key: "H" });
    expect(dialogs()).toEqual([]);
  });

  it.each([
    ["a plain h", { key: "h" }],
    ["a plain H", { key: "H" }],
    ["Shift+H without Ctrl or Meta", { key: "H", shiftKey: true }],
    ["Ctrl+Shift+J", { key: "J", ctrlKey: true, shiftKey: true }],
  ])("should not open the picker for %s", async (_name, init) => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    openPicker(init);
    expect(dialogs()).toEqual([]);
  });

  it("should not open the picker for another key", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    openPicker({ ctrlKey: true, shiftKey: true, key: "J" });
    expect(dialogs()).toEqual([]);
  });

  it("should leave the default action alone for keys it ignores", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(openPicker({ ctrlKey: true, key: "h" })).toBe(true);
  });

  it("shortcut is ignored while a dialog is open", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    document.body.append(other);
    try {
      const notPrevented = openPicker();
      expect(dialogs()).toHaveLength(1);
      expect(notPrevented).toBe(true);
    } finally {
      other.remove();
    }
  });

  it("should fetch the tracked files for the tab's repo id when the picker opens", async () => {
    renderWithProviders(<RepoPane tab={tab(7)} />);
    await screen.findByRole("region", { name: "Changes" });
    openPicker();
    await waitFor(() => expect(listTrackedFiles).toHaveBeenCalledWith(7));
  });

  it("should not fetch the tracked files before the picker opens", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(listTrackedFiles).not.toHaveBeenCalled();
  });

  it("should enter history mode for the picked file and close the picker", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    openPicker();
    fireEvent.click(await screen.findByRole("option", { name: "src/a.ts" }));
    expect(useWorkspace.getState().historyPath[1]).toBe("src/a.ts");
    expect(dialogs()).toEqual([]);
    expect(await screen.findByRole("region", { name: "File history" })).toBeInTheDocument();
  });

  it("should close the picker on Escape without entering history mode", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    openPicker();
    fireEvent.keyDown(await screen.findByRole("searchbox", { name: "Find file" }), {
      key: "Escape",
    });
    expect(dialogs()).toEqual([]);
    expect(useWorkspace.getState().historyPath[1]).toBeUndefined();
  });

  it("should register one keydown listener on the window and keep it across re-renders", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    rerender(<RepoPane tab={tab(1)} />);
    const adds = add.mock.calls.filter(([type]) => type === "keydown").length;
    const removes = remove.mock.calls.filter(([type]) => type === "keydown").length;
    add.mockRestore();
    remove.mockRestore();
    expect(adds).toBe(1);
    expect(removes).toBe(0);
  });

  it("should remove the keydown listener on unmount", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    const added = add.mock.calls.filter(([type]) => type === "keydown").map(([, fn]) => fn);
    unmount();
    const removed = remove.mock.calls.filter(([type]) => type === "keydown").map(([, fn]) => fn);
    add.mockRestore();
    remove.mockRestore();
    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
  });
});

// Contract (spec 5.4): the operation banner sits between the header and the three-column body.
describe("RepoPane operation banner", () => {
  const banner = () => screen.getByTestId("operation-banner");

  it("should render the operation banner", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(banner()).toBeInTheDocument();
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should pass the tab id as the banner repo id", async () => {
    renderWithProviders(<RepoPane tab={tab(7)} />);
    expect(banner()).toHaveAttribute("data-repo-id", "7");
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should render the banner directly after the header", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(header().nextElementSibling).toBe(banner());
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should render the banner before the body columns", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const history = screen.getByRole("region", { name: "History" });
    expect(banner().compareDocumentPosition(history)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should render the banner as a sibling of the body, not inside it", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const history = screen.getByRole("region", { name: "History" });
    expect(banner().parentElement).toBe(header().parentElement);
    expect(history.parentElement).not.toBe(banner().parentElement);
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should remount the banner for a different tab", async () => {
    const view = renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    view.rerender(<RepoPane tab={tab(2)} />);
    expect(bannerMounts).toEqual([1, 2]);
  });

  it("should follow the tab when the pane shows another repository", async () => {
    const view = renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    view.rerender(<RepoPane tab={tab(2)} />);
    expect(banner()).toHaveAttribute("data-repo-id", "2");
  });
});

// Contract (GR-11a): the Stashes panel sits below the branches; a selected stash owns the right column.
describe("RepoPane stashes", () => {
  const precedes = (a: HTMLElement, b: HTMLElement) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const W = stashEntry(0);

  it("renders the Stashes panel below the branches in the refs column", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const branches = await screen.findByRole("region", { name: "Branches" });
    const stashes = await screen.findByRole("region", { name: "Stashes (0)" });
    expect(precedes(branches, stashes)).toBe(true);
  });

  it("requests the stash list for the tab's repo id", async () => {
    renderWithProviders(<RepoPane tab={tab(7)} />);
    await screen.findByRole("region", { name: "Stashes (0)" });
    expect(listStashes).toHaveBeenCalledWith(7);
  });

  it("replaces both with file history while history is open", async () => {
    useWorkspace.getState().showHistory(1, "src/a.ts");
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(await screen.findByRole("region", { name: "File history" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Branches" })).toBeNull();
    expect(screen.queryByRole("region", { name: /^Stashes/ })).toBeNull();
  });

  it("shows the stash summary in the right column when a stash is selected", async () => {
    vi.mocked(listStashes).mockResolvedValue([W]);
    vi.mocked(getStashFiles).mockResolvedValue(stashFiles());
    useWorkspace.getState().selectStash(1, W.oid);
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(await screen.findByRole("heading", { name: "stash@{0}" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Changes" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Commit" })).toBeNull();
  });

  it("shows Changes and the commit box when no stash is selected", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(await screen.findByRole("region", { name: "Changes" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Commit" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Stash details" })).toBeNull();
  });

  it("selecting a commit replaces the stash summary with the commit summary", async () => {
    vi.mocked(listStashes).mockResolvedValue([W]);
    vi.mocked(getStashFiles).mockResolvedValue(stashFiles());
    useWorkspace.getState().selectStash(1, W.oid);
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("heading", { name: "stash@{0}" });
    act(() => useWorkspace.getState().selectCommit(1, oidOf(0)));
    expect(await screen.findByRole("region", { name: "Commit details" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "stash@{0}" })).toBeNull();
  });

  it("closing the stash summary returns the column to Changes", async () => {
    vi.mocked(listStashes).mockResolvedValue([W]);
    vi.mocked(getStashFiles).mockResolvedValue(stashFiles());
    useWorkspace.getState().selectStash(1, W.oid);
    renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Close stash details" }));
    expect(await screen.findByRole("region", { name: "Changes" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Commit" })).toBeInTheDocument();
  });

  it("does not show another repo's stash selection", async () => {
    vi.mocked(listStashes).mockResolvedValue([W]);
    useWorkspace.getState().selectStash(1, W.oid);
    renderWithProviders(<RepoPane tab={tab(2)} />);
    expect(await screen.findByRole("region", { name: "Changes" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "stash@{0}" })).toBeNull();
  });

  it("selecting a stash row in the panel swaps the right column to its summary", async () => {
    vi.mocked(listStashes).mockResolvedValue([W]);
    vi.mocked(getStashFiles).mockResolvedValue(stashFiles());
    renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.click(await screen.findByTitle(W.message));
    expect(await screen.findByRole("heading", { name: "stash@{0}", level: 2 })).toBeInTheDocument();
  });

  it("returns the column to Changes and clears the selection when the stash leaves the list", async () => {
    vi.mocked(listStashes).mockResolvedValue([W]);
    vi.mocked(getStashFiles).mockResolvedValue(stashFiles());
    useWorkspace.getState().selectStash(1, W.oid);
    const { queryClient } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("heading", { name: "stash@{0}", level: 2 });
    vi.mocked(listStashes).mockResolvedValue([]);
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(1) }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "stash@{0}", level: 2 })).toBeNull(),
    );
    expect(useWorkspace.getState().selectedStash[1]).toBeNull();
    expect(await screen.findByRole("region", { name: "Changes" })).toBeInTheDocument();
  });
});

// Contract (GR-11b): the refs column stacks Branches, Stashes and Tags, or shows the file history.
describe("RepoPane tags", () => {
  it("should render the Tags panel below the Stashes panel in the refs column", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const stashes = await screen.findByRole("heading", { name: "Stashes (0)" });
    const tags = await screen.findByRole("button", { name: "Tags (0)" });
    expect(follows(stashes, tags)).toBe(true);
  });

  it("should load the tag list for the tab's repo id", async () => {
    renderWithProviders(<RepoPane tab={tab(7)} />);
    await screen.findByRole("button", { name: "Tags (0)" });
    expect(listTags).toHaveBeenCalledWith(7);
  });

  it("should replace Branches, Stashes and Tags with file history while history is open", async () => {
    useWorkspace.setState({ historyPath: { 1: "src/a.ts" } });
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "File history" });
    expect(screen.queryByRole("region", { name: "Branches" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /^Stashes/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Tags/ })).toBeNull();
  });
});

// Contract: the header carries the sync toolbar, and Ctrl/Cmd+Shift+F, L and P run fetch, pull
// and push through it, under the same dialog guard as the file history shortcut.
describe("RepoPane sync toolbar and shortcuts", () => {
  const press = (init: KeyboardEventInit) => fireEvent.keyDown(window, init);
  const ctrlShift = (key: string): KeyboardEventInit => ({ ctrlKey: true, shiftKey: true, key });

  /** Renders the pane and waits until the toolbar's pull and push are enabled (data loaded). */
  async function renderReady() {
    const view = renderWithProviders(<RepoPane tab={tab(1)} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Pull" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Push" })).toBeEnabled();
    });
    return view;
  }

  it("should render the sync toolbar in the header", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const toolbar = await screen.findByRole("group", { name: "Sync" });
    expect(header().closest("header")).toContainElement(toolbar);
  });

  it("should show the upstream of the current branch in the toolbar", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const toolbar = await screen.findByRole("group", { name: "Sync" });
    expect(await within(toolbar).findByText("→ origin/main")).toBeInTheDocument();
  });

  it("should fetch on Ctrl+Shift+F", async () => {
    await renderReady();
    press(ctrlShift("F"));
    await waitFor(() => expect(fetchAll).toHaveBeenCalledExactlyOnceWith(1, null));
  });

  it("should pull in the default mode on Ctrl+Shift+L", async () => {
    vi.mocked(pullDefaultMode).mockResolvedValue("rebase");
    const { queryClient } = await renderReady();
    await waitFor(() => expect(queryClient.getQueryData(["repo", 1, "pullMode"])).toBe("rebase"));
    press(ctrlShift("L"));
    await waitFor(() => expect(pull).toHaveBeenCalledExactlyOnceWith(1, "rebase", null));
  });

  it("should push on Ctrl+Shift+P", async () => {
    await renderReady();
    press(ctrlShift("P"));
    await waitFor(() =>
      expect(push).toHaveBeenCalledExactlyOnceWith(1, { kind: "upstream" }, false, "main", null),
    );
  });

  it("should push on Cmd+Shift+P", async () => {
    await renderReady();
    press({ metaKey: true, shiftKey: true, key: "P" });
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
  });

  it("should match a lower-case key (Caps Lock)", async () => {
    await renderReady();
    press(ctrlShift("p"));
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
  });

  it("should prevent the default action when a sync shortcut matches", async () => {
    await renderReady();
    expect(press(ctrlShift("F"))).toBe(false);
  });

  it("should ignore the sync shortcuts while a dialog is open", async () => {
    await renderReady();
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    document.body.append(other);
    try {
      const results = ["F", "L", "P"].map((key) => press(ctrlShift(key)));
      expect(results).toEqual([true, true, true]);
      expect([fetchAll, pull, push].map((f) => vi.mocked(f).mock.calls.length)).toEqual([0, 0, 0]);
    } finally {
      other.remove();
    }
  });

  it("should ignore the sync shortcuts while the action is disabled", async () => {
    vi.mocked(listRemotes).mockResolvedValue([]);
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Fetch" })).toHaveAttribute(
        "title",
        "No remotes configured",
      ),
    );
    press(ctrlShift("F"));
    press(ctrlShift("L"));
    press(ctrlShift("P"));
    expect([fetchAll, pull, push].map((f) => vi.mocked(f).mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("should do nothing on Ctrl+F without Shift", async () => {
    await renderReady();
    expect(press({ ctrlKey: true, key: "f" })).toBe(true);
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it("should not sync on Shift+F without Ctrl or Meta", async () => {
    await renderReady();
    press({ shiftKey: true, key: "F" });
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it("should still open the file picker on Ctrl+Shift+H", async () => {
    await renderReady();
    press(ctrlShift("H"));
    expect(await screen.findByRole("dialog", { name: "File history" })).toBeInTheDocument();
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it("should ignore Ctrl+Shift+L while the branch has no upstream", async () => {
    vi.mocked(listBranches).mockResolvedValue(trackedList(null));
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pull" })).toHaveAttribute(
        "title",
        "This branch has no upstream",
      ),
    );
    press(ctrlShift("L"));
    expect(pull).not.toHaveBeenCalled();
  });

  it("should ignore a repeated Ctrl+Shift+P keydown", async () => {
    await renderReady();
    press({ ...ctrlShift("P"), repeat: true });
    expect(push).not.toHaveBeenCalled();
  });

  it("should ignore a keydown that is already default-prevented", async () => {
    await renderReady();
    const event = new KeyboardEvent("keydown", { ...ctrlShift("P"), cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(push).not.toHaveBeenCalled();
  });

  it("should push once for one normal Ctrl+Shift+P press", async () => {
    await renderReady();
    press(ctrlShift("P"));
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
  });
});

// Contract: Remotes… and the Branches heading menu open the Remotes dialog; it belongs to its tab.
describe("RepoPane remotes dialog", () => {
  const withOrigin = () =>
    branchList({
      remotes: [
        {
          remote: "origin",
          branches: [{ remote: "origin", name: "main", oid: "a".repeat(40) }],
        },
      ],
    });

  beforeEach(() => {
    vi.mocked(listBranches).mockResolvedValue(withOrigin());
  });

  it("Remotes… opens the Remotes dialog and Close closes it", async () => {
    const { user } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await user.click(await screen.findByRole("button", { name: "Remotes…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remotes" });
    expect(await within(dialog).findByRole("list", { name: "Remotes" })).toHaveTextContent(
      "origin",
    );
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Remotes" })).toBeNull();
  });

  it("shows no Remotes dialog until one is requested", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("button", { name: "Remotes…" });
    expect(screen.queryByRole("dialog", { name: "Remotes" })).toBeNull();
  });

  it("Edit remote… on a remote heading opens the dialog on that remote's form", async () => {
    const { user } = renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.contextMenu(await screen.findByRole("heading", { level: 2, name: "origin" }), {
      clientX: 5,
      clientY: 5,
    });
    await user.click(screen.getByRole("menuitem", { name: "Edit remote…" }));
    await screen.findByRole("dialog", { name: "Remotes" });
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("origin"));
    expect(screen.getByLabelText("URL")).toHaveValue("/srv/origin.git");
  });

  it("the Remotes dialog does not follow the user to another tab", async () => {
    const { user, rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await user.click(await screen.findByRole("button", { name: "Remotes…" }));
    await screen.findByRole("dialog", { name: "Remotes" });
    rerender(<RepoPane tab={tab(2)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(screen.queryByRole("dialog", { name: "Remotes" })).toBeNull();
  });

  it("the dialog does not reappear when returning to the first tab", async () => {
    const { user, rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await user.click(await screen.findByRole("button", { name: "Remotes…" }));
    await screen.findByRole("dialog", { name: "Remotes" });
    rerender(<RepoPane tab={tab(2)} />);
    rerender(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(screen.queryByRole("dialog", { name: "Remotes" })).toBeNull();
  });

  it("the dialog lists the remotes of its own tab's repo", async () => {
    const { user } = renderWithProviders(<RepoPane tab={tab(7)} />);
    await user.click(await screen.findByRole("button", { name: "Remotes…" }));
    await screen.findByRole("dialog", { name: "Remotes" });
    expect(listRemotes).toHaveBeenCalledWith(7);
  });

  // Architect R1: the target is derived per repo, so a no-key rerender never mounts the dialog for tab 2.
  it("a rerender to another tab never mounts the Remotes dialog for it", async () => {
    const { user, rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await user.click(await screen.findByRole("button", { name: "Remotes…" }));
    await screen.findByRole("dialog", { name: "Remotes" });
    const added: Element[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach((n) => n instanceof Element && added.push(n));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    rerender(<RepoPane tab={tab(2)} />);
    await screen.findByRole("region", { name: "Changes" });
    observer
      .takeRecords()
      .forEach((r) => r.addedNodes.forEach((n) => n instanceof Element && added.push(n)));
    observer.disconnect();
    expect(
      added.some((n) => n.matches('[role="dialog"]') || n.querySelector('[role="dialog"]')),
    ).toBe(false);
  });

  // Architect R4: the pane root is the fallback focus for the dialog.
  it("marks the repo pane root as a programmatic focus target", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const root = await screen.findByRole("region", { name: "repo1" });
    expect(root).toHaveAttribute("tabindex", "-1");
    expect(root).toHaveAttribute("data-focus-target");
  });

  it("after renaming the remote opened from its heading, Close focuses the repo pane", async () => {
    let named = "origin";
    vi.mocked(listBranches).mockImplementation(() =>
      Promise.resolve(
        branchList({
          remotes: [
            { remote: named, branches: [{ remote: named, name: "main", oid: "a".repeat(40) }] },
          ],
        }),
      ),
    );
    vi.mocked(listRemotes).mockImplementation(() =>
      Promise.resolve([remoteInfo(named, { fetchUrl: "/srv/origin.git" })]),
    );
    vi.mocked(updateRemote).mockImplementation((_id, _name, newName) => {
      named = newName;
      return Promise.resolve();
    });
    const { user } = renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.contextMenu(await screen.findByRole("heading", { level: 2, name: "origin" }), {
      clientX: 5,
      clientY: 5,
    });
    await user.click(screen.getByRole("menuitem", { name: "Edit remote…" }));
    const nameInput = await screen.findByLabelText("Name");
    await user.clear(nameInput);
    await user.type(nameInput, "renamed");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { level: 2, name: "renamed" });
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("region", { name: "repo1" })).toHaveFocus();
  });
});

// Contract (W1): the network error panel sits in its own row below the toolbar row in the header,
// so it is neither inside the Sync group nor inside the row that holds the branch line and toolbar.
describe("RepoPane network error layout", () => {
  async function showError() {
    vi.mocked(fetchAll).mockRejectedValue(networkError("hostUnreachable", { verb: "fetch" }));
    const view = renderWithProviders(<RepoPane tab={tab(1)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Fetch" })).toBeEnabled());
    await view.user.click(screen.getByRole("button", { name: "Fetch" }));
    const alert = await screen.findByRole("alert");
    const group = screen.getByRole("group", { name: "Sync" });
    return { alert, group, row: group.parentElement as HTMLElement };
  }

  it("should render the panel inside the header", async () => {
    const { alert } = await showError();
    expect(header().closest("header")).toContainElement(alert);
  });

  it("should not render the panel inside the Sync group", async () => {
    const { alert, group } = await showError();
    expect(group.contains(alert)).toBe(false);
  });

  it("should not render the panel inside the toolbar row", async () => {
    const { alert, row } = await showError();
    expect(row.contains(alert)).toBe(false);
  });

  it("should keep the toolbar row's children the same when an error shows", async () => {
    vi.mocked(fetchAll).mockRejectedValue(networkError("hostUnreachable", { verb: "fetch" }));
    const view = renderWithProviders(<RepoPane tab={tab(1)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Fetch" })).toBeEnabled());
    const row = screen.getByRole("group", { name: "Sync" }).parentElement as HTMLElement;
    const before = row.childElementCount;
    await view.user.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByRole("alert");
    expect(row.childElementCount).toBe(before);
  });

  it("should render the panel after the toolbar row in document order", async () => {
    const { alert, row } = await showError();
    expect(row.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("should render the panel before the operation banner", async () => {
    const { alert } = await showError();
    const banner = screen.getByTestId("operation-banner");
    expect(alert.compareDocumentPosition(banner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("should still offer Dismiss inside the panel", async () => {
    const { alert } = await showError();
    expect(within(alert).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });
});

// Contract (W2): the toolbar reads the operation state the banner uses; pull and push are gated
// during an operation, fetch and Remotes… are not.
describe("RepoPane sync during an in-progress operation", () => {
  const rebase = {
    kind: "rebase",
    onto: "b".repeat(40),
    ontoName: "main",
    branch: "topic",
    step: 1,
    total: 2,
    stoppedForEdit: false,
  } as const;

  async function renderDuringRebase() {
    vi.mocked(getOperationState).mockResolvedValue(rebase);
    const view = renderWithProviders(<RepoPane tab={tab(1)} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Pull" })).toHaveAttribute(
        "title",
        "Finish or abort the rebase first",
      ),
    );
    return view;
  }

  it("should disable Pull, Pull options, Push and Push options with the finish-or-abort title", async () => {
    await renderDuringRebase();
    for (const name of ["Pull", "Pull options", "Push", "Push options"]) {
      const b = screen.getByRole("button", { name });
      expect([name, b.hasAttribute("disabled"), b.getAttribute("title")]).toEqual([
        name,
        true,
        "Finish or abort the rebase first",
      ]);
    }
  });

  it("should keep Fetch and Remotes… enabled", async () => {
    await renderDuringRebase();
    expect(screen.getByRole("button", { name: "Fetch" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remotes…" })).toBeEnabled();
  });

  it("should ignore the pull and push shortcuts", async () => {
    await renderDuringRebase();
    fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: "L" });
    fireEvent.keyDown(window, { ctrlKey: true, shiftKey: true, key: "P" });
    expect([pull, push].map((f) => vi.mocked(f).mock.calls.length)).toEqual([0, 0]);
  });
});
