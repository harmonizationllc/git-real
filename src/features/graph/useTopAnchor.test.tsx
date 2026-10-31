import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TopAnchorOptions } from "./useTopAnchor";
import { useTopAnchor } from "./useTopAnchor";

const flush = () => act(() => Promise.resolve());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Renders the hook at generation 1 with "a" at row 2 on top; `rerender` merges new options. */
function setup(over: Partial<TopAnchorOptions> = {}) {
  const el = document.createElement("div");
  const locate = vi.fn<TopAnchorOptions["locate"]>().mockResolvedValue(5);
  const scrollToStart = vi.fn<TopAnchorOptions["scrollToStart"]>();
  let props: TopAnchorOptions = {
    generation: 1,
    top: { oid: "a", index: 2 },
    locate,
    scrollToStart,
    scrollRef: { current: el },
    ...over,
  };
  const view = renderHook((p: TopAnchorOptions) => useTopAnchor(p), { initialProps: props });
  const rerender = (next: Partial<TopAnchorOptions>) => {
    props = { ...props, ...next };
    view.rerender(props);
  };
  return { el, locate, scrollToStart, rerender, unmount: view.unmount };
}

// Contract: a generation change scrolls the previous top commit back to the top, once.
describe("useTopAnchor anchoring", () => {
  it("should locate the previous top commit and scroll its new row to the top", async () => {
    const { locate, scrollToStart, rerender } = setup();
    rerender({ generation: 2 });
    await flush();
    expect(locate).toHaveBeenCalledExactlyOnceWith("a", expect.any(Function));
    expect(scrollToStart).toHaveBeenCalledExactlyOnceWith(5);
  });

  it("should use the top of the previous generation, not the one rendered with the new", async () => {
    const { locate, rerender } = setup();
    rerender({ generation: 2, top: { oid: "b", index: 7 } });
    await flush();
    expect(locate).toHaveBeenCalledExactlyOnceWith("a", expect.any(Function));
  });

  it("should keep the last loaded top while the top row is not loaded", async () => {
    const { locate, rerender } = setup();
    rerender({ top: undefined });
    rerender({ generation: 2 });
    await flush();
    expect(locate).toHaveBeenCalledWith("a", expect.any(Function));
  });

  it("should anchor again on each later generation with the top recorded since", async () => {
    const { locate, rerender } = setup();
    rerender({ generation: 2 });
    await flush();
    rerender({ top: { oid: "c", index: 9 } });
    rerender({ generation: 3 });
    await flush();
    expect(locate).toHaveBeenLastCalledWith("c", expect.any(Function));
  });

  it("should not anchor on the first render", async () => {
    const { locate } = setup();
    await flush();
    expect(locate).not.toHaveBeenCalled();
  });

  it("should not anchor on a rerender with the same generation", async () => {
    const { locate, rerender } = setup();
    rerender({ top: { oid: "b", index: 4 } });
    await flush();
    expect(locate).not.toHaveBeenCalled();
  });
});

// Contract: the anchor leaves the scroll alone at the top of the list, for a commit that is gone,
// and when the user scrolls, a newer generation arrives or the list unmounts during the lookup.
describe("useTopAnchor leaves the scroll alone", () => {
  it("should not anchor when the first row was on top", async () => {
    const { locate, rerender } = setup({ top: { oid: "a", index: 0 } });
    rerender({ generation: 2 });
    await flush();
    expect(locate).not.toHaveBeenCalled();
  });

  it("should not anchor before any top row was loaded", async () => {
    const { locate, rerender } = setup({ top: undefined });
    rerender({ generation: 2 });
    await flush();
    expect(locate).not.toHaveBeenCalled();
  });

  it("should not scroll when the commit is gone from the new generation", async () => {
    const locate = vi.fn<TopAnchorOptions["locate"]>().mockResolvedValue(undefined);
    const { scrollToStart, rerender } = setup({ locate });
    rerender({ generation: 2 });
    await flush();
    expect(scrollToStart).not.toHaveBeenCalled();
  });

  it("should not scroll when the lookup fails", async () => {
    const locate = vi.fn<TopAnchorOptions["locate"]>().mockRejectedValue(new Error("boom"));
    const { scrollToStart, rerender } = setup({ locate });
    rerender({ generation: 2 });
    await flush();
    expect(scrollToStart).not.toHaveBeenCalled();
  });

  it("should cancel a pending anchor when the user scrolls during the lookup", async () => {
    const lookup = deferred<number | undefined>();
    const locate = vi.fn<TopAnchorOptions["locate"]>().mockReturnValue(lookup.promise);
    const { el, scrollToStart, rerender } = setup({ locate });
    rerender({ generation: 2 });
    el.dispatchEvent(new Event("scroll"));
    lookup.resolve(5);
    await flush();
    expect(scrollToStart).not.toHaveBeenCalled();
    expect(locate.mock.calls[0]?.[1]()).toBe(false);
  });

  it("should drop an older lookup when a newer generation arrives", async () => {
    const first = deferred<number | undefined>();
    const locate = vi
      .fn<TopAnchorOptions["locate"]>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(8);
    const { scrollToStart, rerender } = setup({ locate });
    rerender({ generation: 2 });
    rerender({ generation: 3 });
    await flush();
    first.resolve(5);
    await flush();
    expect(scrollToStart).toHaveBeenCalledExactlyOnceWith(8);
  });

  it("should not scroll after an unmount", async () => {
    const lookup = deferred<number | undefined>();
    const locate = vi.fn<TopAnchorOptions["locate"]>().mockReturnValue(lookup.promise);
    const { scrollToStart, rerender, unmount } = setup({ locate });
    rerender({ generation: 2 });
    unmount();
    lookup.resolve(5);
    await flush();
    expect(scrollToStart).not.toHaveBeenCalled();
  });

  it("should stop listening for scrolls after an unmount", () => {
    const { el, unmount } = setup();
    const remove = vi.spyOn(el, "removeEventListener");
    unmount();
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
});
