import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostingPullRequestDraft } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { hostingError, prDraft } from "../../test/hostingFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { usePullRequestDraft } from "./usePullRequestDraft";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingPullRequestDraft: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hostingPullRequestDraft).mockResolvedValue(prDraft());
});

// Contract: the draft is requested for a target only; `settled` says the answer (or failure) is in.
describe("usePullRequestDraft", () => {
  it("should not call the command and not be settled while the target is null", async () => {
    const { result } = renderHookWithProviders(() => usePullRequestDraft(1, null));
    await act(() => Promise.resolve());
    expect(hostingPullRequestDraft).not.toHaveBeenCalled();
    expect([result.current.draft, result.current.settled]).toEqual([undefined, false]);
  });

  it("should create no cache entry while the target is null", async () => {
    const { queryClient } = renderHookWithProviders(() => usePullRequestDraft(1, null));
    await act(() => Promise.resolve());
    expect(queryClient.getQueryCache().findAll({ queryKey: ["repo", 1, "prDraft"] })).toEqual([]);
  });

  it("should request the draft for the repo and target once", async () => {
    renderHookWithProviders(() => usePullRequestDraft(3, "develop"));
    await waitFor(() =>
      expect(hostingPullRequestDraft).toHaveBeenCalledExactlyOnceWith(3, "develop"),
    );
  });

  it("should expose the draft and settle when it loads", async () => {
    const { result } = renderHookWithProviders(() => usePullRequestDraft(1, "main"));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.draft).toEqual(prDraft());
  });

  it("should not be settled while the request is in flight", () => {
    vi.mocked(hostingPullRequestDraft).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => usePullRequestDraft(1, "main"));
    expect([result.current.draft, result.current.settled]).toEqual([undefined, false]);
  });

  it("should settle with no draft when the request is rejected", async () => {
    vi.mocked(hostingPullRequestDraft).mockRejectedValue(hostingError("revisionNotFound"));
    const { result } = renderHookWithProviders(() => usePullRequestDraft(1, "main"));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.draft).toBeUndefined();
  });

  it("should cache under queryKeys.prDraft", async () => {
    const { result, queryClient } = renderHookWithProviders(() => usePullRequestDraft(1, "main"));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(queryClient.getQueryData(queryKeys.prDraft(1, "main"))).toEqual(prDraft());
  });

  it("should start requesting when the target changes from null", async () => {
    let target: string | null = null;
    const { rerender } = renderHookWithProviders(() => usePullRequestDraft(1, target));
    expect(hostingPullRequestDraft).not.toHaveBeenCalled();
    target = "main";
    rerender();
    await waitFor(() => expect(hostingPullRequestDraft).toHaveBeenCalledExactlyOnceWith(1, "main"));
  });
});
