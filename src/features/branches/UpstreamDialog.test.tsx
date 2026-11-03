import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppError } from "../../lib/ipc";
import { UpstreamDialog } from "./UpstreamDialog";
import type { UpstreamDialogProps } from "./UpstreamDialog";

function renderDialog(over: Partial<UpstreamDialogProps> = {}) {
  const props: UpstreamDialogProps = {
    branch: "topic",
    current: "origin/topic",
    candidates: ["origin/main", "origin/topic"],
    error: null,
    pending: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  const { rerender } = render(<UpstreamDialog {...props} />);
  return {
    ...props,
    user: userEvent.setup(),
    rerender: (next: Partial<UpstreamDialogProps>) =>
      rerender(<UpstreamDialog {...props} {...next} />),
  };
}

const select = () => screen.getByRole("combobox", { name: "Upstream" });
const form = () => screen.getByRole("dialog").querySelector("form") as HTMLFormElement;
const save = () => screen.getByRole("button", { name: "Save" });

// Contract: the dialog names the branch, lists None plus every candidate, preselects the current upstream.
describe("UpstreamDialog options", () => {
  it("should title the dialog with the branch name", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Upstream for topic" })).toBeInTheDocument();
  });

  it("should list None first then the candidates in order", () => {
    renderDialog();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "None",
      "origin/main",
      "origin/topic",
    ]);
  });

  it("should preselect the current upstream", () => {
    renderDialog();
    expect(select()).toHaveValue("origin/topic");
  });

  it("should preselect None when the branch has no upstream", () => {
    renderDialog({ current: null });
    expect(select()).toHaveValue("");
  });

  it("should still offer a gone upstream as the current selection", () => {
    renderDialog({ current: "origin/gone", candidates: ["origin/main"] });
    expect(select()).toHaveValue("origin/gone");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "None",
      "origin/main",
      "origin/gone",
    ]);
  });

  it("should focus the select on open", () => {
    renderDialog();
    expect(select()).toHaveFocus();
  });
});

// Contract: Save is enabled only when the selection differs from the current upstream.
describe("UpstreamDialog save", () => {
  it("should disable Save while the selection is unchanged", () => {
    renderDialog();
    expect(save()).toBeDisabled();
  });

  it("should confirm with the chosen upstream", async () => {
    const { user, onConfirm } = renderDialog();
    await user.selectOptions(select(), "origin/main");
    await user.click(save());
    expect(onConfirm).toHaveBeenCalledWith("origin/main");
  });

  it("should confirm with null when None is chosen", async () => {
    const { user, onConfirm } = renderDialog();
    await user.selectOptions(select(), "");
    await user.click(save());
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it("should enable Save for a branch with no upstream once a candidate is chosen", async () => {
    const { user } = renderDialog({ current: null });
    expect(save()).toBeDisabled();
    await user.selectOptions(select(), "origin/main");
    expect(save()).toBeEnabled();
  });

  it("should allow clearing a gone upstream with no candidates", async () => {
    const { user, onConfirm } = renderDialog({ current: "origin/gone", candidates: [] });
    await user.selectOptions(select(), "");
    await user.click(save());
    expect(onConfirm).toHaveBeenCalledWith(null);
  });

  it("should list only None and the gone upstream when there are no candidates", () => {
    renderDialog({ current: "origin/gone", candidates: [] });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "None",
      "origin/gone",
    ]);
  });

  it("should not confirm on a form submit while the selection is unchanged", () => {
    const { onConfirm } = renderDialog();
    fireEvent.submit(form());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("should not confirm on a form submit while pending", async () => {
    const { user, onConfirm, rerender } = renderDialog({ current: null });
    await user.selectOptions(select(), "origin/main");
    rerender({ current: null, pending: true });
    fireEvent.submit(form());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// Contract: pending disables everything and shows Working…; errors show inline; Escape and backdrop cancel.
describe("UpstreamDialog states", () => {
  it("should disable the controls and show Working… while pending", () => {
    renderDialog({ pending: true });
    expect(select()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("should show the error message as an alert", () => {
    const error: AppError = { kind: "branchNotFound", message: "no branch named origin/x" };
    renderDialog({ error });
    expect(screen.getByRole("alert")).toHaveTextContent("no branch named origin/x");
  });

  it("should cancel on Escape", async () => {
    const { user, onCancel } = renderDialog();
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });

  it("should not cancel on Escape while pending", async () => {
    const { user, onCancel } = renderDialog({ pending: true });
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should cancel on a backdrop click", async () => {
    const { user, onCancel } = renderDialog();
    await user.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onCancel).toHaveBeenCalled();
  });
});

// Contract: Cancel and in-dialog clicks behave; focus follows pending and error.
describe("UpstreamDialog cancel and focus", () => {
  it("should cancel when Cancel is clicked", async () => {
    const { user, onCancel } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("should not cancel on a click inside the dialog", async () => {
    const { user, onCancel } = renderDialog();
    await user.click(screen.getByRole("dialog"));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should not cancel on a backdrop click while pending", () => {
    const { onCancel } = renderDialog({ pending: true });
    fireEvent.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("should hold focus on the dialog while pending", () => {
    const { rerender } = renderDialog();
    rerender({ pending: true });
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("should return focus to the select when pending ends with an error", () => {
    const error: AppError = { kind: "branchNotFound", message: "no branch named origin/x" };
    const { rerender } = renderDialog();
    rerender({ pending: true });
    rerender({ pending: false, error });
    expect(select()).toHaveFocus();
  });

  it("should keep a selected name in the options after a refetch drops it", async () => {
    const error: AppError = { kind: "branchNotFound", message: "no branch named origin/topic" };
    const { user, rerender } = renderDialog({
      current: null,
      candidates: ["origin/main", "origin/topic"],
    });
    await user.selectOptions(select(), "origin/topic");
    rerender({ candidates: ["origin/main"], error });
    expect(select()).toHaveValue("origin/topic");
    expect(screen.getByRole("option", { name: "origin/topic" })).toBeInTheDocument();
  });
});
