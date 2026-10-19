import { fireEvent, render, screen } from "@testing-library/react";
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

  it("should focus the Cancel button on open", () => {
    renderStrict();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("should call onCancel once when Escape is pressed", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderStrict();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("should call onConfirm once when Confirm is clicked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderStrict();
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

// Contract: while pending both buttons are disabled, confirm reads Working…, and dismissal is ignored.
describe("ConfirmDialog pending", () => {
  it("should disable the confirm button while pending", () => {
    renderDialog({ pending: true, confirmLabel: "Delete" });
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
  });

  it("should replace the confirm label with Working… while pending", () => {
    renderDialog({ pending: true, confirmLabel: "Delete" });
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("should disable the cancel button while pending", () => {
    renderDialog({ pending: true });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("should not call onConfirm when the pending confirm is clicked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ pending: true });
    await user.click(screen.getByRole("button", { name: "Working…" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("should not call onCancel when Cancel is clicked while pending", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog({ pending: true });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should not call onCancel on Escape while pending", () => {
    const { onCancel } = renderDialog({ pending: true });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should not call onCancel on a backdrop click while pending", () => {
    const { onCancel } = renderDialog({ pending: true });
    fireEvent.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should behave normally when pending is false", async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog({ pending: false, confirmLabel: "Delete" });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("should default to not pending", () => {
    renderDialog({ confirmLabel: "Delete" });
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });
});

// Contract: pending keeps the danger styling on the disabled confirm button.
describe("ConfirmDialog pending with danger", () => {
  it("should keep data-danger on the Working… confirm button", () => {
    renderDialog({ pending: true, danger: true, confirmLabel: "Delete" });
    const confirm = screen.getByRole("button", { name: "Working…" });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("data-danger", "true");
  });
});

// Contract: the body may be any ReactNode and renders inside the aria-describedby node.
describe("ConfirmDialog node body", () => {
  it("should render an element body inside the described-by node", () => {
    renderDialog({
      body: (
        <p>
          Reset to <strong>abc1234</strong>
        </p>
      ),
    });
    const id = screen.getByRole("dialog").getAttribute("aria-describedby");
    expect(document.getElementById(id ?? "missing")).toContainElement(screen.getByText("abc1234"));
  });

  it("should keep the structure of an element body", () => {
    renderDialog({
      body: (
        <ul>
          <li>one</li>
          <li>two</li>
        </ul>
      ),
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("should render a string body inside the described-by node", () => {
    renderDialog({ body: "This cannot be undone." });
    const id = screen.getByRole("dialog").getAttribute("aria-describedby");
    expect(document.getElementById(id ?? "missing")).toHaveTextContent("This cannot be undone.");
  });

  it("should not render the element body while closed", () => {
    renderDialog({ open: false, body: <p>hidden body</p> });
    expect(screen.queryByText("hidden body")).toBeNull();
  });
});

// Coverage: which body values describe the dialog.
describe("ConfirmDialog body presence", () => {
  it("should not set aria-describedby for a null body", () => {
    renderDialog({ body: null });
    expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-describedby");
  });

  it("should not set aria-describedby for an explicit undefined body", () => {
    renderDialog({ body: undefined });
    expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-describedby");
  });

  it("should set aria-describedby to an element that exists for an element body", () => {
    renderDialog({ body: <p>Detached HEAD</p> });
    const id = screen.getByRole("dialog").getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    expect(document.getElementById(id ?? "")).not.toBeNull();
  });

  it("should give the accessible description of an element body", () => {
    renderDialog({ body: <p>Detached HEAD</p> });
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription("Detached HEAD");
  });

  it("should use a description id different from the title id", () => {
    renderDialog({ body: "text" });
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-describedby")).not.toBe(
      dialog.getAttribute("aria-labelledby"),
    );
  });

  it("should render a zero body, which is content", () => {
    renderDialog({ body: 0 });
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription("0");
  });

  it("should not describe the dialog by an empty element when the body is false", () => {
    // `{cond && <p/>}` yields false; aria-describedby must not point at an empty node.
    renderDialog({ body: false });
    expect(screen.getByRole("dialog")).not.toHaveAttribute("aria-describedby");
  });
});
