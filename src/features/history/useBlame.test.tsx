import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBlame } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { blameHunk, blameOf } from "../../test/historyFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useBlame } from "./useBlame";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getBlame: vi.fn(),
}));

const OID = "c".repeat(40);
const BLAME = blameOf([blameHunk(0, 1, 1)], ["only line"]);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getBlame).mockResolvedValue(BLAME);
});

// Contract: blame at a commit is immutable; blame at HEAD (oid null) refreshes with the repo.
describe("useBlame", () => {
  it("should call getBlame with the repo id, path and oid", async () => {
    renderHookWithProviders(() => useBlame(3, "src/a.ts", OID));
    await waitFor(() => expect(getBlame).toHaveBeenCalledExactlyOnceWith(3, "src/a.ts", OID));
  });

  it("should call getBlame with a null oid to blame HEAD", async () => {
    renderHookWithProviders(() => useBlame(3, "src/a.ts", null));
    await waitFor(() => expect(getBlame).toHaveBeenCalledExactlyOnceWith(3, "src/a.ts", null));
  });

  it("should expose the blame once loaded", async () => {
    const { result } = renderHookWithProviders(() => useBlame(1, "a.txt", OID));
    await waitFor(() => expect(result.current.blame).toEqual(BLAME));
  });

  it("should report isLoading until the blame arrives", async () => {
    const { result } = renderHookWithProviders(() => useBlame(1, "a.txt", OID));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it("should cache a commit's blame under queryKeys.blameAt as immutable data", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useBlame(1, "a.txt", OID));
    await waitFor(() => expect(result.current.blame).toBeDefined());
    const query = queryClient
      .getQueryCache()
      .find({ queryKey: queryKeys.blameAt(1, "a.txt", OID) });
    expect(query?.observers[0]?.options.staleTime).toBe(Infinity);
  });

  it("should cache HEAD blame under queryKeys.blameHead and let it go stale", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useBlame(1, "a.txt", null));
    await waitFor(() => expect(result.current.blame).toBeDefined());
    const query = queryClient.getQueryCache().find({ queryKey: queryKeys.blameHead(1, "a.txt") });
    expect(query?.observers[0]?.options.staleTime).not.toBe(Infinity);
  });

  it("should not cache HEAD blame under the immutable key", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useBlame(1, "a.txt", null));
    await waitFor(() => expect(result.current.blame).toBeDefined());
    const immutable = queryClient.getQueryCache().findAll({ queryKey: queryKeys.repoImmutable(1) });
    expect(immutable).toEqual([]);
  });

  it("should fetch again for the new oid when the oid changes", async () => {
    let oid: string | null = null;
    const { rerender } = renderHookWithProviders(() => useBlame(1, "a.txt", oid));
    await waitFor(() => expect(getBlame).toHaveBeenCalledWith(1, "a.txt", null));
    oid = OID;
    rerender();
    await waitFor(() => expect(getBlame).toHaveBeenCalledWith(1, "a.txt", OID));
  });

  it("should fetch for the new path when the path changes", async () => {
    let path = "a.txt";
    const { rerender } = renderHookWithProviders(() => useBlame(1, path, OID));
    await waitFor(() => expect(getBlame).toHaveBeenCalledWith(1, "a.txt", OID));
    path = "b.txt";
    rerender();
    await waitFor(() => expect(getBlame).toHaveBeenCalledWith(1, "b.txt", OID));
  });
});

// Contract: failures surface as an AppError and refetch tries again.
describe("useBlame errors", () => {
  it("should expose an AppError rejection as error", async () => {
    vi.mocked(getBlame).mockRejectedValue({ kind: "git", message: "blame boom" });
    const { result } = renderHookWithProviders(() => useBlame(1, "a.txt", OID));
    await waitFor(() =>
      expect(result.current.error).toEqual({ kind: "git", message: "blame boom" }),
    );
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(getBlame).mockRejectedValue(new Error("plain"));
    const { result } = renderHookWithProviders(() => useBlame(1, "a.txt", OID));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "plain" }));
  });

  it("should have no error while loading", () => {
    vi.mocked(getBlame).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useBlame(1, "a.txt", OID));
    expect(result.current.error).toBeNull();
  });

  it("should fetch again when refetch is called", async () => {
    vi.mocked(getBlame).mockRejectedValueOnce({ kind: "git", message: "blame boom" });
    const { result } = renderHookWithProviders(() => useBlame(1, "a.txt", OID));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    result.current.refetch();
    await waitFor(() => expect(result.current.blame).toEqual(BLAME));
    expect(getBlame).toHaveBeenCalledTimes(2);
  });
});
