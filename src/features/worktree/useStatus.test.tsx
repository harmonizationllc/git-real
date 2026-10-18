import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStatus, onRepoChanged } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import type { AppError, WorkingTreeStatus } from "../../lib/ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useStatus } from "./useStatus";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getStatus: vi.fn(),
  onRepoChanged: vi.fn(),
}));

const status: WorkingTreeStatus = {
  entries: [{ path: "a.txt", oldPath: null, index: null, worktree: "modified", conflicted: false }],
  headUnborn: false,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getStatus).mockResolvedValue(status);
  vi.mocked(onRepoChanged).mockResolvedValue(() => {});
});

// Contract: useStatus queries getStatus for the repo.
describe("useStatus query", () => {
  it("should report loading with no status before the query resolves", () => {
    const { result } = renderHookWithProviders(() => useStatus(1));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.status).toBeUndefined();
  });

  it("should expose the status returned by getStatus", async () => {
    const { result } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(result.current.status).toEqual(status));
    expect(getStatus).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("should expose a rejected AppError as error", async () => {
    const err: AppError = { kind: "unknownRepo", message: "gone" };
    vi.mocked(getStatus).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(result.current.error).toEqual(err));
  });

  it("should have a null error while the query succeeds", async () => {
    const { result } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(result.current.status).toBeDefined());
    expect(result.current.error).toBeNull();
  });

  it("should map a non-AppError rejection to an io error", async () => {
    vi.mocked(getStatus).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });

  it("should refetch when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(result.current.status).toBeDefined());
    result.current.refetch();
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
  });
});

// Contract: the subscription moved to useRepoChanged; useStatus only queries.
describe("useStatus", () => {
  it("should not subscribe to onRepoChanged", async () => {
    const { result } = renderHookWithProviders(() => useStatus(7));
    await waitFor(() => expect(result.current.status).toBeDefined());
    expect(onRepoChanged).not.toHaveBeenCalled();
  });

  it("should enable refetchOnWindowFocus on the status query", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(result.current.status).toBeDefined());
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.status(1) });
    expect(query?.observers[0]?.options.refetchOnWindowFocus).toBe(true);
  });

  it("should refetch after its query is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(result.current.status).toBeDefined());
    await queryClient.invalidateQueries({ queryKey: queryKeys.repo(1) });
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
  });
});
