import { render, screen } from "@testing-library/react";
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
  render(<UpstreamDialog {...props} />);
  return { ...props, user: userEvent.setup() };
}

const select = () => screen.getByRole("combobox", { name: "Upstream" });
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
