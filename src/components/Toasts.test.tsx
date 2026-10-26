import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "../lib/store/toasts";
import { TOAST_MS, Toasts } from "./Toasts";
import type { ToastVariant } from "../lib/store/toasts";

beforeEach(() => {
  vi.useFakeTimers();
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

const show = (text: string, action?: { label: string; run(): void }) => {
  let id = 0;
  act(() => {
    id = useToasts.getState().show(text, action);
  });
  return id;
};

// Contract: a polite status region lists the toasts, each with an optional action and a dismiss.
describe("Toasts rendering", () => {
  it("should render a polite status region", () => {
    render(<Toasts />);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("should keep the region mounted when there are no toasts", () => {
    render(<Toasts />);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("should render a toast's text", () => {
    render(<Toasts />);
    show("Opened #124");
    expect(screen.getByRole("status")).toHaveTextContent("Opened #124");
  });

  it("should render the action button with its label", () => {
    render(<Toasts />);
    show("Opened #124", { label: "Open in browser", run: vi.fn() });
    expect(screen.getByRole("button", { name: "Open in browser" })).toBeInTheDocument();
  });

  it("should render no action button when the toast has no action", () => {
    render(<Toasts />);
    show("Hi");
    expect(screen.queryByRole("button", { name: "Open in browser" })).toBeNull();
  });

  it("should stack two toasts in the order they were shown", () => {
    render(<Toasts />);
    show("First");
    show("Second");
    const text = screen.getByRole("status").textContent ?? "";
    expect(text.indexOf("First")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Second")).toBeGreaterThan(text.indexOf("First"));
  });
});

// Contract: the action runs and dismisses; Dismiss notification removes without running.
describe("Toasts actions", () => {
  it("should run the action when its button is clicked", () => {
    const run = vi.fn();
    render(<Toasts />);
    show("Opened #124", { label: "Open in browser", run });
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("should dismiss the toast after its action runs", () => {
    render(<Toasts />);
    show("Opened #124", { label: "Open in browser", run: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    expect(screen.queryByText("Opened #124")).toBeNull();
  });

  it("should remove the toast when Dismiss notification is clicked", () => {
    render(<Toasts />);
    show("Hi");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByText("Hi")).toBeNull();
  });

  it("should not run the action when the toast is dismissed", () => {
    const run = vi.fn();
    render(<Toasts />);
    show("Hi", { label: "Open", run });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(run).not.toHaveBeenCalled();
  });

  it("should dismiss only the toast whose button was clicked", () => {
    render(<Toasts />);
    show("First");
    show("Second");
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss notification" })[0]!);
    expect(screen.getByRole("status")).toHaveTextContent("Second");
    expect(screen.queryByText("First")).toBeNull();
  });
});

// Contract: every toast dismisses itself TOAST_MS (8000 ms) after it appears.
describe("Toasts auto-dismiss", () => {
  it("should still show the toast one millisecond before TOAST_MS", () => {
    render(<Toasts />);
    show("Hi");
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(screen.getByText("Hi")).toBeInTheDocument();
  });

  it("should remove the toast at TOAST_MS", () => {
    render(<Toasts />);
    show("Hi");
    act(() => {
      vi.advanceTimersByTime(TOAST_MS);
    });
    expect(screen.queryByText("Hi")).toBeNull();
  });

  it("should time each toast from when it was shown", () => {
    render(<Toasts />);
    show("First");
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    show("Second");
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByText("First")).toBeNull();
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("should keep a toast whose earlier twin was dismissed by hand until its own TOAST_MS", () => {
    render(<Toasts />);
    show("First");
    show("Second");
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss notification" })[0]!);
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 1);
    });
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("should clear a toast's timer when it is dismissed by hand", () => {
    render(<Toasts />);
    show("Hi");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should clear a toast's timer when its action dismisses it", () => {
    render(<Toasts />);
    show("Hi", { label: "Open", run: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should leave the other toast's timer running when one is dismissed", () => {
    render(<Toasts />);
    show("First");
    show("Second");
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss notification" })[0]!);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("should clear its timers on unmount", () => {
    const view = render(<Toasts />);
    show("Hi");
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Contract: a toast under the pointer or holding focus does not time out; leaving restarts the full TOAST_MS.
describe("Toasts pause on hover and focus", () => {
  const toastEl = () => screen.getByText("Hi").parentElement!;
  const advance = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it("should still show a toast hovered at 7 s after another 5 s", () => {
    render(<Toasts />);
    show("Hi");
    advance(7000);
    fireEvent.pointerEnter(toastEl());
    advance(5000);
    expect(screen.getByText("Hi")).toBeInTheDocument();
  });

  it("should clear the timer while the toast is hovered", () => {
    render(<Toasts />);
    show("Hi");
    fireEvent.pointerEnter(toastEl());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should still show the toast one millisecond before a full TOAST_MS after the pointer leaves", () => {
    render(<Toasts />);
    show("Hi");
    advance(7000);
    fireEvent.pointerEnter(toastEl());
    advance(5000);
    fireEvent.pointerLeave(toastEl());
    advance(TOAST_MS - 1);
    expect(screen.getByText("Hi")).toBeInTheDocument();
  });

  it("should remove the toast a full TOAST_MS after the pointer leaves", () => {
    render(<Toasts />);
    show("Hi");
    advance(7000);
    fireEvent.pointerEnter(toastEl());
    advance(5000);
    fireEvent.pointerLeave(toastEl());
    advance(TOAST_MS);
    expect(screen.queryByText("Hi")).toBeNull();
  });

  it("should keep a toast whose action button has focus past TOAST_MS", () => {
    render(<Toasts />);
    show("Hi", { label: "Open", run: vi.fn() });
    fireEvent.focusIn(screen.getByRole("button", { name: "Open" }));
    advance(TOAST_MS * 2);
    expect(screen.getByText("Hi")).toBeInTheDocument();
  });

  it("should remove the toast TOAST_MS after focus leaves to outside it", () => {
    render(<Toasts />);
    show("Hi", { label: "Open", run: vi.fn() });
    const open = screen.getByRole("button", { name: "Open" });
    fireEvent.focusIn(open);
    fireEvent.focusOut(open, { relatedTarget: document.body });
    advance(TOAST_MS);
    expect(screen.queryByText("Hi")).toBeNull();
  });

  it("should remove the toast TOAST_MS after focus leaves with no related target", () => {
    render(<Toasts />);
    show("Hi", { label: "Open", run: vi.fn() });
    const open = screen.getByRole("button", { name: "Open" });
    fireEvent.focusIn(open);
    fireEvent.focusOut(open, { relatedTarget: null });
    advance(TOAST_MS);
    expect(screen.queryByText("Hi")).toBeNull();
  });

  it("should keep the pause when focus moves between buttons inside the same toast", () => {
    render(<Toasts />);
    show("Hi", { label: "Open", run: vi.fn() });
    const open = screen.getByRole("button", { name: "Open" });
    const close = screen.getByRole("button", { name: "Dismiss notification" });
    fireEvent.focusIn(open);
    fireEvent.focusOut(open, { relatedTarget: close });
    fireEvent.focusIn(close);
    advance(TOAST_MS * 2);
    expect(screen.getByText("Hi")).toBeInTheDocument();
  });

  it("should not pause the other toast when one is hovered", () => {
    render(<Toasts />);
    show("First");
    show("Second");
    fireEvent.pointerEnter(screen.getByText("First").parentElement!);
    advance(TOAST_MS);
    expect(screen.queryByText("Second")).toBeNull();
  });

  it("should not start a timer when the pointer leaves a toast that was dismissed", () => {
    render(<Toasts />);
    show("Hi");
    const el = toastEl();
    fireEvent.pointerEnter(el);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    fireEvent.pointerLeave(el);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Held while hovered OR focused: ending one reason while the other holds must not restart it.
  it("should keep the pause when the pointer leaves while focus is still inside", () => {
    render(<Toasts />);
    show("Hi", { label: "Open", run: vi.fn() });
    const open = screen.getByRole("button", { name: "Open" });
    fireEvent.pointerEnter(toastEl());
    fireEvent.focusIn(open);
    fireEvent.pointerLeave(toastEl());
    advance(TOAST_MS * 2);
    expect(screen.getByText("Hi")).toBeInTheDocument();
  });

  it("should keep the pause when focus leaves while the pointer is still over the toast", () => {
    render(<Toasts />);
    show("Hi", { label: "Open", run: vi.fn() });
    const open = screen.getByRole("button", { name: "Open" });
    fireEvent.pointerEnter(toastEl());
    fireEvent.focusIn(open);
    fireEvent.focusOut(open, { relatedTarget: document.body });
    advance(TOAST_MS * 2);
    expect(screen.getByText("Hi")).toBeInTheDocument();
  });

  it("should remove the toast a full TOAST_MS after both the pointer and focus have left", () => {
    render(<Toasts />);
    show("Hi", { label: "Open", run: vi.fn() });
    const open = screen.getByRole("button", { name: "Open" });
    fireEvent.pointerEnter(toastEl());
    fireEvent.focusIn(open);
    fireEvent.focusOut(open, { relatedTarget: document.body });
    fireEvent.pointerLeave(toastEl());
    advance(TOAST_MS - 1);
    expect(screen.getByText("Hi")).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText("Hi")).toBeNull();
  });
});

// Contract (GR-14): variants, sticky behaviour, role=alert for errors.
describe("Toasts variants (GR-14)", () => {
  const notify = (text: string, variant: ToastVariant, sticky = false) => {
    act(() => {
      useToasts.getState().notify({ text, variant, sticky });
    });
  };

  it("renders data-variant on a toast element", () => {
    render(<Toasts />);
    notify("ok", "success");
    const toastEl = screen.getByText("ok").parentElement!;
    expect(toastEl).toHaveAttribute("data-variant", "success");
  });

  it("renders an aria-hidden icon span", () => {
    render(<Toasts />);
    notify("done", "success");
    const toastEl = screen.getByText("done").parentElement!;
    const icon = toastEl.querySelector("[aria-hidden]");
    expect(icon).not.toBeNull();
  });

  it("an error toast has role alert while the region stays polite", () => {
    render(<Toasts />);
    notify("bad", "error");
    const toastEl = screen.getByText("bad").parentElement!;
    expect(toastEl).toHaveAttribute("role", "alert");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it("a sticky toast has no timeout and keeps Dismiss", () => {
    render(<Toasts />);
    act(() => {
      useToasts.getState().notify({ text: "sticky", variant: "error", sticky: true });
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS * 2);
    });
    expect(screen.getByText("sticky")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeInTheDocument();
  });

  it("a non-sticky success toast times out", () => {
    render(<Toasts />);
    act(() => {
      useToasts.getState().notify({ text: "gone", variant: "success", sticky: false });
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_MS);
    });
    expect(screen.queryByText("gone")).toBeNull();
  });
});
