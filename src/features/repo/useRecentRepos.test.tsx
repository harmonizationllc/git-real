import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRecent, removeRecent } from "../../lib/ipc";
import type { RecentEntry } from "../../lib/ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useRecentRepos } from "./useRecentRepos";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  openRepo: vi.fn(),
  initRepo: vi.fn(),
  listRecent: vi.fn(),
  removeRecent: vi.fn(),
  pickFolder: vi.fn(),
}));

const entry = (name: string, path = `/home/u/${name}`): RecentEntry => ({
  name,
  path,
  lastOpened: 1,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listRecent).mockResolvedValue([]);
});

// Contract: recents come from listRecent; remove writes the returned list into the cache.
describe("useRecentRepos loading", () => {
  it("should report loading with no recents before the query resolves", () => {
    vi.mocked(listRecent).mockReturnValue(new Promise(() => {}));
    const { result } = renderHookWithProviders(() => useRecentRepos());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.recents).toEqual([]);
  });

  it("should expose the recents returned by listRecent", async () => {
    const list = [entry("a"), entry("b")];
    vi.mocked(listRecent).mockResolvedValue(list);
    const { result } = renderHookWithProviders(() => useRecentRepos());
    await waitFor(() => expect(result.current.recents).toEqual(list));
    expect(result.current.isLoading).toBe(false);
  });

  it("should call listRecent with no arguments", async () => {
    const { result } = renderHookWithProviders(() => useRecentRepos());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(listRecent).toHaveBeenCalledExactlyOnceWith();
  });

  it("should return empty recents and stop loading when listRecent rejects", async () => {
    vi.mocked(listRecent).mockRejectedValue({ kind: "io", message: "x" });
    const { result } = renderHookWithProviders(() => useRecentRepos());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.recents).toEqual([]);
  });
});

describe("useRecentRepos remove", () => {
  it("should call removeRecent with exactly the path", async () => {
    vi.mocked(listRecent).mockResolvedValue([entry("a"), entry("b")]);
    vi.mocked(removeRecent).mockResolvedValue([entry("b")]);
    const { result } = renderHookWithProviders(() => useRecentRepos());
    await waitFor(() => expect(result.current.recents).toHaveLength(2));
    act(() => result.current.remove("/home/u/a"));
    await waitFor(() => expect(removeRecent).toHaveBeenCalledExactlyOnceWith("/home/u/a"));
  });

  it("should replace recents with the list removeRecent returns", async () => {
    vi.mocked(listRecent).mockResolvedValue([entry("a"), entry("b")]);
    vi.mocked(removeRecent).mockResolvedValue([entry("b")]);
    const { result } = renderHookWithProviders(() => useRecentRepos());
    await waitFor(() => expect(result.current.recents).toHaveLength(2));
    act(() => result.current.remove("/home/u/a"));
    await waitFor(() => expect(result.current.recents).toEqual([entry("b")]));
  });

  it("should not refetch listRecent after a remove", async () => {
    vi.mocked(listRecent).mockResolvedValue([entry("a")]);
    vi.mocked(removeRecent).mockResolvedValue([]);
    const { result } = renderHookWithProviders(() => useRecentRepos());
    await waitFor(() => expect(result.current.recents).toHaveLength(1));
    act(() => result.current.remove("/home/u/a"));
    await waitFor(() => expect(result.current.recents).toEqual([]));
    expect(listRecent).toHaveBeenCalledOnce();
  });

  it("should keep the cached list when removeRecent rejects", async () => {
    vi.mocked(listRecent).mockResolvedValue([entry("a")]);
    vi.mocked(removeRecent).mockRejectedValue({ kind: "io", message: "x" });
    const { result } = renderHookWithProviders(() => useRecentRepos());
    await waitFor(() => expect(result.current.recents).toHaveLength(1));
    act(() => result.current.remove("/home/u/a"));
    await waitFor(() => expect(removeRecent).toHaveBeenCalled());
    expect(result.current.recents).toEqual([entry("a")]);
  });
});
