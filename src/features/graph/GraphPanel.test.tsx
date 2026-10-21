import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkoutCommit,
  copyText,
  createBranch,
  createTag,
  getLogPage,
  getLogSummary,
  listBranches,
  rebasePlan,
  resetToCommit,
  searchLog,
} from "../../lib/ipc";
import type { AppError, BranchList, LogSummary, OperationState, RefLabel } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useWorkspace } from "../../lib/store/workspace";
import { makeRow, oidOf, ref, shortOf } from "../../test/graphFixtures";
import { mockWindow, scrollToIndex } from "../../test/mockVirtualizer";
import { renderWithProviders } from "../../test/renderWithProviders";
import { IN_PROGRESS_TITLE } from "../merge/operationCopy";
import { useIntegrationActions } from "../merge/useIntegrationActions";
import type { UseIntegrationActions } from "../merge/useIntegrationActions";
import { useOperationState } from "../merge/useOperationState";
import { GraphPanel } from "./GraphPanel";
import { gutterWidth } from "./model/edges";

vi.mock("@tanstack/react-virtual", () => import("../../test/mockVirtualizer"));
vi.mock("../merge/useOperationState", () => ({ useOperationState: vi.fn() }));
vi.mock("../merge/useIntegrationActions", () => ({ useIntegrationActions: vi.fn() }));

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getLogSummary: vi.fn(),
  getLogPage: vi.fn(),
  searchLog: vi.fn(),
  checkoutCommit: vi.fn(),
  resetToCommit: vi.fn(),
  createBranch: vi.fn(),
  createTag: vi.fn(),
  listBranches: vi.fn(),
  copyText: vi.fn(),
  rebasePlan: vi.fn(),
}));

const REPO = 1;
const scrolls = scrollToIndex as unknown as Mock<(...args: unknown[]) => void>;
const scrolledTo = (index: number) => scrolls.mock.calls.some((call) => call[0] === index);
// An arrow-style scroll passes no options; a reveal centres.
const scrolledPlain = (index: number) =>
  scrolls.mock.calls.some((call) => call[0] === index && call[1] === undefined);
const scrolledCentred = (index: number) =>
  scrolls.mock.calls.some(
    (call) => call[0] === index && JSON.stringify(call[1]) === JSON.stringify({ align: "center" }),
  );

let total = 3;
let refsByIndex: Record<number, RefLabel[]> = {};
let parentsByIndex: Record<number, string[]> = {};

const integrationRun = vi.fn<UseIntegrationActions["run"]>();
const integrationClear = vi.fn();

/** Drives the merge hooks; defaults model a clean repository with nothing pending. */
function provideMerge(
  opts: {
    state?: OperationState | undefined;
    pending?: boolean;
    error?: AppError | null;
  } = {},
) {
  const state = "state" in opts ? opts.state : ({ kind: "none" } as const);
  vi.mocked(useOperationState).mockReturnValue({ state, error: null, refetch: vi.fn() });
  vi.mocked(useIntegrationActions).mockReturnValue({
    run: integrationRun,
    pending: opts.pending ?? false,
    error: opts.error ?? null,
    clearError: integrationClear,
  });
}

const summary = (over: Partial<LogSummary> = {}): LogSummary => ({
  generation: 1,
  total,
  maxLanes: 2,
  ...over,
});

const branchList = (head: BranchList["head"] = { kind: "branch", name: "main" }): BranchList => ({
  head,
  local: [{ name: "main", oid: oidOf(0), isHead: true, tracking: null }],
  remotes: [],
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<undefined>((r) => {
    resolve = () => r(undefined);
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  scrolls.mockReset();
  mockWindow.size = Infinity;
  total = 3;
  refsByIndex = { 0: [ref("branch", "main", true)] };
  parentsByIndex = {};
  integrationRun.mockResolvedValue(null);
  provideMerge();
  useWorkspace.setState({ selected: {}, selectedCommit: {} });
  vi.mocked(getLogSummary).mockImplementation(() => Promise.resolve(summary()));
  vi.mocked(getLogPage).mockImplementation((_id, _generation, start, count) =>
    Promise.resolve({
      start,
      rows: Array.from({ length: Math.max(0, Math.min(count, total - start)) }, (_, i) =>
        makeRow(start + i, {
          refs: refsByIndex[start + i] ?? [],
          ...(parentsByIndex[start + i] ? { parents: parentsByIndex[start + i] } : {}),
        }),
      ),
    }),
  );
  vi.mocked(searchLog).mockResolvedValue([]);
  vi.mocked(listBranches).mockResolvedValue(branchList());
  vi.mocked(checkoutCommit).mockResolvedValue(undefined);
  vi.mocked(resetToCommit).mockResolvedValue(undefined);
  vi.mocked(createBranch).mockResolvedValue({
    name: "topic",
    oid: oidOf(0),
    isHead: false,
    tracking: null,
  });
  vi.mocked(copyText).mockResolvedValue(undefined);
  vi.mocked(createTag).mockResolvedValue(undefined);
  vi.mocked(rebasePlan).mockResolvedValue([]);
});

// Models a scrolled window: only the first 10 of 600 rows are rendered, so the rest are
// off-screen and on pages nobody has fetched.
async function renderWindowed() {
  total = 600;
  mockWindow.size = 10;
  return renderPanel();
}

async function renderPanel(repoId = REPO) {
  const view = renderWithProviders(<GraphPanel repoId={repoId} />);
  await screen.findAllByRole("option");
  return view;
}

const optionAt = (n: number) => screen.getAllByRole("option")[n] as HTMLElement;
const listbox = () => screen.getByRole("listbox", { name: "Commits" });
const searchBox = () => screen.getByRole("searchbox", { name: "Search commits" });
const selectedOid = (repoId = REPO) => useWorkspace.getState().selectedCommit[repoId];
const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 40, clientY: 60 });
const menuItem = (name: string) => screen.getByRole("menuitem", { name });
const choose = (index: number) =>
  act(() => useWorkspace.getState().selectCommit(REPO, oidOf(index)));
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(listbox(), { key, ...init });

// Contract: loading, empty and error states of the summary.
describe("GraphPanel summary states", () => {
  it("should show Loading history… with role status while the summary is pending", () => {
    vi.mocked(getLogSummary).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<GraphPanel repoId={REPO} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading history…");
  });

  it("should show No commits yet for a repository without commits", async () => {
    total = 0;
    renderWithProviders(<GraphPanel repoId={REPO} />);
    expect(await screen.findByText("No commits yet")).toBeInTheDocument();
  });

  it("should not request any page for an empty history", async () => {
    total = 0;
    renderWithProviders(<GraphPanel repoId={REPO} />);
    await screen.findByText("No commits yet");
    expect(getLogPage).not.toHaveBeenCalled();
  });

  it("should not show Loading history… once the summary resolves", async () => {
    await renderPanel();
    expect(screen.queryByText("Loading history…")).toBeNull();
  });

  it("should show the summary failure in an alert", async () => {
    vi.mocked(getLogSummary).mockRejectedValue({ kind: "git", message: "summary boom" });
    renderWithProviders(<GraphPanel repoId={REPO} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("summary boom");
  });

  it("should fetch the summary again when Retry is clicked", async () => {
    vi.mocked(getLogSummary).mockRejectedValue({ kind: "git", message: "summary boom" });
    renderWithProviders(<GraphPanel repoId={REPO} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getLogSummary).toHaveBeenCalledTimes(2));
  });

  it("should fetch the summary again when the summary error is dismissed", async () => {
    vi.mocked(getLogSummary).mockRejectedValue({ kind: "git", message: "summary boom" });
    renderWithProviders(<GraphPanel repoId={REPO} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(getLogSummary).toHaveBeenCalledTimes(2));
  });

  it("should request the summary for the given repo id", async () => {
    await renderPanel(7);
    expect(getLogSummary).toHaveBeenCalledWith(7);
    expect(getLogPage).toHaveBeenCalledWith(7, 1, 0, 500);
  });
});

// Contract: rows come from the pages overlapping the rendered range.
describe("GraphPanel rows", () => {
  it("should render a Commits listbox", async () => {
    await renderPanel();
    expect(listbox()).toBeInTheDocument();
  });

  it("should render the rows of page 0 in order", async () => {
    await renderPanel();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    options.forEach((option, i) => expect(option).toHaveTextContent(`Subject ${i}`));
  });

  it("should request only page 0 for a short history", async () => {
    await renderPanel();
    expect(getLogPage).toHaveBeenCalledExactlyOnceWith(REPO, 1, 0, 500);
  });

  it("should request pages 0 and 1 for a history of 600 commits", async () => {
    total = 600;
    renderWithProviders(<GraphPanel repoId={REPO} />);
    await waitFor(() => expect(getLogPage).toHaveBeenCalledTimes(2));
    expect(getLogPage).toHaveBeenCalledWith(REPO, 1, 0, 500);
    expect(getLogPage).toHaveBeenCalledWith(REPO, 1, 500, 500);
  });

  it("should render a row from page 1 once it resolves", async () => {
    total = 600;
    renderWithProviders(<GraphPanel repoId={REPO} />);
    expect(await screen.findByText("Subject 599")).toBeInTheDocument();
  });

  it("should render the ref labels of a row", async () => {
    await renderPanel();
    expect(within(optionAt(0)).getByTitle("main")).toBeInTheDocument();
  });

  it("should size each row's lane graph from maxLanes", async () => {
    await renderPanel();
    expect(optionAt(0).querySelector("svg")?.getAttribute("width")).toBe(String(gutterWidth(2)));
  });

  it("should render a … placeholder with aria-busy for a row whose page is pending", async () => {
    vi.mocked(getLogPage).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<GraphPanel repoId={REPO} />);
    const placeholders = await screen.findAllByText("…");
    expect(placeholders).toHaveLength(3);
    placeholders.forEach((p) => expect(p.closest("[aria-busy='true']")).not.toBeNull());
  });

  it("should render pending rows as option placeholders without an id", async () => {
    vi.mocked(getLogPage).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<GraphPanel repoId={REPO} />);
    const placeholders = await screen.findAllByText("…");
    placeholders.forEach((p) => {
      const option = p.closest("[role='option']") as HTMLElement;
      expect(option).not.toBeNull();
      expect(option.id).toBe("");
    });
  });

  it("should not render any placeholder or busy marker once the page resolves", async () => {
    await renderPanel();
    expect(screen.queryByText("…")).toBeNull();
    expect(document.querySelector("[aria-busy]")).toBeNull();
  });

  it("should show a page load failure in an alert with Retry", async () => {
    vi.mocked(getLogPage).mockRejectedValue({ kind: "git", message: "page boom" });
    renderWithProviders(<GraphPanel repoId={REPO} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("page boom");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("should request the page again when Retry is clicked after a page failure", async () => {
    vi.mocked(getLogPage).mockRejectedValue({ kind: "git", message: "page boom" });
    renderWithProviders(<GraphPanel repoId={REPO} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(getLogPage).toHaveBeenCalledTimes(2));
  });
});

// Contract (Review Focus 1): a stale generation is never shown; the summary is re-read once.
describe("GraphPanel stale generation", () => {
  it("should refetch the summary once, show no error, and load the new generation", async () => {
    vi.mocked(getLogSummary)
      .mockResolvedValueOnce(summary({ generation: 1 }))
      .mockResolvedValue(summary({ generation: 2 }));
    vi.mocked(getLogPage).mockImplementation((_id, generation, start) =>
      generation === 1
        ? Promise.reject({ kind: "logStale", message: "generation is gone" })
        : Promise.resolve({ start, rows: [makeRow(0, { subject: "fresh row" })] }),
    );
    renderWithProviders(<GraphPanel repoId={REPO} />);
    expect(await screen.findByText("fresh row")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getLogSummary).toHaveBeenCalledTimes(2);
  });

  it("should show placeholders and no alert while the stale generation is being replaced", async () => {
    vi.mocked(getLogSummary).mockResolvedValue(summary({ generation: 1 }));
    vi.mocked(getLogPage).mockRejectedValue({ kind: "logStale", message: "generation is gone" });
    renderWithProviders(<GraphPanel repoId={REPO} />);
    await waitFor(() => expect(getLogSummary).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByText("…").length).toBeGreaterThan(0);
  });
});

// Contract: listbox semantics, click, arrows, Home/End and Enter.
describe("GraphPanel selection and keyboard", () => {
  it("should leave aria-activedescendant unset until a commit is selected", async () => {
    await renderPanel();
    expect(listbox()).not.toHaveAttribute("aria-activedescendant");
  });

  it("should make the listbox focusable", async () => {
    await renderPanel();
    expect(listbox()).toHaveAttribute("tabindex", "0");
  });

  it("should select the clicked row in the workspace store", async () => {
    await renderPanel();
    fireEvent.click(optionAt(1));
    expect(selectedOid()).toBe(oidOf(1));
  });

  it("should mark only the clicked row aria-selected", async () => {
    await renderPanel();
    fireEvent.click(optionAt(1));
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("should point aria-activedescendant at the selected row", async () => {
    await renderPanel();
    fireEvent.click(optionAt(2));
    expect(listbox()).toHaveAttribute("aria-activedescendant", optionAt(2).id);
  });

  it("should leave aria-activedescendant unset when the selected row is not rendered", async () => {
    await renderWindowed();
    act(() => useWorkspace.getState().selectCommit(REPO, oidOf(550)));
    await act(async () => undefined);
    expect(listbox()).not.toHaveAttribute("aria-activedescendant");
  });

  it("should leave aria-activedescendant unset while the selected row's page is pending", async () => {
    vi.mocked(getLogPage).mockReturnValue(new Promise(() => undefined));
    useWorkspace.getState().selectCommit(REPO, oidOf(1));
    renderWithProviders(<GraphPanel repoId={REPO} />);
    await screen.findAllByText("…");
    expect(listbox()).not.toHaveAttribute("aria-activedescendant");
  });

  it("should give every row a distinct id", async () => {
    await renderPanel();
    const ids = screen.getAllByRole("option").map((o) => o.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id !== "")).toBe(true);
  });

  it("should neither search nor scroll when a rendered row is clicked", async () => {
    await renderPanel();
    fireEvent.click(optionAt(1));
    await act(async () => undefined);
    expect(searchLog).not.toHaveBeenCalled();
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("should select the next row and scroll to it on ArrowDown", async () => {
    await renderPanel();
    fireEvent.click(optionAt(0));
    press("ArrowDown");
    expect(selectedOid()).toBe(oidOf(1));
    expect(scrollToIndex).toHaveBeenCalledWith(1);
  });

  it("should select the previous row and scroll to it on ArrowUp", async () => {
    await renderPanel();
    fireEvent.click(optionAt(2));
    press("ArrowUp");
    expect(selectedOid()).toBe(oidOf(1));
    expect(scrollToIndex).toHaveBeenCalledWith(1);
  });

  it("should stay on the last row when ArrowDown is pressed there", async () => {
    await renderPanel();
    fireEvent.click(optionAt(2));
    press("ArrowDown");
    expect(selectedOid()).toBe(oidOf(2));
  });

  it("should stay on the first row when ArrowUp is pressed there", async () => {
    await renderPanel();
    fireEvent.click(optionAt(0));
    press("ArrowUp");
    expect(selectedOid()).toBe(oidOf(0));
  });

  it("should select the first row and scroll to it on Home", async () => {
    await renderPanel();
    fireEvent.click(optionAt(2));
    press("Home");
    expect(selectedOid()).toBe(oidOf(0));
    expect(scrollToIndex).toHaveBeenCalledWith(0);
  });

  it("should select the last row and scroll to it on End", async () => {
    await renderPanel();
    fireEvent.click(optionAt(0));
    press("End");
    expect(selectedOid()).toBe(oidOf(2));
    expect(scrollToIndex).toHaveBeenCalledWith(2);
  });

  it("should keep the selected row when Enter is pressed", async () => {
    await renderPanel();
    choose(1);
    press("Enter");
    expect(selectedOid()).toBe(oidOf(1));
    expect(optionAt(1)).toHaveAttribute("aria-selected", "true");
  });

  it("should select the first row on Enter when nothing is selected", async () => {
    await renderPanel();
    press("Enter");
    expect(selectedOid()).toBe(oidOf(0));
  });

  it("should select the first row on ArrowDown when nothing is selected", async () => {
    await renderPanel();
    press("ArrowDown");
    expect(selectedOid()).toBe(oidOf(0));
  });

  it("should select the first row on Home when nothing is selected", async () => {
    await renderPanel();
    press("Home");
    expect(selectedOid()).toBe(oidOf(0));
  });

  it("should scroll with no options for arrow navigation", async () => {
    await renderPanel();
    fireEvent.click(optionAt(0));
    press("ArrowDown");
    expect(scrolledPlain(1)).toBe(true);
    expect(scrolledCentred(1)).toBe(false);
  });

  it.each(["ArrowDown", "ArrowUp", "Home", "End", "Enter"])(
    "should prevent the default of the handled key %s",
    async (key) => {
      await renderPanel();
      fireEvent.click(optionAt(1));
      expect(fireEvent.keyDown(listbox(), { key })).toBe(false);
    },
  );

  it("should prevent the default of Shift+F10 and the ContextMenu key", async () => {
    await renderPanel();
    choose(1);
    expect(fireEvent.keyDown(listbox(), { key: "F10", shiftKey: true })).toBe(false);
    expect(fireEvent.keyDown(listbox(), { key: "ContextMenu" })).toBe(false);
  });

  it("should not prevent the default of an unrelated key", async () => {
    await renderPanel();
    expect(fireEvent.keyDown(listbox(), { key: "a" })).toBe(true);
  });

  it("should never search when navigating with the keyboard", async () => {
    await renderPanel();
    fireEvent.click(optionAt(0));
    press("ArrowDown");
    press("End");
    press("Home");
    await act(async () => undefined);
    expect(searchLog).not.toHaveBeenCalled();
  });

  it("should select the last row on an unloaded page when End is pressed", async () => {
    await renderWindowed();
    fireEvent.click(optionAt(0));
    press("End");
    expect(scrolledPlain(599)).toBe(true);
    await waitFor(() => expect(selectedOid()).toBe(oidOf(599)));
    expect(getLogPage).toHaveBeenCalledWith(REPO, 1, 500, 500);
  });

  it("should let the latest keyboard move win over a slow earlier one", async () => {
    const page1 = deferred();
    const base = vi.mocked(getLogPage).getMockImplementation();
    vi.mocked(getLogPage).mockImplementation(async (id, generation, start, count) => {
      if (start === 500) await page1.promise;
      return (base as NonNullable<typeof base>)(id, generation, start, count);
    });
    await renderWindowed();
    fireEvent.click(optionAt(2));
    press("End");
    press("Home");
    expect(selectedOid()).toBe(oidOf(0));
    page1.resolve();
    await act(async () => undefined);
    expect(selectedOid()).toBe(oidOf(0));
  });

  it("should ignore unrelated keys", async () => {
    await renderPanel();
    fireEvent.click(optionAt(1));
    press("a");
    expect(selectedOid()).toBe(oidOf(1));
  });
});

// Contract (Review Focus 5): an off-screen selection is verified through searchLog and centred once.
describe("GraphPanel reveal", () => {
  const far = oidOf(550);
  const select = (oid: string) => act(() => useWorkspace.getState().selectCommit(REPO, oid));

  it("should reveal an off-screen selection through searchLog", async () => {
    vi.mocked(searchLog).mockResolvedValue([550]);
    await renderWindowed();
    select(far);
    await waitFor(() => expect(scrolledCentred(550)).toBe(true));
    expect(searchLog).toHaveBeenCalledExactlyOnceWith(REPO, 1, far);
    expect(scrollToIndex).toHaveBeenCalledOnce();
  });

  it("should fetch the page of the candidate to verify its oid", async () => {
    vi.mocked(searchLog).mockResolvedValue([550]);
    await renderWindowed();
    select(far);
    await waitFor(() => expect(scrolledCentred(550)).toBe(true));
    expect(getLogPage).toHaveBeenCalledWith(REPO, 1, 500, 500);
  });

  it("should skip a candidate whose row has another oid and scroll to the verified one", async () => {
    vi.mocked(searchLog).mockResolvedValue([3, 550]);
    await renderWindowed();
    select(far);
    await waitFor(() => expect(scrolledCentred(550)).toBe(true));
    expect(scrolledTo(3)).toBe(false);
  });

  it("should not scroll when no candidate row has the oid", async () => {
    vi.mocked(searchLog).mockResolvedValue([3, 4]);
    await renderWindowed();
    select(far);
    await waitFor(() => expect(searchLog).toHaveBeenCalledOnce());
    await act(async () => undefined);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("should not scroll when the search finds nothing", async () => {
    vi.mocked(searchLog).mockResolvedValue([]);
    await renderWindowed();
    select(far);
    await waitFor(() => expect(searchLog).toHaveBeenCalledOnce());
    await act(async () => undefined);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("should swallow a failed search without showing an error", async () => {
    vi.mocked(searchLog).mockRejectedValue({ kind: "logStale", message: "gone" });
    await renderWindowed();
    select(far);
    await waitFor(() => expect(searchLog).toHaveBeenCalledOnce());
    await act(async () => undefined);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("should not scroll for a rendered selection", async () => {
    await renderPanel();
    choose(1);
    await act(async () => undefined);
    expect(searchLog).not.toHaveBeenCalled();
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("should not search when nothing is selected", async () => {
    await renderPanel();
    await act(async () => undefined);
    expect(searchLog).not.toHaveBeenCalled();
  });

  it("should not search for a rendered selection that was set before its page loaded", async () => {
    useWorkspace.getState().selectCommit(REPO, oidOf(1));
    await renderPanel();
    await act(async () => undefined);
    expect(searchLog).not.toHaveBeenCalled();
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("should reveal an off-screen selection that was set before mount once pages settle", async () => {
    vi.mocked(searchLog).mockResolvedValue([550]);
    useWorkspace.getState().selectCommit(REPO, far);
    await renderWindowed();
    await waitFor(() => expect(scrolledCentred(550)).toBe(true));
    expect(searchLog).toHaveBeenCalledOnce();
  });

  it("should not search again for the same selection after a rerender", async () => {
    vi.mocked(searchLog).mockResolvedValue([550]);
    const { rerender } = await renderWindowed();
    select(far);
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalled());
    rerender(<GraphPanel repoId={REPO} />);
    await act(async () => undefined);
    expect(searchLog).toHaveBeenCalledOnce();
    expect(scrollToIndex).toHaveBeenCalledOnce();
  });

  it("should keep the selection when the reveal scrolls", async () => {
    vi.mocked(searchLog).mockResolvedValue([550]);
    await renderWindowed();
    select(far);
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalled());
    expect(selectedOid()).toBe(far);
  });

  it("should not scroll for a selection that changed while the search was pending", async () => {
    let release!: (matches: number[]) => void;
    vi.mocked(searchLog).mockReturnValue(
      new Promise<number[]>((resolve) => {
        release = resolve;
      }),
    );
    await renderWindowed();
    select(far);
    await waitFor(() => expect(searchLog).toHaveBeenCalledOnce());
    fireEvent.click(optionAt(1));
    await act(async () => release([550]));
    expect(scrollToIndex).not.toHaveBeenCalled();
    expect(selectedOid()).toBe(oidOf(1));
  });

  it("should neither search nor scroll again when a new generation re-keys the pages", async () => {
    vi.mocked(getLogSummary)
      .mockResolvedValueOnce(summary({ generation: 1 }))
      .mockResolvedValue(summary({ generation: 2 }));
    const { queryClient } = await renderPanel();
    choose(1);
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.log(REPO) }));
    await waitFor(() => expect(getLogPage).toHaveBeenCalledWith(REPO, 2, 0, 500));
    await act(async () => undefined);
    expect(searchLog).not.toHaveBeenCalled();
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("should not reveal an already revealed selection again after a generation change", async () => {
    vi.mocked(searchLog).mockResolvedValue([550]);
    vi.mocked(getLogSummary)
      .mockResolvedValueOnce(summary({ generation: 1 }))
      .mockResolvedValue(summary({ generation: 2 }));
    const { queryClient } = await renderWindowed();
    select(far);
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledOnce());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.log(REPO) }));
    await waitFor(() => expect(getLogPage).toHaveBeenCalledWith(REPO, 2, 0, 500));
    await act(async () => undefined);
    expect(searchLog).toHaveBeenCalledOnce();
    expect(scrollToIndex).toHaveBeenCalledOnce();
  });
});

// Contract: debounced search with highlighting, counter and cycling.
describe("GraphPanel search", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const type = (value: string) => fireEvent.change(searchBox(), { target: { value } });
  const matchedFlags = () => screen.getAllByRole("option").map((o) => /matched/.test(o.className));

  async function searchFor(matches: number[], query = "fix") {
    vi.mocked(searchLog).mockImplementation((_id, _generation, q) =>
      Promise.resolve(q === query ? matches : []),
    );
    await renderPanel();
    type(query);
    await advance(400);
  }

  it("should render the search input", async () => {
    await renderPanel();
    expect(searchBox()).toHaveAttribute("placeholder", "Search commits");
  });

  it("should wait for the debounce before calling searchLog", async () => {
    await renderPanel();
    type("fix");
    await advance(100);
    expect(searchLog).not.toHaveBeenCalled();
  });

  it("should call searchLog with the query once the debounce elapsed", async () => {
    await renderPanel();
    type("fix");
    await advance(400);
    expect(searchLog).toHaveBeenCalledExactlyOnceWith(REPO, 1, "fix");
  });

  it("should search only the final query when typing quickly", async () => {
    await renderPanel();
    type("f");
    await advance(100);
    type("fi");
    await advance(100);
    type("fix");
    await advance(100);
    expect(searchLog).not.toHaveBeenCalled();
    await advance(400);
    expect(searchLog).toHaveBeenCalledExactlyOnceWith(REPO, 1, "fix");
  });

  it("should not search for a whitespace-only query", async () => {
    await renderPanel();
    type("   ");
    await advance(400);
    expect(searchLog).not.toHaveBeenCalled();
  });

  it("should highlight the matching rows only", async () => {
    await searchFor([0, 2]);
    expect(matchedFlags()).toEqual([true, false, true]);
  });

  it("should show the counter for the matches", async () => {
    await searchFor([0, 2]);
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("should select and reveal the first match automatically", async () => {
    await searchFor([1, 2]);
    expect(selectedOid()).toBe(oidOf(1));
    expect(scrolledTo(1)).toBe(true);
  });

  it("should show No matches when nothing matches", async () => {
    await searchFor([]);
    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(matchedFlags()).toEqual([false, false, false]);
  });

  it("should leave the selection alone when nothing matches", async () => {
    await renderPanel();
    fireEvent.click(optionAt(1));
    type("zzz");
    await advance(400);
    expect(selectedOid()).toBe(oidOf(1));
  });

  it("should move to the next match with Next", async () => {
    await searchFor([0, 2]);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    expect(selectedOid()).toBe(oidOf(2));
    expect(scrolledTo(2)).toBe(true);
  });

  it("should wrap to the first match when Next passes the last", async () => {
    await searchFor([0, 2]);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(selectedOid()).toBe(oidOf(0));
  });

  it("should wrap to the last match when Previous passes the first", async () => {
    await searchFor([0, 2]);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    expect(selectedOid()).toBe(oidOf(2));
  });

  it("should move back with Previous after Next", async () => {
    await searchFor([0, 1, 2]);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
    expect(selectedOid()).toBe(oidOf(0));
  });

  it("should move to the next match with Enter in the input", async () => {
    await searchFor([0, 2]);
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });

  it("should move to the previous match with Shift+Enter in the input", async () => {
    await searchFor([0, 2]);
    fireEvent.keyDown(searchBox(), { key: "Enter", shiftKey: true });
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
  });

  it("should clear the input, counter and highlights with Escape", async () => {
    await searchFor([0, 2]);
    fireEvent.keyDown(searchBox(), { key: "Escape" });
    await advance(400);
    expect(searchBox()).toHaveValue("");
    expect(screen.queryByText("1 of 2")).toBeNull();
    expect(matchedFlags()).toEqual([false, false, false]);
  });

  it("should start again at the first match for a new query", async () => {
    vi.mocked(searchLog).mockImplementation((_id, _generation, q) =>
      Promise.resolve(q === "fix" ? [0, 2] : q === "bug" ? [1] : []),
    );
    await renderPanel();
    type("fix");
    await advance(400);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    type("bug");
    await advance(400);
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
    expect(selectedOid()).toBe(oidOf(1));
  });
});

// Contract: search edge cases: in-flight state, unloaded pages and generation changes.
describe("GraphPanel search lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const type = (value: string) => fireEvent.change(searchBox(), { target: { value } });

  it("should show neither a counter nor No matches while the search is in flight", async () => {
    let release!: (matches: number[]) => void;
    vi.mocked(searchLog).mockReturnValue(
      new Promise<number[]>((resolve) => {
        release = resolve;
      }),
    );
    await renderPanel();
    type("fix");
    await advance(400);
    expect(screen.queryByText("No matches")).toBeNull();
    expect(screen.queryByText(/ of /)).toBeNull();
    await act(async () => release([0]));
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });

  it("should select and centre a first match on an unloaded page", async () => {
    vi.mocked(searchLog).mockImplementation((_id, _generation, q) =>
      Promise.resolve(q === "fix" ? [550] : []),
    );
    await renderWindowed();
    type("fix");
    await advance(400);
    await waitFor(() => expect(selectedOid()).toBe(oidOf(550)));
    expect(scrolledCentred(550)).toBe(true);
    expect(getLogPage).toHaveBeenCalledWith(REPO, 1, 500, 500);
  });

  it("should keep the cursor and not reselect when a new generation returns the same matches", async () => {
    vi.mocked(getLogSummary)
      .mockResolvedValueOnce(summary({ generation: 1 }))
      .mockResolvedValue(summary({ generation: 2 }));
    vi.mocked(searchLog).mockImplementation((_id, _generation, q) =>
      Promise.resolve(q === "fix" ? [0, 2] : []),
    );
    const { queryClient } = await renderPanel();
    type("fix");
    await advance(400);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    const scrollsBefore = scrolls.mock.calls.length;
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.log(REPO) }));
    await waitFor(() => expect(searchLog).toHaveBeenCalledWith(REPO, 2, "fix"));
    await advance(100);
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    expect(selectedOid()).toBe(oidOf(2));
    expect(scrolls.mock.calls.length).toBe(scrollsBefore);
  });

  it("should reveal the first match again for a new query", async () => {
    vi.mocked(searchLog).mockImplementation((_id, _generation, q) =>
      Promise.resolve(q === "fix" ? [0] : q === "bug" ? [2] : []),
    );
    await renderPanel();
    type("fix");
    await advance(400);
    type("bug");
    await advance(400);
    expect(selectedOid()).toBe(oidOf(2));
  });
});

// Contract: the row context menu, its labels, titles and enabled states.
describe("GraphPanel context menu", () => {
  it("should list the eight items in order on right-click", async () => {
    await renderPanel();
    rightClick(optionAt(1));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Checkout",
      "Create branch here…",
      "Create tag here…",
      "Reset to this commit…",
      "Cherry-pick commit",
      "Revert commit",
      "Rebase interactively from here…",
      "Copy hash",
    ]);
  });

  it("should select the right-clicked row", async () => {
    await renderPanel();
    rightClick(optionAt(2));
    expect(selectedOid()).toBe(oidOf(2));
  });

  it("should show no menu before a right-click", async () => {
    await renderPanel();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should title Checkout with the short hash it detaches at", async () => {
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem("Checkout")).toHaveAttribute("title", `Detaches HEAD at ${shortOf(oidOf(1))}`);
  });

  it("should disable Checkout on a row labelled with the detached HEAD", async () => {
    refsByIndex = { 1: [ref("head", "HEAD", true)] };
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem("Checkout")).toBeDisabled();
  });

  it("should keep Checkout enabled on a row carrying only branch labels", async () => {
    await renderPanel();
    rightClick(optionAt(0));
    expect(menuItem("Checkout")).toBeEnabled();
  });

  it("should keep Checkout enabled on a row without labels", async () => {
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem("Checkout")).toBeEnabled();
  });

  it("should call checkoutCommit with the full oid when Checkout is chosen", async () => {
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Checkout"));
    expect(checkoutCommit).toHaveBeenCalledExactlyOnceWith(REPO, oidOf(1));
  });

  it("should close the menu after Checkout", async () => {
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Checkout"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should copy the full hash when Copy hash is chosen", async () => {
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Copy hash"));
    expect(copyText).toHaveBeenCalledExactlyOnceWith(oidOf(1));
  });

  it("should show a failed copy in an alert that Dismiss clears", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("clipboard denied"));
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Copy hash"));
    expect(await screen.findByRole("alert")).toHaveTextContent("clipboard denied");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should open the menu for the selected row with Shift+F10", async () => {
    await renderPanel();
    choose(2);
    press("F10", { shiftKey: true });
    expect(menuItem("Checkout")).toHaveAttribute("title", `Detaches HEAD at ${shortOf(oidOf(2))}`);
  });

  it("should open the menu for the selected row with the ContextMenu key", async () => {
    await renderPanel();
    choose(1);
    press("ContextMenu");
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("should not open a menu with Shift+F10 when nothing is selected", async () => {
    await renderPanel();
    press("F10", { shiftKey: true });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should not open a menu with Shift+F10 when the selected row is not rendered", async () => {
    await renderWindowed();
    act(() => useWorkspace.getState().selectCommit(REPO, oidOf(550)));
    press("F10", { shiftKey: true });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should not open a menu with F10 alone", async () => {
    await renderPanel();
    choose(1);
    press("F10");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should focus the Commit graph region when the menu closes and nothing held focus", async () => {
    const { user } = await renderPanel();
    rightClick(optionAt(0));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("region", { name: "Commit graph" })).toHaveFocus();
  });
});

// Contract: Create branch here… opens a prompt bound to the commit's full oid.
describe("GraphPanel create branch", () => {
  async function openCreate(index = 1) {
    const view = await renderPanel();
    rightClick(optionAt(index));
    await view.user.click(menuItem("Create branch here…"));
    const dialog = await screen.findByRole("dialog", {
      name: `New branch from ${shortOf(oidOf(index))}`,
    });
    return { ...view, dialog };
  }

  it("should open a prompt titled New branch from the short hash", async () => {
    const { dialog } = await openCreate();
    expect(dialog).toBeInTheDocument();
  });

  it("should offer a Name field and a Switch to new branch checkbox that is on", async () => {
    const { dialog } = await openCreate();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("");
    expect(within(dialog).getByLabelText("Switch to new branch")).toBeChecked();
  });

  it("should call createBranch with the full oid as start point and switch on", async () => {
    const { dialog, user } = await openCreate();
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createBranch).toHaveBeenCalledExactlyOnceWith(REPO, "topic", oidOf(1), true);
  });

  it("should call createBranch without switching when the checkbox is cleared", async () => {
    const { dialog, user } = await openCreate();
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByLabelText("Switch to new branch"));
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createBranch).toHaveBeenCalledExactlyOnceWith(REPO, "topic", oidOf(1), false);
  });

  it("should close the dialog when the branch is created", async () => {
    const { dialog, user } = await openCreate();
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("should show a creation error inside the dialog and keep it open", async () => {
    vi.mocked(createBranch).mockRejectedValue({ kind: "branchExists", message: "taken" });
    const { dialog, user } = await openCreate();
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("taken");
  });

  it("should show a creation error only inside the dialog, not also in the panel", async () => {
    vi.mocked(createBranch).mockRejectedValue({ kind: "branchExists", message: "taken" });
    const { dialog, user } = await openCreate();
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await within(dialog).findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("should mark the panel busy while the branch is being created", async () => {
    const pending = deferred();
    vi.mocked(createBranch).mockReturnValue(pending.promise as never);
    const { dialog, user } = await openCreate();
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Commit graph" })).toHaveAttribute(
        "aria-busy",
        "true",
      ),
    );
    pending.resolve();
  });

  it("should not call createBranch when the dialog is cancelled", async () => {
    const { dialog, user } = await openCreate();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(createBranch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// Contract (GR-11b): Create tag here… opens the tag dialog bound to the commit's full oid.
describe("GraphPanel create tag", () => {
  const ITEM = "Create tag here…";
  async function openTag(index = 1) {
    const view = await renderPanel();
    rightClick(optionAt(index));
    await view.user.click(menuItem(ITEM));
    const dialog = await screen.findByRole("dialog", {
      name: `Create tag on ${shortOf(oidOf(index))}`,
    });
    return { ...view, dialog };
  }

  it("should open the dialog titled Create tag on the row's short hash", async () => {
    const { dialog } = await openTag();
    expect(dialog).toBeInTheDocument();
  });

  it("should tag the row's full oid", async () => {
    const { dialog, user } = await openTag();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "v1");
    await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "msg");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createTag).toHaveBeenCalledExactlyOnceWith(REPO, "v1", oidOf(1), "msg");
  });

  it("should close the dialog after a successful create", async () => {
    const { dialog, user } = await openTag();
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "v1");
    await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "msg");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("should not call createTag when the dialog is cancelled", async () => {
    const { dialog, user } = await openTag();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(createTag).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should focus the Commit graph region when the dialog is cancelled", async () => {
    const { dialog, user } = await openTag();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("region", { name: "Commit graph" })).toHaveFocus();
  });

  it("should disable the item while a graph action runs", async () => {
    provideMerge({ pending: true });
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem(ITEM)).toBeDisabled();
  });

  it("should enable the item when no action runs", async () => {
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem(ITEM)).toBeEnabled();
  });
});

// Contract: Reset to this commit… confirms with a mode, defaulting to mixed.
describe("GraphPanel reset", () => {
  async function openReset(index = 1) {
    const view = await renderPanel();
    rightClick(optionAt(index));
    await view.user.click(menuItem("Reset to this commit…"));
    const dialog = await screen.findByRole("dialog", {
      name: `Reset to ${shortOf(oidOf(index))}?`,
    });
    return { ...view, dialog };
  }

  const mode = (dialog: HTMLElement, name: string) => within(dialog).getByRole("radio", { name });
  const SOFT = "Soft — keep the index and working tree";
  const MIXED = "Mixed — keep the working tree, unstage everything";
  const HARD = "Hard — discard index and working tree changes";

  it("should open a dialog titled Reset to the short hash with a question mark", async () => {
    const { dialog } = await openReset();
    expect(dialog).toBeInTheDocument();
  });

  it("should offer a Mode radio group with the three modes", async () => {
    const { dialog } = await openReset();
    const group = within(dialog).getByRole("group", { name: "Mode" });
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(mode(dialog, SOFT)).toBeInTheDocument();
    expect(mode(dialog, MIXED)).toBeInTheDocument();
    expect(mode(dialog, HARD)).toBeInTheDocument();
  });

  it("should default to Mixed", async () => {
    const { dialog } = await openReset();
    expect(mode(dialog, MIXED)).toBeChecked();
    expect(mode(dialog, SOFT)).not.toBeChecked();
    expect(mode(dialog, HARD)).not.toBeChecked();
  });

  it("should say which branch moves to the commit", async () => {
    const { dialog } = await openReset();
    expect(
      await within(dialog).findByText(`Moves main to ${shortOf(oidOf(1))}.`),
    ).toBeInTheDocument();
  });

  it("should say HEAD moves when HEAD is detached", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ kind: "detached", oid: oidOf(0) }));
    const { dialog } = await openReset();
    expect(
      await within(dialog).findByText(`Moves HEAD to ${shortOf(oidOf(1))}.`),
    ).toBeInTheDocument();
  });

  it("should confirm with a non-danger Reset button while Mixed is chosen", async () => {
    const { dialog } = await openReset();
    expect(within(dialog).getByRole("button", { name: "Reset" })).not.toHaveAttribute(
      "data-danger",
    );
  });

  it("should turn the Reset button danger when Hard is chosen", async () => {
    const { dialog, user } = await openReset();
    await user.click(mode(dialog, HARD));
    expect(within(dialog).getByRole("button", { name: "Reset" })).toHaveAttribute(
      "data-danger",
      "true",
    );
  });

  it("should drop the danger style again when Soft is chosen after Hard", async () => {
    const { dialog, user } = await openReset();
    await user.click(mode(dialog, HARD));
    await user.click(mode(dialog, SOFT));
    expect(within(dialog).getByRole("button", { name: "Reset" })).not.toHaveAttribute(
      "data-danger",
    );
  });

  it("should reset mixed by default", async () => {
    const { dialog, user } = await openReset();
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(resetToCommit).toHaveBeenCalledExactlyOnceWith(REPO, oidOf(1), "mixed");
  });

  it("should reset hard when Hard is chosen", async () => {
    const { dialog, user } = await openReset();
    await user.click(mode(dialog, HARD));
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(resetToCommit).toHaveBeenCalledExactlyOnceWith(REPO, oidOf(1), "hard");
  });

  it("should reset soft when Soft is chosen", async () => {
    const { dialog, user } = await openReset();
    await user.click(mode(dialog, SOFT));
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(resetToCommit).toHaveBeenCalledExactlyOnceWith(REPO, oidOf(1), "soft");
  });

  it("should close the dialog when the reset succeeds", async () => {
    const { dialog, user } = await openReset();
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("should not reset when the dialog is cancelled", async () => {
    const { dialog, user } = await openReset();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(resetToCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should open on Mixed again after being cancelled on Hard", async () => {
    const { dialog, user } = await openReset();
    await user.click(mode(dialog, HARD));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    rightClick(optionAt(1));
    await user.click(menuItem("Reset to this commit…"));
    const again = await screen.findByRole("dialog", { name: `Reset to ${shortOf(oidOf(1))}?` });
    expect(mode(again, MIXED)).toBeChecked();
  });

  it("should close the dialog and show a failed reset in the panel alert", async () => {
    vi.mocked(resetToCommit).mockRejectedValue({ kind: "git", message: "reset exploded" });
    const { dialog, user } = await openReset();
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("reset exploded");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should say the unborn branch moves to the commit", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ kind: "unborn", name: "trunk" }));
    const { dialog } = await openReset();
    expect(
      await within(dialog).findByText(`Moves trunk to ${shortOf(oidOf(1))}.`),
    ).toBeInTheDocument();
  });

  it("should say HEAD moves while the branch list has not loaded", async () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => undefined));
    const { dialog } = await openReset();
    expect(within(dialog).getByText(`Moves HEAD to ${shortOf(oidOf(1))}.`)).toBeInTheDocument();
  });

  it("should show Working… on a disabled confirm while the reset is pending", async () => {
    const pending = deferred();
    vi.mocked(resetToCommit).mockReturnValue(pending.promise);
    const { dialog, user } = await openReset();
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Working…" })).toBeDisabled(),
    );
    pending.resolve();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

// Contract: failures and pending state of the checkout action.
describe("GraphPanel action errors and busy state", () => {
  it("should show a checkoutFailed rejection in an alert with its message", async () => {
    vi.mocked(checkoutCommit).mockRejectedValue({
      kind: "checkoutFailed",
      message: "Your local changes would be overwritten",
    });
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Checkout"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your local changes would be overwritten",
    );
  });

  it("should clear the alert when Dismiss is clicked", async () => {
    vi.mocked(checkoutCommit).mockRejectedValue({ kind: "checkoutFailed", message: "nope" });
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Checkout"));
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should show a git rejection from a menu action in an alert", async () => {
    vi.mocked(checkoutCommit).mockRejectedValue({ kind: "git", message: "git said no" });
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Checkout"));
    expect(await screen.findByRole("alert")).toHaveTextContent("git said no");
  });

  it("should be aria-busy and disable the menu items while a checkout is pending", async () => {
    const pending = deferred();
    vi.mocked(checkoutCommit).mockReturnValue(pending.promise);
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Checkout"));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Commit graph" })).toHaveAttribute(
        "aria-busy",
        "true",
      ),
    );
    rightClick(optionAt(2));
    for (const item of screen.getAllByRole("menuitem")) expect(item).toBeDisabled();
    pending.resolve();
  });

  it("should stop being busy once the checkout settles", async () => {
    const pending = deferred();
    vi.mocked(checkoutCommit).mockReturnValue(pending.promise);
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Checkout"));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Commit graph" })).toHaveAttribute(
        "aria-busy",
        "true",
      ),
    );
    pending.resolve();
    await waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });
});

// Contract: a new generation re-keys pages and search while the selection survives.
describe("GraphPanel generation change", () => {
  const rowsOfGeneration = () =>
    vi.mocked(getLogPage).mockImplementation((_id, generation, start) =>
      Promise.resolve({
        start,
        rows: Array.from({ length: 3 }, (_, i) =>
          makeRow(i, { subject: `G${generation} row ${i}` }),
        ),
      }),
    );

  it("should request page 0 of the new generation after the summary is refetched", async () => {
    rowsOfGeneration();
    vi.mocked(getLogSummary)
      .mockResolvedValueOnce(summary({ generation: 1 }))
      .mockResolvedValue(summary({ generation: 2 }));
    const { queryClient } = await renderPanel();
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.log(REPO) }));
    await waitFor(() => expect(getLogPage).toHaveBeenCalledWith(REPO, 2, 0, 500));
  });

  it("should show the rows of the new generation", async () => {
    rowsOfGeneration();
    vi.mocked(getLogSummary)
      .mockResolvedValueOnce(summary({ generation: 1 }))
      .mockResolvedValue(summary({ generation: 2 }));
    const { queryClient } = await renderPanel();
    expect(screen.getByText("G1 row 0")).toBeInTheDocument();
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.log(REPO) }));
    expect(await screen.findByText("G2 row 0")).toBeInTheDocument();
  });

  it("should keep the selected oid across the generation change", async () => {
    rowsOfGeneration();
    vi.mocked(getLogSummary)
      .mockResolvedValueOnce(summary({ generation: 1 }))
      .mockResolvedValue(summary({ generation: 2 }));
    const { queryClient } = await renderPanel();
    fireEvent.click(optionAt(1));
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.log(REPO) }));
    await screen.findByText("G2 row 1");
    expect(selectedOid()).toBe(oidOf(1));
    expect(optionAt(1)).toHaveAttribute("aria-selected", "true");
  });

  it("should search the new generation again after the summary is refetched", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(getLogSummary)
        .mockResolvedValueOnce(summary({ generation: 1 }))
        .mockResolvedValue(summary({ generation: 2 }));
      vi.mocked(searchLog).mockResolvedValue([1]);
      const { queryClient } = await renderPanel();
      fireEvent.change(searchBox(), { target: { value: "fix" } });
      await act(async () => void (await vi.advanceTimersByTimeAsync(400)));
      expect(searchLog).toHaveBeenCalledWith(REPO, 1, "fix");
      await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.log(REPO) }));
      await waitFor(() => expect(searchLog).toHaveBeenCalledWith(REPO, 2, "fix"));
    } finally {
      vi.useRealTimers();
    }
  });
});

// Coverage audit: search-box edge cases (empty results, stale answers, rejections, clearing).
describe("GraphPanel search edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const type = (value: string) => fireEvent.change(searchBox(), { target: { value } });
  const matchedFlags = () => screen.getAllByRole("option").map((o) => /matched/.test(o.className));

  it("should ignore Enter and Shift+Enter in the search box when nothing matches", async () => {
    await renderPanel();
    fireEvent.click(optionAt(1));
    type("zzz");
    await advance(400);
    expect(screen.getByText("No matches")).toBeInTheDocument();
    const scrollsBefore = scrolls.mock.calls.length;
    fireEvent.keyDown(searchBox(), { key: "Enter" });
    fireEvent.keyDown(searchBox(), { key: "Enter", shiftKey: true });
    await advance(0);
    expect(selectedOid()).toBe(oidOf(1));
    expect(scrolls.mock.calls.length).toBe(scrollsBefore);
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("should not let a slow answer for an earlier query move the selection", async () => {
    let releaseFix!: (matches: number[]) => void;
    vi.mocked(searchLog).mockImplementation((_id, _generation, q) =>
      q === "fix"
        ? new Promise<number[]>((resolve) => {
            releaseFix = resolve;
          })
        : Promise.resolve(q === "bug" ? [2] : []),
    );
    await renderPanel();
    type("fix");
    await advance(400);
    type("bug");
    await advance(400);
    expect(selectedOid()).toBe(oidOf(2));
    await act(async () => releaseFix([0]));
    expect(selectedOid()).toBe(oidOf(2));
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });

  it("should swallow a failed search without an alert or a selection", async () => {
    vi.mocked(searchLog).mockRejectedValue({ kind: "git", message: "search broke" });
    await renderPanel();
    type("fix");
    await advance(400);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(selectedOid()).toBeUndefined();
  });

  it("should not select or scroll when the panel unmounts before the search answers", async () => {
    let release!: (matches: number[]) => void;
    vi.mocked(searchLog).mockReturnValue(
      new Promise<number[]>((resolve) => {
        release = resolve;
      }),
    );
    const { unmount } = await renderPanel();
    type("fix");
    await advance(400);
    unmount();
    await act(async () => release([1]));
    expect(selectedOid()).toBeUndefined();
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("should clear highlights and counter at once when the input is emptied by editing", async () => {
    vi.mocked(searchLog).mockImplementation((_id, _generation, q) =>
      Promise.resolve(q === "fix" ? [0, 2] : []),
    );
    await renderPanel();
    type("fix");
    await advance(400);
    expect(matchedFlags()).toEqual([true, false, true]);
    type("");
    expect(matchedFlags()).toEqual([false, false, false]);
    expect(screen.queryByText(/ of /)).toBeNull();
    const callsBefore = vi.mocked(searchLog).mock.calls.length;
    await advance(400);
    expect(vi.mocked(searchLog).mock.calls.length).toBe(callsBefore);
  });

  it("should clear highlights when the query becomes whitespace only after a search", async () => {
    vi.mocked(searchLog).mockImplementation((_id, _generation, q) =>
      Promise.resolve(q === "fix" ? [0, 2] : []),
    );
    await renderPanel();
    type("fix");
    await advance(400);
    type("   ");
    await advance(400);
    expect(matchedFlags()).toEqual([false, false, false]);
    expect(screen.queryByText(/ of /)).toBeNull();
    expect(screen.queryByText("No matches")).toBeNull();
  });

  it("should clamp the cursor when a new generation returns fewer matches", async () => {
    vi.mocked(getLogSummary)
      .mockResolvedValueOnce(summary({ generation: 1 }))
      .mockResolvedValue(summary({ generation: 2 }));
    vi.mocked(searchLog).mockImplementation((_id, generation, q) =>
      Promise.resolve(q === "fix" ? (generation === 1 ? [0, 2] : [1]) : []),
    );
    const { queryClient } = await renderPanel();
    type("fix");
    await advance(400);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.log(REPO) }));
    await waitFor(() => expect(searchLog).toHaveBeenCalledWith(REPO, 2, "fix"));
    await advance(100);
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });
});

// Coverage audit: asynchronous continuations after a failure or an unmount (the c6eabdc guard).
describe("GraphPanel async guards", () => {
  const far = oidOf(550);
  const select = (oid: string) => act(() => useWorkspace.getState().selectCommit(REPO, oid));

  function gatePage1() {
    const gate = deferred();
    const base = vi.mocked(getLogPage).getMockImplementation();
    vi.mocked(getLogPage).mockImplementation(async (id, generation, start, count) => {
      if (start === 500) await gate.promise;
      return (base as NonNullable<typeof base>)(id, generation, start, count);
    });
    return gate;
  }

  it("should swallow a failed page fetch when End targets an unloaded page", async () => {
    const base = vi.mocked(getLogPage).getMockImplementation();
    vi.mocked(getLogPage).mockImplementation((id, generation, start, count) =>
      start === 500
        ? Promise.reject({ kind: "git", message: "page broke" })
        : (base as NonNullable<typeof base>)(id, generation, start, count),
    );
    await renderWindowed();
    fireEvent.click(optionAt(0));
    press("End");
    await waitFor(() => expect(getLogPage).toHaveBeenCalledWith(REPO, 1, 500, 500));
    await act(async () => undefined);
    expect(selectedOid()).toBe(oidOf(0));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should not select after unmount when a keyboard move waits on its page", async () => {
    const gate = gatePage1();
    const { unmount } = await renderWindowed();
    fireEvent.click(optionAt(0));
    press("End");
    unmount();
    gate.resolve();
    await act(async () => undefined);
    expect(selectedOid()).toBe(oidOf(0));
  });

  it("should not scroll after unmount when the reveal is waiting on the candidate's page", async () => {
    vi.mocked(searchLog).mockResolvedValue([550]);
    const gate = gatePage1();
    const { unmount } = await renderWindowed();
    select(far);
    await waitFor(() => expect(searchLog).toHaveBeenCalledOnce());
    await waitFor(() => expect(getLogPage).toHaveBeenCalledWith(REPO, 1, 500, 500));
    unmount();
    gate.resolve();
    await act(async () => undefined);
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("should not scroll after unmount when the reveal is still searching", async () => {
    let release!: (matches: number[]) => void;
    vi.mocked(searchLog).mockReturnValue(
      new Promise<number[]>((resolve) => {
        release = resolve;
      }),
    );
    const { unmount } = await renderWindowed();
    select(far);
    await waitFor(() => expect(searchLog).toHaveBeenCalledOnce());
    unmount();
    await act(async () => release([550]));
    expect(scrollToIndex).not.toHaveBeenCalled();
  });

  it("should not scroll when the selection changes while the candidate's page loads", async () => {
    vi.mocked(searchLog).mockResolvedValue([550]);
    const gate = gatePage1();
    await renderWindowed();
    select(far);
    await waitFor(() => expect(getLogPage).toHaveBeenCalledWith(REPO, 1, 500, 500));
    fireEvent.click(optionAt(1));
    gate.resolve();
    await act(async () => undefined);
    expect(scrollToIndex).not.toHaveBeenCalledWith(550, expect.anything());
    expect(selectedOid()).toBe(oidOf(1));
  });
});

// Coverage audit: keyboard anchoring when the selection is absent or cleared from outside.
describe("GraphPanel keyboard anchor", () => {
  it("should select the first row on ArrowUp when nothing is selected", async () => {
    await renderPanel();
    press("ArrowUp");
    expect(selectedOid()).toBe(oidOf(0));
  });

  it.each(["ArrowDown", "Home", "Enter"])(
    "should select row 0 on %s after the selection is cleared outside",
    async (key) => {
      total = 5;
      await renderPanel();
      fireEvent.click(optionAt(1));
      press("ArrowDown");
      expect(selectedOid()).toBe(oidOf(2));
      act(() => useWorkspace.getState().selectCommit(REPO, null));
      press(key);
      expect(selectedOid()).toBe(oidOf(0));
    },
  );

  it("should continue from the last keyboard row when the selection is outside the rendered window", async () => {
    await renderWindowed();
    fireEvent.click(optionAt(0));
    press("End");
    await waitFor(() => expect(selectedOid()).toBe(oidOf(599)));
    press("ArrowUp");
    await waitFor(() => expect(selectedOid()).toBe(oidOf(598)));
  });

  it("should open no menu on Shift+F10 once the selection is cleared outside", async () => {
    await renderPanel();
    fireEvent.click(optionAt(1));
    act(() => useWorkspace.getState().selectCommit(REPO, null));
    press("F10", { shiftKey: true });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

// Coverage audit: relative dates follow a one-minute clock that stops with the panel.
describe("GraphPanel clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("should refresh relative dates every minute", async () => {
    const start = 1_800_000_000;
    vi.useFakeTimers({ shouldAdvanceTime: true, now: start * 1000 });
    vi.mocked(getLogPage).mockImplementation((_id, _generation, startIndex) =>
      Promise.resolve({ start: startIndex, rows: [makeRow(0, { authorTime: start })] }),
    );
    total = 1;
    await renderPanel();
    expect(screen.getByText("just now")).toBeInTheDocument();
    await act(async () => void (await vi.advanceTimersByTimeAsync(61_000)));
    expect(screen.getByText("1 minute ago")).toBeInTheDocument();
  });

  it("should stop the clock when the panel unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const cleared = vi.spyOn(globalThis, "clearInterval");
    const { unmount } = await renderPanel();
    unmount();
    expect(cleared).toHaveBeenCalled();
    cleared.mockRestore();
  });
});

// Coverage audit: a panel error never leaks into a dialog, and a dialog never leaves one behind.
describe("GraphPanel dialog error hygiene", () => {
  it("should not show an earlier checkout failure after a create dialog is cancelled", async () => {
    vi.mocked(checkoutCommit).mockRejectedValue({ kind: "checkoutFailed", message: "blocked" });
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Checkout"));
    await screen.findByRole("alert");
    rightClick(optionAt(1));
    await user.click(menuItem("Create branch here…"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should leave no alert behind when a failed create dialog is cancelled", async () => {
    vi.mocked(createBranch).mockRejectedValue({ kind: "branchExists", message: "taken" });
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Create branch here…"));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    await within(dialog).findByRole("alert");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Final fix pass: a cursor belongs to one search, and an empty window is not a settled one.
describe("GraphPanel final fix pass", () => {
  it("should restart the counter at 1 when the box is cleared and the same query retyped", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.mocked(searchLog).mockImplementation((_id, _generation, q) =>
        Promise.resolve(q === "fix" ? [0, 2] : []),
      );
      await renderPanel();
      const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
      fireEvent.change(searchBox(), { target: { value: "fix" } });
      await advance(400);
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByText("2 of 2")).toBeInTheDocument();
      fireEvent.change(searchBox(), { target: { value: "" } });
      fireEvent.change(searchBox(), { target: { value: "fix" } });
      await advance(400);
      expect(screen.getByText("1 of 2")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("should not search for a remounted selection whose row is on the loaded first page", async () => {
    useWorkspace.getState().selectCommit(REPO, oidOf(1));
    mockWindow.size = 0;
    renderWithProviders(<GraphPanel repoId={REPO} />);
    await screen.findByRole("listbox", { name: "Commits" });
    await act(async () => undefined);
    mockWindow.size = Infinity;
    fireEvent.change(searchBox(), { target: { value: " " } });
    await screen.findByText("Subject 1");
    await act(async () => undefined);
    expect(searchLog).not.toHaveBeenCalled();
    expect(scrollToIndex).not.toHaveBeenCalled();
  });
});

// Contract (spec 5.4): Cherry-pick commit and Revert commit after Reset to this commit….
describe("GraphPanel cherry-pick and revert", () => {
  const mergeState: OperationState = {
    kind: "merge",
    head: oidOf(5),
    branch: "feature",
    message: { subject: "Merge branch 'feature'", body: "" },
  };
  const twoParents = (n: number) => [oidOf(n + 1), oidOf(n + 2)];
  const dirty: AppError = {
    kind: "operationFailed",
    message: "error: could not apply abc1234",
  };
  /** Waits until the branch list has landed so HEAD-dependent items are final. */
  async function renderWithHead() {
    const view = await renderPanel();
    await waitFor(() => expect(listBranches).toHaveBeenCalled());
    await act(async () => {});
    return view;
  }

  it("should enable Cherry-pick commit and Revert commit on an ordinary commit", async () => {
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem("Cherry-pick commit")).toBeEnabled();
    expect(menuItem("Revert commit")).toBeEnabled();
  });

  it("should give the enabled items no title", async () => {
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem("Cherry-pick commit")).not.toHaveAttribute("title");
    expect(menuItem("Revert commit")).not.toHaveAttribute("title");
  });

  // Contract: merge commits are not supported yet.
  it("should disable both items on a merge commit with the unsupported title", async () => {
    parentsByIndex = { 1: twoParents(1) };
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem("Cherry-pick commit")).toBeDisabled();
    expect(menuItem("Revert commit")).toBeDisabled();
    expect(menuItem("Cherry-pick commit")).toHaveAttribute(
      "title",
      "Merge commits are not supported yet",
    );
    expect(menuItem("Revert commit")).toHaveAttribute(
      "title",
      "Merge commits are not supported yet",
    );
  });

  it("should keep the items enabled on a root commit without parents", async () => {
    parentsByIndex = { 1: [] };
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem("Cherry-pick commit")).toBeEnabled();
  });

  // Contract: cherry-pick of the commit HEAD points at is a no-op, so it is refused.
  it("should disable Cherry-pick on the HEAD branch commit with the already-here title", async () => {
    await renderWithHead();
    rightClick(optionAt(0));
    expect(menuItem("Cherry-pick commit")).toBeDisabled();
    expect(menuItem("Cherry-pick commit")).toHaveAttribute("title", "Already on this commit");
  });

  it("should keep Revert enabled on the HEAD branch commit", async () => {
    await renderWithHead();
    rightClick(optionAt(0));
    expect(menuItem("Revert commit")).toBeEnabled();
  });

  it("should disable Cherry-pick on the commit a detached HEAD points at", async () => {
    refsByIndex = { 1: [ref("head", "HEAD", true)] };
    vi.mocked(listBranches).mockResolvedValue({
      head: { kind: "detached", oid: oidOf(1) },
      local: [],
      remotes: [],
    });
    await renderWithHead();
    rightClick(optionAt(1));
    expect(menuItem("Cherry-pick commit")).toHaveAttribute("title", "Already on this commit");
  });

  it("should keep Cherry-pick enabled on a commit other than the detached HEAD", async () => {
    refsByIndex = { 1: [ref("head", "HEAD", true)] };
    vi.mocked(listBranches).mockResolvedValue({
      head: { kind: "detached", oid: oidOf(1) },
      local: [],
      remotes: [],
    });
    await renderWithHead();
    rightClick(optionAt(2));
    expect(menuItem("Cherry-pick commit")).toBeEnabled();
  });

  it("should prefer the unsupported title over the already-here title on a HEAD merge commit", async () => {
    parentsByIndex = { 0: twoParents(0) };
    await renderWithHead();
    rightClick(optionAt(0));
    expect(menuItem("Cherry-pick commit")).toHaveAttribute(
      "title",
      "Merge commits are not supported yet",
    );
  });

  // Contract: an operation in progress disables both items.
  it("should disable both items with the in-progress title during an operation", async () => {
    provideMerge({ state: mergeState });
    await renderPanel();
    rightClick(optionAt(1));
    for (const label of ["Cherry-pick commit", "Revert commit"]) {
      expect(menuItem(label)).toBeDisabled();
      expect(menuItem(label)).toHaveAttribute("title", IN_PROGRESS_TITLE);
    }
  });

  it("should disable both items while the operation state is still unknown", async () => {
    provideMerge({ state: undefined });
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem("Cherry-pick commit")).toBeDisabled();
    expect(menuItem("Revert commit")).toBeDisabled();
  });

  it("should disable both items while an integration action is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem("Cherry-pick commit")).toBeDisabled();
    expect(menuItem("Revert commit")).toBeDisabled();
  });

  // Contract: choosing an item runs the request with the full oid and closes the menu.
  it("should run a cherry-pick with the full oid when Cherry-pick commit is chosen", async () => {
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Cherry-pick commit"));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "cherryPick",
      oid: oidOf(1),
    });
  });

  it("should run a revert with the full oid when Revert commit is chosen", async () => {
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Revert commit"));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({ action: "revert", oid: oidOf(1) });
  });

  it("should close the menu after Cherry-pick commit", async () => {
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Cherry-pick commit"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should clear an earlier copy error when an integration item is chosen", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("clipboard denied"));
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Copy hash"));
    await screen.findByText(/clipboard denied/);
    rightClick(optionAt(1));
    await user.click(menuItem("Revert commit"));
    expect(screen.queryByText(/clipboard denied/)).toBeNull();
    expect(integrationRun).toHaveBeenCalledTimes(1);
  });

  it("should run nothing when a disabled item is clicked", async () => {
    parentsByIndex = { 1: twoParents(1) };
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Revert commit"));
    expect(integrationRun).not.toHaveBeenCalled();
  });

  // Contract: integration errors and pending share the panel slot.
  it("should show an integration error in the panel alert", async () => {
    provideMerge({ error: dirty });
    await renderPanel();
    expect(screen.getByRole("alert")).toHaveTextContent(dirty.message);
  });

  it("should show no alert when the integration has no error", async () => {
    await renderPanel();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should clear the integration error when Dismiss is pressed", async () => {
    provideMerge({ error: dirty });
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(integrationClear).toHaveBeenCalledTimes(1);
  });

  it("should be aria-busy while an integration action is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel();
    expect(screen.getByRole("region", { name: "Commit graph" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("should not be busy when the integration is idle", async () => {
    await renderPanel();
    expect(screen.getByRole("region", { name: "Commit graph" })).not.toHaveAttribute("aria-busy");
  });
});

// Coverage audit: rule precedence, every operation kind, shared pending and error hygiene.
describe("GraphPanel cherry-pick and revert gaps", () => {
  const message = { subject: "s", body: "" };
  const operations: OperationState[] = [
    { kind: "merge", head: oidOf(5), branch: "feature", message },
    {
      kind: "rebase",
      onto: oidOf(5),
      ontoName: "develop",
      branch: "topic",
      step: 1,
      total: 2,
      stoppedForEdit: false,
    },
    { kind: "cherryPick", oid: oidOf(5), message },
    { kind: "revert", oid: oidOf(5), message },
  ];
  const dirty: AppError = { kind: "operationFailed", message: "error: could not apply abc1234" };
  const twoParents = [oidOf(8), oidOf(9)];

  it.each(operations.map((state) => [state.kind, state] as const))(
    "should disable both items with the in-progress title during a %s",
    async (_kind, state) => {
      provideMerge({ state });
      await renderPanel();
      rightClick(optionAt(1));
      for (const label of ["Cherry-pick commit", "Revert commit"]) {
        expect(menuItem(label)).toBeDisabled();
        expect(menuItem(label)).toHaveAttribute("title", IN_PROGRESS_TITLE);
      }
    },
  );

  it("should prefer the in-progress title over the unsupported title on a merge commit", async () => {
    provideMerge({ state: operations[0] });
    parentsByIndex = { 1: twoParents };
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem("Cherry-pick commit")).toHaveAttribute("title", IN_PROGRESS_TITLE);
    expect(menuItem("Revert commit")).toHaveAttribute("title", IN_PROGRESS_TITLE);
  });

  it("should prefer the in-progress title over the already-here title on the HEAD commit", async () => {
    provideMerge({ state: operations[0] });
    await renderPanel();
    rightClick(optionAt(0));
    expect(menuItem("Cherry-pick commit")).toHaveAttribute("title", IN_PROGRESS_TITLE);
  });

  it("should keep Cherry-pick enabled on a commit that only carries another branch's label", async () => {
    refsByIndex = { 0: [ref("branch", "main", true)], 1: [ref("branch", "feature", false)] };
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem("Cherry-pick commit")).toBeEnabled();
  });

  it("should disable Revert on a merge commit that HEAD points at, with the unsupported title", async () => {
    parentsByIndex = { 0: twoParents };
    await renderPanel();
    rightClick(optionAt(0));
    expect(menuItem("Revert commit")).toHaveAttribute(
      "title",
      "Merge commits are not supported yet",
    );
  });

  it("should treat a commit with three parents as a merge commit", async () => {
    parentsByIndex = { 1: [oidOf(7), oidOf(8), oidOf(9)] };
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem("Revert commit")).toBeDisabled();
  });

  it("should run the request for the right-clicked row, not the selected one", async () => {
    const { user } = await renderPanel();
    await user.click(optionAt(0));
    rightClick(optionAt(2));
    await user.click(menuItem("Revert commit"));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({ action: "revert", oid: oidOf(2) });
  });

  // Contract: `pending` is shared, so an integration run locks the other menu items too.
  it("should disable every menu item while only the integration is pending", async () => {
    provideMerge({ pending: true });
    await renderPanel();
    rightClick(optionAt(1));
    expect(screen.getAllByRole("menuitem")).toHaveLength(7);
    for (const item of screen.getAllByRole("menuitem")) expect(item).toBeDisabled();
  });

  // Contract: errors share one slot ordered commit, integration, copy; Dismiss clears every source.
  it("should show the integration error ahead of a copy error", async () => {
    provideMerge({ error: dirty });
    vi.mocked(copyText).mockRejectedValue(new Error("clipboard denied"));
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Copy hash"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(dirty.message));
    expect(screen.queryByText(/clipboard denied/)).toBeNull();
  });

  it("should clear the integration error before running an integration item", async () => {
    provideMerge({ error: dirty });
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Cherry-pick commit"));
    expect(integrationClear).toHaveBeenCalledTimes(1);
    expect(integrationClear.mock.invocationCallOrder[0]).toBeLessThan(
      integrationRun.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("should clear the integration error when a dialog opens from the menu", async () => {
    provideMerge({ error: dirty });
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Reset to this commit…"));
    expect(integrationClear).toHaveBeenCalled();
  });

  it("should clear a copy error when Dismiss is pressed alongside an integration error", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("clipboard denied"));
    const { user } = await renderPanel();
    rightClick(optionAt(1));
    await user.click(menuItem("Copy hash"));
    await screen.findByText(/clipboard denied/);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(integrationClear).toHaveBeenCalledTimes(1);
  });
});

// Contract (spec 4.6): Rebase interactively from here… follows Revert commit and opens the plan dialog.
describe("GraphPanel rebase interactively", () => {
  const ITEM = "Rebase interactively from here…";
  const mergeState: OperationState = {
    kind: "merge",
    head: oidOf(5),
    branch: "feature",
    message: { subject: "Merge branch 'feature'", body: "" },
  };
  const detachedHead = (): BranchList => ({
    head: { kind: "detached", oid: oidOf(0) },
    local: [],
    remotes: [],
  });
  /** Waits until the branch list has landed so HEAD-dependent items are final. */
  async function renderWithHead() {
    const view = await renderPanel();
    await waitFor(() => expect(listBranches).toHaveBeenCalled());
    await act(async () => {});
    return view;
  }

  it("should enable the item with no title on an ancestor of a checked-out branch", async () => {
    await renderWithHead();
    rightClick(optionAt(1));
    expect(menuItem(ITEM)).toBeEnabled();
    expect(menuItem(ITEM)).not.toHaveAttribute("title");
  });

  it("should disable the item with Check out a branch first before the branch list loads", async () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => undefined));
    await renderPanel();
    rightClick(optionAt(1));
    expect(menuItem(ITEM)).toBeDisabled();
    expect(menuItem(ITEM)).toHaveAttribute("title", "Check out a branch first");
  });

  it("should place the item after Revert commit", async () => {
    await renderWithHead();
    rightClick(optionAt(1));
    const labels = screen.getAllByRole("menuitem").map((i) => i.textContent);
    expect(labels.indexOf(ITEM)).toBe(labels.indexOf("Revert commit") + 1);
  });

  it("should disable the item on the commit HEAD points at with the Already at HEAD title", async () => {
    await renderWithHead();
    rightClick(optionAt(0));
    expect(menuItem(ITEM)).toBeDisabled();
    expect(menuItem(ITEM)).toHaveAttribute("title", "Already at HEAD");
  });

  it("should disable the item with the Check out a branch first title on a detached HEAD", async () => {
    vi.mocked(listBranches).mockResolvedValue(detachedHead());
    await renderWithHead();
    rightClick(optionAt(1));
    expect(menuItem(ITEM)).toBeDisabled();
    expect(menuItem(ITEM)).toHaveAttribute("title", "Check out a branch first");
  });

  it("should prefer Check out a branch first over Already at HEAD on a detached HEAD", async () => {
    refsByIndex = { 0: [ref("head", "HEAD", true)] };
    vi.mocked(listBranches).mockResolvedValue(detachedHead());
    await renderWithHead();
    rightClick(optionAt(0));
    expect(menuItem(ITEM)).toHaveAttribute("title", "Check out a branch first");
  });

  it("should disable the item with the in-progress title during an operation", async () => {
    provideMerge({ state: mergeState });
    await renderWithHead();
    rightClick(optionAt(1));
    expect(menuItem(ITEM)).toBeDisabled();
    expect(menuItem(ITEM)).toHaveAttribute("title", IN_PROGRESS_TITLE);
  });

  it("should prefer the in-progress title over Already at HEAD", async () => {
    provideMerge({ state: mergeState });
    await renderWithHead();
    rightClick(optionAt(0));
    expect(menuItem(ITEM)).toHaveAttribute("title", IN_PROGRESS_TITLE);
  });

  it("should prefer the in-progress title over the detached HEAD title", async () => {
    provideMerge({ state: mergeState });
    vi.mocked(listBranches).mockResolvedValue(detachedHead());
    await renderWithHead();
    rightClick(optionAt(1));
    expect(menuItem(ITEM)).toHaveAttribute("title", IN_PROGRESS_TITLE);
  });

  it("should disable the item while an integration is pending", async () => {
    provideMerge({ pending: true });
    await renderWithHead();
    rightClick(optionAt(1));
    expect(menuItem(ITEM)).toBeDisabled();
  });

  it("should open no dialog when the disabled item is clicked", async () => {
    const { user } = await renderWithHead();
    rightClick(optionAt(0));
    await user.click(menuItem(ITEM));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rebasePlan).not.toHaveBeenCalled();
  });

  it("should open the dialog titled with the short oid when selected", async () => {
    const { user } = await renderWithHead();
    rightClick(optionAt(1));
    await user.click(menuItem(ITEM));
    expect(
      await screen.findByRole("dialog", {
        name: `Rebase main onto ${shortOf(oidOf(1))} interactively`,
      }),
    ).toBeInTheDocument();
  });

  it("should request the plan with the full oid of the chosen commit", async () => {
    const { user } = await renderWithHead();
    rightClick(optionAt(1));
    await user.click(menuItem(ITEM));
    await screen.findByRole("dialog");
    expect(rebasePlan).toHaveBeenCalledExactlyOnceWith(REPO, oidOf(1));
  });

  it("should close the menu when the item is selected", async () => {
    const { user } = await renderWithHead();
    rightClick(optionAt(1));
    await user.click(menuItem(ITEM));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("should close the dialog when Cancel is clicked", async () => {
    const { user } = await renderWithHead();
    rightClick(optionAt(1));
    await user.click(menuItem(ITEM));
    await screen.findByRole("dialog");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should start the rebase through the panel's integration run", async () => {
    vi.mocked(rebasePlan).mockResolvedValue([
      {
        oid: oidOf(2),
        subject: "Subject 2",
        author: { name: "Alice", email: "alice@x.io", time: 1 },
      },
    ]);
    const { user } = await renderWithHead();
    rightClick(optionAt(1));
    await user.click(menuItem(ITEM));
    await user.click(await screen.findByRole("button", { name: "Start rebase" }));
    expect(integrationRun).toHaveBeenCalledExactlyOnceWith({
      action: "rebaseInteractive",
      base: oidOf(1),
      steps: [{ action: "pick", oid: oidOf(2) }],
    });
  });

  it("should open the dialog clean by clearing an earlier integration error", async () => {
    provideMerge({ error: { kind: "operationFailed", message: "earlier failure" } });
    const { user } = await renderWithHead();
    rightClick(optionAt(1));
    await user.click(menuItem(ITEM));
    await screen.findByRole("dialog");
    expect(integrationClear).toHaveBeenCalled();
  });

  it("should offer the item on a merge commit row, leaving ancestry to the dialog", async () => {
    parentsByIndex = { 1: [oidOf(2), oidOf(3)] };
    await renderWithHead();
    rightClick(optionAt(1));
    expect(menuItem(ITEM)).toBeEnabled();
  });
});

// Contract: when a dialog closes and its opener cannot take focus, the Commit graph region does.
describe("GraphPanel focus fallback", () => {
  it("should focus the Commit graph region when Create branch here… is cancelled", async () => {
    const { user } = await renderPanel();
    rightClick(optionAt(0));
    await user.click(menuItem("Create branch here…"));
    const prompt = await screen.findByRole("dialog");
    expect(within(prompt).getByRole("textbox")).toHaveFocus();
    await user.click(within(prompt).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("region", { name: "Commit graph" })).toHaveFocus();
  });

  it("should keep focus in the dialog when the menu item that opened it is activated", async () => {
    const { user } = await renderPanel();
    rightClick(optionAt(0));
    await user.click(menuItem("Create branch here…"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("should mark the Commit graph region as a programmatic focus target", async () => {
    await renderPanel();
    const target = screen.getByRole("region", { name: "Commit graph" });
    expect(target).toHaveAttribute("data-focus-target");
    expect(target).toHaveAttribute("tabindex", "-1");
  });
});
