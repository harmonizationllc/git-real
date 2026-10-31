import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFileHistory } from "../../lib/ipc";
import type { FileHistoryEntry } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { historyEntry } from "../../test/historyFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { FILE_HISTORY_PAGE, useFileHistory } from "./useFileHistory";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getFileHistory: vi.fn(),
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const stale = { kind: "logStale", message: "generation is gone" };
const page = (
  entries: FileHistoryEntry[],
  nextRow: number | null = null,
  followPath = "a.txt",
) => ({
  entries,
  nextRow,
  followPath,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFileHistory).mockResolvedValue(page([historyEntry(0)]));
});

// Contract: a file's history under a log generation, fetched once, immutable.
describe("useFileHistory", () => {
  it("should call getFileHistory with the repo id, generation and path", async () => {
    renderHookWithProviders(() => useFileHistory(3, 7, "src/a.ts", true));
    await waitFor(() =>
      expect(getFileHistory).toHaveBeenCalledExactlyOnceWith(
        3,
        7,
        "src/a.ts",
        0,
        FILE_HISTORY_PAGE,
        null,
      ),
    );
  });

  it("should expose the entries once loaded", async () => {
    const { result } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    await waitFor(() => expect(result.current.entries).toEqual([historyEntry(0)]));
  });

  it("should report isLoading until the entries arrive", async () => {
    const { result } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it("should not fetch while the generation is undefined", async () => {
    const { result } = renderHookWithProviders(() => useFileHistory(1, undefined, "a.txt", true));
    await settle();
    expect(getFileHistory).not.toHaveBeenCalled();
    expect(result.current.entries).toBeUndefined();
  });

  it("should fetch once the generation becomes known", async () => {
    let generation = undefined as number | undefined;
    const { rerender } = renderHookWithProviders(() =>
      useFileHistory(1, generation, "a.txt", true),
    );
    await settle();
    generation = 4;
    rerender();
    await waitFor(() =>
      expect(getFileHistory).toHaveBeenCalledWith(1, 4, "a.txt", 0, FILE_HISTORY_PAGE, null),
    );
  });

  it("should fetch under the new generation when the generation changes", async () => {
    let generation = 7;
    const { rerender } = renderHookWithProviders(() =>
      useFileHistory(1, generation, "a.txt", true),
    );
    await waitFor(() =>
      expect(getFileHistory).toHaveBeenCalledWith(1, 7, "a.txt", 0, FILE_HISTORY_PAGE, null),
    );
    generation = 8;
    rerender();
    await waitFor(() =>
      expect(getFileHistory).toHaveBeenCalledWith(1, 8, "a.txt", 0, FILE_HISTORY_PAGE, null),
    );
  });

  it("should fetch for the new path when the path changes", async () => {
    let path = "a.txt";
    const { rerender } = renderHookWithProviders(() => useFileHistory(1, 7, path, true));
    await waitFor(() =>
      expect(getFileHistory).toHaveBeenCalledWith(1, 7, "a.txt", 0, FILE_HISTORY_PAGE, null),
    );
    path = "b.txt";
    rerender();
    await waitFor(() =>
      expect(getFileHistory).toHaveBeenCalledWith(1, 7, "b.txt", 0, FILE_HISTORY_PAGE, null),
    );
  });

  it("should cache under queryKeys.fileHistory as immutable data", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useFileHistory(1, 7, "a.txt", true),
    );
    await waitFor(() => expect(result.current.entries).toBeDefined());
    const query = queryClient
      .getQueryCache()
      .find({ queryKey: queryKeys.fileHistory(1, 7, "a.txt") });
    expect(query?.observers[0]?.options.staleTime).toBe(Infinity);
  });
});

// Contract: failures surface as an AppError and refetch tries again.
describe("useFileHistory errors", () => {
  it("should expose an AppError rejection as error", async () => {
    vi.mocked(getFileHistory).mockRejectedValue({ kind: "git", message: "history boom" });
    const { result } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    await waitFor(() =>
      expect(result.current.error).toEqual({ kind: "git", message: "history boom" }),
    );
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(getFileHistory).mockRejectedValue(new Error("plain"));
    const { result } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "plain" }));
  });

  it("should not invalidate the log for an error other than logStale", async () => {
    vi.mocked(getFileHistory).mockRejectedValue({ kind: "git", message: "history boom" });
    const { result, queryClient } = renderHookWithProviders(() =>
      useFileHistory(1, 7, "a.txt", true),
    );
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(spy).not.toHaveBeenCalled();
  });

  it("should fetch again when refetch is called", async () => {
    vi.mocked(getFileHistory).mockRejectedValueOnce({ kind: "git", message: "history boom" });
    const { result } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    result.current.refetch();
    await waitFor(() => expect(result.current.entries).toEqual([historyEntry(0)]));
    expect(getFileHistory).toHaveBeenCalledTimes(2);
  });
});

// Contract (same rule as useLogPages): a stale generation invalidates the log once, never retries,
// never shows an error, and reads as loading until the new generation arrives.
describe("useFileHistory logStale", () => {
  it("should invalidate queryKeys.log exactly once", async () => {
    vi.mocked(getFileHistory).mockRejectedValue(stale);
    const { queryClient } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.log(1) }));
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("should call getFileHistory once per generation and not retry", async () => {
    vi.mocked(getFileHistory).mockRejectedValue(stale);
    const { queryClient } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await settle();
    expect(getFileHistory).toHaveBeenCalledTimes(1);
  });

  it("should hide the stale error", async () => {
    vi.mocked(getFileHistory).mockRejectedValue(stale);
    const { result, queryClient } = renderHookWithProviders(() =>
      useFileHistory(1, 7, "a.txt", true),
    );
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await settle();
    expect(result.current.error).toBeNull();
  });

  it("should read as loading while stale", async () => {
    vi.mocked(getFileHistory).mockRejectedValue(stale);
    const { result, queryClient } = renderHookWithProviders(() =>
      useFileHistory(1, 7, "a.txt", true),
    );
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await settle();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.entries).toBeUndefined();
  });

  it("should not invalidate again on a rerender with the same generation", async () => {
    vi.mocked(getFileHistory).mockRejectedValue(stale);
    const { rerender, queryClient } = renderHookWithProviders(() =>
      useFileHistory(1, 7, "a.txt", true),
    );
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    rerender();
    rerender();
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("should invalidate again when a newer generation is also stale", async () => {
    vi.mocked(getFileHistory).mockRejectedValue(stale);
    let generation = 7;
    const { rerender, queryClient } = renderHookWithProviders(() =>
      useFileHistory(1, generation, "a.txt", true),
    );
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    generation = 8;
    rerender();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});

// Contract: the history arrives in pages of FILE_HISTORY_PAGE entries behind a resumable
// cursor (nextRow, followPath), flattened into entries; nothing is fetched until the graph is
// complete.
describe("useFileHistory pages", () => {
  it("should call getFileHistory with startRow 0, FILE_HISTORY_PAGE and a null followPath first", async () => {
    renderHookWithProviders(() => useFileHistory(3, 4, "a.txt", true));
    await waitFor(() =>
      expect(getFileHistory).toHaveBeenCalledExactlyOnceWith(3, 4, "a.txt", 0, 100, null),
    );
    expect(FILE_HISTORY_PAGE).toBe(100);
  });

  it("should flatten pages into entries and report hasMore from nextRow", async () => {
    vi.mocked(getFileHistory)
      .mockResolvedValueOnce(page([historyEntry(0), historyEntry(1)], 700, "old.txt"))
      .mockResolvedValueOnce(page([historyEntry(2)]));
    const { result } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    expect(result.current.entries).toEqual([historyEntry(0), historyEntry(1)]);
    act(() => result.current.fetchMore());
    await waitFor(() =>
      expect(result.current.entries).toEqual([historyEntry(0), historyEntry(1), historyEntry(2)]),
    );
    expect(result.current.hasMore).toBe(false);
  });

  it("should pass nextRow and followPath to the following call on fetchMore", async () => {
    vi.mocked(getFileHistory)
      .mockResolvedValueOnce(page([historyEntry(0)], 700, "old.txt"))
      .mockResolvedValueOnce(page([historyEntry(1)]));
    const { result } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.fetchMore());
    await waitFor(() =>
      expect(getFileHistory).toHaveBeenLastCalledWith(1, 7, "a.txt", 700, 100, "old.txt"),
    );
  });

  it("should report isFetchingMore while a further page is in flight", async () => {
    vi.mocked(getFileHistory)
      .mockResolvedValueOnce(page([historyEntry(0)], 700))
      .mockReturnValueOnce(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    expect(result.current.isFetchingMore).toBe(false);
    act(() => result.current.fetchMore());
    await waitFor(() => expect(result.current.isFetchingMore).toBe(true));
  });

  it("should not start a second fetch while one is in flight", async () => {
    vi.mocked(getFileHistory)
      .mockResolvedValueOnce(page([historyEntry(0)], 700))
      .mockReturnValueOnce(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => {
      result.current.fetchMore();
      result.current.fetchMore();
    });
    await settle();
    expect(getFileHistory).toHaveBeenCalledTimes(2);
  });

  it("should not fetch while the graph is incomplete", async () => {
    const { result } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", false));
    await settle();
    expect(getFileHistory).not.toHaveBeenCalled();
    expect(result.current.entries).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });

  it("should fetch once the graph becomes complete", async () => {
    let complete = false;
    const { rerender } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", complete));
    await settle();
    complete = true;
    rerender();
    await waitFor(() => expect(getFileHistory).toHaveBeenCalledOnce());
  });

  it("should report hasMore false after a further page fails", async () => {
    vi.mocked(getFileHistory)
      .mockResolvedValueOnce(page([historyEntry(0)], 700))
      .mockRejectedValue({ kind: "logStale", message: "generation is gone" });
    const { result } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.fetchMore());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    act(() => result.current.fetchMore());
    await settle();
    expect(getFileHistory).toHaveBeenCalledTimes(2);
  });

  it("should report hasMore false when nextRow is null", async () => {
    const { result } = renderHookWithProviders(() => useFileHistory(1, 7, "a.txt", true));
    await waitFor(() => expect(result.current.entries).toBeDefined());
    expect(result.current.hasMore).toBe(false);
  });

  it("should store the pages under queryKeys.fileHistory", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useFileHistory(1, 7, "a.txt", true),
    );
    await waitFor(() => expect(result.current.entries).toBeDefined());
    expect(queryClient.getQueryData(queryKeys.fileHistory(1, 7, "a.txt"))).toEqual({
      pages: [page([historyEntry(0)])],
      pageParams: [{ startRow: 0, followPath: null }],
    });
  });
});
