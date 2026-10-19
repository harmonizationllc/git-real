import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommit } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { commitDetail, oidOf } from "../../test/graphFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useCommitDetail } from "./useCommitDetail";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getCommit: vi.fn(),
}));

const oid = oidOf(4);
const detail = commitDetail({ oid });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCommit).mockResolvedValue(detail);
});

// Contract: the commit detail query calls getCommit under queryKeys.commit and never goes stale.
describe("useCommitDetail loading", () => {
  it("should call getCommit with the repo id and oid", async () => {
    renderHookWithProviders(() => useCommitDetail(3, oid));
    await waitFor(() => expect(getCommit).toHaveBeenCalledExactlyOnceWith(3, oid));
  });

  it("should expose the commit once it resolves", async () => {
    const { result } = renderHookWithProviders(() => useCommitDetail(3, oid));
    await waitFor(() => expect(result.current.commit).toEqual(detail));
  });

  it("should report loading and no commit before the first resolve", () => {
    vi.mocked(getCommit).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useCommitDetail(3, oid));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.commit).toBeUndefined();
  });

  it("should stop loading with a null error after a resolve", async () => {
    const { result } = renderHookWithProviders(() => useCommitDetail(3, oid));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it("should store the commit under queryKeys.commit", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useCommitDetail(3, oid));
    await waitFor(() => expect(result.current.commit).toBeDefined());
    expect(queryClient.getQueryData(queryKeys.commit(3, oid))).toEqual(detail);
  });

  it("should treat the commit as immutable with an infinite stale time", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useCommitDetail(3, oid));
    await waitFor(() => expect(result.current.commit).toBeDefined());
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.commit(3, oid) });
    expect(query?.observers[0]?.options.staleTime).toBe(Infinity);
  });

  it("should fetch the new commit when the oid changes", async () => {
    let current = oid;
    const { rerender } = renderHookWithProviders(() => useCommitDetail(3, current));
    await waitFor(() => expect(getCommit).toHaveBeenCalledWith(3, oid));
    current = oidOf(5);
    rerender();
    await waitFor(() => expect(getCommit).toHaveBeenCalledWith(3, oidOf(5)));
  });
});

// Contract: failures arrive as AppError and refetch retries.
describe("useCommitDetail errors", () => {
  it("should expose an AppError rejection as error", async () => {
    const err = { kind: "commitNotFound", message: "no such commit" };
    vi.mocked(getCommit).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useCommitDetail(3, oid));
    await waitFor(() => expect(result.current.error).toEqual(err));
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(getCommit).mockRejectedValue(new Error("plain"));
    const { result } = renderHookWithProviders(() => useCommitDetail(3, oid));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "plain" }));
  });

  it("should leave the commit undefined on failure", async () => {
    vi.mocked(getCommit).mockRejectedValue({ kind: "commitNotFound", message: "x" });
    const { result } = renderHookWithProviders(() => useCommitDetail(3, oid));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.commit).toBeUndefined();
  });

  it("should call getCommit again when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useCommitDetail(3, oid));
    await waitFor(() => expect(result.current.commit).toBeDefined());
    result.current.refetch();
    await waitFor(() => expect(getCommit).toHaveBeenCalledTimes(2));
  });
});
