import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

type Props = Partial<React.ComponentProps<typeof ConfirmDialog>>;

function renderDialog(props: Props = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Discard changes?"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

// Contract: nothing is rendered while closed; when open it is a modal dialog labelled by its title.
describe("ConfirmDialog rendering", () => {
  it("should render nothing when closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should render a dialog when open", () => {
    renderDialog();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("should mark the dialog aria-modal", () => {
    renderDialog();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("should label the dialog by the title element", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Discard changes?" })).toBeInTheDocument();
  });

  it("should point aria-labelledby at an element containing the title", () => {
    renderDialog();
    const id = screen.getByRole("dialog").getAttribute("aria-labelledby");
    expect(document.getElementById(id ?? "missing")).toHaveTextContent("Discard changes?");
  });

  it("should render the body when provided", () => {
    renderDialog({ body: "This cannot be undone." });
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
  });

  it("should not set aria-describedby when no body is provided", () => {
    renderDialog();
    expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-describedby");
  });

  it("should describe the dialog by the body when provided", () => {
    renderDialog({ body: "This cannot be undone." });
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription("This cannot be undone.");
  });
});

// Contract: default button labels are Confirm/Cancel and both can be overridden.
describe("ConfirmDialog labels", () => {
  it("should label the confirm button Confirm by default", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });

  it("should label the cancel button Cancel by default", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("should use a custom confirm label when given", () => {
    renderDialog({ confirmLabel: "Discard" });
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  it("should use a custom cancel label when given", () => {
    renderDialog({ cancelLabel: "Keep" });
    expect(screen.getByRole("button", { name: "Keep" })).toBeInTheDocument();
  });

  it("should not show the default Confirm label when a custom one is given", () => {
    renderDialog({ confirmLabel: "Discard" });
    expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
  });
});

// Contract: the cancel button (the safe choice) receives focus on open.
describe("ConfirmDialog initial focus", () => {
  it("should focus the cancel button when opened", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("should focus the custom-labelled cancel button when opened", () => {
    renderDialog({ cancelLabel: "Keep" });
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
  });
});

// Contract: Escape and backdrop click cancel; clicks inside the dialog do not.
describe("ConfirmDialog cancellation", () => {
  it("should call onCancel when Escape is pressed", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("should not call onCancel when a key other than Escape is pressed", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.keyboard("{Tab}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should not call onConfirm when Escape is pressed", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.keyboard("{Escape}");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("should call onCancel when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    const backdrop = screen.getByRole("dialog").parentElement;
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("should not call onCancel when the dialog body is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog({ body: "Details" });
    await user.click(screen.getByText("Details"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should not call onCancel when the dialog title is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.click(screen.getByText("Discard changes?"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should not call onCancel when the dialog panel itself is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.click(screen.getByRole("dialog"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should call onCancel when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("should not call onCancel on Escape when closed", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog({ open: false });
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// Contract: clicking confirm calls onConfirm and nothing else.
describe("ConfirmDialog confirmation", () => {
  it("should call onConfirm when the confirm button is clicked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("should not call onCancel when the confirm button is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should not call onConfirm when the cancel button is clicked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// Contract: the confirm button carries data-danger only when the dialog is dangerous.
describe("ConfirmDialog danger styling", () => {
  it("should mark the confirm button with data-danger true when danger is set", () => {
    renderDialog({ danger: true });
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveAttribute("data-danger", "true");
  });

  it("should not mark the confirm button with data-danger when danger is not set", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Confirm" })).not.toHaveAttribute("data-danger");
  });

  it("should not mark the cancel button with data-danger when danger is set", () => {
    renderDialog({ danger: true });
    expect(screen.getByRole("button", { name: "Cancel" })).not.toHaveAttribute("data-danger");
  });
});

// Contract: focus returns to the previously focused element when the dialog closes.
describe("ConfirmDialog focus restore", () => {
  it("should restore focus to the previously focused element when closed", () => {
    const ui = (open: boolean) => (
      <>
        <button>Opener</button>
        <ConfirmDialog open={open} title="T" onConfirm={vi.fn()} onCancel={vi.fn()} />
      </>
    );
    const view = render(ui(false));
    screen.getByRole("button", { name: "Opener" }).focus();
    view.rerender(ui(true));
    view.rerender(ui(false));
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });
});

// Contract: danger is an attribute that is absent unless explicitly true.
describe("ConfirmDialog explicit danger false", () => {
  it("should not render data-danger at all when danger is explicitly false", () => {
    renderDialog({ danger: false });
    expect(screen.getByRole("button", { name: "Confirm" })).not.toHaveAttribute("data-danger");
  });
});

// Contract: keyboard and repeat-click behaviour on the buttons.
describe("ConfirmDialog button interactions", () => {
  it("should call onCancel once and not onConfirm when Escape is pressed on the Confirm button", async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog();
    await user.tab();
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect([onCancel.mock.calls.length, onConfirm.mock.calls.length]).toEqual([1, 0]);
  });

  it("should call onConfirm once per click; the parent, not the dialog, guards repeats", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    const confirm = screen.getByRole("button", { name: "Confirm" });
    await user.click(confirm);
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});

// Contract: focus restore targets the element focused before opening, even after re-renders.
describe("ConfirmDialog re-render while open", () => {
  const ui = (open: boolean, title: string) => (
    <>
      <button>Opener</button>
      <ConfirmDialog open={open} title={title} onConfirm={vi.fn()} onCancel={vi.fn()} />
    </>
  );

  it("should keep focus on the focused button when re-rendered with new props", async () => {
    const user = userEvent.setup();
    const view = render(ui(true, "One"));
    await user.tab();
    view.rerender(ui(true, "Two"));
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
  });

  it("should restore focus to the original opener, not a dialog button, after a re-render", async () => {
    const user = userEvent.setup();
    const view = render(ui(false, "One"));
    screen.getByRole("button", { name: "Opener" }).focus();
    view.rerender(ui(true, "One"));
    await user.tab();
    view.rerender(ui(true, "Two"));
    view.rerender(ui(false, "Two"));
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });
});

// Contract: React StrictMode (double-invoked effects) must not double-fire callbacks or break focus.
describe("ConfirmDialog under StrictMode", () => {
  function renderStrict() {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <StrictMode>
        <button>Opener</button>
        <ConfirmDialog open title="T" onConfirm={onConfirm} onCancel={onCancel} />
      </StrictMode>,
    );
    return { onConfirm, onCancel };
  }

  it("should call onConfirm once when Confirm is clicked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderStrict();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
