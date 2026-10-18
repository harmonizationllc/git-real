import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onRepoChanged } from "../ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { queryKeys } from "./keys";
import { useRepoChanged } from "./useRepoChanged";

vi.mock(import("../ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  onRepoChanged: vi.fn(),
}));

let handler: (() => void) | undefined;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  handler = undefined;
  unlisten = vi.fn();
  vi.mocked(onRepoChanged).mockImplementation(async (_id, h) => {
    handler = h;
    return unlisten as unknown as () => void;
  });
});

// Contract: one repo-changed subscription per repoId; the event invalidates every repo query.
describe("useRepoChanged subscription", () => {
  it("should subscribe to onRepoChanged for the repo id", async () => {
    renderHookWithProviders(() => useRepoChanged(7));
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledOnce());
    expect(vi.mocked(onRepoChanged).mock.calls[0]?.[0]).toBe(7);
  });

  it("should subscribe only once across re-renders with the same repoId", async () => {
    const { rerender } = renderHookWithProviders(() => useRepoChanged(1));
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledOnce());
    rerender();
    rerender();
    expect(onRepoChanged).toHaveBeenCalledOnce();
  });

  it("should invalidate the repo query key when the event fires", async () => {
    const { queryClient } = renderHookWithProviders(() => useRepoChanged(1));
    await waitFor(() => expect(handler).toBeDefined());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    handler?.();
    expect(spy).toHaveBeenCalledExactlyOnceWith({ queryKey: queryKeys.repo(1) });
  });

  it("should mark status and branches queries of the repo invalidated when the event fires", async () => {
    const { queryClient } = renderHookWithProviders(() => useRepoChanged(1));
    await waitFor(() => expect(handler).toBeDefined());
    queryClient.setQueryData(queryKeys.status(1), 1);
    queryClient.setQueryData(queryKeys.branches(1), 1);
    handler?.();
    expect([
      queryClient.getQueryState(queryKeys.status(1))?.isInvalidated,
      queryClient.getQueryState(queryKeys.branches(1))?.isInvalidated,
    ]).toEqual([true, true]);
  });

  it("should unlisten when the hook unmounts", async () => {
    const { unmount } = renderHookWithProviders(() => useRepoChanged(1));
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledOnce());
    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });

  it("should not unlisten while the hook stays mounted", async () => {
    renderHookWithProviders(() => useRepoChanged(1));
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledOnce());
    expect(unlisten).not.toHaveBeenCalled();
  });

  it("should unlisten even when unmounted before the subscription resolves", async () => {
    let resolve!: (u: () => void) => void;
    vi.mocked(onRepoChanged).mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = renderHookWithProviders(() => useRepoChanged(1));
    unmount();
    resolve(unlisten as unknown as () => void);
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });

  it("should resubscribe and unlisten the old subscription when repoId changes", async () => {
    let id = 1;
    const { rerender } = renderHookWithProviders(() => useRepoChanged(id));
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledTimes(1));
    id = 2;
    rerender();
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledTimes(2));
    expect(vi.mocked(onRepoChanged).mock.calls[1]?.[0]).toBe(2);
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  });
});

// Contract: hardening around the subscription.
describe("useRepoChanged robustness", () => {
  it("should not invalidate when the handler fires after unmount", async () => {
    const { queryClient, unmount } = renderHookWithProviders(() => useRepoChanged(1));
    await waitFor(() => expect(handler).toBeDefined());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    unmount();
    handler?.();
    expect(spy).not.toHaveBeenCalled();
  });

  it("should not throw or leave an unhandled rejection when the subscription rejects", async () => {
    vi.mocked(onRepoChanged).mockRejectedValue(new Error("no bridge"));
    const { unmount } = renderHookWithProviders(() => useRepoChanged(1));
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledOnce());
    expect(() => unmount()).not.toThrow();
  });

  it("should tolerate unmount when the subscription resolved to undefined", async () => {
    vi.mocked(onRepoChanged).mockResolvedValue(undefined as unknown as () => void);
    const { unmount } = renderHookWithProviders(() => useRepoChanged(1));
    await waitFor(() => expect(onRepoChanged).toHaveBeenCalledOnce());
    expect(() => unmount()).not.toThrow();
  });
});

// Contract: subscriptions are per repo; an event only invalidates its own repo's queries.
describe("useRepoChanged multi-repo isolation", () => {
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
    const { queryClient } = renderHookWithProviders(() => {
      useRepoChanged(1);
      useRepoChanged(2);
    });
    await waitFor(() => expect(handlers.size).toBe(2));
    queryClient.setQueryData(queryKeys.status(1), 1);
    queryClient.setQueryData(queryKeys.status(2), 1);
    handlers.get(1)?.();
    expect([
      queryClient.getQueryState(queryKeys.status(1))?.isInvalidated,
      queryClient.getQueryState(queryKeys.status(2))?.isInvalidated,
    ]).toEqual([true, false]);
  });

  it("should leave unrelated queries valid when an event fires", async () => {
    installPerRepoHandlers();
    const { queryClient } = renderHookWithProviders(() => useRepoChanged(1));
    await waitFor(() => expect(handlers.size).toBe(1));
    queryClient.setQueryData(queryKeys.recent, 1);
    handlers.get(1)?.();
    expect(queryClient.getQueryState(queryKeys.recent)?.isInvalidated).toBe(false);
  });

  it("should ignore events from the old subscription after repoId changes", async () => {
    installPerRepoHandlers();
    let id = 1;
    const { rerender, queryClient } = renderHookWithProviders(() => useRepoChanged(id));
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
});
