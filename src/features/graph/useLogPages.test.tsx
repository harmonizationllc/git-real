import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogPage } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { makeRow } from "../../test/graphFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { LOG_PAGE_GC_MS, logPageOptions, useLogPages } from "./useLogPages";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getLogPage: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getLogPage).mockImplementation((_id, _generation, start, count) =>
    Promise.resolve({
      start,
      rows: Array.from({ length: count }, (_, i) => makeRow(start + i)),
    }),
  );
});

// Contract: only the pages overlapping the requested index range are fetched, by generation.
describe("useLogPages fetching", () => {
  it("should fetch only page 0 for the range 0..10", async () => {
    renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    await waitFor(() => expect(getLogPage).toHaveBeenCalledExactlyOnceWith(1, 7, 0, 500));
  });

  it("should fetch pages 0 and 1 for the range 490..510", async () => {
    renderHookWithProviders(() => useLogPages(1, 7, 490, 510));
    await waitFor(() => expect(getLogPage).toHaveBeenCalledTimes(2));
    expect(getLogPage).toHaveBeenCalledWith(1, 7, 0, 500);
    expect(getLogPage).toHaveBeenCalledWith(1, 7, 500, 500);
  });

  it("should not fetch page 1 for a range ending at the last row of page 0", async () => {
    renderHookWithProviders(() => useLogPages(1, 7, 0, 499));
    await waitFor(() => expect(getLogPage).toHaveBeenCalledTimes(1));
    await settle();
    expect(getLogPage).toHaveBeenCalledTimes(1);
  });

  it("should fetch nothing while the generation is undefined", async () => {
    const { result } = renderHookWithProviders(() => useLogPages(1, undefined, 0, 10));
    await settle();
    expect(getLogPage).not.toHaveBeenCalled();
    expect(result.current.rowAt(0)).toBeUndefined();
  });

  it("should fetch nothing for an empty range", async () => {
    renderHookWithProviders(() => useLogPages(1, 7, 5, 4));
    await settle();
    expect(getLogPage).not.toHaveBeenCalled();
  });

  it("should fetch the new page when the range moves", async () => {
    let range: [number, number] = [0, 10];
    const { rerender } = renderHookWithProviders(() => useLogPages(1, 7, range[0], range[1]));
    await waitFor(() => expect(getLogPage).toHaveBeenCalledWith(1, 7, 0, 500));
    range = [1000, 1010];
    rerender();
    await waitFor(() => expect(getLogPage).toHaveBeenCalledWith(1, 7, 1000, 500));
  });

  it("should fetch under the new generation when the generation changes", async () => {
    let generation = 7;
    const { rerender } = renderHookWithProviders(() => useLogPages(1, generation, 0, 10));
    await waitFor(() => expect(getLogPage).toHaveBeenCalledWith(1, 7, 0, 500));
    generation = 8;
    rerender();
    await waitFor(() => expect(getLogPage).toHaveBeenCalledWith(1, 8, 0, 500));
  });

  it("should treat fetched pages as immutable", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    await waitFor(() => expect(result.current.rowAt(0)).toBeDefined());
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.logPage(1, 7, 0) });
    expect(query?.observers[0]?.options.staleTime).toBe(Infinity);
  });
});

// Contract: rowAt maps a history index to the row inside its loaded page.
describe("useLogPages rowAt", () => {
  it("should return the first row of page 0 for index 0", async () => {
    const { result } = renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    await waitFor(() => expect(result.current.rowAt(0)).toEqual(makeRow(0)));
  });

  it("should return row index 1 of page 1 for index 501", async () => {
    const { result } = renderHookWithProviders(() => useLogPages(1, 7, 490, 510));
    await waitFor(() => expect(result.current.rowAt(501)).toEqual(makeRow(501)));
  });

  it("should return the last row of page 0 for index 499", async () => {
    const { result } = renderHookWithProviders(() => useLogPages(1, 7, 490, 510));
    await waitFor(() => expect(result.current.rowAt(499)).toEqual(makeRow(499)));
  });

  it("should return undefined for an index outside the loaded pages", async () => {
    const { result } = renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    await waitFor(() => expect(result.current.rowAt(0)).toBeDefined());
    expect(result.current.rowAt(700)).toBeUndefined();
  });

  it("should return undefined for every index before the page resolves", () => {
    vi.mocked(getLogPage).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    expect(result.current.rowAt(0)).toBeUndefined();
  });

  it("should return undefined for an index past the end of a short last page", async () => {
    vi.mocked(getLogPage).mockResolvedValue({ start: 0, rows: [makeRow(0), makeRow(1)] });
    const { result } = renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    await waitFor(() => expect(result.current.rowAt(1)).toBeDefined());
    expect(result.current.rowAt(2)).toBeUndefined();
  });
});

// Contract: load failures surface as error, except a stale generation which is handled silently.
describe("useLogPages errors", () => {
  it("should expose an AppError rejection as error", async () => {
    vi.mocked(getLogPage).mockRejectedValue({ kind: "git", message: "page boom" });
    const { result } = renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    await waitFor(() =>
      expect(result.current.error).toEqual({ kind: "git", message: "page boom" }),
    );
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(getLogPage).mockRejectedValue(new Error("plain"));
    const { result } = renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "plain" }));
  });

  it("should not invalidate the summary for an error other than logStale", async () => {
    vi.mocked(getLogPage).mockRejectedValue({ kind: "git", message: "page boom" });
    const { result, queryClient } = renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(spy).not.toHaveBeenCalled();
  });

  it("should fetch every loaded page again when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useLogPages(1, 7, 490, 510));
    await waitFor(() => expect(result.current.rowAt(501)).toBeDefined());
    result.current.refetch();
    await waitFor(() => expect(getLogPage).toHaveBeenCalledTimes(4));
  });
});

// Contract (Review Focus 1): a stale generation invalidates the summary once, never retries, never errors.
describe("useLogPages invalidates the summary once on logStale and does not retry", () => {
  const stale = { kind: "logStale", message: "generation is gone" };

  it("should invalidate queryKeys.log exactly once when a page rejects with logStale", async () => {
    vi.mocked(getLogPage).mockRejectedValue(stale);
    const { queryClient } = renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.log(1) }));
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("should call getLogPage only once and not retry after logStale", async () => {
    vi.mocked(getLogPage).mockRejectedValue(stale);
    const { queryClient } = renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await settle();
    expect(getLogPage).toHaveBeenCalledTimes(1);
  });

  it("should keep error null after logStale", async () => {
    vi.mocked(getLogPage).mockRejectedValue(stale);
    const { result, queryClient } = renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await settle();
    expect(result.current.error).toBeNull();
  });

  it("should invalidate once even when several pages of the same generation are stale", async () => {
    vi.mocked(getLogPage).mockRejectedValue(stale);
    const { queryClient } = renderHookWithProviders(() => useLogPages(1, 7, 490, 510));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("should not invalidate again on a rerender with the same generation", async () => {
    vi.mocked(getLogPage).mockRejectedValue(stale);
    const { rerender, queryClient } = renderHookWithProviders(() => useLogPages(1, 7, 0, 10));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    rerender();
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("should invalidate again when a newer generation is also stale", async () => {
    vi.mocked(getLogPage).mockRejectedValue(stale);
    let generation = 7;
    const { rerender, queryClient } = renderHookWithProviders(() =>
      useLogPages(1, generation, 0, 10),
    );
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    generation = 8;
    rerender();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});

// Contract (GR-16 §6): log pages nobody is viewing are garbage collected after LOG_PAGE_GC_MS,
// which bounds memory while scrolling a long history.
describe("useLogPages page cache bound", () => {
  it("should carry gcTime LOG_PAGE_GC_MS on page queries", () => {
    const { gcTime } = logPageOptions(1, 7, 0);
    // typeof guard: an undefined export and an unset gcTime must not compare equal
    expect([gcTime, typeof gcTime]).toEqual([LOG_PAGE_GC_MS, "number"]);
  });

  it("should set LOG_PAGE_GC_MS to one minute", () => {
    expect(LOG_PAGE_GC_MS).toBe(60_000);
  });

  it("should collect a page no longer in view after LOG_PAGE_GC_MS", async () => {
    let first = 0;
    let last = 500; // pages 0 and 1
    const { rerender, queryClient } = renderHookWithProviders(() => useLogPages(1, 7, first, last));
    await waitFor(() => expect(getLogPage).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        queryClient.getQueryCache().find({ queryKey: queryKeys.logPage(1, 7, 1) })?.state.data,
      ).toBeDefined(),
    );

    vi.useFakeTimers();
    first = 40 * 500;
    last = 40 * 500 + 10; // page 40 only
    rerender();
    await vi.advanceTimersByTimeAsync(LOG_PAGE_GC_MS);

    const cache = queryClient.getQueryCache();
    expect({
      page0: cache.find({ queryKey: queryKeys.logPage(1, 7, 0) }) !== undefined,
      page1: cache.find({ queryKey: queryKeys.logPage(1, 7, 1) }) !== undefined,
      page40: cache.find({ queryKey: queryKeys.logPage(1, 7, 40) }) !== undefined,
    }).toEqual({ page0: false, page1: false, page40: true });
  });

  it("should keep a page that left the view until LOG_PAGE_GC_MS has elapsed", async () => {
    let first = 0;
    const { rerender, queryClient } = renderHookWithProviders(() => useLogPages(1, 7, first, 10));
    await waitFor(() => expect(getLogPage).toHaveBeenCalledTimes(1));
    await settle();

    vi.useFakeTimers();
    first = 40 * 500;
    rerender();
    await vi.advanceTimersByTimeAsync(LOG_PAGE_GC_MS - 1);

    expect(
      queryClient.getQueryCache().find({ queryKey: queryKeys.logPage(1, 7, 0) }),
    ).toBeDefined();
  });
});
