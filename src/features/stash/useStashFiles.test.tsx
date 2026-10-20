import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStashFiles } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { commitFile } from "../../test/historyFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { stashFiles } from "../../test/stashFixtures";
import { useStashFiles } from "./useStashFiles";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getStashFiles: vi.fn(),
}));

const OID = "a".repeat(40);
const FILES = stashFiles({ tracked: [commitFile("a.txt")] });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getStashFiles).mockResolvedValue(FILES);
});

// Contract: a stash's files are fetched once per oid and only while a stash is selected.
describe("useStashFiles", () => {
  it("should not fetch while no oid is selected", () => {
    const { result } = renderHookWithProviders(() => useStashFiles(1, null));
    expect(getStashFiles).not.toHaveBeenCalled();
    expect(result.current.files).toBeUndefined();
  });

  it("should call getStashFiles with id and oid", async () => {
    renderHookWithProviders(() => useStashFiles(3, OID));
    await waitFor(() => expect(getStashFiles).toHaveBeenCalledExactlyOnceWith(3, OID));
  });

  it("should expose the files once loaded", async () => {
    const { result } = renderHookWithProviders(() => useStashFiles(1, OID));
    await waitFor(() => expect(result.current.files).toEqual(FILES));
  });

  it("should keep the revisionNotFound kind in error", async () => {
    vi.mocked(getStashFiles).mockRejectedValue({ kind: "revisionNotFound", message: "gone" });
    const { result } = renderHookWithProviders(() => useStashFiles(1, OID));
    await waitFor(() => expect(result.current.error?.kind).toBe("revisionNotFound"));
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(getStashFiles).mockRejectedValue(new Error("plain"));
    const { result } = renderHookWithProviders(() => useStashFiles(1, OID));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "plain" }));
  });

  it("should have a null error while loading", () => {
    vi.mocked(getStashFiles).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useStashFiles(1, OID));
    expect(result.current.error).toBeNull();
  });

  it("should cache under queryKeys.stashFiles as immutable data", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useStashFiles(1, OID));
    await waitFor(() => expect(result.current.files).toBeDefined());
    expect(queryClient.getQueryData(queryKeys.stashFiles(1, OID))).toEqual(FILES);
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.stashFiles(1, OID) });
    expect(query?.observers[0]?.options.staleTime).toBe(Infinity);
  });

  it("should fetch again when refetch is called", async () => {
    vi.mocked(getStashFiles).mockRejectedValueOnce({ kind: "git", message: "boom" });
    const { result } = renderHookWithProviders(() => useStashFiles(1, OID));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    result.current.refetch();
    await waitFor(() => expect(result.current.files).toEqual(FILES));
  });
});
