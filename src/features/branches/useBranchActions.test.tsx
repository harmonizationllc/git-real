import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkoutBranch,
  checkoutRemoteBranch,
  createBranch,
  deleteBranches,
  renameBranch,
  setBranchUpstream,
} from "../../lib/ipc";
import type {
  AppError,
  AutoStash,
  BranchDeleteOutcome,
  CheckoutOutcome,
  CreatedBranch,
} from "../../lib/ipc";
import { useAutoFetchState } from "../../lib/store/autoFetch";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { toastAutoStash } from "../checkout/autoStashToast";
import { useBranchActions } from "./useBranchActions";
import type { UseBranchActions } from "./useBranchActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  createBranch: vi.fn(),
  renameBranch: vi.fn(),
  deleteBranches: vi.fn(),
  checkoutBranch: vi.fn(),
  checkoutRemoteBranch: vi.fn(),
  setBranchUpstream: vi.fn(),
}));
vi.mock(import("../checkout/autoStashToast"), async (importOriginal) => ({
  ...(await importOriginal()),
  toastAutoStash: vi.fn(),
}));

type Request = Parameters<UseBranchActions["run"]>[0];

const exists: AppError = { kind: "branchExists", message: "taken" };
const created: CreatedBranch = {
  branch: { name: "topic", oid: "a".repeat(40), isHead: true, tracking: null, worktree: null },
  autoStash: null,
};
const noStash: CheckoutOutcome = { autoStash: null };
const deletedA: BranchDeleteOutcome[] = [{ name: "a", status: { kind: "deleted" } }];

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
  vi.mocked(deleteBranches).mockResolvedValue(deletedA);
  vi.mocked(checkoutBranch).mockResolvedValue(noStash);
  vi.mocked(checkoutRemoteBranch).mockResolvedValue(noStash);
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

  it("should call deleteBranches with the names and force and resolve the outcomes", async () => {
    const outcomes: BranchDeleteOutcome[] = [{ name: "a", status: { kind: "deleted" } }];
    vi.mocked(deleteBranches).mockResolvedValue(outcomes);
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    let out: BranchDeleteOutcome[] | AppError | null = null;
    await act(async () => {
      out = await result.current.deleteBranches(["a", "b"], true);
    });
    expect(out).toEqual(outcomes);
    expect(deleteBranches).toHaveBeenCalledExactlyOnceWith(4, ["a", "b"], true);
  });

  it("should resolve the AppError when deleteBranches rejects", async () => {
    vi.mocked(deleteBranches).mockRejectedValue(exists);
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    let out: BranchDeleteOutcome[] | AppError | null = null;
    await act(async () => {
      out = await result.current.deleteBranches(["a"], false);
    });
    expect(out).toEqual(exists);
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

  it("should not call any other wrapper when checkout runs", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    await run(() => result.current, { action: "checkout", name: "a" });
    expect(checkoutRemoteBranch).not.toHaveBeenCalled();
    expect(deleteBranches).not.toHaveBeenCalled();
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
    ["checkout", { action: "checkout", name: "a" }],
    ["checkoutRemote", { action: "checkoutRemote", remote: "origin", name: "a" }],
  ])("should resolve the AppError when %s fails", async (_n, req) => {
    const err: AppError = { kind: "checkoutFailed", message: "no" };
    vi.mocked(renameBranch).mockRejectedValue(err);
    vi.mocked(checkoutBranch).mockRejectedValue(err);
    vi.mocked(checkoutRemoteBranch).mockRejectedValue(err);
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
    vi.mocked(checkoutBranch).mockRejectedValueOnce(exists).mockResolvedValue(noStash);
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
    ["checkout", { action: "checkout", name: "a" }],
    ["checkoutRemote", { action: "checkoutRemote", remote: "origin", name: "a" }],
    ["setUpstream", { action: "setUpstream", name: "topic", upstream: "origin/topic" }],
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
    vi.mocked(checkoutBranch).mockRejectedValue(exists);
    vi.mocked(checkoutRemoteBranch).mockRejectedValue(exists);
    vi.mocked(setBranchUpstream).mockRejectedValue(exists);
    const { result, queryClient } = renderHookWithProviders(() => useBranchActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await run(() => result.current, req);
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ["repo", 4] }));
  });

  it("should invalidate the repo key when deleteBranches succeeds", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useBranchActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.deleteBranches(["a"], false));
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ["repo", 4] }));
  });

  it("should invalidate the repo key when deleteBranches fails", async () => {
    vi.mocked(deleteBranches).mockRejectedValue(exists);
    const { result, queryClient } = renderHookWithProviders(() => useBranchActions(4));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.deleteBranches(["a"], false));
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
    vi.mocked(checkoutBranch).mockReturnValue(
      new Promise<CheckoutOutcome>((r) => (finish = () => r(noStash))),
    );
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
    const first = gate<CheckoutOutcome>();
    vi.mocked(checkoutBranch).mockReturnValueOnce(first.promise).mockRejectedValueOnce(other);
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    let firstResult: AppError | null | undefined;
    act(() => {
      void result.current.run({ action: "checkout", name: "a" }).then((e) => (firstResult = e));
    });
    await run(() => result.current, { action: "checkout", name: "b" });
    await waitFor(() => expect(result.current.error).toEqual(other));
    await act(async () => {
      first.resolve(noStash);
      await first.promise;
    });
    expect(firstResult).toBeNull();
    expect(result.current.error).toEqual(other);
  });

  it("should resolve each run with its own outcome", async () => {
    const first = gate<CheckoutOutcome>();
    vi.mocked(checkoutBranch).mockReturnValueOnce(first.promise).mockResolvedValueOnce(noStash);
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

// Contract: setUpstream forwards the branch and upstream (null clears); invalidation is in the table above.
describe("useBranchActions setUpstream", () => {
  it("should call setBranchUpstream with the branch and upstream", async () => {
    vi.mocked(setBranchUpstream).mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    const out = await run(() => result.current, {
      action: "setUpstream",
      name: "topic",
      upstream: "origin/topic",
    });
    expect(out).toBeNull();
    expect(setBranchUpstream).toHaveBeenCalledExactlyOnceWith(4, "topic", "origin/topic");
  });

  it("should pass null to clear the upstream", async () => {
    vi.mocked(setBranchUpstream).mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    await run(() => result.current, { action: "setUpstream", name: "topic", upstream: null });
    expect(setBranchUpstream).toHaveBeenCalledExactlyOnceWith(4, "topic", null);
  });

  it("should resolve with the error on failure", async () => {
    const missing: AppError = { kind: "branchNotFound", message: "no branch named origin/x" };
    vi.mocked(setBranchUpstream).mockRejectedValue(missing);
    const { result } = renderHookWithProviders(() => useBranchActions(4));
    const out = await run(() => result.current, {
      action: "setUpstream",
      name: "topic",
      upstream: "origin/x",
    });
    expect(out).toEqual(missing);
  });
});

// Contract: a successful checkout or set upstream asks the focused pane to auto-fetch.
describe("useBranchActions auto-fetch requests", () => {
  beforeEach(() => {
    useAutoFetchState.setState({ repos: {} });
    vi.mocked(setBranchUpstream).mockResolvedValue(undefined);
  });

  const requested = () => useAutoFetchState.getState().repos[1]?.requested ?? 0;

  it("requests an auto-fetch after a successful checkout", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "checkout", name: "dev" });
    expect(requested()).toBe(1);
  });

  it("requests an auto-fetch after a successful remote checkout", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "checkoutRemote", remote: "origin", name: "dev" });
    expect(requested()).toBe(1);
  });

  it("requests an auto-fetch after a successful set upstream", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "setUpstream", name: "dev", upstream: "origin/dev" });
    expect(requested()).toBe(1);
  });

  it("requests nothing after unsetting the upstream", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "setUpstream", name: "dev", upstream: null });
    expect(requested()).toBe(0);
  });

  it("requests nothing after a failed checkout", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue({ kind: "checkoutFailed", message: "dirty" });
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "checkout", name: "dev" });
    expect(requested()).toBe(0);
  });

  it("requests nothing after create, rename or deleteBranches", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, {
      action: "create",
      name: "topic",
      startPoint: null,
      checkout: true,
    });
    await run(() => result.current, { action: "rename", oldName: "topic", newName: "t2" });
    await act(() => result.current.deleteBranches(["t2"], false));
    expect(requested()).toBe(0);
  });
});

// Contract: a successful checkout or checkout-create toasts its auto-stash report.
describe("useBranchActions auto-stash toast", () => {
  const report: AutoStash = { files: 2, reapply: "applied", detail: null };

  it("toasts the report after a checkout, naming the branch", async () => {
    vi.mocked(checkoutBranch).mockResolvedValue({ autoStash: report });
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "checkout", name: "dev" });
    expect(toastAutoStash).toHaveBeenCalledExactlyOnceWith(report, "dev");
  });

  it("toasts the report after a remote checkout, naming the branch", async () => {
    vi.mocked(checkoutRemoteBranch).mockResolvedValue({ autoStash: report });
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "checkoutRemote", remote: "origin", name: "dev" });
    expect(toastAutoStash).toHaveBeenCalledExactlyOnceWith(report, "dev");
  });

  it("toasts the report after a create that checks out, naming the new branch", async () => {
    vi.mocked(createBranch).mockResolvedValue({ ...created, autoStash: report });
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, {
      action: "create",
      name: "topic",
      startPoint: null,
      checkout: true,
    });
    expect(toastAutoStash).toHaveBeenCalledExactlyOnceWith(report, "topic");
  });

  it("does not toast after a create that does not check out", async () => {
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, {
      action: "create",
      name: "topic",
      startPoint: null,
      checkout: false,
    });
    expect(toastAutoStash).not.toHaveBeenCalled();
  });

  it("does not toast after a failed checkout", async () => {
    vi.mocked(checkoutBranch).mockRejectedValue({ kind: "checkoutFailedStashKept", message: "m" });
    const { result } = renderHookWithProviders(() => useBranchActions(1));
    await run(() => result.current, { action: "checkout", name: "dev" });
    expect(toastAutoStash).not.toHaveBeenCalled();
  });
});
