import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFileHistory, getLogSummary } from "../../lib/ipc";
import type { FileHistoryEntry } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useWorkspace } from "../../lib/store/workspace";
import { oidOf } from "../../test/graphFixtures";
import { historyEntry } from "../../test/historyFixtures";
import { mockWindow, scrollToIndex } from "../../test/mockVirtualizer";
import { renderWithProviders } from "../../test/renderWithProviders";
import { FileHistoryPanel } from "./FileHistoryPanel";
import { historyRowHeight } from "./HistoryRow";

vi.mock("@tanstack/react-virtual", () => import("../../test/mockVirtualizer"));

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getLogSummary: vi.fn(),
  getFileHistory: vi.fn(),
}));

const REPO = 1;
const PATH = "src/new.ts";
const scrolls = scrollToIndex as unknown as Mock<(...args: unknown[]) => void>;
const scrolledTo = (index: number) => scrolls.mock.calls.some((call) => call[0] === index);
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 30)));

// Newest first; the oldest entry is the file under its former name.
const ENTRIES: FileHistoryEntry[] = [
  historyEntry(0, { path: PATH }),
  historyEntry(1, { path: PATH, subject: "Rename it", oldPath: "src/old.ts" }),
  historyEntry(2, { path: "src/old.ts", subject: "Create it", change: "added" }),
];
const OTHER_ENTRIES: FileHistoryEntry[] = [
  historyEntry(5, { path: "other.ts", subject: "Other 5" }),
  historyEntry(6, { path: "other.ts", subject: "Other 6" }),
];

/** One page of history; null nextRow means the scan reached the end. */
const page = (entries: FileHistoryEntry[], nextRow: number | null = null) => ({
  entries,
  nextRow,
  followPath: PATH,
});
const many = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => historyEntry(from + i, { path: PATH }));

const summary = (generation = 1) => ({
  generation,
  total: 10,
  maxLanes: 1,
  complete: true,
  refreshing: false,
});

beforeEach(() => {
  vi.resetAllMocks();
  scrolls.mockReset();
  mockWindow.size = Infinity;
  mockWindow.start = 0;
  useWorkspace.setState(useWorkspace.getInitialState(), true);
  vi.mocked(getLogSummary).mockResolvedValue(summary());
  vi.mocked(getFileHistory).mockImplementation((_id, _generation, path) =>
    Promise.resolve(page(path === "other.ts" ? OTHER_ENTRIES : ENTRIES)),
  );
});

async function renderPanel(path = PATH) {
  const view = renderWithProviders(<FileHistoryPanel repoId={REPO} path={path} />);
  await screen.findAllByRole("option");
  return view;
}

const panel = () => screen.getByRole("region", { name: "File history" });
const listbox = () => screen.getByRole("listbox", { name: "File history" });
const optionAt = (n: number) => screen.getAllByRole("option")[n] as HTMLElement;
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(listbox(), { key, ...init });
const selectedCommit = () => useWorkspace.getState().selectedCommit[REPO];
const selectedFile = () => useWorkspace.getState().selected[REPO];
const lastOid = oidOf(2);

// Contract: a File history region whose header (History, path, Close) shows in every state.
describe("FileHistoryPanel header", () => {
  it("should render a File history region", async () => {
    await renderPanel();
    expect(panel()).toBeInTheDocument();
  });

  it("should head the panel with History", async () => {
    await renderPanel();
    expect(within(panel()).getByRole("heading", { name: "History" })).toBeInTheDocument();
  });

  it("should show the path with the full path as its title", async () => {
    await renderPanel();
    expect(within(panel()).getByText(PATH)).toHaveAttribute("title", PATH);
  });

  it("should close the panel when Close file history is clicked", async () => {
    useWorkspace.getState().showHistory(REPO, PATH);
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Close file history" }));
    expect(useWorkspace.getState().historyPath[REPO]).toBeNull();
  });

  it("should label the close button Close", async () => {
    await renderPanel();
    expect(screen.getByRole("button", { name: "Close file history" })).toHaveTextContent("Close");
  });

  it("should show the header while the summary loads", () => {
    vi.mocked(getLogSummary).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    expect(screen.getByText(PATH)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close file history" })).toBeInTheDocument();
  });

  it("should show the header while the history loads", async () => {
    vi.mocked(getFileHistory).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    await waitFor(() => expect(getFileHistory).toHaveBeenCalled());
    expect(screen.getByText(PATH)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close file history" })).toBeInTheDocument();
  });

  it("should show the header for an empty history", async () => {
    vi.mocked(getFileHistory).mockResolvedValue(page([]));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    await screen.findByText("No commits touch this file");
    expect(screen.getByText(PATH)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close file history" })).toBeInTheDocument();
  });

  it("should show the header on an error", async () => {
    vi.mocked(getFileHistory).mockRejectedValue({ kind: "git", message: "history boom" });
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    await screen.findByRole("alert");
    expect(screen.getByText(PATH)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close file history" })).toBeInTheDocument();
  });
});

// Contract: the log summary's generation keys the file-history request.
describe("FileHistoryPanel data", () => {
  it("should request the log summary for the repo", async () => {
    await renderPanel();
    expect(getLogSummary).toHaveBeenCalledWith(REPO);
  });

  it("should request the history under the summary's generation and the path", async () => {
    vi.mocked(getLogSummary).mockResolvedValue(summary(9));
    await renderPanel();
    expect(getFileHistory).toHaveBeenCalledExactlyOnceWith(REPO, 9, PATH, 0, 100, null);
  });

  it("should not request the history before the summary arrives", async () => {
    vi.mocked(getLogSummary).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    await settle();
    expect(getFileHistory).not.toHaveBeenCalled();
  });
});

// Contract: Loading history…, No commits touch this file, and a stale history reads as loading.
describe("FileHistoryPanel states", () => {
  it("should show Loading history… with role status while the summary is pending", () => {
    vi.mocked(getLogSummary).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading history…");
  });

  it("should show Loading history… while the history is pending", async () => {
    vi.mocked(getFileHistory).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Loading history…");
  });

  it("should not show the loading status once loaded", async () => {
    await renderPanel();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("should show No commits touch this file for an empty history", async () => {
    vi.mocked(getFileHistory).mockResolvedValue(page([]));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    expect(await screen.findByText("No commits touch this file")).toBeInTheDocument();
  });

  it("should render no listbox options for an empty history", async () => {
    vi.mocked(getFileHistory).mockResolvedValue(page([]));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    await screen.findByText("No commits touch this file");
    expect(screen.queryAllByRole("option")).toEqual([]);
  });

  it("should show Loading history…, not an error, while the history is stale", async () => {
    vi.mocked(getFileHistory).mockRejectedValue({
      kind: "logStale",
      message: "generation is gone",
    });
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    await waitFor(() => expect(getFileHistory).toHaveBeenCalled());
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("Loading history…");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: a listbox of rows, one per entry, with the current commit active.
describe("FileHistoryPanel rows", () => {
  it("should render one option per entry", async () => {
    await renderPanel();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("should show each entry's subject in order", async () => {
    await renderPanel();
    expect(optionAt(0)).toHaveTextContent("Subject 0");
    expect(optionAt(1)).toHaveTextContent("Rename it");
    expect(optionAt(2)).toHaveTextContent("Create it");
  });

  it("should render the listbox as focusable", async () => {
    await renderPanel();
    expect(listbox()).toHaveAttribute("tabindex", "0");
  });

  it("should suppress the native context menu on the listbox", async () => {
    await renderPanel();
    expect(fireEvent.contextMenu(listbox())).toBe(false);
  });

  it("should mark the selected commit's row with aria-selected", async () => {
    await renderPanel();
    await waitFor(() => expect(optionAt(0)).toHaveAttribute("aria-selected", "true"));
    expect(optionAt(1)).toHaveAttribute("aria-selected", "false");
  });

  it("should point aria-activedescendant at the selected row", async () => {
    await renderPanel();
    await waitFor(() => expect(optionAt(0)).toHaveAttribute("aria-selected", "true"));
    expect(listbox().getAttribute("aria-activedescendant")).toBe(optionAt(0).id);
  });

  it("should omit aria-activedescendant while no row is selected", async () => {
    await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    act(() => useWorkspace.getState().selectCommit(REPO, null));
    await waitFor(() => expect(listbox()).not.toHaveAttribute("aria-activedescendant"));
  });

  it("should size a renamed entry's item taller than a plain one", async () => {
    await renderPanel();
    const plain = optionAt(0).parentElement as HTMLElement;
    const renamed = optionAt(1).parentElement as HTMLElement;
    expect(plain.style.height).toBe(`${historyRowHeight(ENTRIES[0])}px`);
    expect(renamed.style.height).toBe(`${historyRowHeight(ENTRIES[1])}px`);
    expect(historyRowHeight(ENTRIES[1])).toBeGreaterThan(historyRowHeight(ENTRIES[0]));
  });
});

// Contract: on first load the first entry is selected, once per path, unless the selection is in the list.
describe("FileHistoryPanel auto-select", () => {
  it("should select the first entry's commit on first load", async () => {
    await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
  });

  it("should select the first entry's file with its own path and commit scope", async () => {
    await renderPanel();
    await waitFor(() =>
      expect(selectedFile()).toEqual({ path: PATH, scope: { commit: oidOf(0) } }),
    );
  });

  it("should select nothing when the selected commit is already in the list", async () => {
    useWorkspace.getState().selectCommit(REPO, oidOf(2));
    await renderPanel();
    await settle();
    expect(selectedCommit()).toBe(oidOf(2));
    expect(selectedFile()).toBeUndefined();
  });

  it("should select the first entry when the selected commit is not in the list", async () => {
    useWorkspace.getState().selectCommit(REPO, oidOf(40));
    await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
  });

  it("should select nothing for an empty list", async () => {
    vi.mocked(getFileHistory).mockResolvedValue(page([]));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    await screen.findByText("No commits touch this file");
    await settle();
    expect(selectedCommit()).toBeUndefined();
    expect(selectedFile()).toBeUndefined();
  });

  it("should not select again when a new log generation produces a new list", async () => {
    const { queryClient } = await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    act(() => useWorkspace.getState().selectCommit(REPO, null));
    vi.mocked(getLogSummary).mockResolvedValue(summary(2));
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.log(REPO) }));
    await waitFor(() => expect(getFileHistory).toHaveBeenCalledWith(REPO, 2, PATH, 0, 100, null));
    await settle();
    expect(selectedCommit()).toBeNull();
  });

  it("should not select twice for the same path", async () => {
    await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    act(() => useWorkspace.getState().selectCommit(REPO, null));
    await settle();
    expect(selectedCommit()).toBeNull();
  });

  it("should auto-select again when the path changes", async () => {
    const view = await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    view.rerender(<FileHistoryPanel repoId={REPO} path="other.ts" />);
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(5)));
    expect(selectedFile()).toEqual({ path: "other.ts", scope: { commit: oidOf(5) } });
  });
});

// Contract: clicking a row, or Enter, ArrowUp/Down, Home/End, selects the commit and its file.
describe("FileHistoryPanel selection", () => {
  it("should select the commit and the entry's own path when a row is clicked", async () => {
    await renderPanel();
    fireEvent.click(optionAt(2));
    expect(selectedCommit()).toBe(lastOid);
    expect(selectedFile()).toEqual({ path: "src/old.ts", scope: { commit: lastOid } });
  });

  it("should move the selection to the clicked row", async () => {
    await renderPanel();
    fireEvent.click(optionAt(1));
    await waitFor(() => expect(optionAt(1)).toHaveAttribute("aria-selected", "true"));
    expect(optionAt(0)).toHaveAttribute("aria-selected", "false");
  });

  it("should select the next entry on ArrowDown", async () => {
    await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    press("ArrowDown");
    expect(selectedCommit()).toBe(oidOf(1));
    expect(selectedFile()).toEqual({ path: PATH, scope: { commit: oidOf(1) } });
  });

  it("should select the previous entry on ArrowUp", async () => {
    await renderPanel();
    fireEvent.click(optionAt(2));
    press("ArrowUp");
    expect(selectedCommit()).toBe(oidOf(1));
  });

  it("should stay on the last entry on ArrowDown at the end", async () => {
    await renderPanel();
    fireEvent.click(optionAt(2));
    press("ArrowDown");
    expect(selectedCommit()).toBe(lastOid);
  });

  it("should stay on the first entry on ArrowUp at the start", async () => {
    await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    press("ArrowUp");
    expect(selectedCommit()).toBe(oidOf(0));
  });

  it("should select the first entry on Home", async () => {
    await renderPanel();
    fireEvent.click(optionAt(2));
    press("Home");
    expect(selectedCommit()).toBe(oidOf(0));
  });

  it("should select the last entry on End", async () => {
    await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    press("End");
    expect(selectedCommit()).toBe(lastOid);
  });

  it("should scroll the new row into view on ArrowDown", async () => {
    await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    press("ArrowDown");
    expect(scrolledTo(1)).toBe(true);
  });

  it("should scroll to the last row on End", async () => {
    await renderPanel();
    press("End");
    expect(scrolledTo(2)).toBe(true);
  });

  it("should scroll to the first row on Home", async () => {
    await renderPanel();
    fireEvent.click(optionAt(2));
    press("Home");
    expect(scrolledTo(0)).toBe(true);
  });

  it("should start at the first entry on ArrowDown when nothing is selected", async () => {
    await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    act(() => useWorkspace.getState().selectCommit(REPO, null));
    press("ArrowDown");
    expect(selectedCommit()).toBe(oidOf(0));
  });

  it("should select the active entry's file again on Enter", async () => {
    useWorkspace.getState().selectCommit(REPO, oidOf(1));
    await renderPanel();
    press("Enter");
    expect(selectedFile()).toEqual({ path: PATH, scope: { commit: oidOf(1) } });
  });

  it("should select the first entry on Enter when nothing is selected", async () => {
    await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    act(() => useWorkspace.getState().selectCommit(REPO, null));
    press("Enter");
    expect(selectedCommit()).toBe(oidOf(0));
  });

  it("should prevent the default action of the keys it handles", async () => {
    await renderPanel();
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "Enter"]) {
      expect(press(key), key).toBe(false);
    }
  });

  it("should leave other keys alone", async () => {
    await renderPanel();
    expect(press("a")).toBe(true);
  });
});

// Contract: Escape closes the panel from anywhere inside it.
describe("FileHistoryPanel Escape", () => {
  it("should close the panel on Escape in the listbox", async () => {
    useWorkspace.getState().showHistory(REPO, PATH);
    await renderPanel();
    press("Escape");
    expect(useWorkspace.getState().historyPath[REPO]).toBeNull();
  });

  it("should close the panel on Escape in the Close button", async () => {
    useWorkspace.getState().showHistory(REPO, PATH);
    await renderPanel();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close file history" }), {
      key: "Escape",
    });
    expect(useWorkspace.getState().historyPath[REPO]).toBeNull();
  });

  it("should not close the panel on other keys", async () => {
    useWorkspace.getState().showHistory(REPO, PATH);
    await renderPanel();
    press("ArrowDown");
    expect(useWorkspace.getState().historyPath[REPO]).toBe(PATH);
  });
});

// Contract: a history failure shows RepoError with Retry; a summary failure does too.
describe("FileHistoryPanel errors", () => {
  it("should show the history error in an alert", async () => {
    vi.mocked(getFileHistory).mockRejectedValue({ kind: "git", message: "history boom" });
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("history boom");
  });

  it("should fetch the history again when Retry is clicked", async () => {
    vi.mocked(getFileHistory).mockRejectedValueOnce({ kind: "git", message: "history boom" });
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    fireEvent.click(
      await within(await screen.findByRole("alert")).findByRole("button", { name: "Retry" }),
    );
    expect(await screen.findAllByRole("option")).toHaveLength(3);
    expect(getFileHistory).toHaveBeenCalledTimes(2);
  });

  it("should close the panel when Dismiss is clicked", async () => {
    useWorkspace.getState().showHistory(REPO, PATH);
    vi.mocked(getFileHistory).mockRejectedValue({ kind: "git", message: "history boom" });
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(useWorkspace.getState().historyPath[REPO]).toBeNull();
  });

  it("should show the summary error in an alert instead of loading forever", async () => {
    vi.mocked(getLogSummary).mockRejectedValue({ kind: "git", message: "summary boom" });
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("summary boom");
    expect(screen.queryByText("Loading history…")).toBeNull();
  });

  it("should fetch the summary again when Retry is clicked on a summary error", async () => {
    vi.mocked(getLogSummary).mockRejectedValueOnce({ kind: "git", message: "summary boom" });
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    fireEvent.click(
      await within(await screen.findByRole("alert")).findByRole("button", { name: "Retry" }),
    );
    expect(await screen.findAllByRole("option")).toHaveLength(3);
    expect(getLogSummary).toHaveBeenCalledTimes(2);
  });

  it("should close the panel when Dismiss is clicked on a summary error", async () => {
    useWorkspace.getState().showHistory(REPO, PATH);
    vi.mocked(getLogSummary).mockRejectedValue({ kind: "git", message: "summary boom" });
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(useWorkspace.getState().historyPath[REPO]).toBeNull();
  });
});

// Contract: with a single entry every navigation key lands on it; an empty list has no listbox.
describe("FileHistoryPanel with one entry", () => {
  const ONE = [ENTRIES[0]];
  const renderOne = async () => {
    vi.mocked(getFileHistory).mockResolvedValue(page(ONE));
    const view = await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    return view;
  };

  it.each(["Home", "End", "ArrowDown", "ArrowUp", "Enter"])(
    "should stay on the only entry on %s",
    async (key) => {
      await renderOne();
      press(key);
      expect(selectedCommit()).toBe(oidOf(0));
      expect(selectedFile()).toEqual({ path: PATH, scope: { commit: oidOf(0) } });
    },
  );

  it("should scroll to index 0 on End", async () => {
    await renderOne();
    press("End");
    expect(scrolledTo(0)).toBe(true);
  });

  it("should offer no listbox to navigate for an empty history", async () => {
    vi.mocked(getFileHistory).mockResolvedValue(page([]));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    await screen.findByText("No commits touch this file");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(panel(), { key: "End" });
    expect(selectedCommit()).toBeUndefined();
  });
});

// Contract: auto-select is once per path; the user's later choice survives a new generation.
describe("FileHistoryPanel auto-select after the user chooses", () => {
  it("should keep another commit the user selected across a new log generation", async () => {
    const { queryClient } = await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    fireEvent.click(optionAt(2));
    expect(selectedCommit()).toBe(oidOf(2));
    vi.mocked(getLogSummary).mockResolvedValue(summary(2));
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.log(REPO) }));
    await waitFor(() => expect(getFileHistory).toHaveBeenCalledWith(REPO, 2, PATH, 0, 100, null));
    await settle();
    expect(selectedCommit()).toBe(oidOf(2));
    expect(selectedFile()).toEqual({ path: "src/old.ts", scope: { commit: oidOf(2) } });
  });

  it("should not auto-select again when the same path is shown again after another path", async () => {
    const view = await renderPanel();
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(0)));
    view.rerender(<FileHistoryPanel repoId={REPO} path="other.ts" />);
    await waitFor(() => expect(selectedCommit()).toBe(oidOf(5)));
    fireEvent.click(screen.getAllByRole("option")[1]);
    await settle();
    expect(selectedCommit()).toBe(oidOf(6));
  });
});

// Contract: the history loads in pages. Short histories keep fetching until at least
// FILE_HISTORY_MIN_LOADED entries are loaded or none remain, reaching the end of the list
// fetches the next page, a page in flight shows Loading more…, and an incomplete graph
// reads Loading history….
describe("FileHistoryPanel pages", () => {
  it("should keep fetching until at least 100 entries are loaded or none remain", async () => {
    // A viewport of ten rows, so reaching the end of the list does not fetch on its own.
    mockWindow.size = 10;
    vi.mocked(getFileHistory)
      .mockResolvedValueOnce(page(many(60), 700))
      .mockResolvedValueOnce(page(many(30, 60), 1400))
      .mockResolvedValueOnce(page(many(20, 90), 2100))
      .mockResolvedValue(page(many(5, 110)));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    await waitFor(() => expect(getFileHistory).toHaveBeenCalledTimes(3));
    expect(getFileHistory).toHaveBeenNthCalledWith(2, REPO, 1, PATH, 700, 100, PATH);
    expect(getFileHistory).toHaveBeenNthCalledWith(3, REPO, 1, PATH, 1400, 100, PATH);
    await settle();
    // 110 entries are loaded, so the fourth page waits for the end of the list.
    expect(getFileHistory).toHaveBeenCalledTimes(3);
  });

  it("should stop fetching once no page remains", async () => {
    mockWindow.size = 10;
    vi.mocked(getFileHistory)
      .mockResolvedValueOnce(page(many(10), 700))
      .mockResolvedValueOnce(page(many(5, 10)));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    await waitFor(() => expect(getFileHistory).toHaveBeenCalledTimes(2));
    await settle();
    expect(getFileHistory).toHaveBeenCalledTimes(2);
  });

  it("should show Loading more… while a further page is in flight", async () => {
    vi.mocked(getFileHistory)
      .mockResolvedValueOnce(page(many(60), 700))
      .mockReturnValueOnce(new Promise(() => undefined));
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    expect(await screen.findByText("Loading more…")).toHaveRole("status");
    expect(screen.getAllByRole("option")).toHaveLength(60);
  });

  it("should not show Loading more… once the pages have arrived", async () => {
    await renderPanel();
    await settle();
    expect(screen.queryByText("Loading more…")).toBeNull();
  });

  it("should fetch more when the end of the list is reached", async () => {
    mockWindow.size = 10;
    vi.mocked(getFileHistory)
      .mockResolvedValueOnce(page(many(150), 900))
      .mockResolvedValue(page(many(5, 150)));
    await renderPanel();
    await settle();
    expect(getFileHistory).toHaveBeenCalledOnce();
    // The window scrolls to the last entries; any re-render reports it.
    act(() => {
      mockWindow.start = 140;
      useWorkspace.getState().selectCommit(REPO, oidOf(145));
    });
    await waitFor(() =>
      expect(getFileHistory).toHaveBeenLastCalledWith(REPO, 1, PATH, 900, 100, PATH),
    );
  });

  it("should show Loading history… while the graph is incomplete", async () => {
    vi.mocked(getLogSummary).mockResolvedValue({ ...summary(), complete: false });
    renderWithProviders(<FileHistoryPanel repoId={REPO} path={PATH} />);
    await waitFor(() => expect(getLogSummary).toHaveBeenCalled());
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("Loading history…");
    expect(getFileHistory).not.toHaveBeenCalled();
  });
});
