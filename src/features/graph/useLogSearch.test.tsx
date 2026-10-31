import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchLog } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useLogSearch } from "./useLogSearch";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  searchLog: vi.fn(),
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(searchLog).mockResolvedValue([2, 9, 40]);
});

// Contract: the query is disabled for an empty or blank query and while there is no generation.
describe("useLogSearch disabled states", () => {
  it("should not call searchLog for an empty query", async () => {
    const { result } = renderHookWithProviders(() => useLogSearch(1, 7, "", true));
    await settle();
    expect(searchLog).not.toHaveBeenCalled();
    expect(result.current.matches).toEqual([]);
  });

  it("should not call searchLog for a whitespace-only query", async () => {
    renderHookWithProviders(() => useLogSearch(1, 7, "   ", true));
    await settle();
    expect(searchLog).not.toHaveBeenCalled();
  });

  it("should not call searchLog while the generation is undefined", async () => {
    renderHookWithProviders(() => useLogSearch(1, undefined, "abc", true));
    await settle();
    expect(searchLog).not.toHaveBeenCalled();
  });

  it("should not report fetching when disabled", () => {
    const { result } = renderHookWithProviders(() => useLogSearch(1, 7, "", true));
    expect(result.current.isFetching).toBe(false);
  });
});

// Contract: search waits for a complete graph.
describe("useLogSearch on an incomplete graph", () => {
  it("should not search while the graph is incomplete", async () => {
    const { result } = renderHookWithProviders(() => useLogSearch(1, 7, "abc", false));
    await settle();
    expect(searchLog).not.toHaveBeenCalled();
    expect(result.current.isFetching).toBe(false);
  });

  it("should search once complete becomes true", async () => {
    let complete = false;
    const { result, rerender } = renderHookWithProviders(() => useLogSearch(1, 7, "abc", complete));
    await settle();
    expect(searchLog).not.toHaveBeenCalled();
    complete = true;
    rerender();
    await waitFor(() => expect(result.current.matches).toEqual([2, 9, 40]));
    expect(searchLog).toHaveBeenCalledExactlyOnceWith(1, 7, "abc");
  });
});

// Contract: a non-empty query searches the given generation and exposes ascending indices.
describe("useLogSearch results", () => {
  it("should call searchLog with the repo, generation and query", async () => {
    renderHookWithProviders(() => useLogSearch(1, 7, "abc", true));
    await waitFor(() => expect(searchLog).toHaveBeenCalledExactlyOnceWith(1, 7, "abc"));
  });

  it("should expose the returned indices as matches", async () => {
    const { result } = renderHookWithProviders(() => useLogSearch(1, 7, "abc", true));
    await waitFor(() => expect(result.current.matches).toEqual([2, 9, 40]));
  });

  it("should default matches to an empty array before the result arrives", () => {
    vi.mocked(searchLog).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useLogSearch(1, 7, "abc", true));
    expect(result.current.matches).toEqual([]);
  });

  it("should report fetching while the search is in flight", async () => {
    const { result } = renderHookWithProviders(() => useLogSearch(1, 7, "abc", true));
    expect(result.current.isFetching).toBe(true);
    await waitFor(() => expect(result.current.isFetching).toBe(false));
  });

  it("should keep matches empty when the search fails", async () => {
    vi.mocked(searchLog).mockRejectedValue({ kind: "logStale", message: "stale" });
    const { result } = renderHookWithProviders(() => useLogSearch(1, 7, "abc", true));
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.matches).toEqual([]);
  });

  it("should search again when the query changes", async () => {
    let query = "abc";
    const { rerender } = renderHookWithProviders(() => useLogSearch(1, 7, query, true));
    await waitFor(() => expect(searchLog).toHaveBeenCalledWith(1, 7, "abc"));
    query = "abcd";
    rerender();
    await waitFor(() => expect(searchLog).toHaveBeenCalledWith(1, 7, "abcd"));
  });

  it("should search again under the new generation when the generation changes", async () => {
    let generation = 7;
    const { rerender } = renderHookWithProviders(() => useLogSearch(1, generation, "abc", true));
    await waitFor(() => expect(searchLog).toHaveBeenCalledWith(1, 7, "abc"));
    generation = 8;
    rerender();
    await waitFor(() => expect(searchLog).toHaveBeenCalledWith(1, 8, "abc"));
  });
});

// Contract: results are immutable per (generation, query) and cached under queryKeys.logSearch.
describe("useLogSearch caching", () => {
  it("should store the result under queryKeys.logSearch for the generation and query", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useLogSearch(1, 7, "abc", true));
    await waitFor(() => expect(result.current.matches).toHaveLength(3));
    expect(queryClient.getQueryData(queryKeys.logSearch(1, 7, "abc"))).toEqual([2, 9, 40]);
  });

  it("should never treat the cached result as stale", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useLogSearch(1, 7, "abc", true));
    await waitFor(() => expect(result.current.matches).toHaveLength(3));
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.logSearch(1, 7, "abc") });
    expect(query?.observers[0]?.options.staleTime).toBe(Infinity);
  });
});
