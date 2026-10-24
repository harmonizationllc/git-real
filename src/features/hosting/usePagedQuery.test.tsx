import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { usePagedQuery } from "./usePagedQuery";

interface Item {
  number: number;
  title: string;
}

/** n items numbered from `start` down, titled after the page they came from. */
const items = (n: number, start: number, title = "t"): Item[] =>
  Array.from({ length: n }, (_, i) => ({ number: start - i, title }));

const fetchPage = vi.fn<(page: number) => Promise<Item[]>>();
const KEY = ["test", "paged"] as const;

function render(enabled = true) {
  return renderHookWithProviders(() => usePagedQuery<Item>(KEY, fetchPage, enabled));
}

beforeEach(() => {
  vi.resetAllMocks();
  fetchPage.mockResolvedValue(items(2, 2));
});

// Contract: nothing is fetched until enabled, and the first request is page 1.
describe("usePagedQuery enabled", () => {
  it("should not fetch while disabled and expose an idle state", async () => {
    const { result } = render(false);
    await act(() => Promise.resolve());
    expect(fetchPage).not.toHaveBeenCalled();
    expect([result.current.items, result.current.error, result.current.hasMore]).toEqual([
      undefined,
      null,
      false,
    ]);
    expect([result.current.fetching, result.current.loadingMore]).toEqual([false, false]);
  });

  it("should fetch page 1 first once enabled", async () => {
    render();
    await waitFor(() => expect(fetchPage).toHaveBeenCalledExactlyOnceWith(1));
  });
});

// Contract: a full page of 50 means there may be more; anything else ends the list.
describe("usePagedQuery hasMore", () => {
  it.each([
    [49, false],
    [50, true],
    [51, false],
    [0, false],
  ])("should give hasMore for a first page of %i as %s", async (n, expected) => {
    fetchPage.mockResolvedValue(items(n, 200));
    const { result } = render();
    await waitFor(() => expect(result.current.items).toHaveLength(n));
    expect(result.current.hasMore).toBe(expected);
  });

  it("should read hasMore from the raw last page, not the deduped list", async () => {
    fetchPage.mockResolvedValueOnce(items(50, 100)).mockResolvedValueOnce(items(50, 100));
    const { result } = render();
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.items).toHaveLength(50);
    expect(result.current.hasMore).toBe(true);
  });
});

// Contract: loadMore asks for the next page number and appends it in order.
describe("usePagedQuery loadMore", () => {
  it("should ask for pages 2 and 3 in turn and keep the pages in order", async () => {
    fetchPage
      .mockResolvedValueOnce(items(50, 150, "p1"))
      .mockResolvedValueOnce(items(50, 100, "p2"))
      .mockResolvedValueOnce(items(1, 50, "p3"));
    const { result } = render();
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(100));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(101));
    expect(fetchPage.mock.calls).toEqual([[1], [2], [3]]);
    expect(result.current.items?.map((i) => i.title)).toEqual([
      ...Array<string>(50).fill("p1"),
      ...Array<string>(50).fill("p2"),
      "p3",
    ]);
    expect(result.current.hasMore).toBe(false);
  });

  it("should flag loadingMore, not a first load, while the next page is pending", async () => {
    fetchPage
      .mockResolvedValueOnce(items(50, 100))
      .mockReturnValueOnce(new Promise(() => undefined));
    const { result } = render();
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loadingMore).toBe(true));
    expect(result.current.items).toHaveLength(50);
  });

  it("should not request another page when the last one was short", async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    act(() => result.current.loadMore());
    await act(() => Promise.resolve());
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});

// Contract: an item whose number appears again on a later page shows once, in its first place.
describe("usePagedQuery dedupe", () => {
  it("should keep the first occurrence of a number across pages", async () => {
    fetchPage
      .mockResolvedValueOnce([...items(49, 100, "first"), { number: 7, title: "first" }])
      .mockResolvedValueOnce([
        { number: 7, title: "second" },
        { number: 3, title: "second" },
      ]);
    const { result } = render();
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(51));
    const sevens = result.current.items?.filter((i) => i.number === 7);
    expect(sevens).toEqual([{ number: 7, title: "first" }]);
    expect(result.current.items?.at(-1)).toEqual({ number: 3, title: "second" });
  });

  it("should keep the first occurrence of a number repeated within one page", async () => {
    fetchPage.mockResolvedValue([
      { number: 5, title: "a" },
      { number: 4, title: "b" },
      { number: 5, title: "c" },
    ]);
    const { result } = render();
    await waitFor(() =>
      expect(result.current.items).toEqual([
        { number: 5, title: "a" },
        { number: 4, title: "b" },
      ]),
    );
  });

  it("should not reorder or drop distinct numbers", async () => {
    fetchPage.mockResolvedValue([
      { number: 1, title: "a" },
      { number: 9, title: "b" },
      { number: 4, title: "c" },
    ]);
    const { result } = render();
    await waitFor(() => expect(result.current.items?.map((i) => i.number)).toEqual([1, 9, 4]));
  });
});

// Contract: failures reach the caller as AppError; refetch asks again.
describe("usePagedQuery errors and refetch", () => {
  it("should wrap a plain Error as an io error", async () => {
    fetchPage.mockRejectedValue(new Error("boom"));
    const { result } = render();
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
    expect(result.current.items).toBeUndefined();
  });

  it("should pass an AppError shape through unchanged", async () => {
    fetchPage.mockRejectedValue({ kind: "hostingRateLimited", message: "slow down" });
    const { result } = render();
    await waitFor(() =>
      expect(result.current.error).toEqual({ kind: "hostingRateLimited", message: "slow down" }),
    );
  });

  it("should keep the loaded pages when a later page fails", async () => {
    fetchPage
      .mockResolvedValueOnce(items(50, 100))
      .mockRejectedValueOnce({ kind: "hostingUnreachable", message: "down" });
    const { result } = render();
    await waitFor(() => expect(result.current.hasMore).toBe(true));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.error?.kind).toBe("hostingUnreachable"));
    expect(result.current.items).toHaveLength(50);
  });

  it("should clear the error and show the items when refetch succeeds", async () => {
    fetchPage.mockRejectedValueOnce(new Error("boom")).mockResolvedValue(items(2, 2));
    const { result } = render();
    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(result.current.error).toBeNull();
    expect(fetchPage.mock.calls).toEqual([[1], [1]]);
  });

  it("should report fetching during a refetch of loaded items", async () => {
    const { result } = render();
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    fetchPage.mockReturnValue(new Promise(() => undefined));
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.fetching).toBe(true));
    expect(result.current.loadingMore).toBe(false);
  });
});
