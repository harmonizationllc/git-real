import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkoutCommit,
  copyText,
  createBranch,
  getLogPage,
  getLogSummary,
  listBranches,
  resetToCommit,
  searchLog,
} from "../../lib/ipc";
import type { BranchList, LogSummary, RefLabel } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useWorkspace } from "../../lib/store/workspace";
import { makeRow, oidOf, ref, shortOf } from "../../test/graphFixtures";
import { scrollToIndex } from "../../test/mockVirtualizer";
import { renderWithProviders } from "../../test/renderWithProviders";
import { GraphPanel } from "./GraphPanel";
import { gutterWidth } from "./model/edges";

vi.mock("@tanstack/react-virtual", () => import("../../test/mockVirtualizer"));

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getLogSummary: vi.fn(),
  getLogPage: vi.fn(),
  searchLog: vi.fn(),
  checkoutCommit: vi.fn(),
  resetToCommit: vi.fn(),
  createBranch: vi.fn(),
  listBranches: vi.fn(),
  copyText: vi.fn(),
}));

const REPO = 1;
const scrolls = scrollToIndex as unknown as Mock<(...args: unknown[]) => void>;
const scrolledTo = (index: number) => scrolls.mock.calls.some((call) => call[0] === index);

let total = 3;
let refsByIndex: Record<number, RefLabel[]> = {};

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
  total = 3;
  refsByIndex = { 0: [ref("branch", "main", true)] };
  useWorkspace.setState({ selected: {}, selectedCommit: {} });
  vi.mocked(getLogSummary).mockImplementation(() => Promise.resolve(summary()));
  vi.mocked(getLogPage).mockImplementation((_id, _generation, start, count) =>
    Promise.resolve({
      start,
      rows: Array.from({ length: Math.max(0, Math.min(count, total - start)) }, (_, i) =>
        makeRow(start + i, { refs: refsByIndex[start + i] ?? [] }),
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
});

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

  it("should keep the active row selected when Enter is pressed", async () => {
    await renderPanel();
    choose(1);
    press("Enter");
    expect(selectedOid()).toBe(oidOf(1));
    expect(optionAt(1)).toHaveAttribute("aria-selected", "true");
  });

  it("should not select anything when Enter is pressed without a selection", async () => {
    await renderPanel();
    press("Enter");
    expect(selectedOid()).toBeUndefined();
  });

  it("should ignore unrelated keys", async () => {
    await renderPanel();
    fireEvent.click(optionAt(1));
    press("a");
    expect(selectedOid()).toBe(oidOf(1));
  });
});

// Contract (Review Focus 5): an off-screen selection is resolved through searchLog and centred once.
describe("GraphPanel reveal", () => {
  const far = oidOf(900);

  it("should reveal an off-screen selection through searchLog", async () => {
    vi.mocked(searchLog).mockResolvedValue([900]);
    await renderPanel();
    act(() => useWorkspace.getState().selectCommit(REPO, far));
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalledWith(900, { align: "center" }));
    expect(searchLog).toHaveBeenCalledExactlyOnceWith(REPO, 1, far);
    expect(scrollToIndex).toHaveBeenCalledOnce();
  });

  it("should not scroll when the oid cannot be found", async () => {
    vi.mocked(searchLog).mockResolvedValue([]);
    await renderPanel();
    act(() => useWorkspace.getState().selectCommit(REPO, far));
    await waitFor(() => expect(searchLog).toHaveBeenCalledOnce());
    await act(async () => undefined);
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

  it("should not search again for the same off-screen selection after a rerender", async () => {
    vi.mocked(searchLog).mockResolvedValue([900]);
    const { rerender } = await renderPanel();
    act(() => useWorkspace.getState().selectCommit(REPO, far));
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalled());
    rerender(<GraphPanel repoId={REPO} />);
    await act(async () => undefined);
    expect(searchLog).toHaveBeenCalledOnce();
  });

  it("should select an off-screen commit chosen elsewhere in the listbox", async () => {
    vi.mocked(searchLog).mockResolvedValue([900]);
    await renderPanel();
    act(() => useWorkspace.getState().selectCommit(REPO, far));
    await waitFor(() => expect(scrollToIndex).toHaveBeenCalled());
    expect(selectedOid()).toBe(far);
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

// Contract: the row context menu, its labels, titles and enabled states.
describe("GraphPanel context menu", () => {
  it("should list the four items in order on right-click", async () => {
    await renderPanel();
    rightClick(optionAt(1));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Checkout",
      "Create branch here…",
      "Reset to this commit…",
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

  it("should not open a menu with F10 alone", async () => {
    await renderPanel();
    choose(1);
    press("F10");
    expect(screen.queryByRole("menu")).toBeNull();
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

  it("should not call createBranch when the dialog is cancelled", async () => {
    const { dialog, user } = await openCreate();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(createBranch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
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
    const group = within(dialog).getByRole("radiogroup", { name: "Mode" });
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

  it("should show a failed reset in an alert", async () => {
    vi.mocked(resetToCommit).mockRejectedValue({ kind: "git", message: "reset exploded" });
    const { dialog, user } = await openReset();
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));
    expect(await screen.findByText("reset exploded")).toBeInTheDocument();
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
    await waitFor(() => expect(listbox().closest("[aria-busy='true']")).not.toBeNull());
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
    await waitFor(() => expect(listbox().closest("[aria-busy='true']")).not.toBeNull());
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
