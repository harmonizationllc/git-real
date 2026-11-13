import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailsDialog } from "./DetailsDialog";

type Props = Partial<React.ComponentProps<typeof DetailsDialog>>;

function renderDialog(props: Props = {}) {
  const onClose = vi.fn();
  render(
    <DetailsDialog
      open
      title="Push failed"
      details={"remote: denied\nfatal: nope"}
      onClose={onClose}
      {...props}
    />,
  );
  return { onClose };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

// Contract: a modal dialog showing raw output, with Copy and Close.
describe("DetailsDialog", () => {
  it("renders nothing when closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders the title and details in a dialog", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "Push failed" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveTextContent("remote: denied");
    expect(dialog).toHaveTextContent("fatal: nope");
  });

  it("focuses Close on open", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("Copy writes the details to the clipboard", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("remote: denied\nfatal: nope");
  });

  it("Close calls onClose", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape calls onClose", () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("returns focus to the opener when closed", () => {
    const ui = (open: boolean) => (
      <>
        <button>Opener</button>
        <DetailsDialog open={open} title="T" details="d" onClose={vi.fn()} />
      </>
    );
    const view = render(ui(false));
    screen.getByRole("button", { name: "Opener" }).focus();
    view.rerender(ui(true));
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    view.rerender(ui(false));
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });

  it("renders into document.body, outside the render container", () => {
    const { container } = render(<DetailsDialog open title="T" details="d" onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.getByRole("dialog").parentElement?.parentElement).toBe(document.body);
  });

  it("a backdrop click calls onClose, a click inside does not", () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
