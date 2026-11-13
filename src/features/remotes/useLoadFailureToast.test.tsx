import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "../../lib/ipc";
import { useToasts } from "../../lib/store/toasts";
import { useLoadFailureToast } from "./useLoadFailureToast";

const toasts = () => useToasts.getState().toasts;
const broken: AppError = { kind: "operationFailed", message: "broken" };

beforeEach(() => {
  useToasts.setState({ toasts: [] });
});

// Contract: a failed list load with nothing to show toasts once per error object, with Retry.
describe("useLoadFailureToast", () => {
  it("toasts once with the copy and a Retry action, and returns true", () => {
    const refetch = vi.fn();
    const { result, rerender } = renderHook(() =>
      useLoadFailureToast("tags", false, broken, refetch),
    );
    rerender();
    expect(result.current).toBe(true);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].text).toBe("Couldn't load tags: broken");
    expect(toasts()[0].variant).toBe("error");
    expect(toasts()[0].action?.label).toBe("Retry");
    toasts()[0].action?.run();
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("toasts again for a new error object", () => {
    let error = broken;
    const { rerender } = renderHook(() => useLoadFailureToast("tags", false, error, vi.fn()));
    error = { ...broken };
    rerender();
    expect(toasts()).toHaveLength(2);
  });

  it("does not toast, and returns false, while loaded", () => {
    const { result } = renderHook(() => useLoadFailureToast("tags", true, broken, vi.fn()));
    expect(result.current).toBe(false);
    expect(toasts()).toEqual([]);
  });

  it("does not toast without an error", () => {
    const { result } = renderHook(() => useLoadFailureToast("tags", false, null, vi.fn()));
    expect(result.current).toBe(false);
    expect(toasts()).toEqual([]);
  });
});
