import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listTags } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { tagEntry, tagList } from "../../test/tagFixtures";
import { useTags } from "./useTags";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listTags: vi.fn(),
}));

const loaded = () => tagList({ tags: [tagEntry("v1")] });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listTags).mockResolvedValue(loaded());
});

// Contract: the tag list is queried under the repo prefix so a repo change refreshes it.
describe("useTags", () => {
  it("should call listTags with the repo id", async () => {
    renderHookWithProviders(() => useTags(3));
    await waitFor(() => expect(listTags).toHaveBeenCalledExactlyOnceWith(3));
  });

  it("should have no list and no error while loading", () => {
    vi.mocked(listTags).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useTags(1));
    expect([result.current.list, result.current.error]).toEqual([undefined, null]);
  });

  it("should expose the list once loaded", async () => {
    const { result } = renderHookWithProviders(() => useTags(1));
    await waitFor(() => expect(result.current.list).toEqual(loaded()));
  });

  it("should map a rejection into error", async () => {
    vi.mocked(listTags).mockRejectedValue({ kind: "io", message: "x" });
    const { result } = renderHookWithProviders(() => useTags(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "x" }));
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(listTags).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useTags(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });

  it("should cache under queryKeys.tags", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useTags(1));
    await waitFor(() => expect(result.current.list).toBeDefined());
    expect(queryClient.getQueryData(queryKeys.tags(1))).toEqual(loaded());
  });

  it("should refetch when the repo prefix is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useTags(1));
    await waitFor(() => expect(result.current.list).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(1) }));
    expect(listTags).toHaveBeenCalledTimes(2);
  });

  it("should not refetch when another repo is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useTags(1));
    await waitFor(() => expect(result.current.list).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(2) }));
    expect(listTags).toHaveBeenCalledTimes(1);
  });

  it("should query again when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useTags(1));
    await waitFor(() => expect(result.current.list).toBeDefined());
    result.current.refetch();
    await waitFor(() => expect(listTags).toHaveBeenCalledTimes(2));
  });
});
