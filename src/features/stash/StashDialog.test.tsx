import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stashPush } from "../../lib/ipc";
import { renderWithProviders } from "../../test/renderWithProviders";
import { StashDialog } from "./StashDialog";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  stashPush: vi.fn(),
}));

const onClose = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(stashPush).mockResolvedValue(undefined);
});

function renderDialog(open = true) {
  return renderWithProviders(<StashDialog repoId={1} open={open} onClose={onClose} />);
}

const messageField = () => screen.getByRole("textbox", { name: "Message" });
const untrackedBox = () => screen.getByRole("checkbox", { name: "Include untracked files" });
const stashButton = () => screen.getByRole("button", { name: "Stash" });

// Contract: nothing renders while closed; open it is a modal dialog titled Stash changes.
describe("StashDialog rendering", () => {
  it("should render nothing when closed", () => {
    renderDialog(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should show the title as a modal dialog", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "Stash changes" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
  });

  it("should show the Message field empty", () => {
    renderDialog();
    expect(messageField()).toHaveValue("");
  });

  it("should show the Include untracked files box unchecked", () => {
    renderDialog();
    expect(untrackedBox()).not.toBeChecked();
  });

  it("should show Cancel and Stash buttons", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(stashButton()).toBeInTheDocument();
  });

  it("should focus the message field on open", () => {
    renderDialog();
    expect(messageField()).toHaveFocus();
  });

  it("should not show an alert initially", () => {
    renderDialog();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: submit pushes a trimmed message (null when blank) and the checkbox value, then closes.
describe("StashDialog submit", () => {
  it("submits a trimmed message and the checkbox value", async () => {
    const { user } = renderDialog();
    await user.type(messageField(), "  wip  ");
    await user.click(untrackedBox());
    await user.click(stashButton());
    expect(stashPush).toHaveBeenCalledExactlyOnceWith(1, "wip", true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("submits a blank message as null", async () => {
    const { user } = renderDialog();
    await user.type(messageField(), "   ");
    await user.click(stashButton());
    expect(stashPush).toHaveBeenCalledExactlyOnceWith(1, null, false);
  });

  it("submits an empty message as null with the Stash button never disabled by blankness", async () => {
    const { user } = renderDialog();
    expect(stashButton()).toBeEnabled();
    await user.click(stashButton());
    expect(stashPush).toHaveBeenCalledExactlyOnceWith(1, null, false);
  });

  it("submits on Enter in the message field", async () => {
    const { user } = renderDialog();
    await user.type(messageField(), "hi{Enter}");
    expect(stashPush).toHaveBeenCalledExactlyOnceWith(1, "hi", false);
  });
});

// Contract: failures stay inline and keep the dialog open.
describe("StashDialog errors", () => {
  it("shows No local changes to stash. and stays open on nothingToStash", async () => {
    vi.mocked(stashPush).mockRejectedValue({ kind: "nothingToStash", message: "raw" });
    const { user } = renderDialog();
    await user.click(stashButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("No local changes to stash.");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows other errors inline", async () => {
    vi.mocked(stashPush).mockRejectedValue({ kind: "operationFailed", message: "git exploded" });
    const { user } = renderDialog();
    await user.click(stashButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("git exploded");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("allows submitting again after an error", async () => {
    vi.mocked(stashPush).mockRejectedValueOnce({ kind: "operationFailed", message: "x" });
    const { user } = renderDialog();
    await user.click(stashButton());
    await screen.findByRole("alert");
    await user.click(stashButton());
    expect(stashPush).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// Contract: while pushing the form is disabled and cannot be dismissed.
describe("StashDialog pending", () => {
  function pending() {
    let resolve: () => void = () => undefined;
    vi.mocked(stashPush).mockReturnValue(new Promise((r) => (resolve = () => r(undefined))));
    return () => resolve();
  }

  it("disables the form and reads Working… while pending", async () => {
    pending();
    const { user } = renderDialog();
    await user.click(stashButton());
    expect(await screen.findByRole("button", { name: "Working…" })).toBeDisabled();
    expect(messageField()).toBeDisabled();
    expect(untrackedBox()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("does not close on Escape while pending", async () => {
    pending();
    const { user } = renderDialog();
    await user.click(stashButton());
    await screen.findByRole("button", { name: "Working…" });
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close on a backdrop click while pending", async () => {
    pending();
    const { user } = renderDialog();
    await user.click(stashButton());
    await screen.findByRole("button", { name: "Working…" });
    const backdrop = screen.getByRole("dialog").parentElement as HTMLElement;
    await user.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not push twice when submitted again while pending", async () => {
    pending();
    const { user } = renderDialog();
    await user.type(messageField(), "x");
    await user.click(stashButton());
    await screen.findByRole("button", { name: "Working…" });
    await user.type(messageField(), "{Enter}");
    expect(stashPush).toHaveBeenCalledOnce();
  });
});

// Contract: Cancel, Escape and a backdrop click close the dialog when idle.
describe("StashDialog dismissal", () => {
  it("closes on Cancel", async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", async () => {
    const { user } = renderDialog();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a backdrop click", async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close on a click inside the dialog", async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not push on Cancel", async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(stashPush).not.toHaveBeenCalled();
  });
});

describe("StashDialog reopening", () => {
  it("a reopened dialog starts empty with no error", async () => {
    vi.mocked(stashPush).mockRejectedValue({ kind: "nothingToStash", message: "raw" });
    const { user, rerender } = renderDialog();
    await user.type(messageField(), "old");
    await user.click(untrackedBox());
    await user.click(stashButton());
    await screen.findByRole("alert");
    rerender(<StashDialog repoId={1} open={false} onClose={onClose} />);
    rerender(<StashDialog repoId={1} open onClose={onClose} />);
    expect(messageField()).toHaveValue("");
    expect(untrackedBox()).not.toBeChecked();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
