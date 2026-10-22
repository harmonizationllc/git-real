import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRemotes } from "../../lib/ipc";
import { remoteInfo } from "../../test/remoteFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useRemotes } from "./useRemotes";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listRemotes: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listRemotes).mockResolvedValue([remoteInfo("origin")]);
});

// Contract: the configured remotes of a repo, cached under queryKeys.remotes.
describe("useRemotes", () => {
  it("should call listRemotes with the repo id", async () => {
    renderHookWithProviders(() => useRemotes(7));
    await waitFor(() => expect(listRemotes).toHaveBeenCalledExactlyOnceWith(7));
  });

  it("should be undefined with no error before the data arrives", () => {
    vi.mocked(listRemotes).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useRemotes(1));
    expect([result.current.remotes, result.current.error]).toEqual([undefined, null]);
  });

  it("should expose the data", async () => {
    const { result } = renderHookWithProviders(() => useRemotes(1));
    await waitFor(() => expect(result.current.remotes).toEqual([remoteInfo("origin")]));
  });

  it("should cache under queryKeys.remotes", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRemotes(1));
    await waitFor(() => expect(result.current.remotes).toBeDefined());
    expect(queryClient.getQueryData(["repo", 1, "remotes"])).toEqual([remoteInfo("origin")]);
  });

  it("should map a rejection into error", async () => {
    vi.mocked(listRemotes).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useRemotes(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });

  it("should keep a structured AppError as it is", async () => {
    vi.mocked(listRemotes).mockRejectedValue({ kind: "unknownRepo", message: "gone" });
    const { result } = renderHookWithProviders(() => useRemotes(1));
    await waitFor(() => expect(result.current.error?.kind).toBe("unknownRepo"));
  });

  it("should refetch when the repo prefix is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRemotes(1));
    await waitFor(() => expect(result.current.remotes).toBeDefined());
    vi.mocked(listRemotes).mockResolvedValue([remoteInfo("origin"), remoteInfo("upstream")]);
    await queryClient.invalidateQueries({ queryKey: ["repo", 1] });
    await waitFor(() => expect(result.current.remotes).toHaveLength(2));
  });

  it("should refetch when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useRemotes(1));
    await waitFor(() => expect(result.current.remotes).toBeDefined());
    result.current.refetch();
    await waitFor(() => expect(listRemotes).toHaveBeenCalledTimes(2));
  });
});
