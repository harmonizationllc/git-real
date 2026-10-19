import type { Parser } from "@lezer/common";
import { Tree } from "@lezer/common";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadParser } from "./model/highlight";
import { HIGHLIGHT_LIMIT } from "./model/limits";
import { useTextHighlight } from "./useTextHighlight";

vi.mock(import("./model/highlight"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadParser: vi.fn(actual.loadParser) };
});

beforeEach(() => {
  vi.mocked(loadParser).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const settle = () => new Promise((r) => setTimeout(r, 20));

// Contract: no tokens, and no language load, when there is nothing to highlight.
describe("useTextHighlight eligibility", () => {
  it("should be null and load nothing while lines are undefined", async () => {
    const { result } = renderHook(() => useTextHighlight("a.js", undefined));
    await settle();
    expect(loadParser).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
  it("should be null for an unknown extension", async () => {
    const { result } = renderHook(() => useTextHighlight("noext", ["x"]));
    await settle();
    expect(loadParser).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
  it("should be null above HIGHLIGHT_LIMIT lines", async () => {
    const lines = Array.from({ length: HIGHLIGHT_LIMIT + 1 }, () => "x");
    const { result } = renderHook(() => useTextHighlight("a.js", lines));
    await settle();
    expect(loadParser).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});

// Contract: HIGHLIGHT_LIMIT lines is the largest highlighted file; one more is skipped.
describe("useTextHighlight limit boundary", () => {
  it("should highlight a file of exactly HIGHLIGHT_LIMIT lines", async () => {
    // A span-less stub parser keeps this about the limit check, not real tokenizing time.
    vi.mocked(loadParser).mockResolvedValueOnce({ parse: () => Tree.empty } as unknown as Parser);
    const lines = Array.from({ length: HIGHLIGHT_LIMIT }, () => "x");
    const { result } = renderHook(() => useTextHighlight("a.js", lines));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(loadParser).toHaveBeenCalledTimes(1);
    expect(result.current).toHaveLength(HIGHLIGHT_LIMIT);
  });
  it("should highlight an empty file as no lines", async () => {
    const lines: string[] = [];
    const { result } = renderHook(() => useTextHighlight("a.js", lines));
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toEqual([]);
  });
  it("should go back to null when the lines grow past the limit", async () => {
    const small = ["const a = 1;"];
    const big = Array.from({ length: HIGHLIGHT_LIMIT + 1 }, () => "x");
    const { result, rerender } = renderHook(({ l }) => useTextHighlight("a.js", l), {
      initialProps: { l: small },
    });
    await waitFor(() => expect(result.current).not.toBeNull());
    rerender({ l: big });
    await settle();
    expect(result.current).toBeNull();
  });
});

// Contract: tokens arrive once the grammar loads, one array per line.
describe("useTextHighlight result", () => {
  it("should be null while loading and tokens after", async () => {
    const lines = ["const a = 1;", "// c"];
    const { result } = renderHook(() => useTextHighlight("a.js", lines));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current).toHaveLength(2);
    expect(result.current?.[0]?.find((t) => t.text === "1")?.className).toBe("tok-number");
    expect(result.current?.[1]?.[0]?.className).toBe("tok-comment");
  });
  it("should drop stale tokens when the lines change", async () => {
    const { result, rerender } = renderHook(({ l }) => useTextHighlight("a.js", l), {
      initialProps: { l: ["const a = 1;"] },
    });
    await waitFor(() => expect(result.current).not.toBeNull());
    rerender({ l: ["// other", "// more"] });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toHaveLength(2));
  });
  it("should log and stay null when the language fails to load", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadParser).mockRejectedValueOnce(new Error("chunk failed"));
    const { result } = renderHook(() => useTextHighlight("a.js", ["x"]));
    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
  it("should make no state update after unmount", async () => {
    let resolve: (p: never) => void = () => undefined;
    vi.mocked(loadParser).mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = renderHook(() => useTextHighlight("a.js", ["const a = 1;"]));
    unmount();
    const { javascriptLanguage } = await import("@codemirror/lang-javascript");
    resolve(javascriptLanguage.parser as never);
    await settle();
    expect(err).not.toHaveBeenCalled();
  });
});
