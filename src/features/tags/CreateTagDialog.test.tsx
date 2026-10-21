import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTag } from "../../lib/ipc";
import { oidOf } from "../../test/graphFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { CreateTagDialog } from "./CreateTagDialog";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  createTag: vi.fn(),
}));

const OID = oidOf(3);
const TITLE = `Create tag on ${OID.slice(0, 7)}`;
const onClose = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createTag).mockResolvedValue(undefined);
});

function renderDialog(open = true) {
  return renderWithProviders(
    <CreateTagDialog repoId={1} oid={OID} open={open} onClose={onClose} />,
  );
}

const nameField = () => screen.getByRole("textbox", { name: "Name" });
const messageField = () => screen.getByRole("textbox", { name: "Message" });
const annotatedBox = () => screen.getByRole("checkbox", { name: "Annotated" });
const createButton = () => screen.getByRole("button", { name: "Create" });

// Contract: nothing renders while closed; open it is a modal dialog titled with the short oid.
describe("CreateTagDialog rendering", () => {
  it("should render nothing when closed", () => {
    renderDialog(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should show Create tag on the short oid as a modal dialog", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: TITLE })).toHaveAttribute("aria-modal", "true");
  });

  it("should show an empty Name field", () => {
    renderDialog();
    expect(nameField()).toHaveValue("");
  });

  it("should show the Annotated box checked", () => {
    renderDialog();
    expect(annotatedBox()).toBeChecked();
  });

  it("should show an empty Message field while annotated", () => {
    renderDialog();
    expect(messageField()).toHaveValue("");
  });

  it("should show Cancel and Create buttons", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(createButton()).toBeInTheDocument();
  });

  it("should focus the name field on open", () => {
    renderDialog();
    expect(nameField()).toHaveFocus();
  });

  it("should not show an alert initially", () => {
    renderDialog();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: Annotated toggles the Message field and keeps what was typed.
describe("CreateTagDialog annotated toggle", () => {
  it("should hide Message when Annotated is unchecked", async () => {
    const { user } = renderDialog();
    await user.click(annotatedBox());
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  });

  it("should restore the typed message when Annotated is checked again", async () => {
    const { user } = renderDialog();
    await user.type(messageField(), "Release");
    await user.click(annotatedBox());
    await user.click(annotatedBox());
    expect(messageField()).toHaveValue("Release");
  });
});

// Contract: Create stays disabled until the required fields have text.
describe("CreateTagDialog gate", () => {
  it("should disable Create until the name is non-blank", async () => {
    const { user } = renderDialog();
    await user.type(messageField(), "msg");
    expect(createButton()).toBeDisabled();
    await user.type(nameField(), "   ");
    expect(createButton()).toBeDisabled();
    await user.type(nameField(), "v1");
    expect(createButton()).toBeEnabled();
  });

  it("should disable Create while annotated until the message is non-blank", async () => {
    const { user } = renderDialog();
    await user.type(nameField(), "v1");
    expect(createButton()).toBeDisabled();
    await user.type(messageField(), "  ");
    expect(createButton()).toBeDisabled();
    await user.type(messageField(), "msg");
    expect(createButton()).toBeEnabled();
  });

  it("should not need a message when Annotated is off", async () => {
    const { user } = renderDialog();
    await user.type(nameField(), "v1");
    await user.click(annotatedBox());
    expect(createButton()).toBeEnabled();
  });

  it("should not call createTag when submitted with Enter while blank", async () => {
    const { user } = renderDialog();
    await user.type(nameField(), "{Enter}");
    expect(createTag).not.toHaveBeenCalled();
  });
});

// Contract: submit sends the trimmed name and the message as typed (null when lightweight), then closes.
describe("CreateTagDialog submit", () => {
  it("submits an annotated tag with the trimmed name and the message as typed", async () => {
    const { user } = renderDialog();
    await user.type(nameField(), "  v1 ");
    fireEvent.change(messageField(), { target: { value: "Release\n\nbody" } });
    await user.click(createButton());
    expect(createTag).toHaveBeenCalledExactlyOnceWith(1, "v1", OID, "Release\n\nbody");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("submits a lightweight tag with a null message", async () => {
    const { user } = renderDialog();
    await user.type(nameField(), "v1");
    await user.click(annotatedBox());
    await user.click(createButton());
    expect(createTag).toHaveBeenCalledExactlyOnceWith(1, "v1", OID, null);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("ignores a message typed before Annotated was switched off", async () => {
    const { user } = renderDialog();
    await user.type(nameField(), "v1");
    await user.type(messageField(), "unused");
    await user.click(annotatedBox());
    await user.click(createButton());
    expect(createTag).toHaveBeenCalledExactlyOnceWith(1, "v1", OID, null);
  });

  it("submits on Enter in the name field", async () => {
    const { user } = renderDialog();
    await user.click(annotatedBox());
    await user.type(nameField(), "v1{Enter}");
    expect(createTag).toHaveBeenCalledExactlyOnceWith(1, "v1", OID, null);
  });
});

// Contract: failures stay inline, keep the dialog open and put focus on the field concerned.
describe("CreateTagDialog errors", () => {
  async function fail(kind: string, message = "raw") {
    vi.mocked(createTag).mockRejectedValue({ kind, message });
    const view = renderDialog();
    await view.user.type(nameField(), "bad..x");
    await view.user.type(messageField(), "msg");
    await view.user.click(createButton());
    return view;
  }

  it.each([
    ["invalidTagName", "raw", "bad..x is not a valid tag name."],
    ["tagExists", "raw", "A tag named bad..x already exists."],
    ["commitNotFound", "raw", "That commit no longer exists."],
    ["emptyMessage", "raw", "Enter a message for an annotated tag."],
    ["operationFailed", "error: gpg failed to sign the data", "error: gpg failed to sign the data"],
  ])("shows %s inline and stays open", async (kind, message, text) => {
    await fail(kind, message);
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("focuses the name field after a name error", async () => {
    await fail("tagExists");
    await screen.findByRole("alert");
    expect(nameField()).toHaveFocus();
  });

  it("focuses the message field after emptyMessage", async () => {
    await fail("emptyMessage");
    await screen.findByRole("alert");
    expect(messageField()).toHaveFocus();
  });

  it("keeps what was typed after an error", async () => {
    await fail("tagExists");
    await screen.findByRole("alert");
    expect(nameField()).toHaveValue("bad..x");
    expect(messageField()).toHaveValue("msg");
  });

  it("clears the inline error when the form is submitted again", async () => {
    vi.mocked(createTag)
      .mockRejectedValueOnce({ kind: "tagExists", message: "x" })
      .mockReturnValueOnce(new Promise(() => undefined));
    const { user } = renderDialog();
    await user.type(nameField(), "v1");
    await user.type(messageField(), "msg");
    await user.click(createButton());
    await screen.findByRole("alert");
    await user.click(createButton());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("allows submitting again after an error and closes on success", async () => {
    vi.mocked(createTag).mockRejectedValueOnce({ kind: "tagExists", message: "x" });
    const { user } = renderDialog();
    await user.type(nameField(), "v1");
    await user.type(messageField(), "msg");
    await user.click(createButton());
    await screen.findByRole("alert");
    await user.click(createButton());
    expect(createTag).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});

// Contract: while creating the form is disabled, focus stays on the dialog and it cannot be dismissed.
describe("CreateTagDialog pending", () => {
  async function startPending() {
    vi.mocked(createTag).mockReturnValue(new Promise(() => undefined));
    const view = renderDialog();
    await view.user.type(nameField(), "v1");
    await view.user.type(messageField(), "msg");
    await view.user.click(createButton());
    await screen.findByRole("button", { name: "Working…" });
    return view;
  }

  it("reads Working… on a disabled button and disables the fields", async () => {
    await startPending();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(nameField()).toBeDisabled();
    expect(messageField()).toBeDisabled();
    expect(annotatedBox()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("holds focus on the dialog", async () => {
    await startPending();
    expect(screen.getByRole("dialog", { name: TITLE })).toHaveFocus();
  });

  it("does not close on Escape", async () => {
    const { user } = await startPending();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close on a backdrop click", async () => {
    const { user } = await startPending();
    await user.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not create twice when submitted again", async () => {
    const { user } = await startPending();
    await user.type(nameField(), "{Enter}");
    expect(createTag).toHaveBeenCalledOnce();
  });
});

// Contract: Cancel, Escape and a backdrop click close the dialog when idle.
describe("CreateTagDialog dismissal", () => {
  it("closes on Cancel without creating", async () => {
    const { user } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(createTag).not.toHaveBeenCalled();
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
});

describe("CreateTagDialog reopening", () => {
  it("a reopened dialog starts empty with no error", async () => {
    vi.mocked(createTag).mockRejectedValue({ kind: "tagExists", message: "raw" });
    const { user, rerender } = renderDialog();
    await user.type(nameField(), "old");
    await user.type(messageField(), "old msg");
    await user.click(annotatedBox());
    await user.click(annotatedBox());
    await user.click(createButton());
    await screen.findByRole("alert");
    rerender(<CreateTagDialog repoId={1} oid={OID} open={false} onClose={onClose} />);
    rerender(<CreateTagDialog repoId={1} oid={OID} open onClose={onClose} />);
    expect(nameField()).toHaveValue("");
    expect(messageField()).toHaveValue("");
    expect(annotatedBox()).toBeChecked();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: on close, focus returns to the opener unless it is gone or disabled; then the fallback.
describe("CreateTagDialog focus on close", () => {
  function Harness({ openerDisabled = false }: { openerDisabled?: boolean }) {
    const [open, setOpen] = useState(false);
    const fallback = useRef<HTMLDivElement>(null);
    return (
      <>
        <div ref={fallback} tabIndex={-1} data-testid="fallback" />
        <button type="button" disabled={openerDisabled} onClick={() => setOpen(true)}>
          Opener
        </button>
        <CreateTagDialog
          repoId={1}
          oid={OID}
          open={open}
          onClose={() => setOpen(false)}
          fallbackFocus={fallback}
        />
      </>
    );
  }

  it("restores focus to the opener when it is still enabled", async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Opener" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });

  it("returns focus to the fallback when the opener is gone", async () => {
    const { user, rerender } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Opener" }));
    rerender(<Harness openerDisabled />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("fallback")).toHaveFocus();
  });
});
