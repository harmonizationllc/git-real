import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listBranches } from "../../lib/ipc";
import type { AppError, BranchList } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useBranches } from "./useBranches";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listBranches: vi.fn(),
}));

const list: BranchList = {
  head: { kind: "branch", name: "main" },
  local: [{ name: "main", oid: "a".repeat(40), isHead: true, tracking: null, worktree: null }],
  remotes: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listBranches).mockResolvedValue(list);
});

// Contract: useBranches queries listBranches for the repo.
describe("useBranches query", () => {
  it("should report loading with no branches before the query resolves", () => {
    const { result } = renderHookWithProviders(() => useBranches(1));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.branches).toBeUndefined();
  });

  it("should expose the list returned by listBranches", async () => {
    const { result } = renderHookWithProviders(() => useBranches(3));
    await waitFor(() => expect(result.current.branches).toEqual(list));
    expect(listBranches).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("should stop loading once the list arrived", async () => {
    const { result } = renderHookWithProviders(() => useBranches(1));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it("should have a null error while the query succeeds", async () => {
    const { result } = renderHookWithProviders(() => useBranches(1));
    await waitFor(() => expect(result.current.branches).toBeDefined());
    expect(result.current.error).toBeNull();
  });

  it("should expose a rejected AppError as error", async () => {
    const err: AppError = { kind: "unknownRepo", message: "gone" };
    vi.mocked(listBranches).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useBranches(1));
    await waitFor(() => expect(result.current.error).toEqual(err));
  });

  it("should map a non-AppError rejection to an io error", async () => {
    vi.mocked(listBranches).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useBranches(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });

  it("should leave branches undefined when the query fails", async () => {
    vi.mocked(listBranches).mockRejectedValue({ kind: "io", message: "x" });
    const { result } = renderHookWithProviders(() => useBranches(1));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.branches).toBeUndefined();
  });

  it("should call listBranches again when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useBranches(1));
    await waitFor(() => expect(result.current.branches).toBeDefined());
    result.current.refetch();
    await waitFor(() => expect(listBranches).toHaveBeenCalledTimes(2));
  });
});

// Contract: the query lives under queryKeys.branches(id) and refreshes on focus and invalidation.
describe("useBranches cache", () => {
  it("should store the list under queryKeys.branches(id)", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useBranches(2));
    await waitFor(() => expect(result.current.branches).toBeDefined());
    expect(queryClient.getQueryData(queryKeys.branches(2))).toEqual(list);
  });

  it("should enable refetchOnWindowFocus on the branches query", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useBranches(1));
    await waitFor(() => expect(result.current.branches).toBeDefined());
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.branches(1) });
    expect(query?.observers[0]?.options.refetchOnWindowFocus).toBe(true);
  });

  it("should refetch after the repo prefix is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useBranches(1));
    await waitFor(() => expect(result.current.branches).toBeDefined());
    await queryClient.invalidateQueries({ queryKey: queryKeys.repo(1) });
    await waitFor(() => expect(listBranches).toHaveBeenCalledTimes(2));
  });
});
