import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CentreView } from "../../lib/store/workspace";
import { CloseDiffButton, FileHeader } from "./FileHeader";

function setup(over: { path?: string; oldPath?: string | null; view?: CentreView } = {}) {
  const props = { onViewChange: vi.fn(), onHistory: vi.fn(), onClose: vi.fn() };
  const view = render(
    <FileHeader
      path={over.path ?? "src/a.ts"}
      oldPath={over.oldPath}
      view={over.view ?? "diff"}
      {...props}
    />,
  );
  return { ...view, ...props };
}

// Contract: the header names the file, or old → new for a rename.
describe("FileHeader path", () => {
  it("should show the path", () => {
    setup();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
  });

  it("should show old → new as one text for a rename", () => {
    setup({ path: "new.ts", oldPath: "old.ts" });
    expect(screen.getByText("old.ts → new.ts")).toBeInTheDocument();
  });

  it("should show no arrow when oldPath is null", () => {
    const { container } = setup({ oldPath: null });
    expect(container.textContent).not.toContain("→");
  });

  it("should show no arrow when oldPath is omitted", () => {
    const { container } = setup();
    expect(container.textContent).not.toContain("→");
  });
});

// Contract: a radio group named View switches between Diff and Blame.
describe("FileHeader view toggle", () => {
  it("should expose a radiogroup named View with Diff and Blame", () => {
    setup();
    const group = screen.getByRole("radiogroup", { name: "View" });
    expect(group).toContainElement(screen.getByRole("radio", { name: "Diff" }));
    expect(group).toContainElement(screen.getByRole("radio", { name: "Blame" }));
  });

  it("should check Diff when the view is diff", () => {
    setup({ view: "diff" });
    expect(screen.getByRole("radio", { name: "Diff" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Blame" })).not.toBeChecked();
  });

  it("should check Blame when the view is blame", () => {
    setup({ view: "blame" });
    expect(screen.getByRole("radio", { name: "Blame" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Diff" })).not.toBeChecked();
  });

  it("should call onViewChange with blame when Blame is chosen", () => {
    const { onViewChange } = setup({ view: "diff" });
    fireEvent.click(screen.getByRole("radio", { name: "Blame" }));
    expect(onViewChange).toHaveBeenCalledExactlyOnceWith("blame");
  });

  it("should call onViewChange with diff when Diff is chosen", () => {
    const { onViewChange } = setup({ view: "blame" });
    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    expect(onViewChange).toHaveBeenCalledExactlyOnceWith("diff");
  });

  it("should not call onViewChange when the checked radio is clicked again", () => {
    const { onViewChange } = setup({ view: "diff" });
    fireEvent.click(screen.getByRole("radio", { name: "Diff" }));
    expect(onViewChange).not.toHaveBeenCalled();
  });
});

// Contract: History opens the file history; Close asks the owner to close the file view.
describe("FileHeader buttons", () => {
  it("should call onHistory once when Show file history is clicked", () => {
    const { onHistory } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Show file history" }));
    expect(onHistory).toHaveBeenCalledOnce();
  });

  it("should label the history button History", () => {
    setup();
    expect(screen.getByRole("button", { name: "Show file history" })).toHaveTextContent("History");
  });

  it("should call onClose once when Close diff is clicked", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should call no callback before any control is used", () => {
    const { onClose, onHistory, onViewChange } = setup();
    expect([onClose, onHistory, onViewChange].every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("should not call onClose or onViewChange when History is clicked", () => {
    const { onClose, onViewChange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Show file history" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(onViewChange).not.toHaveBeenCalled();
  });
});

// Contract: CloseDiffButton moved here and keeps its label and click behaviour.
describe("CloseDiffButton", () => {
  it("should render a button named Close diff", () => {
    render(<CloseDiffButton onClick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Close diff" })).toBeInTheDocument();
  });

  it("should call onClick once when clicked", () => {
    const onClick = vi.fn();
    render(<CloseDiffButton onClick={onClick} />);
    fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
