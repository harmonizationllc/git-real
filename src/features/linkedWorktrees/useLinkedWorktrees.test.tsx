import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listLinkedWorktrees } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { linkedWorktree } from "../../test/worktreeFixtures";
import { useLinkedWorktrees } from "./useLinkedWorktrees";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listLinkedWorktrees: vi.fn(),
}));

const loaded = () => [linkedWorktree()];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listLinkedWorktrees).mockResolvedValue(loaded());
});

// Contract: the worktree list is queried under the repo prefix so a repo change refreshes it.
describe("useLinkedWorktrees", () => {
  it("should fetch under queryKeys.linkedWorktrees", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useLinkedWorktrees(3));
    await waitFor(() => expect(result.current.list).toEqual(loaded()));
    expect(listLinkedWorktrees).toHaveBeenCalledExactlyOnceWith(3);
    expect(queryClient.getQueryData(queryKeys.linkedWorktrees(3))).toEqual(loaded());
  });

  it("should have no list and no error while loading", () => {
    vi.mocked(listLinkedWorktrees).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useLinkedWorktrees(1));
    expect([result.current.list, result.current.error]).toEqual([undefined, null]);
  });

  it("should surface an AppError", async () => {
    vi.mocked(listLinkedWorktrees).mockRejectedValue({ kind: "git", message: "x" });
    const { result } = renderHookWithProviders(() => useLinkedWorktrees(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "git", message: "x" }));
  });

  it("should map a plain Error to an io error", async () => {
    vi.mocked(listLinkedWorktrees).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useLinkedWorktrees(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });

  it("should refetch when the repo prefix is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useLinkedWorktrees(1));
    await waitFor(() => expect(result.current.list).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(1) }));
    expect(listLinkedWorktrees).toHaveBeenCalledTimes(2);
  });

  it("should query again when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useLinkedWorktrees(1));
    await waitFor(() => expect(result.current.list).toBeDefined());
    act(() => result.current.refetch());
    await waitFor(() => expect(listLinkedWorktrees).toHaveBeenCalledTimes(2));
  });
});
