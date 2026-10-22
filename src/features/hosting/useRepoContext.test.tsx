import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostingRepoContext } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { repoContext } from "../../test/hostingFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useRepoContext } from "./useRepoContext";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingRepoContext: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hostingRepoContext).mockResolvedValue(repoContext());
});

// Contract: the hosted repository behind origin is queried under the repo prefix.
describe("useRepoContext", () => {
  it("should call hostingRepoContext with the repo id", async () => {
    renderHookWithProviders(() => useRepoContext(3));
    await waitFor(() => expect(hostingRepoContext).toHaveBeenCalledExactlyOnceWith(3));
  });

  it("should have no context and no error while loading", () => {
    vi.mocked(hostingRepoContext).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useRepoContext(1));
    expect([result.current.context, result.current.error]).toEqual([undefined, null]);
  });

  it("should expose the context once loaded", async () => {
    const { result } = renderHookWithProviders(() => useRepoContext(1));
    await waitFor(() => expect(result.current.context).toEqual(repoContext()));
  });

  it("should pass a null context through as null", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(null);
    const { result } = renderHookWithProviders(() => useRepoContext(1));
    await waitFor(() => expect(result.current.context).toBeNull());
  });

  it("should cache under queryKeys.hostingContext", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRepoContext(1));
    await waitFor(() => expect(result.current.context).toBeDefined());
    expect(queryClient.getQueryData(["repo", 1, "hostingContext"])).toEqual(repoContext());
    expect(queryKeys.hostingContext(1)).toEqual(["repo", 1, "hostingContext"]);
  });

  it("should map a rejection into error", async () => {
    vi.mocked(hostingRepoContext).mockRejectedValue({ kind: "io", message: "x" });
    const { result } = renderHookWithProviders(() => useRepoContext(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "x" }));
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(hostingRepoContext).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useRepoContext(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });

  it("should refetch when the repo prefix is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRepoContext(1));
    await waitFor(() => expect(result.current.context).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(1) }));
    expect(hostingRepoContext).toHaveBeenCalledTimes(2);
  });

  it("should not refetch when another repo is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRepoContext(1));
    await waitFor(() => expect(result.current.context).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(2) }));
    expect(hostingRepoContext).toHaveBeenCalledTimes(1);
  });
});
