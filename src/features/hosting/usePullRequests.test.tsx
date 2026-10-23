import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostingListPullRequests } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { pullRequest, pullRequests } from "../../test/hostingFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { usePullRequests } from "./usePullRequests";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingListPullRequests: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hostingListPullRequests).mockResolvedValue([pullRequest(2), pullRequest(1)]);
});

// Contract: nothing is requested until the section is enabled (expanded with a usable account).
describe("usePullRequests enabled", () => {
  it("should not call the provider while disabled", async () => {
    const { result } = renderHookWithProviders(() => usePullRequests(1, false));
    await act(() => Promise.resolve());
    expect(hostingListPullRequests).not.toHaveBeenCalled();
    expect(result.current.pullRequests).toBeUndefined();
  });

  it("should request page 1 once enabled", async () => {
    renderHookWithProviders(() => usePullRequests(4, true));
    await waitFor(() => expect(hostingListPullRequests).toHaveBeenCalledExactlyOnceWith(4, 1));
  });

  it("should start fetching when enabled flips to true", async () => {
    let enabled = false;
    const { rerender } = renderHookWithProviders(() => usePullRequests(1, enabled));
    expect(hostingListPullRequests).not.toHaveBeenCalled();
    enabled = true;
    rerender();
    await waitFor(() => expect(hostingListPullRequests).toHaveBeenCalledExactlyOnceWith(1, 1));
  });

  it("should have no pull requests and no error while loading", () => {
    vi.mocked(hostingListPullRequests).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    expect([result.current.pullRequests, result.current.error]).toEqual([undefined, null]);
  });

  it("should expose the loaded pull requests", async () => {
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() =>
      expect(result.current.pullRequests).toEqual([pullRequest(2), pullRequest(1)]),
    );
  });

  it("should cache under queryKeys.pullRequests", async () => {
    const { result, queryClient } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.pullRequests).toBeDefined());
    expect(queryClient.getQueryState(queryKeys.pullRequests(1))).toBeDefined();
  });
});

// Contract: pages hold 50 pull requests; a full page means there may be more.
describe("usePullRequests paging", () => {
  it("should report hasMore when the last page has 50 items", async () => {
    vi.mocked(hostingListPullRequests).mockResolvedValue(pullRequests(50));
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
  });

  it("should not report hasMore for a page under 50", async () => {
    vi.mocked(hostingListPullRequests).mockResolvedValue(pullRequests(49));
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.pullRequests).toHaveLength(49));
    expect(result.current.hasMore).toBe(false);
  });

  it("should not report hasMore for an empty page", async () => {
    vi.mocked(hostingListPullRequests).mockResolvedValue([]);
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.pullRequests).toEqual([]));
    expect(result.current.hasMore).toBe(false);
  });

  it("should request page 2 and append it on loadMore", async () => {
    vi.mocked(hostingListPullRequests)
      .mockResolvedValueOnce(pullRequests(50, 100))
      .mockResolvedValueOnce(pullRequests(3, 50));
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.pullRequests).toHaveLength(53));
    expect(hostingListPullRequests).toHaveBeenLastCalledWith(1, 2);
    expect(result.current.pullRequests?.[50]).toEqual(pullRequest(50));
  });

  it("should stop reporting hasMore after a short second page", async () => {
    vi.mocked(hostingListPullRequests)
      .mockResolvedValueOnce(pullRequests(50, 100))
      .mockResolvedValueOnce(pullRequests(3, 50));
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.pullRequests).toHaveLength(53));
    expect(result.current.hasMore).toBe(false);
  });

  it("should flag loadingMore while the next page loads", async () => {
    vi.mocked(hostingListPullRequests)
      .mockResolvedValueOnce(pullRequests(50))
      .mockReturnValueOnce(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    expect(result.current.loadingMore).toBe(false);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(true));
  });
});

// Contract: refetch and errors.
describe("usePullRequests refetch and errors", () => {
  it("should request again when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.pullRequests).toBeDefined());
    act(() => result.current.refetch());
    await waitFor(() => expect(hostingListPullRequests).toHaveBeenCalledTimes(2));
  });

  it("should report fetching while the list loads and not after", async () => {
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.fetching).toBe(true));
    await waitFor(() => expect(result.current.fetching).toBe(false));
  });

  it("should map a rejection into error", async () => {
    vi.mocked(hostingListPullRequests).mockRejectedValue({ kind: "hostingAuth", message: "no" });
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() =>
      expect(result.current.error).toEqual({ kind: "hostingAuth", message: "no" }),
    );
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(hostingListPullRequests).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });
});

// Contract (Review Focus 4): watcher events must not cost an API call.
describe("usePullRequests refresh policy", () => {
  it("does not refetch when the repo prefix is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.pullRequests).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(1) }));
    expect(hostingListPullRequests).toHaveBeenCalledTimes(1);
  });

  it("should refetch when the pull request key is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.pullRequests).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.pullRequests(1) }));
    expect(hostingListPullRequests).toHaveBeenCalledTimes(2);
  });

  it("should not refetch on window focus", async () => {
    const { result } = renderHookWithProviders(() => usePullRequests(1, true));
    await waitFor(() => expect(result.current.pullRequests).toBeDefined());
    await act(async () => {
      window.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(hostingListPullRequests).toHaveBeenCalledTimes(1);
  });
});
