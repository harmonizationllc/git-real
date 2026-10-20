import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConflictToolbar, type ConflictToolbarProps } from "./ConflictToolbar";

const labels = { ours: "main", theirs: "feature" };

function props(over: Partial<ConflictToolbarProps> = {}): ConflictToolbarProps {
  return {
    path: "src/a.txt",
    remaining: 2,
    canPickAll: true,
    labels,
    pending: false,
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onKeepAll: vi.fn(),
    onTakeAll: vi.fn(),
    onMarkResolved: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

const btn = (name: string) => screen.getByRole("button", { name });

// Contract: while loading or on the placeholder only the path and Close show.
describe("ConflictToolbar without a count", () => {
  it("shows only the path and Close when remaining is null", () => {
    render(<ConflictToolbar {...props({ remaining: null })} />);
    expect(screen.getByText("src/a.txt")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
  });

  it("shows no count copy when remaining is null", () => {
    render(<ConflictToolbar {...props({ remaining: null })} />);
    expect(screen.queryByText(/conflicts? remaining|All conflicts resolved/)).toBeNull();
  });
});

// Contract: count copy follows spec section 5.
describe("ConflictToolbar count copy", () => {
  it("shows the count copy for 0, 1 and n", () => {
    const { rerender } = render(<ConflictToolbar {...props({ remaining: 0 })} />);
    expect(screen.getByText("All conflicts resolved")).toBeInTheDocument();
    rerender(<ConflictToolbar {...props({ remaining: 1 })} />);
    expect(screen.getByText("1 conflict remaining")).toBeInTheDocument();
    rerender(<ConflictToolbar {...props({ remaining: 5 })} />);
    expect(screen.getByText("5 conflicts remaining")).toBeInTheDocument();
  });
});

// Contract: the editable toolbar offers the full set of actions, labelled with the side names.
describe("ConflictToolbar actions", () => {
  it("shows the path and every button with the side names", () => {
    render(<ConflictToolbar {...props()} />);
    expect(screen.getByText("src/a.txt")).toBeInTheDocument();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Previous",
      "Next",
      "Keep all main",
      "Take all feature",
      "Mark resolved",
      "Close",
    ]);
  });

  it("enables Previous, Next, Keep all and Take all while conflicts remain", () => {
    render(<ConflictToolbar {...props()} />);
    expect(btn("Previous")).toBeEnabled();
    expect(btn("Next")).toBeEnabled();
    expect(btn("Keep all main")).toBeEnabled();
    expect(btn("Take all feature")).toBeEnabled();
  });

  it("disables Previous, Next, Keep all and Take all at zero", () => {
    render(<ConflictToolbar {...props({ remaining: 0 })} />);
    expect(btn("Previous")).toBeDisabled();
    expect(btn("Next")).toBeDisabled();
    expect(btn("Keep all main")).toBeDisabled();
    expect(btn("Take all feature")).toBeDisabled();
  });

  it("disables Keep all and Take all when no block is unresolved", () => {
    render(<ConflictToolbar {...props({ canPickAll: false })} />);
    expect(btn("Keep all main")).toBeDisabled();
    expect(btn("Take all feature")).toBeDisabled();
  });

  it("keeps Previous and Next enabled when no block is unresolved but markers remain", () => {
    render(<ConflictToolbar {...props({ canPickAll: false })} />);
    expect(btn("Previous")).toBeEnabled();
    expect(btn("Next")).toBeEnabled();
  });

  it("disables Keep all and Take all while pending", () => {
    render(<ConflictToolbar {...props({ pending: true })} />);
    expect(btn("Keep all main")).toBeDisabled();
    expect(btn("Take all feature")).toBeDisabled();
  });

  it("labels Keep all and Take all from the side names", () => {
    render(<ConflictToolbar {...props({ labels: { ours: "develop", theirs: "topic" } })} />);
    expect(btn("Keep all develop")).toBeInTheDocument();
    expect(btn("Take all topic")).toBeInTheDocument();
  });
});

// Contract: Mark resolved explains why it is disabled.
describe("ConflictToolbar Mark resolved", () => {
  it('disables Mark resolved with "Resolve all conflicts first" while remaining > 0', () => {
    render(<ConflictToolbar {...props({ remaining: 1 })} />);
    expect(btn("Mark resolved")).toBeDisabled();
    expect(btn("Mark resolved")).toHaveAttribute("title", "Resolve all conflicts first");
  });

  it('disables Mark resolved with "Saving…" while pending', () => {
    render(<ConflictToolbar {...props({ remaining: 0, pending: true })} />);
    expect(btn("Mark resolved")).toBeDisabled();
    expect(btn("Mark resolved")).toHaveAttribute("title", "Saving…");
  });

  it("enables Mark resolved with no title once nothing remains and nothing is pending", () => {
    render(<ConflictToolbar {...props({ remaining: 0 })} />);
    expect(btn("Mark resolved")).toBeEnabled();
    expect(btn("Mark resolved")).not.toHaveAttribute("title");
  });
});

// Contract: every button calls its callback once.
describe("ConflictToolbar callbacks", () => {
  it("fires every callback", () => {
    const p = props();
    const { rerender } = render(<ConflictToolbar {...p} />);
    for (const name of ["Previous", "Next", "Keep all main", "Take all feature"]) {
      fireEvent.click(btn(name));
    }
    rerender(<ConflictToolbar {...p} remaining={0} />);
    fireEvent.click(btn("Mark resolved"));
    fireEvent.click(btn("Close"));
    for (const fn of [
      p.onPrevious,
      p.onNext,
      p.onKeepAll,
      p.onTakeAll,
      p.onMarkResolved,
      p.onClose,
    ]) {
      expect(fn).toHaveBeenCalledOnce();
    }
  });

  it("fires only onClose when Close is clicked", () => {
    const p = props();
    render(<ConflictToolbar {...p} />);
    fireEvent.click(btn("Close"));
    expect(p.onNext).not.toHaveBeenCalled();
    expect(p.onMarkResolved).not.toHaveBeenCalled();
  });

  it("does not fire onMarkResolved while it is disabled", () => {
    const p = props({ remaining: 2 });
    render(<ConflictToolbar {...p} />);
    fireEvent.click(btn("Mark resolved"));
    expect(p.onMarkResolved).not.toHaveBeenCalled();
  });
});
