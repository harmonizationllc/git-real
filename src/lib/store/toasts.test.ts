import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "./toasts";

beforeEach(() => {
  useToasts.setState({ toasts: [] });
});

// Contract: a minimal list of toasts with one optional action each.
describe("useToasts", () => {
  it("should start with no toasts", () => {
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("should append a toast with its text when show is called", () => {
    useToasts.getState().show("Hi");
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Hi"]);
  });

  it("should store a null action when none is given", () => {
    useToasts.getState().show("Hi");
    expect(useToasts.getState().toasts[0]?.action).toBeNull();
  });

  it("should store the action when one is given", () => {
    const run = vi.fn();
    useToasts.getState().show("Hi", { label: "Open", run });
    expect(useToasts.getState().toasts[0]?.action).toEqual({ label: "Open", run });
  });

  it("should return the id of the new toast", () => {
    const id = useToasts.getState().show("Hi");
    expect(useToasts.getState().toasts[0]?.id).toBe(id);
  });

  it("should return increasing ids", () => {
    const first = useToasts.getState().show("A");
    const second = useToasts.getState().show("B");
    expect(second).toBeGreaterThan(first);
  });

  it("should keep toasts in the order they were shown", () => {
    useToasts.getState().show("A");
    useToasts.getState().show("B");
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["A", "B"]);
  });

  it("should remove only the dismissed toast", () => {
    const a = useToasts.getState().show("A");
    useToasts.getState().show("B");
    useToasts.getState().dismiss(a);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["B"]);
  });

  it("should ignore dismissing an unknown id", () => {
    useToasts.getState().show("A");
    useToasts.getState().dismiss(-1);
    expect(useToasts.getState().toasts).toHaveLength(1);
  });
});
