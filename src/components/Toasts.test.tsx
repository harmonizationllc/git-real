import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToasts } from "../lib/store/toasts";
import { Toasts } from "./Toasts";

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

// Contract: every toast dismisses itself 8000 ms after it appears.
describe("Toasts auto-dismiss", () => {
  it("should still show the toast at 7999 ms", () => {
    render(<Toasts />);
    show("Hi");
    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(screen.getByText("Hi")).toBeInTheDocument();
  });

  it("should remove the toast at 8000 ms", () => {
    render(<Toasts />);
    show("Hi");
    act(() => {
      vi.advanceTimersByTime(8000);
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

  it("should keep a toast whose earlier twin was dismissed by hand until its own 8000 ms", () => {
    render(<Toasts />);
    show("First");
    show("Second");
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss notification" })[0]!);
    act(() => {
      vi.advanceTimersByTime(7999);
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
