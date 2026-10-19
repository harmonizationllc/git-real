import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommitFiles } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { commitFile } from "../../test/historyFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useCommitFiles } from "./useCommitFiles";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getCommitFiles: vi.fn(),
}));

const OID = "a".repeat(40);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getCommitFiles).mockResolvedValue([commitFile("a.txt")]);
});

// Contract: the files a commit changed, fetched once and never stale.
describe("useCommitFiles", () => {
  it("should call getCommitFiles with the repo id and oid", async () => {
    renderHookWithProviders(() => useCommitFiles(3, OID));
    await waitFor(() => expect(getCommitFiles).toHaveBeenCalledExactlyOnceWith(3, OID));
  });

  it("should expose the files once loaded", async () => {
    const { result } = renderHookWithProviders(() => useCommitFiles(1, OID));
    await waitFor(() => expect(result.current.files).toEqual([commitFile("a.txt")]));
  });

  it("should report isLoading until the files arrive", async () => {
    const { result } = renderHookWithProviders(() => useCommitFiles(1, OID));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it("should have no files and no error while loading", () => {
    vi.mocked(getCommitFiles).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useCommitFiles(1, OID));
    expect(result.current.files).toBeUndefined();
    expect(result.current.error).toBeNull();
  });

  it("should cache under queryKeys.commitFiles as immutable data", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useCommitFiles(1, OID));
    await waitFor(() => expect(result.current.files).toBeDefined());
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.commitFiles(1, OID) });
    expect(query?.observers[0]?.options.staleTime).toBe(Infinity);
  });

  it("should fetch for the new oid when the oid changes", async () => {
    let oid = OID;
    const { rerender } = renderHookWithProviders(() => useCommitFiles(1, oid));
    await waitFor(() => expect(getCommitFiles).toHaveBeenCalledWith(1, OID));
    oid = "b".repeat(40);
    rerender();
    await waitFor(() => expect(getCommitFiles).toHaveBeenCalledWith(1, "b".repeat(40)));
  });
});

// Contract: failures surface as an AppError and refetch tries again.
describe("useCommitFiles errors", () => {
  it("should expose an AppError rejection as error", async () => {
    vi.mocked(getCommitFiles).mockRejectedValue({ kind: "git", message: "files boom" });
    const { result } = renderHookWithProviders(() => useCommitFiles(1, OID));
    await waitFor(() =>
      expect(result.current.error).toEqual({ kind: "git", message: "files boom" }),
    );
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(getCommitFiles).mockRejectedValue(new Error("plain"));
    const { result } = renderHookWithProviders(() => useCommitFiles(1, OID));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "plain" }));
  });

  it("should fetch again when refetch is called", async () => {
    vi.mocked(getCommitFiles).mockRejectedValueOnce({ kind: "git", message: "files boom" });
    const { result } = renderHookWithProviders(() => useCommitFiles(1, OID));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    result.current.refetch();
    await waitFor(() => expect(result.current.files).toEqual([commitFile("a.txt")]));
    expect(getCommitFiles).toHaveBeenCalledTimes(2);
  });
});
