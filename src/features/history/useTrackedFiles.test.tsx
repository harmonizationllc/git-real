import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listTrackedFiles } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useTrackedFiles } from "./useTrackedFiles";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listTrackedFiles: vi.fn(),
}));

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listTrackedFiles).mockResolvedValue(["a.txt", "src/b.ts"]);
});

// Contract: the tracked file list is fetched only while the picker is open and is never kept.
describe("useTrackedFiles", () => {
  it("should call listTrackedFiles with the repo id when open", async () => {
    renderHookWithProviders(() => useTrackedFiles(3, true));
    await waitFor(() => expect(listTrackedFiles).toHaveBeenCalledExactlyOnceWith(3));
  });

  it("should expose the files once loaded", async () => {
    const { result } = renderHookWithProviders(() => useTrackedFiles(1, true));
    await waitFor(() => expect(result.current.files).toEqual(["a.txt", "src/b.ts"]));
  });

  it("should report isLoading until the files arrive", async () => {
    const { result } = renderHookWithProviders(() => useTrackedFiles(1, true));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it("should not fetch while closed", async () => {
    const { result } = renderHookWithProviders(() => useTrackedFiles(1, false));
    await settle();
    expect(listTrackedFiles).not.toHaveBeenCalled();
    expect(result.current.files).toBeUndefined();
  });

  it("should fetch when it becomes open", async () => {
    let open = false;
    const { rerender } = renderHookWithProviders(() => useTrackedFiles(1, open));
    await settle();
    open = true;
    rerender();
    await waitFor(() => expect(listTrackedFiles).toHaveBeenCalledTimes(1));
  });

  it("should keep nothing in the cache and always refetch", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useTrackedFiles(1, true));
    await waitFor(() => expect(result.current.files).toBeDefined());
    const options = queryClient.getQueryCache().find({ queryKey: queryKeys.trackedFiles(1) })
      ?.observers[0]?.options;
    expect(options?.gcTime).toBe(0);
    expect(options?.staleTime).toBe(0);
  });
});

// Contract: failures surface as an AppError and refetch tries again.
describe("useTrackedFiles errors", () => {
  it("should expose an AppError rejection as error", async () => {
    vi.mocked(listTrackedFiles).mockRejectedValue({ kind: "git", message: "list boom" });
    const { result } = renderHookWithProviders(() => useTrackedFiles(1, true));
    await waitFor(() =>
      expect(result.current.error).toEqual({ kind: "git", message: "list boom" }),
    );
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(listTrackedFiles).mockRejectedValue(new Error("plain"));
    const { result } = renderHookWithProviders(() => useTrackedFiles(1, true));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "plain" }));
  });

  it("should fetch again when refetch is called", async () => {
    vi.mocked(listTrackedFiles).mockRejectedValueOnce({ kind: "git", message: "list boom" });
    const { result } = renderHookWithProviders(() => useTrackedFiles(1, true));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    result.current.refetch();
    await waitFor(() => expect(result.current.files).toEqual(["a.txt", "src/b.ts"]));
    expect(listTrackedFiles).toHaveBeenCalledTimes(2);
  });
});
