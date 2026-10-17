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

// Runs an action inside act and swallows a rejection, so tests assert on hook state instead.
async function run(call: () => unknown): Promise<void> {
  await act(async () => {
    try {
      await call();
    } catch {
      /* state is asserted by the tests */
    }
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
    await waitFor(() => expect(result.current.error).toEqual(noChanges));
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
});
