import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMessages } from "./messages";
import { MAX_TOASTS, useToasts } from "./toasts";

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  useMessages.setState({ messages: [], unread: false });
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

  it("should keep increasing ids after the toasts are reset", () => {
    const first = useToasts.getState().show("A");
    useToasts.setState({ toasts: [] });
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

// Contract (GR-14): variant, sticky and the cap of 5 toasts.
describe("useToasts notify (GR-14)", () => {
  it("show stores variant info and sticky false", () => {
    useToasts.getState().show("Hi");
    const t = useToasts.getState().toasts[0];
    expect(t?.variant).toBe("info");
    expect(t?.sticky).toBe(false);
  });

  it("notify defaults every variant to non-sticky", () => {
    const { notify } = useToasts.getState();
    notify({ text: "err", variant: "error" });
    notify({ text: "ok", variant: "success" });
    const [err, ok] = useToasts.getState().toasts;
    expect(err?.sticky).toBe(false);
    expect(ok?.sticky).toBe(false);
  });

  it("notify stores details", () => {
    useToasts.getState().notify({ text: "bad", variant: "error", details: "git said no" });
    expect(useToasts.getState().toasts[0]?.details).toBe("git said no");
  });

  it("notify stores null details by default", () => {
    useToasts.getState().notify({ text: "bad", variant: "error" });
    useToasts.getState().show("Hi");
    expect(useToasts.getState().toasts.map((t) => t.details)).toEqual([null, null]);
  });

  it("logs every toast to messages", () => {
    const id = useToasts.getState().notify({ text: "bad", variant: "error", details: "why" });
    const m = useMessages.getState().messages[0];
    expect(m).toMatchObject({ id, text: "bad", variant: "error", details: "why" });
    expect(typeof m?.at).toBe("number");
  });

  it("logs a toast the cap drops", () => {
    for (let i = 0; i <= MAX_TOASTS; i++) {
      useToasts.getState().notify({ text: `T${i}`, variant: "info" });
    }
    expect(useToasts.getState().toasts).toHaveLength(MAX_TOASTS);
    expect(useMessages.getState().messages).toHaveLength(MAX_TOASTS + 1);
  });

  it("notify honours an explicit sticky=false on error", () => {
    useToasts.getState().notify({ text: "err", variant: "error", sticky: false });
    expect(useToasts.getState().toasts[0]?.sticky).toBe(false);
  });

  it("notify honours an explicit sticky=true on success", () => {
    useToasts.getState().notify({ text: "ok", variant: "success", sticky: true });
    expect(useToasts.getState().toasts[0]?.sticky).toBe(true);
  });

  it("caps at 5, dropping the oldest non-error first", () => {
    const { notify } = useToasts.getState();
    // First toast is info (non-error).
    notify({ text: "A", variant: "info" });
    notify({ text: "B", variant: "error" });
    notify({ text: "C", variant: "success" });
    notify({ text: "D", variant: "success" });
    notify({ text: "E", variant: "info" });
    // 5 toasts now; adding a 6th should drop "A" (oldest non-error).
    notify({ text: "F", variant: "info" });
    const texts = useToasts.getState().toasts.map((t) => t.text);
    expect(texts).toHaveLength(MAX_TOASTS);
    expect(texts).not.toContain("A");
    expect(texts).toContain("F");
  });

  it("drops the oldest error when all five are errors", () => {
    const { notify } = useToasts.getState();
    for (let i = 0; i < 5; i++) {
      notify({ text: `E${i}`, variant: "error" });
    }
    notify({ text: "E5", variant: "error" });
    const texts = useToasts.getState().toasts.map((t) => t.text);
    expect(texts).toHaveLength(MAX_TOASTS);
    expect(texts).not.toContain("E0");
    expect(texts).toContain("E5");
  });

  // RED test (GR-14 fix-round-1): when five errors exist and a success arrives, the
  // success must be kept and the OLDEST EXISTING error must be dropped.
  // The current capped() searches [...list, toast] so findIndex returns the incoming
  // success (index 5) and splices it out — the arrival is silently lost.
  it("drops the oldest error when five errors exist and a success arrives", () => {
    const { notify } = useToasts.getState();
    for (let i = 0; i < 5; i++) {
      notify({ text: `E${i}`, variant: "error" });
    }
    notify({ text: "success", variant: "success" });
    const texts = useToasts.getState().toasts.map((t) => t.text);
    expect(texts).toHaveLength(MAX_TOASTS);
    // The incoming success must be present.
    expect(texts).toContain("success");
    // The oldest existing error must have been dropped.
    expect(texts).not.toContain("E0");
  });
});
