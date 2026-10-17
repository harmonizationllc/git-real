import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import { loadParser } from "./model/highlight";
import { HIGHLIGHT_LIMIT } from "./model/limits";
import { useHighlight } from "./useHighlight";

vi.mock(import("./model/highlight"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadParser: vi.fn(actual.loadParser) };
});

const settle = () => new Promise((r) => setTimeout(r, 20));

// Contract: no highlight map when there is nothing to highlight.
describe("useHighlight eligibility", () => {
  it("should be null without a diff", () => {
    expect(renderHook(() => useHighlight(undefined)).result.current).toBeNull();
  });
  it("should be null for a binary diff", () => {
    const diff = fileDiff([hunk([L("context", "x")])], { isBinary: true });
    expect(renderHook(() => useHighlight(diff)).result.current).toBeNull();
  });
  it("should be null for an unknown language", () => {
    const diff = fileDiff([hunk([L("context", "x")])], { path: "noext" });
    expect(renderHook(() => useHighlight(diff)).result.current).toBeNull();
  });
  it("should skip diffs above HIGHLIGHT_LIMIT lines", async () => {
    const lines = Array.from({ length: HIGHLIGHT_LIMIT + 1 }, () => L("context", "x"));
    const diff = fileDiff([hunk(lines)], { path: "a.js" });
    const { result } = renderHook(() => useHighlight(diff));
    await settle();
    expect(result.current).toBeNull();
  });
});

// Contract: once the language loads, every hunk gets tokens keyed by hunk index.
describe("useHighlight result", () => {
  it("should be null until the language loads, then highlight every hunk", async () => {
    const diff = fileDiff([hunk([L("addition", "const a = 1;")]), hunk([L("deletion", "// c")])], {
      path: "a.js",
    });
    const { result } = renderHook(() => useHighlight(diff));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.get(0)?.[0]?.find((t) => t.text === "1")?.className).toBe("tok-number");
    expect(result.current?.get(1)?.[0]?.[0]?.className).toBe("tok-comment");
  });
  it("should ignore a load that finishes after the diff changed", async () => {
    const a = fileDiff([hunk([L("addition", "a"), L("addition", "b")])], { path: "a.js" });
    const b = fileDiff([hunk([L("addition", "c")])], { path: "b.js" });
    const { result, rerender } = renderHook(({ d }) => useHighlight(d), { initialProps: { d: a } });
    rerender({ d: b });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.get(0)).toHaveLength(1);
  });
  it("should stay null when the diff becomes undefined before the language loads", async () => {
    const a = fileDiff([hunk([L("addition", "a")])], { path: "a.js" });
    const { result, rerender } = renderHook(({ d }) => useHighlight(d), {
      initialProps: { d: a as typeof a | undefined },
    });
    rerender({ d: undefined });
    await settle();
    expect(result.current).toBeNull();
  });
  it("should return null for a new diff until its own highlight is ready", async () => {
    const a = fileDiff([hunk([L("addition", "a")])], { path: "a.js" });
    const b = fileDiff([hunk([L("addition", "b")])], { path: "b.js" });
    const { result, rerender } = renderHook(({ d }) => useHighlight(d), { initialProps: { d: a } });
    await waitFor(() => expect(result.current).not.toBeNull());
    rerender({ d: b });
    expect(result.current).toBeNull();
  });
});

// Contract: a failed language load is logged and leaves highlighting off.
describe("useHighlight failure", () => {
  it("should return null when a language fails to load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadParser).mockRejectedValueOnce(new Error("offline"));
    const diff = fileDiff([hunk([L("context", "x")])], { path: "z.js" });
    const { result } = renderHook(() => useHighlight(diff));
    await settle();
    expect(result.current).toBeNull();
  });
  it("should log the load failure", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadParser).mockRejectedValueOnce(new Error("offline"));
    const diff = fileDiff([hunk([L("context", "x")])], { path: "z.js" });
    renderHook(() => useHighlight(diff));
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });
});
