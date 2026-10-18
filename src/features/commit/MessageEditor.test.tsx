import { render, screen } from "@testing-library/react";
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
