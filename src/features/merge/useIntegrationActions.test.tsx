import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortOperation,
  cherryPick,
  continueRebase,
  mergeBranch,
  rebaseOnto,
  resolveConflicts,
  revertCommit,
} from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useIntegrationActions } from "./useIntegrationActions";
import type { UseIntegrationActions } from "./useIntegrationActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  mergeBranch: vi.fn(),
  rebaseOnto: vi.fn(),
  cherryPick: vi.fn(),
  revertCommit: vi.fn(),
  abortOperation: vi.fn(),
  continueRebase: vi.fn(),
  resolveConflicts: vi.fn(),
}));

type Request = Parameters<UseIntegrationActions["run"]>[0];

const failure: AppError = { kind: "operationFailed", message: "git said no" };

async function run(actions: () => UseIntegrationActions, req: Request): Promise<AppError | null> {
  let out: AppError | null = null;
  await act(async () => {
    out = await actions().run(req);
  });
  return out;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(mergeBranch).mockResolvedValue("completed");
  vi.mocked(rebaseOnto).mockResolvedValue("completed");
  vi.mocked(cherryPick).mockResolvedValue("completed");
  vi.mocked(revertCommit).mockResolvedValue("completed");
  vi.mocked(abortOperation).mockResolvedValue(undefined);
  vi.mocked(continueRebase).mockResolvedValue("completed");
  vi.mocked(resolveConflicts).mockResolvedValue(undefined);
});

// Contract: each request calls its wrapper with the repo id and the given arguments.
describe("useIntegrationActions wrapper calls", () => {
  it("should call mergeBranch in merge mode when merge runs", async () => {
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    await run(() => result.current, { action: "merge", branch: "feature" });
    expect(mergeBranch).toHaveBeenCalledExactlyOnceWith(4, "feature", "merge");
  });

  it("should call mergeBranch in fastForward mode when fastForward runs", async () => {
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    await run(() => result.current, { action: "fastForward", branch: "feature" });
    expect(mergeBranch).toHaveBeenCalledExactlyOnceWith(4, "feature", "fastForward");
  });

  it("should call rebaseOnto when rebase runs", async () => {
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    await run(() => result.current, { action: "rebase", onto: "main" });
    expect(rebaseOnto).toHaveBeenCalledExactlyOnceWith(4, "main");
  });

  it("should call cherryPick when cherryPick runs", async () => {
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    await run(() => result.current, { action: "cherryPick", oid: "abc" });
    expect(cherryPick).toHaveBeenCalledExactlyOnceWith(4, "abc");
  });

  it("should call revertCommit when revert runs", async () => {
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    await run(() => result.current, { action: "revert", oid: "abc" });
    expect(revertCommit).toHaveBeenCalledExactlyOnceWith(4, "abc");
  });

  it("should call abortOperation when abort runs", async () => {
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    await run(() => result.current, { action: "abort" });
    expect(abortOperation).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("should call continueRebase when continue runs", async () => {
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    await run(() => result.current, { action: "continue" });
    expect(continueRebase).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("should call resolveConflicts with paths and side when resolve runs", async () => {
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    await run(() => result.current, { action: "resolve", paths: ["a", "b"], side: "theirs" });
    expect(resolveConflicts).toHaveBeenCalledExactlyOnceWith(4, ["a", "b"], "theirs");
  });
});

// Contract: run never rejects; it resolves null on success (including a conflicts outcome)
// and the AppError on failure.
describe("useIntegrationActions results", () => {
  it("should resolve null when the action completes", async () => {
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    expect(await run(() => result.current, { action: "merge", branch: "f" })).toBeNull();
  });

  it("should resolve null when the outcome is conflicts", async () => {
    vi.mocked(mergeBranch).mockResolvedValue("conflicts");
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    expect(await run(() => result.current, { action: "merge", branch: "f" })).toBeNull();
  });

  it("should leave error null when the outcome is conflicts", async () => {
    vi.mocked(rebaseOnto).mockResolvedValue("conflicts");
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    await run(() => result.current, { action: "rebase", onto: "main" });
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("should resolve the AppError when the wrapper rejects with one", async () => {
    vi.mocked(cherryPick).mockRejectedValue(failure);
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    expect(await run(() => result.current, { action: "cherryPick", oid: "a" })).toEqual(failure);
  });

  it("should expose the failure as error", async () => {
    vi.mocked(abortOperation).mockRejectedValue(failure);
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    await run(() => result.current, { action: "abort" });
    await waitFor(() => expect(result.current.error).toEqual(failure));
  });

  it("should map a non-AppError rejection to an io error", async () => {
    vi.mocked(continueRebase).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    const out = await run(() => result.current, { action: "continue" });
    expect(out).toEqual({ kind: "io", message: "boom" });
  });

  it("should clear the error when clearError is called", async () => {
    vi.mocked(revertCommit).mockRejectedValue(failure);
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    await run(() => result.current, { action: "revert", oid: "a" });
    act(() => result.current.clearError());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("should clear a previous error when the next run succeeds", async () => {
    vi.mocked(resolveConflicts).mockRejectedValueOnce(failure);
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    const req: Request = { action: "resolve", paths: ["a"], side: "ours" };
    await run(() => result.current, req);
    await run(() => result.current, req);
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("should not be pending before and after a run", async () => {
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    await waitFor(() => expect(result.current.pending).toBe(false));
    await run(() => result.current, { action: "abort" });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  it("should be pending while an action is in flight", async () => {
    let finish!: () => void;
    vi.mocked(abortOperation).mockReturnValue(
      new Promise<undefined>((r) => {
        finish = () => r(undefined);
      }),
    );
    const { result } = renderHookWithProviders(() => useIntegrationActions(4));
    let pending!: Promise<AppError | null>;
    act(() => {
      pending = result.current.run({ action: "abort" });
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => {
      finish();
      await pending;
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});

// Contract: the repo prefix is invalidated after success and after failure, since a failed
// operation may have partly applied.
describe("useIntegrationActions invalidation", () => {
  it("should invalidate the repo prefix after a success", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useIntegrationActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await run(() => result.current, { action: "merge", branch: "f" });
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.repo(4) });
  });

  it("should invalidate the repo prefix after a conflicts outcome", async () => {
    vi.mocked(mergeBranch).mockResolvedValue("conflicts");
    const { result, queryClient } = renderHookWithProviders(() => useIntegrationActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await run(() => result.current, { action: "merge", branch: "f" });
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.repo(4) });
  });

  it("should invalidate the repo prefix after a failure", async () => {
    vi.mocked(mergeBranch).mockRejectedValue(failure);
    const { result, queryClient } = renderHookWithProviders(() => useIntegrationActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await run(() => result.current, { action: "merge", branch: "f" });
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.repo(4) });
  });
});
