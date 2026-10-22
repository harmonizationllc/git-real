import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addRemote, removeRemote, updateRemote } from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useRemoteActions } from "./useRemoteActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  addRemote: vi.fn(),
  updateRemote: vi.fn(),
  removeRemote: vi.fn(),
}));

const exists: AppError = { kind: "remoteExists", message: "taken" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<undefined>((res) => {
    resolve = () => res(undefined);
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(addRemote).mockResolvedValue(undefined);
  vi.mocked(updateRemote).mockResolvedValue(undefined);
  vi.mocked(removeRemote).mockResolvedValue(undefined);
});

// Contract: each action calls its wrapper with the repo id and arguments and resolves null on success.
describe("useRemoteActions calls", () => {
  it("add calls addRemote with name, url and push URL and resolves null", async () => {
    const { result } = renderHookWithProviders(() => useRemoteActions(3));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.add("up", "/srv/up.git", "/srv/push.git");
    });
    expect(addRemote).toHaveBeenCalledExactlyOnceWith(3, "up", "/srv/up.git", "/srv/push.git");
    expect(outcome).toBeNull();
  });

  it("add passes a null push URL through", async () => {
    const { result } = renderHookWithProviders(() => useRemoteActions(3));
    await act(() => result.current.add("up", "/srv/up.git", null));
    expect(addRemote).toHaveBeenCalledExactlyOnceWith(3, "up", "/srv/up.git", null);
  });

  it("update calls updateRemote with name, new name, url and push URL", async () => {
    const { result } = renderHookWithProviders(() => useRemoteActions(3));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.update("up", "upstream", "/srv/u.git", null);
    });
    expect(updateRemote).toHaveBeenCalledExactlyOnceWith(3, "up", "upstream", "/srv/u.git", null);
    expect(outcome).toBeNull();
  });

  it("remove calls removeRemote", async () => {
    const { result } = renderHookWithProviders(() => useRemoteActions(3));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.remove("up");
    });
    expect(removeRemote).toHaveBeenCalledExactlyOnceWith(3, "up");
    expect(outcome).toBeNull();
  });
});

// Contract: failures resolve with the AppError and never reject.
describe("useRemoteActions errors", () => {
  it("a rejection resolves with the AppError", async () => {
    vi.mocked(addRemote).mockRejectedValue(exists);
    const { result } = renderHookWithProviders(() => useRemoteActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.add("up", "/srv/up.git", null);
    });
    expect(outcome).toEqual(exists);
  });

  it("an update rejection resolves with the AppError", async () => {
    vi.mocked(updateRemote).mockRejectedValue(exists);
    const { result } = renderHookWithProviders(() => useRemoteActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.update("a", "b", "/x", null);
    });
    expect(outcome).toEqual(exists);
  });

  it("a remove rejection resolves with the AppError", async () => {
    vi.mocked(removeRemote).mockRejectedValue({ kind: "remoteNotFound", message: "gone" });
    const { result } = renderHookWithProviders(() => useRemoteActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.remove("a");
    });
    expect(outcome).toEqual({ kind: "remoteNotFound", message: "gone" });
  });

  it("a plain Error rejection becomes an io AppError", async () => {
    vi.mocked(removeRemote).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useRemoteActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.remove("a");
    });
    expect(outcome).toEqual({ kind: "io", message: "boom" });
  });
});

// Contract: pending is true only while an action runs.
describe("useRemoteActions pending", () => {
  it("is false when idle", () => {
    const { result } = renderHookWithProviders(() => useRemoteActions(1));
    expect(result.current.pending).toBe(false);
  });

  it("is true while an action runs and false after", async () => {
    const d = deferred();
    vi.mocked(addRemote).mockReturnValue(d.promise);
    const { result } = renderHookWithProviders(() => useRemoteActions(1));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.add("up", "/x", null);
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => {
      d.resolve();
      await done;
    });
    expect(result.current.pending).toBe(false);
  });

  it("is false after a failed action", async () => {
    vi.mocked(removeRemote).mockRejectedValue(exists);
    const { result } = renderHookWithProviders(() => useRemoteActions(1));
    await act(() => result.current.remove("a"));
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});

// Contract: every settle refreshes the repo's queries (remotes, branches, ...) and no other repo's.
describe("useRemoteActions invalidation", () => {
  const repoKey = { queryKey: ["repo", 1] };

  it("invalidates the repo queries after success", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRemoteActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.add("up", "/x", null));
    expect(spy).toHaveBeenCalledWith(repoKey);
  });

  it("invalidates the repo queries after failure", async () => {
    vi.mocked(updateRemote).mockRejectedValue(exists);
    const { result, queryClient } = renderHookWithProviders(() => useRemoteActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.update("a", "b", "/x", null));
    expect(spy).toHaveBeenCalledWith(repoKey);
  });

  it("does not invalidate another repo", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRemoteActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.remove("a"));
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ["repo", 2] });
  });
});
