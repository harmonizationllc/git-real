import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppError } from "../../lib/ipc";
import { renderWithProviders } from "../../test/renderWithProviders";
import { SetUpstreamDialog } from "./SetUpstreamDialog";
import type { SetUpstreamDialogProps } from "./SetUpstreamDialog";

function renderDialog(over: Partial<SetUpstreamDialogProps> = {}) {
  const props: SetUpstreamDialogProps = {
    remotes: ["origin", "upstream"],
    branch: "main",
    error: null,
    pending: false,
    onPublish: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  return { props, ...renderWithProviders(<SetUpstreamDialog {...props} />) };
}

const remote = () => screen.getByRole("combobox", { name: "Remote" });
const branchName = () => screen.getByRole("textbox", { name: "Branch name" });
const publish = () => screen.getByRole("button", { name: "Publish" });

// Contract: a modal titled Publish <branch> with a Remote select and a Branch name field.
describe("SetUpstreamDialog rendering", () => {
  it("should title the dialog Publish main and focus Branch name", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Publish main" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    expect(branchName()).toHaveFocus();
  });

  it("should offer every remote in the select", () => {
    renderDialog();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["origin", "upstream"]);
  });

  it("should default the remote to origin when present", () => {
    renderDialog({ remotes: ["upstream", "origin"] });
    expect(remote()).toHaveValue("origin");
  });

  it("should default the remote to the first remote when there is no origin", () => {
    renderDialog({ remotes: ["upstream", "team"] });
    expect(remote()).toHaveValue("upstream");
  });

  it("should default the branch name to the local name", () => {
    renderDialog({ branch: "topic" });
    expect(branchName()).toHaveValue("topic");
  });

  it("should show no alert without an error", () => {
    renderDialog();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: Publish sends the chosen remote and the trimmed branch name; blank names are refused.
describe("SetUpstreamDialog submit", () => {
  it("should send the chosen remote and the trimmed branch name on Publish", async () => {
    const { user, props } = renderDialog();
    await user.selectOptions(remote(), "upstream");
    await user.clear(branchName());
    await user.type(branchName(), "  feature/x  ");
    await user.click(publish());
    expect(props.onPublish).toHaveBeenCalledExactlyOnceWith("upstream", "feature/x");
  });

  it("should publish the defaults when nothing is changed", async () => {
    const { user, props } = renderDialog();
    await user.click(publish());
    expect(props.onPublish).toHaveBeenCalledExactlyOnceWith("origin", "main");
  });

  it("should disable Publish for a blank name", async () => {
    const { user } = renderDialog();
    await user.clear(branchName());
    expect(publish()).toBeDisabled();
    await user.type(branchName(), "   ");
    expect(publish()).toBeDisabled();
  });

  it("should not publish when Enter is pressed on a blank name", async () => {
    const { user, props } = renderDialog();
    await user.clear(branchName());
    await user.keyboard("{Enter}");
    expect(props.onPublish).not.toHaveBeenCalled();
  });
});

// Contract: the inline error names an invalid branch name, else shows the message.
describe("SetUpstreamDialog errors", () => {
  it("should show bad..x is not a valid branch name. for invalidBranchName", () => {
    const error: AppError = { kind: "invalidBranchName", message: "ref is bad" };
    renderDialog({ error, branch: "bad..x" });
    expect(screen.getByRole("alert")).toHaveTextContent("bad..x is not a valid branch name.");
  });

  it("should show the message for any other error", () => {
    renderDialog({ error: { kind: "remoteNotFound", message: "no remote named x" } });
    expect(screen.getByRole("alert")).toHaveTextContent("no remote named x");
  });
});

// Contract: pending disables the form and relabels Publish; Cancel and Escape work unless pending.
describe("SetUpstreamDialog pending and cancel", () => {
  it("should disable the form and label Publish Working… while pending", () => {
    renderDialog({ pending: true });
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(remote()).toBeDisabled();
    expect(branchName()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("should cancel on Cancel", async () => {
    const { user, props } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it("should cancel on Escape", async () => {
    const { user, props } = renderDialog();
    await user.keyboard("{Escape}");
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it("should not cancel on Escape while pending", () => {
    const { props } = renderDialog({ pending: true });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(props.onCancel).not.toHaveBeenCalled();
  });
});
