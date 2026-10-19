import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  commit,
  getCommit,
  getCommitConfig,
  getFileDiff,
  getHeadMessage,
  getLogPage,
  getLogSummary,
  getStatus,
  listBranches,
  onRepoChanged,
} from "../lib/ipc";
import type { BranchList } from "../lib/ipc";
import { queryKeys } from "../lib/query/keys";
import type { RepoTab } from "../lib/store/repoTabs";
import { EMPTY_DRAFT, useCommitDraft } from "../lib/store/commitDraft";
import { useLayoutPrefs } from "../lib/store/layoutPrefs";
import { useWorkspace } from "../lib/store/workspace";
import { commitDetail, makeRow, oidOf, shortOf } from "../test/graphFixtures";
import { renderWithProviders } from "../test/renderWithProviders";
import { FULL_DIFF_LINES } from "../features/diff/model/limits";
import { RepoPane } from "./RepoPane";

vi.mock("@tanstack/react-virtual", () => import("../test/mockVirtualizer"));

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  commit: vi.fn(),
  getCommit: vi.fn(),
  getCommitConfig: vi.fn(),
  getFileDiff: vi.fn(),
  getHeadMessage: vi.fn(),
  getLogPage: vi.fn(),
  getLogSummary: vi.fn(),
  getStatus: vi.fn(),
  listBranches: vi.fn(),
  onRepoChanged: vi.fn(),
}));

const tab = (id: number, headBranch: string | null = "main"): RepoTab => ({
  id,
  summary: { path: `/r/repo${id}`, name: `repo${id}`, headBranch, isBare: false },
});

const branchList = (over: Partial<BranchList> = {}): BranchList => ({
  head: { kind: "branch", name: "main" },
  local: [{ name: "main", oid: "a".repeat(40), isHead: true, tracking: null }],
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
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  useLayoutPrefs.setState({ refsWidth: 240, sidebarWidth: 320 });
  vi.mocked(listBranches).mockResolvedValue(branchList());
  useWorkspace.setState({ selected: {}, selectedCommit: {} });
  vi.mocked(getLogSummary).mockResolvedValue({ generation: 1, total: 2, maxLanes: 1 });
  vi.mocked(getLogPage).mockResolvedValue({ start: 0, rows: [makeRow(0), makeRow(1)] });
  vi.mocked(getCommit).mockResolvedValue(commitDetail({ oid: oidOf(0) }));
  useCommitDraft.setState({ drafts: {} });
  vi.mocked(getFileDiff).mockReturnValue(new Promise(() => undefined));
  vi.mocked(onRepoChanged).mockResolvedValue(vi.fn());
  vi.mocked(getStatus).mockResolvedValue({ entries: [], headUnborn: false });
  vi.mocked(getCommitConfig).mockResolvedValue({ name: "A", email: "a@b.c", signing: null });
  vi.mocked(getHeadMessage).mockResolvedValue(null);
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

  it("should reset the branches filter when the active tab changes", async () => {
    const { rerender, user } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await user.type(await screen.findByRole("searchbox", { name: "Filter branches" }), "zzz");
    rerender(<RepoPane tab={tab(2)} />);
    expect(await screen.findByRole("searchbox", { name: "Filter branches" })).toHaveValue("");
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
