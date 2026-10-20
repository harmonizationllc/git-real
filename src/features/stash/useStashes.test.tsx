import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listStashes } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { stashEntry } from "../../test/stashFixtures";
import { useStashes } from "./useStashes";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listStashes: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listStashes).mockResolvedValue([stashEntry(0)]);
});

// Contract: the stash list is queried under the repo prefix so a repo change refreshes it.
describe("useStashes", () => {
  it("should call listStashes with the repo id", async () => {
    renderHookWithProviders(() => useStashes(3));
    await waitFor(() => expect(listStashes).toHaveBeenCalledExactlyOnceWith(3));
  });

  it("should have no stashes and no error while loading", () => {
    vi.mocked(listStashes).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useStashes(1));
    expect([result.current.stashes, result.current.error]).toEqual([undefined, null]);
  });

  it("should expose the stashes once loaded", async () => {
    const { result } = renderHookWithProviders(() => useStashes(1));
    await waitFor(() => expect(result.current.stashes).toEqual([stashEntry(0)]));
  });

  it("should map a rejection into error", async () => {
    vi.mocked(listStashes).mockRejectedValue({ kind: "io", message: "x" });
    const { result } = renderHookWithProviders(() => useStashes(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "x" }));
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(listStashes).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useStashes(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });

  it("should cache under queryKeys.stashes", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useStashes(1));
    await waitFor(() => expect(result.current.stashes).toBeDefined());
    expect(queryClient.getQueryData(queryKeys.stashes(1))).toEqual([stashEntry(0)]);
  });

  it("should refetch when the repo prefix is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useStashes(1));
    await waitFor(() => expect(result.current.stashes).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(1) }));
    expect(listStashes).toHaveBeenCalledTimes(2);
  });

  it("should not refetch when another repo is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useStashes(1));
    await waitFor(() => expect(result.current.stashes).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(2) }));
    expect(listStashes).toHaveBeenCalledTimes(1);
  });

  it("should query again when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useStashes(1));
    await waitFor(() => expect(result.current.stashes).toBeDefined());
    result.current.refetch();
    await waitFor(() => expect(listStashes).toHaveBeenCalledTimes(2));
  });
});
