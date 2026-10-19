import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutCommit, resetToCommit } from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useCommitActions } from "./useCommitActions";
import type { CommitRequest } from "./useCommitActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  checkoutCommit: vi.fn(),
  resetToCommit: vi.fn(),
}));

const oid = "b".repeat(40);
const failed: AppError = { kind: "checkoutFailed", message: "local changes would be overwritten" };

type Actions = ReturnType<typeof useCommitActions>;

async function run(actions: () => Actions, req: CommitRequest): Promise<AppError | null> {
  let out: AppError | null = null;
  await act(async () => {
    out = await actions().run(req);
  });
  return out;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkoutCommit).mockResolvedValue(undefined);
  vi.mocked(resetToCommit).mockResolvedValue(undefined);
});

// Contract: each request calls its wrapper with the repo id and the given arguments.
describe("useCommitActions wrapper calls", () => {
  it("should call checkoutCommit with the repo id and oid when checkout runs", async () => {
    const { result } = renderHookWithProviders(() => useCommitActions(4));
    await run(() => result.current, { action: "checkout", oid });
    expect(checkoutCommit).toHaveBeenCalledExactlyOnceWith(4, oid);
  });

  it("should not call resetToCommit when checkout runs", async () => {
    const { result } = renderHookWithProviders(() => useCommitActions(4));
    await run(() => result.current, { action: "checkout", oid });
    expect(resetToCommit).not.toHaveBeenCalled();
  });

  it.each(["soft", "mixed", "hard"] as const)(
    "should call resetToCommit with mode %s when reset runs",
    async (mode) => {
      const { result } = renderHookWithProviders(() => useCommitActions(4));
      await run(() => result.current, { action: "reset", oid, mode });
      expect(resetToCommit).toHaveBeenCalledExactlyOnceWith(4, oid, mode);
    },
  );

  it("should not call checkoutCommit when reset runs", async () => {
    const { result } = renderHookWithProviders(() => useCommitActions(4));
    await run(() => result.current, { action: "reset", oid, mode: "hard" });
    expect(checkoutCommit).not.toHaveBeenCalled();
  });
});

// Contract: run never rejects; it resolves null on success and the AppError on failure.
describe("useCommitActions run result", () => {
  it("should resolve null when checkout succeeds", async () => {
    const { result } = renderHookWithProviders(() => useCommitActions(1));
    expect(await run(() => result.current, { action: "checkout", oid })).toBeNull();
  });

  it("should resolve null when reset succeeds", async () => {
    const { result } = renderHookWithProviders(() => useCommitActions(1));
    expect(await run(() => result.current, { action: "reset", oid, mode: "soft" })).toBeNull();
  });

  it("should resolve the AppError when checkout fails", async () => {
    vi.mocked(checkoutCommit).mockRejectedValue(failed);
    const { result } = renderHookWithProviders(() => useCommitActions(1));
    expect(await run(() => result.current, { action: "checkout", oid })).toEqual(failed);
  });

  it("should resolve the AppError when reset fails", async () => {
    vi.mocked(resetToCommit).mockRejectedValue({ kind: "git", message: "no" });
    const { result } = renderHookWithProviders(() => useCommitActions(1));
    const out = await run(() => result.current, { action: "reset", oid, mode: "hard" });
    expect(out).toEqual({ kind: "git", message: "no" });
  });

  it("should map a plain Error rejection to an io error with its message", async () => {
    vi.mocked(checkoutCommit).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useCommitActions(1));
    const out = await run(() => result.current, { action: "checkout", oid });
    expect(out).toEqual({ kind: "io", message: "boom" });
  });
});

// Contract: the repo prefix is invalidated after every settle, success or failure.
describe("useCommitActions invalidation", () => {
  it("should invalidate the repo prefix after a successful checkout", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useCommitActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await run(() => result.current, { action: "checkout", oid });
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.repo(4) });
  });

  it("should invalidate the repo prefix after a successful reset", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useCommitActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await run(() => result.current, { action: "reset", oid, mode: "mixed" });
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.repo(4) });
  });

  it("should invalidate the repo prefix after a failed checkout", async () => {
    vi.mocked(checkoutCommit).mockRejectedValue(failed);
    const { result, queryClient } = renderHookWithProviders(() => useCommitActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await run(() => result.current, { action: "checkout", oid });
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.repo(4) });
  });

  it("should not invalidate before anything runs", () => {
    const { queryClient } = renderHookWithProviders(() => useCommitActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    expect(spy).not.toHaveBeenCalled();
  });
});

// Contract: pending covers the call, error mirrors the last result and clearError resets it.
describe("useCommitActions state", () => {
  it("should start idle with a null error", () => {
    const { result } = renderHookWithProviders(() => useCommitActions(1));
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("should be pending while the call is in flight", async () => {
    let finish!: () => void;
    vi.mocked(checkoutCommit).mockReturnValue(
      new Promise<undefined>((resolve) => {
        finish = () => resolve(undefined);
      }),
    );
    const { result } = renderHookWithProviders(() => useCommitActions(1));
    let running!: Promise<AppError | null>;
    act(() => {
      running = result.current.run({ action: "checkout", oid });
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => {
      finish();
      await running;
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  it("should expose the AppError of a failed action as error", async () => {
    vi.mocked(checkoutCommit).mockRejectedValue(failed);
    const { result } = renderHookWithProviders(() => useCommitActions(1));
    await run(() => result.current, { action: "checkout", oid });
    await waitFor(() => expect(result.current.error).toEqual(failed));
  });

  it("should clear the error when clearError is called", async () => {
    vi.mocked(checkoutCommit).mockRejectedValue(failed);
    const { result } = renderHookWithProviders(() => useCommitActions(1));
    await run(() => result.current, { action: "checkout", oid });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => result.current.clearError());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("should replace the error with null after a later success", async () => {
    vi.mocked(checkoutCommit).mockRejectedValueOnce(failed).mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useCommitActions(1));
    await run(() => result.current, { action: "checkout", oid });
    await run(() => result.current, { action: "checkout", oid });
    await waitFor(() => expect(result.current.error).toBeNull());
  });
});
