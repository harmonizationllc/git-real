import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addToGitignore,
  discardPaths,
  stageAll,
  stagePaths,
  unstageAll,
  unstagePaths,
} from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useWorktreeActions } from "./useWorktreeActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  stagePaths: vi.fn(),
  unstagePaths: vi.fn(),
  stageAll: vi.fn(),
  unstageAll: vi.fn(),
  discardPaths: vi.fn(),
  addToGitignore: vi.fn(),
}));

type Actions = ReturnType<typeof useWorktreeActions>;

const noChanges: AppError = { kind: "noChanges", message: "nothing to do" };

// Runs an action inside act; actions never reject, failures surface through hook state.
async function run(call: () => unknown): Promise<void> {
  await act(async () => {
    await call();
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(stagePaths).mockResolvedValue(undefined);
  vi.mocked(unstagePaths).mockResolvedValue(undefined);
  vi.mocked(stageAll).mockResolvedValue(undefined);
  vi.mocked(unstageAll).mockResolvedValue(undefined);
  vi.mocked(discardPaths).mockResolvedValue(undefined);
  vi.mocked(addToGitignore).mockResolvedValue("/a.txt");
});

// Contract: each action calls its wrapper with the repo id and the given arguments.
describe("useWorktreeActions wrapper calls", () => {
  it("should call stagePaths with the repo id and paths when stage runs", async () => {
    const { result } = renderHookWithProviders(() => useWorktreeActions(4));
    await run(() => result.current.stage(["a", "b"]));
    expect(stagePaths).toHaveBeenCalledExactlyOnceWith(4, ["a", "b"]);
  });

  it("should call unstagePaths with the repo id and paths when unstage runs", async () => {
    const { result } = renderHookWithProviders(() => useWorktreeActions(4));
    await run(() => result.current.unstage(["a"]));
    expect(unstagePaths).toHaveBeenCalledExactlyOnceWith(4, ["a"]);
  });

  it("should call stageAll with the repo id when stageAll runs", async () => {
    const { result } = renderHookWithProviders(() => useWorktreeActions(4));
    await run(() => result.current.stageAll());
    expect(stageAll).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("should call unstageAll with the repo id when unstageAll runs", async () => {
    const { result } = renderHookWithProviders(() => useWorktreeActions(4));
    await run(() => result.current.unstageAll());
    expect(unstageAll).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("should call discardPaths with the repo id and paths when discard runs", async () => {
    const { result } = renderHookWithProviders(() => useWorktreeActions(4));
    await run(() => result.current.discard(["a"]));
    expect(discardPaths).toHaveBeenCalledExactlyOnceWith(4, ["a"]);
  });

  it("should call addToGitignore with the repo id and path when addToGitignore runs", async () => {
    const { result } = renderHookWithProviders(() => useWorktreeActions(4));
    await run(() => result.current.addToGitignore("a.txt"));
    expect(addToGitignore).toHaveBeenCalledExactlyOnceWith(4, "a.txt");
  });
});

// Contract: every action invalidates the repo key once it settles, on success and on failure.
describe("useWorktreeActions invalidation", () => {
  const cases: [string, (a: Actions) => unknown][] = [
    ["stage", (a) => a.stage(["a"])],
    ["unstage", (a) => a.unstage(["a"])],
    ["stageAll", (a) => a.stageAll()],
    ["unstageAll", (a) => a.unstageAll()],
    ["discard", (a) => a.discard(["a"])],
    ["addToGitignore", (a) => a.addToGitignore("a")],
  ];

  it.each(cases)("should invalidate the repo key when %s succeeds", async (_n, call) => {
    const { result, queryClient } = renderHookWithProviders(() => useWorktreeActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await run(() => call(result.current));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ["repo", 4] }));
  });

  it.each(cases)("should invalidate the repo key when %s fails", async (_n, call) => {
    vi.mocked(stagePaths).mockRejectedValue(noChanges);
    vi.mocked(unstagePaths).mockRejectedValue(noChanges);
    vi.mocked(stageAll).mockRejectedValue(noChanges);
    vi.mocked(unstageAll).mockRejectedValue(noChanges);
    vi.mocked(discardPaths).mockRejectedValue(noChanges);
    vi.mocked(addToGitignore).mockRejectedValue(noChanges);
    const { result, queryClient } = renderHookWithProviders(() => useWorktreeActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await run(() => call(result.current));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ["repo", 4] }));
  });
});

// Contract: pending is true while an action is in flight.
describe("useWorktreeActions pending", () => {
  it("should start not pending", () => {
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    expect(result.current.pending).toBe(false);
  });

  it("should be pending while an action is in flight and idle after it settles", async () => {
    let finish!: () => void;
    vi.mocked(stagePaths).mockReturnValue(new Promise<void>((r) => (finish = r)));
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    let call!: Promise<unknown>;
    act(() => {
      call = Promise.resolve(result.current.stage(["a"]));
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => {
      finish();
      await call;
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  it("should be pending while stageAll is in flight", async () => {
    vi.mocked(stageAll).mockReturnValue(new Promise<void>(() => {}));
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    act(() => {
      void result.current.stageAll();
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
  });

  it("should not be pending after an action fails", async () => {
    vi.mocked(stagePaths).mockRejectedValue(noChanges);
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    await run(() => result.current.stage(["a"]));
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});

// Contract: failures surface as an AppError; anything else is coerced to an io error.
describe("useWorktreeActions errors", () => {
  it("should start with a null error", () => {
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    expect(result.current.error).toBeNull();
  });

  it("should expose an AppError rejection as error", async () => {
    vi.mocked(stagePaths).mockRejectedValue(noChanges);
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    await run(() => result.current.stage(["a"]));
    await waitFor(() => expect(result.current.error).toBe(noChanges));
  });

  it("should expose an AppError from discard as error", async () => {
    const err: AppError = { kind: "io", message: "denied" };
    vi.mocked(discardPaths).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    await run(() => result.current.discard(["a"]));
    await waitFor(() => expect(result.current.error).toEqual(err));
  });

  it("should map a plain Error rejection to an io error with its message", async () => {
    vi.mocked(unstageAll).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    await run(() => result.current.unstageAll());
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });

  it("should map a non-Error rejection to an io error with its string form", async () => {
    vi.mocked(addToGitignore).mockRejectedValue("x");
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    await run(() => result.current.addToGitignore("a"));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "x" }));
  });

  it("should reset error when clearError is called", async () => {
    vi.mocked(stagePaths).mockRejectedValue(noChanges);
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    await run(() => result.current.stage(["a"]));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => result.current.clearError());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("should clear a previous error when the next action succeeds", async () => {
    vi.mocked(stagePaths).mockRejectedValueOnce(noChanges).mockResolvedValueOnce(undefined);
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    await run(() => result.current.stage(["a"]));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    await run(() => result.current.stage(["a"]));
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("should clear a previous error as soon as the next action starts", async () => {
    vi.mocked(stagePaths).mockRejectedValueOnce(noChanges);
    vi.mocked(stageAll).mockReturnValue(new Promise<void>(() => {}));
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    await run(() => result.current.stage(["a"]));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => result.current.stageAll());
    await waitFor(() => expect(result.current.pending).toBe(true));
    expect(result.current.error).toBeNull();
  });
});

// Contract: pending stays true until the repo invalidation triggered on settle has resolved.
describe("useWorktreeActions pending until invalidated", () => {
  it("should stay pending until the invalidation promise resolves", async () => {
    let release!: () => void;
    const { result, queryClient } = renderHookWithProviders(() => useWorktreeActions(1));
    const spy = vi
      .spyOn(queryClient, "invalidateQueries")
      .mockReturnValue(new Promise<void>((r) => (release = r)));
    act(() => result.current.stage(["a"]));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(result.current.pending).toBe(true);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});

// Contract (pinned behaviour): mutate is not serialised, so a second action while one is
// pending runs in parallel; it is neither queued nor dropped.
describe("useWorktreeActions overlapping actions", () => {
  it("should start a second action immediately while the first is still pending", async () => {
    vi.mocked(stagePaths).mockReturnValue(new Promise<void>(() => {}));
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    act(() => result.current.stage(["a"]));
    await waitFor(() => expect(result.current.pending).toBe(true));
    act(() => result.current.unstage(["b"]));
    expect(stagePaths).toHaveBeenCalledExactlyOnceWith(1, ["a"]);
    await waitFor(() => expect(unstagePaths).toHaveBeenCalledExactlyOnceWith(1, ["b"]));
    expect(stagePaths).toHaveBeenCalledOnce();
  });

  it("should invalidate once per settled action when two run in parallel", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useWorktreeActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await run(() => {
      result.current.stage(["a"]);
      result.current.stageAll();
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(stagePaths).toHaveBeenCalledOnce();
    expect(stageAll).toHaveBeenCalledOnce();
  });
});

describe("useWorktreeActions edges", () => {
  it("should return nothing from addToGitignore, dropping the resolved pattern", async () => {
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    let returned: unknown = "unset";
    await run(() => {
      returned = result.current.addToGitignore("a.txt");
    });
    expect(returned).toBeUndefined();
    expect(addToGitignore).toHaveBeenCalledExactlyOnceWith(1, "a.txt");
  });

  it("should not surface an addToGitignore rejection as an unhandled rejection", async () => {
    vi.mocked(addToGitignore).mockRejectedValue(noChanges);
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    await run(() => result.current.addToGitignore("a"));
    await waitFor(() => expect(result.current.error).toEqual(noChanges));
  });

  it("should leave pending false and error null after clearError following a failure", async () => {
    vi.mocked(discardPaths).mockRejectedValue(noChanges);
    const { result } = renderHookWithProviders(() => useWorktreeActions(1));
    await run(() => result.current.discard(["a"]));
    await waitFor(() => expect(result.current.error).toEqual(noChanges));
    act(() => result.current.clearError());
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.pending).toBe(false);
  });

  it("should invalidate only the acting repo's key, not another repo's", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useWorktreeActions(4));
    queryClient.setQueryData(["repo", 4, "status"], 1);
    queryClient.setQueryData(["repo", 5, "status"], 1);
    await run(() => result.current.stageAll());
    await waitFor(() =>
      expect(queryClient.getQueryState(["repo", 4, "status"])?.isInvalidated).toBe(true),
    );
    expect(queryClient.getQueryState(["repo", 5, "status"])?.isInvalidated).toBe(false);
  });
});
