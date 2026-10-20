import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stashApply, stashDrop, stashPop, stashPush } from "../../lib/ipc";
import type { StashOutcome } from "../../lib/ipc";
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

beforeEach(() => {
  vi.resetAllMocks();
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

  it('apply resolving "conflicts" sets an apply notice with the index', async () => {
    vi.mocked(stashApply).mockResolvedValue("conflicts");
    const { result } = renderHookWithProviders(() => useStashActions(1));
    await act(() => result.current.apply(entry));
    expect(result.current.notice).toEqual({ kind: "apply", index: 2 });
  });

  it('pop resolving "conflicts" sets a pop notice', async () => {
    vi.mocked(stashPop).mockResolvedValue("conflicts");
    const { result } = renderHookWithProviders(() => useStashActions(1));
    await act(() => result.current.pop(entry));
    expect(result.current.notice).toEqual({ kind: "pop", index: 2 });
  });

  it('apply resolving "applied" leaves no notice', async () => {
    const { result } = renderHookWithProviders(() => useStashActions(1));
    await act(() => result.current.apply(entry));
    expect(result.current.notice).toBeNull();
  });

  it("the next action clears the previous notice", async () => {
    vi.mocked(stashApply).mockResolvedValue("conflicts");
    const { result } = renderHookWithProviders(() => useStashActions(1));
    await act(() => result.current.apply(entry));
    await act(() => result.current.drop(entry));
    expect(result.current.notice).toBeNull();
  });

  it("a rejected action resolves with the AppError and mirrors it in error", async () => {
    const err = { kind: "staleStash", message: "stale" };
    vi.mocked(stashDrop).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useStashActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.drop(entry);
    });
    expect(outcome).toEqual(err);
    await waitFor(() => expect(result.current.error).toEqual(err));
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

  it("a rejected apply sets no notice", async () => {
    vi.mocked(stashApply).mockRejectedValue({ kind: "operationFailed", message: "x" });
    const { result } = renderHookWithProviders(() => useStashActions(1));
    await act(() => result.current.apply(entry));
    expect(result.current.notice).toBeNull();
  });

  it("clearError resets the error", async () => {
    vi.mocked(stashDrop).mockRejectedValue({ kind: "io", message: "x" });
    const { result } = renderHookWithProviders(() => useStashActions(1));
    await act(() => result.current.drop(entry));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => result.current.clearError());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("clearNotice resets the notice", async () => {
    vi.mocked(stashApply).mockResolvedValue("conflicts");
    const { result } = renderHookWithProviders(() => useStashActions(1));
    await act(() => result.current.apply(entry));
    act(() => result.current.clearNotice());
    expect(result.current.notice).toBeNull();
  });

  it("starts idle with no error and no notice", () => {
    const { result } = renderHookWithProviders(() => useStashActions(1));
    expect([result.current.pending, result.current.error, result.current.notice]).toEqual([
      false,
      null,
      null,
    ]);
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
});
