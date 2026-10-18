import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkoutBranch,
  checkoutRemoteBranch,
  createBranch,
  deleteBranch,
  deleteRemoteBranch,
  renameBranch,
} from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useBranchActions } from "./useBranchActions";
import type { UseBranchActions } from "./useBranchActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  createBranch: vi.fn(),
  renameBranch: vi.fn(),
  deleteBranch: vi.fn(),
  checkoutBranch: vi.fn(),
  checkoutRemoteBranch: vi.fn(),
  deleteRemoteBranch: vi.fn(),
}));

type Request = Parameters<UseBranchActions["run"]>[0];

const exists: AppError = { kind: "branchExists", message: "taken" };
const created = { name: "topic", oid: "a".repeat(40), isHead: true, tracking: null };

// Runs a request inside act and returns what run resolved with.
async function run(actions: () => UseBranchActions, req: Request): Promise<AppError | null> {
  let out: AppError | null = null;
  await act(async () => {
    out = await actions().run(req);
  });
  return out;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createBranch).mockResolvedValue(created);
  vi.mocked(renameBranch).mockResolvedValue(undefined);
  vi.mocked(deleteBranch).mockResolvedValue(undefined);
  vi.mocked(checkoutBranch).mockResolvedValue(undefined);
  vi.mocked(checkoutRemoteBranch).mockResolvedValue(undefined);
  vi.mocked(deleteRemoteBranch).mockResolvedValue(undefined);
});

// Contract: each request calls its wrapper with the repo id and the given arguments.
describe("useBranchActions wrapper calls", () => {
  it("should call createBranch with name, start point and checkout when create runs", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    await run(() => result.current, {
      action: "create",
      name: "topic",
      startPoint: "main",
      checkout: true,
    });
    expect(createBranch).toHaveBeenCalledExactlyOnceWith(4, "topic", "main", true);
  });

  it("should pass a null start point and checkout false through when create runs", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    await run(() => result.current, {
      action: "create",
      name: "topic",
      startPoint: null,
      checkout: false,
    });
    expect(createBranch).toHaveBeenCalledExactlyOnceWith(4, "topic", null, false);
  });

  it("should call renameBranch with the old and new name when rename runs", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    await run(() => result.current, { action: "rename", oldName: "a", newName: "b" });
    expect(renameBranch).toHaveBeenCalledExactlyOnceWith(4, "a", "b");
  });

  it("should call deleteBranch without force when delete runs unforced", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    await run(() => result.current, { action: "delete", name: "a", force: false });
    expect(deleteBranch).toHaveBeenCalledExactlyOnceWith(4, "a", false);
  });

  it("should call deleteBranch with force when delete runs forced", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    await run(() => result.current, { action: "delete", name: "a", force: true });
    expect(deleteBranch).toHaveBeenCalledExactlyOnceWith(4, "a", true);
  });

  it("should call checkoutBranch with the name when checkout runs", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    await run(() => result.current, { action: "checkout", name: "a" });
    expect(checkoutBranch).toHaveBeenCalledExactlyOnceWith(4, "a");
  });

  it("should call checkoutRemoteBranch with remote and name when checkoutRemote runs", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    await run(() => result.current, { action: "checkoutRemote", remote: "origin", name: "a" });
    expect(checkoutRemoteBranch).toHaveBeenCalledExactlyOnceWith(4, "origin", "a");
  });

  it("should call deleteRemoteBranch with remote and name when deleteRemote runs", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    await run(() => result.current, { action: "deleteRemote", remote: "origin", name: "a" });
    expect(deleteRemoteBranch).toHaveBeenCalledExactlyOnceWith(4, "origin", "a");
  });

  it("should not call any other wrapper when checkout runs", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    await run(() => result.current, { action: "checkout", name: "a" });
    expect(checkoutRemoteBranch).not.toHaveBeenCalled();
    expect(deleteBranch).not.toHaveBeenCalled();
  });
});

// Contract: run never rejects; it resolves null on success and the AppError on failure.
describe("useBranchActions run result", () => {
  it("should resolve null when the action succeeds", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    expect(await run(() => result.current, { action: "checkout", name: "a" })).toBeNull();
  });

  it("should resolve null when create succeeds", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    const req: Request = { action: "create", name: "t", startPoint: null, checkout: true };
    expect(await run(() => result.current, req)).toBeNull();
  });

  it("should resolve the AppError when the action fails", async () => {
    vi.mocked(createBranch).mockRejectedValue(exists);
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    const req: Request = { action: "create", name: "t", startPoint: null, checkout: true };
    expect(await run(() => result.current, req)).toEqual(exists);
  });

  it.each<[string, Request]>([
    ["rename", { action: "rename", oldName: "a", newName: "b" }],
    ["delete", { action: "delete", name: "a", force: false }],
    ["checkout", { action: "checkout", name: "a" }],
    ["checkoutRemote", { action: "checkoutRemote", remote: "origin", name: "a" }],
    ["deleteRemote", { action: "deleteRemote", remote: "origin", name: "a" }],
  ])("should resolve the AppError when %s fails", async (_n, req) => {
    const err: AppError = { kind: "checkoutFailed", message: "no" };
    vi.mocked(renameBranch).mockRejectedValue(err);
    vi.mocked(deleteBranch).mockRejectedValue(err);
    vi.mocked(checkoutBranch).mockRejectedValue(err);
    vi.mocked(checkoutRemoteBranch).mockRejectedValue(err);
    vi.mocked(deleteRemoteBranch).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    expect(await run(() => result.current, req)).toEqual(err);
  });

  it("should map a plain Error rejection to an io error with its message", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    const out = await run(() => result.current, { action: "checkout", name: "a" });
    expect(out).toEqual({ kind: "io", message: "boom" });
  });

  it("should map a non-Error rejection to an AppError", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue("weird");
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    const out = await run(() => result.current, { action: "checkout", name: "a" });
    expect(out?.kind).toBe("io");
  });
});

// Contract: error mirrors the last result and clearError resets it.
describe("useBranchActions error state", () => {
  it("should start with a null error", () => {
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    expect(result.current.error).toBeNull();
  });

  it("should expose the AppError of a failed action as error", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue(exists);
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "checkout", name: "a" });
    await waitFor(() => expect(result.current.error).toEqual(exists));
  });

  it("should clear the error when clearError is called", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue(exists);
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "checkout", name: "a" });
    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => result.current.clearError());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("should replace the error with null after a later success", async () => {
    vi.mocked(checkoutBranch).mockRejectedValueOnce(exists).mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "checkout", name: "a" });
    await run(() => result.current, { action: "checkout", name: "a" });
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("should keep a null error after a success", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "checkout", name: "a" });
    expect(result.current.error).toBeNull();
  });
});

// Contract: every request invalidates the repo key once it settles, on success and on failure.
describe("useBranchActions invalidation", () => {
  const cases: [string, Request][] = [
    ["create", { action: "create", name: "t", startPoint: null, checkout: true }],
    ["rename", { action: "rename", oldName: "a", newName: "b" }],
    ["delete", { action: "delete", name: "a", force: false }],
    ["checkout", { action: "checkout", name: "a" }],
    ["checkoutRemote", { action: "checkoutRemote", remote: "origin", name: "a" }],
    ["deleteRemote", { action: "deleteRemote", remote: "origin", name: "a" }],
  ];

  it.each(cases)("should invalidate the repo key when %s succeeds", async (_n, req) => {
    const { result, queryClient } = renderHookWithProviders(() => useBranchActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await run(() => result.current, req);
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ["repo", 4] }));
  });

  it.each(cases)("should invalidate the repo key when %s fails", async (_n, req) => {
    vi.mocked(createBranch).mockRejectedValue(exists);
    vi.mocked(renameBranch).mockRejectedValue(exists);
    vi.mocked(deleteBranch).mockRejectedValue(exists);
    vi.mocked(checkoutBranch).mockRejectedValue(exists);
    vi.mocked(checkoutRemoteBranch).mockRejectedValue(exists);
    vi.mocked(deleteRemoteBranch).mockRejectedValue(exists);
    const { result, queryClient } = renderHookWithProviders(() => useBranchActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await run(() => result.current, req);
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ["repo", 4] }));
  });
});

// Contract: pending is true while a request is in flight.
describe("useBranchActions pending", () => {
  it("should start not pending", () => {
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    expect(result.current.pending).toBe(false);
  });

  it("should be pending while a request is in flight and idle after it settles", async () => {
    let finish!: () => void;
    vi.mocked(checkoutBranch).mockReturnValue(new Promise<void>((r) => (finish = r)));
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    let call!: Promise<unknown>;
    act(() => {
      call = result.current.run({ action: "checkout", name: "a" });
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => {
      finish();
      await call;
    });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });

  it("should not be pending after a request fails", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue(exists);
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "checkout", name: "a" });
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});

// Contract: with overlapping runs, `error` and `pending` follow the most recent run.
describe("useBranchActions overlapping runs", () => {
  const other: AppError = { kind: "checkoutFailed", message: "dirty tree" };

  function gate<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("should expose the error of the latest run when an earlier run settles afterwards", async () => {
    const first = gate<undefined>();
    vi.mocked(checkoutBranch).mockReturnValueOnce(first.promise).mockRejectedValueOnce(other);
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    let firstResult: AppError | null | undefined;
    act(() => {
      void result.current.run({ action: "checkout", name: "a" }).then((e) => (firstResult = e));
    });
    await run(() => result.current, { action: "checkout", name: "b" });
    await waitFor(() => expect(result.current.error).toEqual(other));
    await act(async () => {
      first.resolve(undefined);
      await first.promise;
    });
    expect(firstResult).toBeNull();
    expect(result.current.error).toEqual(other);
  });

  it("should resolve each run with its own outcome", async () => {
    const first = gate<undefined>();
    vi.mocked(checkoutBranch).mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    let firstResult: AppError | null | undefined;
    act(() => {
      void result.current.run({ action: "checkout", name: "a" }).then((e) => (firstResult = e));
    });
    const second = await run(() => result.current, { action: "checkout", name: "b" });
    expect(second).toBeNull();
    await act(async () => {
      first.reject(exists);
      await first.promise.catch(() => undefined);
    });
    expect(firstResult).toEqual(exists);
  });
});

// Contract: clearError only resets the mutation state; it never fails or alters a success.
describe("useBranchActions clearError after success", () => {
  it("should leave the error null and not throw when cleared after a success", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "checkout", name: "a" });
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
  });
});
