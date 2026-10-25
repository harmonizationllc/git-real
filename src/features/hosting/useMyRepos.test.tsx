import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostingListMyRepos } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { hostedRepo, hostedRepoPage, hostedRepos, hostingError } from "../../test/hostingFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useMyRepos } from "./useMyRepos";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingListMyRepos: vi.fn(),
}));

const ACCOUNT = "github:github.com:octo";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage(hostedRepos(2)));
});

// Contract: nothing is requested without an account or while disabled; page 1 uses the query.
describe("useMyRepos requests", () => {
  it("should request page 1 for the account and query", async () => {
    renderHookWithProviders(() => useMyRepos(ACCOUNT, "git", true));
    await waitFor(() =>
      expect(hostingListMyRepos).toHaveBeenCalledExactlyOnceWith(ACCOUNT, "git", 1),
    );
  });

  it("should request page 1 with an empty query for the plain list", async () => {
    renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(hostingListMyRepos).toHaveBeenCalledExactlyOnceWith(ACCOUNT, "", 1));
  });

  it("should not request when disabled", async () => {
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", false));
    await act(() => Promise.resolve());
    expect(hostingListMyRepos).not.toHaveBeenCalled();
    expect(result.current.repos).toBeUndefined();
  });

  it("should not request without an account even when enabled", async () => {
    const { result } = renderHookWithProviders(() => useMyRepos(null, "", true));
    await act(() => Promise.resolve());
    expect(hostingListMyRepos).not.toHaveBeenCalled();
    expect(result.current.repos).toBeUndefined();
  });

  it("should start fetching when enabled flips to true", async () => {
    let enabled = false;
    const { rerender } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", enabled));
    expect(hostingListMyRepos).not.toHaveBeenCalled();
    enabled = true;
    rerender();
    await waitFor(() => expect(hostingListMyRepos).toHaveBeenCalledExactlyOnceWith(ACCOUNT, "", 1));
  });

  it("should have no repos and no error while loading", () => {
    vi.mocked(hostingListMyRepos).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    expect([result.current.repos, result.current.error]).toEqual([undefined, null]);
  });

  it("should expose the loaded repositories", async () => {
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(result.current.repos).toEqual(hostedRepos(2)));
  });

  it("should cache under queryKeys.myRepos for the account and query", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "git", true));
    await waitFor(() => expect(result.current.repos).toBeDefined());
    expect(queryClient.getQueryState(queryKeys.myRepos(ACCOUNT, "git"))).toBeDefined();
    expect(queryClient.getQueryState(queryKeys.myRepos(ACCOUNT, ""))).toBeUndefined();
  });

  it("should request again for a different account", async () => {
    let account = ACCOUNT;
    const { result, rerender } = renderHookWithProviders(() => useMyRepos(account, "", true));
    await waitFor(() => expect(result.current.repos).toBeDefined());
    account = "gitlab:gitlab.com:octo";
    rerender();
    await waitFor(() =>
      expect(hostingListMyRepos).toHaveBeenLastCalledWith("gitlab:gitlab.com:octo", "", 1),
    );
  });
});

// Contract: pages hold 50 repositories; a full page means there may be more.
describe("useMyRepos paging", () => {
  it("should report hasMore when the last page has 50 items", async () => {
    vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage(hostedRepos(50)));
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
  });

  // Fix 1: the wire page's hasMore decides, not the number of repositories that survived.
  it("should report hasMore from the wire page when fewer than 50 repositories came back", async () => {
    vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage(hostedRepos(49), true));
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(result.current.repos).toHaveLength(49));
    expect(result.current.hasMore).toBe(true);
  });

  it("should not report hasMore when the wire page says false even with 50 repositories", async () => {
    vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage(hostedRepos(50), false));
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(result.current.repos).toHaveLength(50));
    expect(result.current.hasMore).toBe(false);
  });

  it("should request page 2 after a short page that says hasMore", async () => {
    vi.mocked(hostingListMyRepos)
      .mockResolvedValueOnce(hostedRepoPage(hostedRepos(49), true))
      .mockResolvedValueOnce(hostedRepoPage(hostedRepos(2, 49), false));
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.repos).toHaveLength(51));
    expect(hostingListMyRepos).toHaveBeenLastCalledWith(ACCOUNT, "", 2);
  });

  it("should not report hasMore for a page under 50", async () => {
    vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage(hostedRepos(49)));
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(result.current.repos).toHaveLength(49));
    expect(result.current.hasMore).toBe(false);
  });

  it("should request page 2 with the same account and query and append it on loadMore", async () => {
    vi.mocked(hostingListMyRepos)
      .mockResolvedValueOnce(hostedRepoPage(hostedRepos(50)))
      .mockResolvedValueOnce(hostedRepoPage(hostedRepos(3, 50)));
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "repo", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.repos).toHaveLength(53));
    expect(hostingListMyRepos).toHaveBeenLastCalledWith(ACCOUNT, "repo", 2);
  });

  it("should flag loadingMore while the next page loads", async () => {
    vi.mocked(hostingListMyRepos)
      .mockResolvedValueOnce(hostedRepoPage(hostedRepos(50)))
      .mockReturnValueOnce(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    expect(result.current.loadingMore).toBe(false);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(true));
  });

  // Review Focus 5: a repository whose update time moved it from page 1 to page 2 shows once.
  it("should dedupe repositories across pages by full name", async () => {
    const moved = hostedRepo({ fullName: "octo/moved", name: "moved" });
    vi.mocked(hostingListMyRepos)
      .mockResolvedValueOnce(hostedRepoPage([moved, ...hostedRepos(49)], true))
      .mockResolvedValueOnce(
        hostedRepoPage([moved, hostedRepo({ fullName: "octo/later", name: "later" })]),
      );
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.repos).toHaveLength(51));
    const names = (result.current.repos ?? []).map((r) => r.fullName);
    expect(names.filter((n) => n === "octo/moved")).toHaveLength(1);
  });

  it("should keep the first occurrence when a full name repeats", async () => {
    const first = hostedRepo({ fullName: "octo/dup", description: "first" });
    vi.mocked(hostingListMyRepos)
      .mockResolvedValueOnce(hostedRepoPage([first, ...hostedRepos(49)], true))
      .mockResolvedValueOnce(
        hostedRepoPage([hostedRepo({ fullName: "octo/dup", description: "second" })]),
      );
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(hostingListMyRepos).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.repos?.find((r) => r.fullName === "octo/dup")?.description).toBe("first");
  });

  it("should keep two repositories that share a name but not an owner", async () => {
    vi.mocked(hostingListMyRepos).mockResolvedValue(
      hostedRepoPage([
        hostedRepo({ fullName: "octo/app", name: "app" }),
        hostedRepo({ fullName: "acme/app", name: "app", owner: "acme" }),
      ]),
    );
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(result.current.repos).toHaveLength(2));
  });
});

// Contract: a failed call surfaces as an AppError and refetch retries it.
describe("useMyRepos errors", () => {
  it("should expose the provider error", async () => {
    vi.mocked(hostingListMyRepos).mockRejectedValue(hostingError("hostingRateLimited"));
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(result.current.error?.kind).toBe("hostingRateLimited"));
  });

  it("should request again on refetch", async () => {
    const { result } = renderHookWithProviders(() => useMyRepos(ACCOUNT, "", true));
    await waitFor(() => expect(result.current.repos).toBeDefined());
    act(() => result.current.refetch());
    await waitFor(() => expect(hostingListMyRepos).toHaveBeenCalledTimes(2));
  });
});
