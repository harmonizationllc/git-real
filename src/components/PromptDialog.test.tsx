import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppError } from "../lib/ipc";
import { PromptDialog } from "./PromptDialog";

type Props = Partial<React.ComponentProps<typeof PromptDialog>>;

function renderDialog(props: Props = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const view = render(
    <PromptDialog
      open
      title="New branch"
      label="Name"
      error={null}
      pending={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel, ...view };
}

// Contract: nothing is rendered while closed; when open it is a modal dialog labelled by its title.
describe("PromptDialog rendering", () => {
  it("should render nothing when closed", () => {
    renderDialog({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should render a modal dialog labelled by the title when open", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: "New branch" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("should point aria-labelledby at an element containing the title", () => {
    renderDialog();
    const id = screen.getByRole("dialog").getAttribute("aria-labelledby");
    expect(document.getElementById(id ?? "missing")).toHaveTextContent("New branch");
  });

  it("should render a text input labelled by label", () => {
    renderDialog();
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
  });

  it("should start empty when no initialValue is given", () => {
    renderDialog();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
  });

  it("should start with initialValue when given", () => {
    renderDialog({ initialValue: "main" });
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("main");
  });

  it("should label the confirm button Confirm by default", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });

  it("should use a custom confirm label when given", () => {
    renderDialog({ confirmLabel: "Create" });
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("should render a Cancel button", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});

// Contract: on open the input is focused with its text selected so typing replaces it.
describe("PromptDialog focus and selection", () => {
  it("should focus the input when opened", () => {
    renderDialog({ initialValue: "main" });
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
  });

  it("should select the whole initial value when opened", () => {
    renderDialog({ initialValue: "feature/x" });
    const input = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 9]);
  });

  it("should restore focus to the previously focused element when closed", () => {
    const ui = (open: boolean) => (
      <>
        <button>Opener</button>
        <PromptDialog
          open={open}
          title="T"
          label="Name"
          error={null}
          pending={false}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </>
    );
    const view = render(ui(false));
    screen.getByRole("button", { name: "Opener" }).focus();
    view.rerender(ui(true));
    view.rerender(ui(false));
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });
});

// Contract: confirming submits the trimmed value; a blank value cannot be confirmed.
describe("PromptDialog confirmation", () => {
  it("should disable confirm when the value is empty", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("should disable confirm when the value is only whitespace", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "   ");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();
  });

  it("should enable confirm once the value is non-blank", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "x");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeEnabled();
  });

  it("should call onConfirm with the trimmed value when confirm is clicked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "  topic  ");
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("topic");
  });

  it("should call onConfirm with the trimmed value when Enter is pressed", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.type(screen.getByRole("textbox", { name: "Name" }), " topic {Enter}");
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("topic");
  });

  it("should confirm the initialValue unchanged when Enter is pressed", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ initialValue: "main" });
    await user.keyboard("{Enter}");
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("main");
  });

  it("should not call onConfirm when Enter is pressed on a blank value", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "  {Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("should replace the selected initial value when typing", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ initialValue: "old" });
    await user.keyboard("new{Enter}");
    expect(onConfirm).toHaveBeenCalledExactlyOnceWith("new");
  });
});

// Contract: Escape, the Cancel button and a backdrop click cancel; clicks inside do not.
describe("PromptDialog cancellation", () => {
  it("should call onCancel when Escape is pressed", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("should call onCancel when the Cancel button is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("should call onCancel when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("should not call onCancel when the dialog panel is clicked", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();
    await user.click(screen.getByRole("dialog"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should not call onConfirm when cancelled", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ initialValue: "main" });
    await user.keyboard("{Escape}");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("should not call onCancel on Escape when closed", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog({ open: false });
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// Contract: the optional checkbox is controlled by the caller.
describe("PromptDialog checkbox", () => {
  it("should not render a checkbox when none is given", () => {
    renderDialog();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("should render a labelled checkbox reflecting checked", () => {
    renderDialog({ checkbox: { label: "Switch to new branch", checked: true, onChange: vi.fn() } });
    expect(screen.getByRole("checkbox", { name: "Switch to new branch" })).toBeChecked();
  });

  it("should render the checkbox unchecked when checked is false", () => {
    renderDialog({
      checkbox: { label: "Switch to new branch", checked: false, onChange: vi.fn() },
    });
    expect(screen.getByRole("checkbox", { name: "Switch to new branch" })).not.toBeChecked();
  });

  it("should call checkbox.onChange with the new state when toggled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderDialog({ checkbox: { label: "Switch to new branch", checked: false, onChange } });
    await user.click(screen.getByRole("checkbox", { name: "Switch to new branch" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("should call checkbox.onChange with false when unchecking", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderDialog({ checkbox: { label: "Switch to new branch", checked: true, onChange } });
    await user.click(screen.getByRole("checkbox", { name: "Switch to new branch" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});

// Contract: an inline error is announced; no alert exists without one.
describe("PromptDialog error", () => {
  it("should not render an alert when error is null", () => {
    renderDialog();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should render the error message in an alert", () => {
    const error: AppError = { kind: "branchExists", message: "branch topic already exists" };
    renderDialog({ error });
    expect(screen.getByRole("alert")).toHaveTextContent("branch topic already exists");
  });

  it("should keep the dialog open and the value intact when an error is shown", async () => {
    const user = userEvent.setup();
    const error: AppError = { kind: "invalidBranchName", message: "bad name" };
    renderDialog({ error });
    await user.type(screen.getByRole("textbox", { name: "Name" }), "a b");
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("a b");
  });
});

// Contract: while pending every control is disabled and confirm reads "Working…".
describe("PromptDialog pending", () => {
  it("should disable the input while pending", () => {
    renderDialog({ pending: true, initialValue: "x" });
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
  });

  it("should disable the checkbox while pending", () => {
    renderDialog({
      pending: true,
      checkbox: { label: "Switch to new branch", checked: false, onChange: vi.fn() },
    });
    expect(screen.getByRole("checkbox", { name: "Switch to new branch" })).toBeDisabled();
  });

  it("should disable confirm and label it Working… while pending", () => {
    renderDialog({ pending: true, initialValue: "x", confirmLabel: "Create" });
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
  });

  it("should not show the confirm label while pending", () => {
    renderDialog({ pending: true, initialValue: "x", confirmLabel: "Create" });
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
  });

  it("should not call onConfirm on Enter while pending", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ pending: true, initialValue: "x" });
    await user.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("should enable the input and confirm when not pending", () => {
    renderDialog({ pending: false, initialValue: "x" });
    expect(screen.getByRole("textbox", { name: "Name" })).toBeEnabled();
  });
});
