import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostingRepoInfo } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { hostingError, repoInfo } from "../../test/hostingFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { issuesAllowed, useRepoInfo } from "./useRepoInfo";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingRepoInfo: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo());
});

// Contract: the provider is asked only when enabled; the answer is cached under hostingRepoInfo.
describe("useRepoInfo", () => {
  it("should not call the provider while disabled", async () => {
    const { result } = renderHookWithProviders(() => useRepoInfo(1, false));
    await act(() => Promise.resolve());
    expect(hostingRepoInfo).not.toHaveBeenCalled();
    expect(result.current.info).toBeUndefined();
  });

  it("should request the info once when enabled", async () => {
    renderHookWithProviders(() => useRepoInfo(4, true));
    await waitFor(() => expect(hostingRepoInfo).toHaveBeenCalledExactlyOnceWith(4));
  });

  it("should expose the loaded info", async () => {
    const { result } = renderHookWithProviders(() => useRepoInfo(1, true));
    await waitFor(() => expect(result.current.info).toEqual(repoInfo()));
  });

  it("should cache under queryKeys.hostingRepoInfo", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRepoInfo(1, true));
    await waitFor(() => expect(result.current.info).toBeDefined());
    expect(queryClient.getQueryData(queryKeys.hostingRepoInfo(1))).toEqual(repoInfo());
  });

  it("should expose a rejection as an AppError", async () => {
    const error = hostingError("hostingUnreachable");
    vi.mocked(hostingRepoInfo).mockRejectedValue(error);
    const { result } = renderHookWithProviders(() => useRepoInfo(1, true));
    await waitFor(() => expect(result.current.error).toEqual(error));
    expect(result.current.info).toBeUndefined();
  });

  it("should turn a plain Error into an io AppError", async () => {
    vi.mocked(hostingRepoInfo).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useRepoInfo(1, true));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });

  it("should have no error while loading", () => {
    vi.mocked(hostingRepoInfo).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useRepoInfo(1, true));
    expect([result.current.info, result.current.error]).toEqual([undefined, null]);
  });

  it("should request again when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useRepoInfo(1, true));
    await waitFor(() => expect(result.current.info).toBeDefined());
    act(() => result.current.refetch());
    await waitFor(() => expect(hostingRepoInfo).toHaveBeenCalledTimes(2));
  });
});

// Contract (fix wave 2, F6): the one rule for asking the provider for issues.
describe("issuesAllowed", () => {
  it("should allow when the repository has issues turned on", () => {
    expect(issuesAllowed(repoInfo({ issuesEnabled: true }), null)).toBe(true);
  });

  it("should not allow when the repository has issues turned off", () => {
    expect(issuesAllowed(repoInfo({ issuesEnabled: false }), null)).toBe(false);
  });

  it("should not allow while the info is still loading", () => {
    expect(issuesAllowed(undefined, null)).toBe(false);
  });

  it.each(["hostingUnreachable", "hostingNotFound", "io"] as const)(
    "should allow the fallback listing after a %s error with no info",
    (kind) => {
      expect(issuesAllowed(undefined, hostingError(kind))).toBe(true);
    },
  );

  it.each(["hostingAuth", "hostingRateLimited"] as const)(
    "should not allow after a %s error with no info",
    (kind) => {
      expect(issuesAllowed(undefined, hostingError(kind))).toBe(false);
    },
  );

  it("should follow the info, not a stale error, once the info is known", () => {
    expect(
      issuesAllowed(repoInfo({ issuesEnabled: false }), hostingError("hostingUnreachable")),
    ).toBe(false);
  });
});
