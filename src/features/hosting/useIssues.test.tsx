import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostingListIssues } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { issue } from "../../test/hostingFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useIssues } from "./useIssues";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingListIssues: vi.fn(),
}));

/** n issues numbered from `start` down. */
const issues = (n: number, start = 100) => Array.from({ length: n }, (_, i) => issue(start - i));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hostingListIssues).mockResolvedValue([issue(2), issue(1)]);
});

// Contract: nothing is requested until the caller enables it (section expanded, issues allowed).
describe("useIssues enabled", () => {
  it("should not call the provider while disabled", async () => {
    const { result } = renderHookWithProviders(() => useIssues(1, "", false));
    await act(() => Promise.resolve());
    expect(hostingListIssues).not.toHaveBeenCalled();
    expect(result.current.issues).toBeUndefined();
  });

  it("should request page 1 with the query once enabled", async () => {
    renderHookWithProviders(() => useIssues(4, "crash", true));
    await waitFor(() => expect(hostingListIssues).toHaveBeenCalledExactlyOnceWith(4, "crash", 1));
  });

  it("should request page 1 with an empty query for the plain list", async () => {
    renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(hostingListIssues).toHaveBeenCalledExactlyOnceWith(1, "", 1));
  });

  it("should start fetching when enabled flips to true", async () => {
    let enabled = false;
    const { rerender } = renderHookWithProviders(() => useIssues(1, "", enabled));
    expect(hostingListIssues).not.toHaveBeenCalled();
    enabled = true;
    rerender();
    await waitFor(() => expect(hostingListIssues).toHaveBeenCalledExactlyOnceWith(1, "", 1));
  });

  it("should have no issues and no error while loading", () => {
    vi.mocked(hostingListIssues).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    expect([result.current.issues, result.current.error]).toEqual([undefined, null]);
  });

  it("should expose the loaded issues", async () => {
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.issues).toEqual([issue(2), issue(1)]));
  });

  it("should cache under queryKeys.issues for the repo and query", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useIssues(1, "crash", true));
    await waitFor(() => expect(result.current.issues).toBeDefined());
    expect(queryClient.getQueryState(queryKeys.issues(1, "crash"))).toBeDefined();
    expect(queryClient.getQueryState(queryKeys.issues(1, ""))).toBeUndefined();
  });

  it("should keep a different query in a different cache entry", async () => {
    let query = "a";
    const { result, rerender, queryClient } = renderHookWithProviders(() =>
      useIssues(1, query, true),
    );
    await waitFor(() => expect(result.current.issues).toBeDefined());
    query = "b";
    rerender();
    await waitFor(() => expect(hostingListIssues).toHaveBeenLastCalledWith(1, "b", 1));
    expect([
      queryClient.getQueryState(queryKeys.issues(1, "a")) !== undefined,
      queryClient.getQueryState(queryKeys.issues(1, "b")) !== undefined,
    ]).toEqual([true, true]);
  });
});

// Contract: pages hold 50 issues; a full page means there may be more.
describe("useIssues paging", () => {
  it("should report hasMore when the last page has 50 items", async () => {
    vi.mocked(hostingListIssues).mockResolvedValue(issues(50));
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
  });

  it("should not report hasMore for a page under 50", async () => {
    vi.mocked(hostingListIssues).mockResolvedValue(issues(49));
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.issues).toHaveLength(49));
    expect(result.current.hasMore).toBe(false);
  });

  it("should not report hasMore for an empty page", async () => {
    vi.mocked(hostingListIssues).mockResolvedValue([]);
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.issues).toEqual([]));
    expect(result.current.hasMore).toBe(false);
  });

  it("should request page 2 with the same query and append it on loadMore", async () => {
    vi.mocked(hostingListIssues)
      .mockResolvedValueOnce(issues(50, 100))
      .mockResolvedValueOnce(issues(3, 50));
    const { result } = renderHookWithProviders(() => useIssues(1, "crash", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.issues).toHaveLength(53));
    expect(hostingListIssues).toHaveBeenLastCalledWith(1, "crash", 2);
    expect(result.current.issues?.[50]).toEqual(issue(50));
  });

  it("should stop reporting hasMore after a short second page", async () => {
    vi.mocked(hostingListIssues)
      .mockResolvedValueOnce(issues(50, 100))
      .mockResolvedValueOnce(issues(3, 50));
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.issues).toHaveLength(53));
    expect(result.current.hasMore).toBe(false);
  });

  it("should flag loadingMore while the next page loads", async () => {
    vi.mocked(hostingListIssues)
      .mockResolvedValueOnce(issues(50))
      .mockReturnValueOnce(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    expect(result.current.loadingMore).toBe(false);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(true));
  });
});

// Contract: refetch and errors.
describe("useIssues refetch and errors", () => {
  it("should request again when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.issues).toBeDefined());
    act(() => result.current.refetch());
    await waitFor(() => expect(hostingListIssues).toHaveBeenCalledTimes(2));
  });

  it("should report fetching while the list loads and not after", async () => {
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.fetching).toBe(true));
    await waitFor(() => expect(result.current.fetching).toBe(false));
  });

  it("should map a rejection into error", async () => {
    vi.mocked(hostingListIssues).mockRejectedValue({ kind: "hostingAuth", message: "no" });
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() =>
      expect(result.current.error).toEqual({ kind: "hostingAuth", message: "no" }),
    );
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(hostingListIssues).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });
});

// Contract (Review Focus 5): watcher events must not cost an API call.
describe("useIssues refresh policy", () => {
  it("does not refetch when the repo prefix is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.issues).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(1) }));
    expect(hostingListIssues).toHaveBeenCalledTimes(1);
  });

  it("should refetch when the issues key is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.issues).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.issues(1, "") }));
    expect(hostingListIssues).toHaveBeenCalledTimes(2);
  });

  it("should not refetch on window focus", async () => {
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.issues).toBeDefined());
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(hostingListIssues).toHaveBeenCalledTimes(1);
  });
});

// Contract (fix wave 2, F9): a number that reappears on a later page (the list shifted while
// paging) appears once, in its first position, so React keys stay unique.
describe("useIssues overlapping pages", () => {
  const pageOne = () => issues(50, 100); // #100..#51
  const loadBoth = async (second: ReturnType<typeof issues>) => {
    vi.mocked(hostingListIssues).mockResolvedValueOnce(pageOne()).mockResolvedValueOnce(second);
    const view = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(view.result.current.hasMore).toBe(true));
    act(() => view.result.current.loadMore());
    await waitFor(() => expect(hostingListIssues).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.result.current.loadingMore).toBe(false));
    return view;
  };

  it("should list an issue present on both pages once", async () => {
    const { result } = await loadBoth([issue(51), issue(50)]);
    expect(result.current.issues?.map((i) => i.number)).toEqual([
      ...pageOne().map((i) => i.number),
      50,
    ]);
  });

  it("should keep the first occurrence of a duplicated issue", async () => {
    const { result } = await loadBoth([issue(51, { title: "Later copy" }), issue(50)]);
    expect(result.current.issues?.find((i) => i.number === 51)?.title).toBe("Issue 51");
  });

  it("should leave the pages unchanged when no number repeats", async () => {
    const { result } = await loadBoth([issue(50), issue(49)]);
    expect(result.current.issues).toHaveLength(52);
  });

  it("should drop a number repeated within one page", async () => {
    const { result } = await loadBoth([issue(50), issue(50), issue(49)]);
    expect(result.current.issues).toHaveLength(52);
  });

  it("should still report hasMore from the raw page size, not the deduped count", async () => {
    vi.mocked(hostingListIssues)
      .mockResolvedValueOnce(pageOne())
      .mockResolvedValueOnce(issues(50, 51)); // #51..#2, one overlap, a full page
    const { result } = renderHookWithProviders(() => useIssues(1, "", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.issues).toHaveLength(99));
    expect(result.current.hasMore).toBe(true);
  });
});
