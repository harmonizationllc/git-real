import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addLinkedWorktree,
  closeRepo,
  isLinkedWorktreeDirty,
  pruneLinkedWorktrees,
  removeLinkedWorktree,
} from "../../lib/ipc";
import type { AppError, OpenedRepo } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useRepoTabs } from "../../lib/store/repoTabs";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useLinkedWorktreeActions } from "./useLinkedWorktreeActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  addLinkedWorktree: vi.fn(),
  removeLinkedWorktree: vi.fn(),
  pruneLinkedWorktrees: vi.fn(),
  closeRepo: vi.fn(),
  isLinkedWorktreeDirty: vi.fn(),
}));

const repo = (id: number, path: string): OpenedRepo => ({
  id,
  summary: { path, name: path.split("/").at(-1) as string, headBranch: "main", isBare: false },
});

const pathExists: AppError = {
  kind: "pathExists",
  message: "`/x` already exists and is not empty",
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0] as number;
const tabIds = () => useRepoTabs.getState().tabs.map((t) => t.id);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(addLinkedWorktree).mockResolvedValue(undefined);
  vi.mocked(removeLinkedWorktree).mockResolvedValue(undefined);
  vi.mocked(pruneLinkedWorktrees).mockResolvedValue({ paths: [] });
  vi.mocked(closeRepo).mockResolvedValue(undefined);
  useRepoTabs.setState({ tabs: [], activeId: null });
  useRepoTabs.getState().openTab(repo(1, "/repos/app"));
  useRepoTabs.getState().openTab(repo(2, "/repos/app-feat-a"));
});

// Contract: add resolves null or the AppError, and refreshes the repo and the recent list.
describe("useLinkedWorktreeActions add", () => {
  it("should resolve null and invalidate the repo and recent queries", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.add("/repos/app-x", { kind: "existing", name: "x" });
    });
    expect(outcome).toBeNull();
    expect(addLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-x", {
      kind: "existing",
      name: "x",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.repo(1) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.recent });
    expect(result.current.error).toBeNull();
  });

  it("should resolve the AppError of a rejected add and set error", async () => {
    vi.mocked(addLinkedWorktree).mockRejectedValue(pathExists);
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.add("/x", { kind: "new", name: "x", start: null });
    });
    expect(outcome).toEqual(pathExists);
    expect(result.current.error).toEqual(pathExists);
  });

  it("should map a plain Error to an io error", async () => {
    vi.mocked(addLinkedWorktree).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    await act(() => result.current.add("/x", { kind: "existing", name: "x" }));
    expect(result.current.error).toEqual({ kind: "io", message: "boom" });
  });

  it("should clear the error with clearError", async () => {
    vi.mocked(addLinkedWorktree).mockRejectedValue(pathExists);
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    await act(() => result.current.add("/x", { kind: "existing", name: "x" }));
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it("should clear an earlier error when the next action starts", async () => {
    vi.mocked(addLinkedWorktree).mockRejectedValueOnce(pathExists);
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    await act(() => result.current.add("/x", { kind: "existing", name: "x" }));
    await act(() => result.current.add("/y", { kind: "existing", name: "y" }));
    expect(result.current.error).toBeNull();
  });
});

// Contract: remove closes the tabs on the target path first, then runs the command.
describe("useLinkedWorktreeActions remove", () => {
  it("should close the tab on the path before removing it", async () => {
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.remove("/repos/app-feat-a", false);
    });
    expect(outcome).toBeNull();
    expect(closeRepo).toHaveBeenCalledExactlyOnceWith(2);
    expect(removeLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-feat-a", false);
    expect(order(closeRepo)).toBeLessThan(order(removeLinkedWorktree));
    expect(tabIds()).toEqual([1]);
  });

  it("should pass force through", async () => {
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    await act(() => result.current.remove("/repos/app-feat-a", true));
    expect(removeLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-feat-a", true);
  });

  it("should leave the tab closed when the remove fails", async () => {
    const dirty: AppError = { kind: "worktreeDirty", message: "dirty" };
    vi.mocked(removeLinkedWorktree).mockRejectedValue(dirty);
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.remove("/repos/app-feat-a", false);
    });
    expect(outcome).toEqual(dirty);
    expect(result.current.error).toEqual(dirty);
    expect(tabIds()).toEqual([1]);
  });

  it("should not run the remove until closeRepo settles", async () => {
    const gate = deferred<undefined>();
    vi.mocked(closeRepo).mockReturnValue(gate.promise);
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    let done!: Promise<AppError | null>;
    act(() => {
      done = result.current.remove("/repos/app-feat-a", false);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(removeLinkedWorktree).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve(undefined);
      await done;
    });
    expect(removeLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-feat-a", false);
  });

  it("should still remove when closeRepo rejects with unknownRepo", async () => {
    vi.mocked(closeRepo).mockRejectedValue({ kind: "unknownRepo", message: "unknown repo 2" });
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.remove("/repos/app-feat-a", false);
    });
    expect(outcome).toBeNull();
    expect(removeLinkedWorktree).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-feat-a", false);
  });

  it("should close no tab when none is on the path", async () => {
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    await act(() => result.current.remove("/elsewhere", false));
    expect(closeRepo).not.toHaveBeenCalled();
    expect(tabIds()).toEqual([1, 2]);
  });
});

// Contract: checkDirty asks the backend without closing anything, and counts as pending.
describe("useLinkedWorktreeActions checkDirty", () => {
  it("should resolve the boolean without closing a tab", async () => {
    vi.mocked(isLinkedWorktreeDirty).mockResolvedValue(true);
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.checkDirty("/repos/app-feat-a");
    });
    expect(outcome).toBe(true);
    expect(isLinkedWorktreeDirty).toHaveBeenCalledExactlyOnceWith(1, "/repos/app-feat-a");
    expect(closeRepo).not.toHaveBeenCalled();
    expect(tabIds()).toEqual([1, 2]);
    expect(result.current.error).toBeNull();
  });

  it("should resolve the AppError of a failed check and set error", async () => {
    const failed: AppError = { kind: "git", message: "status failed" };
    vi.mocked(isLinkedWorktreeDirty).mockRejectedValue(failed);
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.checkDirty("/repos/app-feat-a");
    });
    expect(outcome).toEqual(failed);
    expect(result.current.error).toEqual(failed);
  });

  it("should be pending while the check runs", async () => {
    const gate = deferred<boolean>();
    vi.mocked(isLinkedWorktreeDirty).mockReturnValue(gate.promise);
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    let done!: Promise<boolean | AppError>;
    act(() => {
      done = result.current.checkDirty("/repos/app-feat-a");
    });
    expect(result.current.pending).toBe(true);
    await act(async () => {
      gate.resolve(false);
      await done;
    });
    expect(result.current.pending).toBe(false);
  });
});

// Contract: prune closes the tabs on the stale paths first, then runs the command.
describe("useLinkedWorktreeActions prune", () => {
  it("should close a tab on a pruned path, then prune", async () => {
    useRepoTabs.getState().openTab(repo(3, "/x"));
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.prune(["/x"]);
    });
    expect(outcome).toBeNull();
    expect(closeRepo).toHaveBeenCalledExactlyOnceWith(3);
    expect(pruneLinkedWorktrees).toHaveBeenCalledExactlyOnceWith(1);
    expect(order(closeRepo)).toBeLessThan(order(pruneLinkedWorktrees));
    expect(tabIds()).toEqual([1, 2]);
  });

  it("should not prune until closeRepo settles", async () => {
    useRepoTabs.getState().openTab(repo(3, "/x"));
    const gate = deferred<undefined>();
    vi.mocked(closeRepo).mockReturnValue(gate.promise);
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    let done!: Promise<AppError | null>;
    act(() => {
      done = result.current.prune(["/x"]);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(pruneLinkedWorktrees).not.toHaveBeenCalled();
    await act(async () => {
      gate.resolve(undefined);
      await done;
    });
    expect(pruneLinkedWorktrees).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("should resolve the AppError of a failed prune", async () => {
    const failed: AppError = { kind: "operationFailed", message: "worktree prune failed" };
    vi.mocked(pruneLinkedWorktrees).mockRejectedValue(failed);
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.prune([]);
    });
    expect(outcome).toEqual(failed);
  });
});

// Contract: pending is true while any worktree action of the repo runs.
describe("useLinkedWorktreeActions pending", () => {
  it("should start idle", () => {
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    expect([result.current.pending, result.current.error]).toEqual([false, null]);
  });

  it("should be pending while a call is in flight", async () => {
    const gate = deferred<undefined>();
    vi.mocked(removeLinkedWorktree).mockReturnValue(gate.promise);
    const { result } = renderHookWithProviders(() => useLinkedWorktreeActions(1));
    let done!: Promise<AppError | null>;
    act(() => {
      done = result.current.remove("/repos/app-feat-a", false);
    });
    expect(result.current.pending).toBe(true);
    await act(async () => {
      gate.resolve(undefined);
      await done;
    });
    expect(result.current.pending).toBe(false);
  });

  it("should see an action running in another instance of the same repo", async () => {
    const gate = deferred<undefined>();
    vi.mocked(addLinkedWorktree).mockReturnValue(gate.promise);
    const { result } = renderHookWithProviders(() => ({
      a: useLinkedWorktreeActions(1),
      b: useLinkedWorktreeActions(1),
    }));
    act(() => {
      void result.current.a.add("/x", { kind: "existing", name: "x" });
    });
    await waitFor(() => expect(result.current.b.pending).toBe(true));
    await act(async () => gate.resolve(undefined));
    await waitFor(() => expect(result.current.b.pending).toBe(false));
  });
});
