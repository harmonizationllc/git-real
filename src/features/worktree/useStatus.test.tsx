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

let handler: (() => void) | undefined;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  handler = undefined;
  unlisten = vi.fn();
  vi.mocked(getStatus).mockResolvedValue(status);
  vi.mocked(onRepoChanged).mockImplementation(async (_id, h) => {
    handler = h;
    return unlisten as unknown as () => void;
  });
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
    await result.current.refetch();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });
});

// Contract: one repo-changed subscription per repoId; the event invalidates every repo query.
describe("useStatus repo-changed subscription", () => {
  it("should subscribe to onRepoChanged for the repo id", async () => {
    renderHookWithProviders(() => useStatus(7));
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledOnce());
    expect(vi.mocked(onRepoChanged).mock.calls[0]?.[0]).toBe(7);
  });

  it("should subscribe only once across re-renders with the same repoId", async () => {
    const { rerender } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledOnce());
    rerender();
    rerender();
    expect(onRepoChanged).toHaveBeenCalledOnce();
  });

  it("should invalidate the repo query key when the event fires", async () => {
    const { queryClient } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(handler).toBeDefined());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    handler?.();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["repo", 1] });
  });

  it("should refetch the status when the event fires", async () => {
    const { result } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(result.current.status).toBeDefined());
    handler?.();
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
  });

  it("should unlisten when the hook unmounts", async () => {
    const { unmount } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledOnce());
    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });

  it("should unlisten even when unmounted before the subscription resolves", async () => {
    let resolve!: (u: () => void) => void;
    vi.mocked(onRepoChanged).mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = renderHookWithProviders(() => useStatus(1));
    unmount();
    resolve(unlisten as unknown as () => void);
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });

  it("should resubscribe and unlisten the old subscription when repoId changes", async () => {
    let id = 1;
    const { rerender } = renderHookWithProviders(() => useStatus(id));
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledTimes(1));
    id = 2;
    rerender();
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledTimes(2));
    expect(vi.mocked(onRepoChanged).mock.calls[1]?.[0]).toBe(2);
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });
});

// Contract: hardening around the subscription and query options.
describe("useStatus robustness", () => {
  it("should not invalidate when the handler fires after unmount", async () => {
    const { queryClient, unmount } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(handler).toBeDefined());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    unmount();
    handler?.();
    expect(spy).not.toHaveBeenCalled();
  });

  it("should still resolve the status when the subscription rejects", async () => {
    vi.mocked(onRepoChanged).mockRejectedValue(new Error("no bridge"));
    const { result } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(result.current.status).toEqual(status));
  });

  it("should enable refetchOnWindowFocus on the status query", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(result.current.status).toBeDefined());
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.status(1) });
    expect(query?.observers[0]?.options.refetchOnWindowFocus).toBe(true);
  });
});

// Contract: subscriptions are per repo; an event only invalidates its own repo's queries.
describe("useStatus multi-repo isolation", () => {
  const handlers = new Map<number, () => void>();

  function installPerRepoHandlers() {
    handlers.clear();
    vi.mocked(onRepoChanged).mockImplementation(async (id, h) => {
      handlers.set(id, h);
      return unlisten as unknown as () => void;
    });
  }

  it("should invalidate only the repo whose event fired", async () => {
    installPerRepoHandlers();
    // The second fetch for each repo never settles, so isInvalidated stays observable.
    vi.mocked(getStatus)
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(status)
      .mockReturnValue(new Promise(() => {}));
    const one = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(one.result.current.status).toBeDefined());
    // Share one client for both hooks by reading both keys from the first client.
    const two = renderHookWithProviders(() => useStatus(2));
    await waitFor(() => expect(two.result.current.status).toBeDefined());
    await waitFor(() => expect(handlers.size).toBe(2));

    handlers.get(1)?.();

    const q1 = one.queryClient.getQueryCache().find({ queryKey: queryKeys.status(1) });
    expect(q1?.state.isInvalidated).toBe(true);
    const q2 = two.queryClient.getQueryCache().find({ queryKey: queryKeys.status(2) });
    expect(q2?.state.isInvalidated).toBe(false);
    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(vi.mocked(getStatus).mock.calls[2]).toEqual([1]);
  });

  it("should invalidate sibling repo keys in a shared client only for the firing repo", async () => {
    installPerRepoHandlers();
    const { queryClient } = renderHookWithProviders(() => {
      useStatus(1);
      useStatus(2);
    });
    await waitFor(() => expect(handlers.size).toBe(2));
    await waitFor(() =>
      expect(
        queryClient.getQueryCache().find({ queryKey: queryKeys.status(2) })?.state.status,
      ).toBe("success"),
    );
    vi.mocked(getStatus).mockReturnValue(new Promise(() => {}));
    handlers.get(2)?.();
    const find = (id: number) =>
      queryClient.getQueryCache().find({ queryKey: queryKeys.status(id) });
    expect(find(2)?.state.isInvalidated).toBe(true);
    expect(find(1)?.state.isInvalidated).toBe(false);
  });

  it("should ignore events from the old subscription after repoId changes", async () => {
    installPerRepoHandlers();
    let id = 1;
    const { rerender, queryClient } = renderHookWithProviders(() => useStatus(id));
    await waitFor(() => expect(handlers.has(1)).toBe(true));
    const oldHandler = handlers.get(1);
    id = 2;
    rerender();
    await waitFor(() => expect(handlers.has(2)).toBe(true));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    oldHandler?.();
    expect(spy).not.toHaveBeenCalled();
    handlers.get(2)?.();
    expect(spy).toHaveBeenCalledExactlyOnceWith({ queryKey: queryKeys.repo(2) });
  });

  it("should keep reporting status after the subscription rejects and refetch is called", async () => {
    vi.mocked(onRepoChanged).mockRejectedValue(new Error("no bridge"));
    const { result } = renderHookWithProviders(() => useStatus(1));
    await waitFor(() => expect(result.current.status).toEqual(status));
    result.current.refetch();
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
    expect(result.current.status).toEqual(status);
    expect(result.current.error).toBeNull();
  });
});
