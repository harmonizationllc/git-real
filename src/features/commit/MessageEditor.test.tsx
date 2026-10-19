import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageEditor } from "./MessageEditor";

function setup(over: Partial<React.ComponentProps<typeof MessageEditor>> = {}) {
  const props = {
    subject: "",
    body: "",
    disabled: false,
    onSubjectChange: vi.fn(),
    onBodyChange: vi.fn(),
    onSubmit: vi.fn(),
    ...over,
  };
  render(<MessageEditor {...props} />);
  return { ...props, user: userEvent.setup() };
}

describe("MessageEditor", () => {
  it("renders labelled subject and body with placeholders", () => {
    setup();
    expect(screen.getByLabelText("Subject")).toHaveAttribute("placeholder", "Summary of changes");
    expect(screen.getByLabelText("Body")).toHaveAttribute(
      "placeholder",
      "Optional longer description",
    );
  });

  it("forwards typing to the change handlers", async () => {
    const { user, onSubjectChange, onBodyChange } = setup();
    await user.type(screen.getByLabelText("Subject"), "a");
    await user.type(screen.getByLabelText("Body"), "b");
    expect(onSubjectChange).toHaveBeenCalledWith("a");
    expect(onBodyChange).toHaveBeenCalledWith("b");
  });

  it("shows the counter and no hint at the limit", () => {
    setup({ subject: "x".repeat(72) });
    expect(screen.getByText("72/72")).toBeInTheDocument();
    expect(screen.queryByText("Keep the subject at 72 characters or fewer")).toBeNull();
  });

  it("shows the hint past the limit and links it to the input", () => {
    setup({ subject: "x".repeat(73) });
    const hint = screen.getByText("Keep the subject at 72 characters or fewer");
    expect(screen.getByText("73/72")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toHaveAttribute("aria-describedby", hint.id);
  });

  it("Enter in the subject moves focus to the body without submitting", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Subject"));
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Body")).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter submits from either field", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Subject"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(screen.getByLabelText("Body"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("Meta+Enter also submits", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Body"));
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("disables both fields when disabled", () => {
    setup({ disabled: true });
    expect(screen.getByLabelText("Subject")).toBeDisabled();
    expect(screen.getByLabelText("Body")).toBeDisabled();
  });
});

describe("MessageEditor limit boundary and key modifiers", () => {
  it("styles the counter as over the limit at 73 but not at 72", () => {
    const { unmount } = render(
      <MessageEditor
        subject={"x".repeat(72)}
        body=""
        disabled={false}
        onSubjectChange={vi.fn()}
        onBodyChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText("72/72").className).not.toMatch(/counterOver/);
    expect(screen.getByLabelText("Subject")).not.toHaveAttribute("aria-describedby");
    unmount();
    setup({ subject: "x".repeat(73) });
    expect(screen.getByText("73/72").className).toMatch(/counterOver/);
  });

  it("Shift+Enter in the subject moves focus to the body and does not submit", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Subject"));
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(screen.getByLabelText("Body")).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("plain Enter in the body does not submit", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Body"));
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter during IME composition neither moves focus nor submits", async () => {
    const { user, onSubmit } = setup();
    const subject = screen.getByLabelText("Subject");
    await user.click(subject);
    const notPrevented = fireEvent.keyDown(subject, { key: "Enter", isComposing: true });
    expect(subject).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("Ctrl+Enter during IME composition does not submit", async () => {
    const { user, onSubmit } = setup();
    const subject = screen.getByLabelText("Subject");
    await user.click(subject);
    fireEvent.keyDown(subject, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter with keyCode 229 (WebKit post-composition) neither moves focus nor submits", async () => {
    const { user, onSubmit } = setup();
    const subject = screen.getByLabelText("Subject");
    await user.click(subject);
    const notPrevented = fireEvent.keyDown(subject, { key: "Enter", keyCode: 229 });
    expect(subject).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });
});

// Contract (spec 5.4): the subject input has a fixed id so the banner can focus it.
describe("MessageEditor subject id", () => {
  it("gives the subject input the id commit-subject", () => {
    setup();
    expect(screen.getByLabelText("Subject")).toHaveAttribute("id", "commit-subject");
  });

  it("keeps the subject input labelled Subject", () => {
    setup();
    expect(screen.getByRole("textbox", { name: "Subject" })).toBeInTheDocument();
  });

  it("does not give the body input the subject id", () => {
    setup();
    expect(screen.getByLabelText("Body")).not.toHaveAttribute("id", "commit-subject");
  });
});
