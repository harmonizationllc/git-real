import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNow } from "./useNow";

const START = new Date("2026-10-19T12:00:00Z");
const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

// Contract: the current Unix time in seconds, refreshed every minute, so rows never read the clock.
describe("useNow", () => {
  it("should start at the current time in Unix seconds", () => {
    const { result } = renderHook(() => useNow());
    expect(result.current).toBe(Math.floor(Date.now() / 1000));
  });

  it("should truncate to whole seconds", () => {
    vi.setSystemTime(new Date(START.getTime() + 999));
    const { result } = renderHook(() => useNow());
    expect(result.current).toBe(seconds(START));
  });

  it("should not change before a minute has passed", () => {
    const { result } = renderHook(() => useNow());
    act(() => {
      vi.advanceTimersByTime(59_999);
    });
    expect(result.current).toBe(seconds(START));
  });

  it("should advance after 60 seconds", () => {
    const { result } = renderHook(() => useNow());
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current).toBe(seconds(START) + 60);
  });

  it("should keep advancing every minute", () => {
    const { result } = renderHook(() => useNow());
    act(() => {
      vi.advanceTimersByTime(180_000);
    });
    expect(result.current).toBe(seconds(START) + 180);
  });

  it("should clear its interval on unmount", () => {
    const { unmount } = renderHook(() => useNow());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should keep a single interval across rerenders", () => {
    const { rerender } = renderHook(() => useNow());
    rerender();
    rerender();
    expect(vi.getTimerCount()).toBe(1);
  });
});
