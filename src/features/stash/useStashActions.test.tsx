import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stashApply, stashDrop, stashPop, stashPush } from "../../lib/ipc";
import type { StashOutcome } from "../../lib/ipc";
import { mutationKeys } from "../../lib/query/keys";
import { useToasts } from "../../lib/store/toasts";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useStashActions } from "./useStashActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  stashPush: vi.fn(),
  stashApply: vi.fn(),
  stashPop: vi.fn(),
  stashDrop: vi.fn(),
}));

const entry = { index: 2, oid: "b".repeat(40) };

const toasts = () => useToasts.getState().toasts;

beforeEach(() => {
  vi.resetAllMocks();
  useToasts.setState({ toasts: [] });
  vi.mocked(stashPush).mockResolvedValue(undefined);
  vi.mocked(stashApply).mockResolvedValue("applied");
  vi.mocked(stashPop).mockResolvedValue("applied");
  vi.mocked(stashDrop).mockResolvedValue(undefined);
});

// Contract: each action resolves with the AppError or null, never rejects, and refreshes the repo.
describe("useStashActions", () => {
  it("push calls stashPush with the message and flag and resolves null", async () => {
    const { result } = renderHookWithProviders(() => useStashActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.push("wip", true);
    });
    expect(stashPush).toHaveBeenCalledExactlyOnceWith(1, "wip", true);
    expect(outcome).toBeNull();
  });

  it("push passes a null message through", async () => {
    const { result } = renderHookWithProviders(() => useStashActions(1));
    await act(() => result.current.push(null, false));
    expect(stashPush).toHaveBeenCalledExactlyOnceWith(1, null, false);
  });

  it("apply calls stashApply with index and oid and resolves null", async () => {
    const { result } = renderHookWithProviders(() => useStashActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.apply(entry);
    });
    expect(stashApply).toHaveBeenCalledExactlyOnceWith(1, 2, entry.oid);
    expect(outcome).toBeNull();
  });

  it("pop calls stashPop with index and oid", async () => {
    const { result } = renderHookWithProviders(() => useStashActions(1));
    await act(() => result.current.pop(entry));
    expect(stashPop).toHaveBeenCalledExactlyOnceWith(1, 2, entry.oid);
  });

  it("drop calls stashDrop with index and oid", async () => {
    const { result } = renderHookWithProviders(() => useStashActions(1));
    await act(() => result.current.drop(entry));
    expect(stashDrop).toHaveBeenCalledExactlyOnceWith(1, 2, entry.oid);
  });

  it("toasts the conflict notice after apply", async () => {
    vi.mocked(stashApply).mockResolvedValue("conflicts");
    const { result } = renderHookWithProviders(() => useStashActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.apply(entry);
    });
    expect(outcome).toBeNull();
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatchObject({
      text: "Applied with conflicts. Resolve them in Changes.",
      variant: "info",
    });
  });

  it('pop resolving "conflicts" toasts the kept notice and resolves it', async () => {
    vi.mocked(stashPop).mockResolvedValue("conflicts");
    const { result } = renderHookWithProviders(() => useStashActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.pop(entry);
    });
    expect(outcome).toEqual({ error: null, notice: { kind: "pop", index: 2 } });
    expect(toasts()[0].text).toBe(
      "Applied with conflicts. Resolve them in Changes. The stash was kept; drop it once resolved.",
    );
  });

  it('pop resolving "appliedNotDropped" toasts and resolves a popKept notice', async () => {
    vi.mocked(stashPop).mockResolvedValue("appliedNotDropped" as StashOutcome);
    const { result } = renderHookWithProviders(() => useStashActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.pop(entry);
    });
    expect(outcome).toEqual({ error: null, notice: { kind: "popKept", index: 2 } });
    expect(toasts()[0]).toMatchObject({ variant: "info" });
  });

  it('pop resolving "applied" toasts nothing and resolves no notice', async () => {
    const { result } = renderHookWithProviders(() => useStashActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.pop(entry);
    });
    expect(outcome).toEqual({ error: null, notice: null });
    expect(toasts()).toEqual([]);
  });

  it('apply resolving "applied" toasts nothing and resolves null', async () => {
    const { result } = renderHookWithProviders(() => useStashActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.apply(entry);
    });
    expect(outcome).toBeNull();
    expect(toasts()).toEqual([]);
  });

  it("a rejected action resolves with the AppError and toasts nothing itself", async () => {
    const err = { kind: "staleStash", message: "stale" };
    vi.mocked(stashDrop).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useStashActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.drop(entry);
    });
    expect(outcome).toEqual(err);
    expect(toasts()).toEqual([]);
  });

  it("a rejected pop resolves the error with no notice", async () => {
    const err = { kind: "operationFailed", message: "x" };
    vi.mocked(stashPop).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useStashActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.pop(entry);
    });
    expect(outcome).toEqual({ error: err, notice: null });
  });

  it("a plain Error rejection becomes an io AppError", async () => {
    vi.mocked(stashPush).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useStashActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.push(null, false);
    });
    expect(outcome).toEqual({ kind: "io", message: "boom" });
  });

  it("no longer exposes error or notice", () => {
    const { result } = renderHookWithProviders(() => useStashActions(1));
    expect(Object.keys(result.current).sort()).toEqual(
      ["apply", "drop", "pending", "pop", "push"].sort(),
    );
  });

  it("pending is true while an action runs", async () => {
    let finish: (o: StashOutcome) => void = () => undefined;
    vi.mocked(stashApply).mockReturnValue(new Promise((r) => (finish = r)));
    const { result } = renderHookWithProviders(() => useStashActions(1));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.apply(entry);
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => {
      finish("applied");
      await done;
    });
    expect(result.current.pending).toBe(false);
  });

  it("invalidates the repo prefix after success and after failure", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useStashActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.drop(entry));
    vi.mocked(stashDrop).mockRejectedValue({ kind: "staleStash", message: "s" });
    await act(() => result.current.drop(entry));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, { queryKey: ["repo", 1] });
    expect(spy).toHaveBeenNthCalledWith(2, { queryKey: ["repo", 1] });
  });

  it("counts a running action under the repo's stash mutation key only", async () => {
    let finish: (o: StashOutcome) => void = () => undefined;
    vi.mocked(stashApply).mockReturnValue(new Promise((r) => (finish = r)));
    const { result, queryClient } = renderHookWithProviders(() => useStashActions(1));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.apply(entry);
    });
    await waitFor(() =>
      expect(queryClient.isMutating({ mutationKey: mutationKeys.stash(1) })).toBe(1),
    );
    expect(queryClient.isMutating({ mutationKey: mutationKeys.stash(2) })).toBe(0);
    await act(async () => {
      finish("applied");
      await done;
    });
    expect(queryClient.isMutating({ mutationKey: mutationKeys.stash(1) })).toBe(0);
  });
});
