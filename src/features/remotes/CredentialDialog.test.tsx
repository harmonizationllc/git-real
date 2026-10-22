import { fireEvent, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/renderWithProviders";
import { CredentialDialog } from "./CredentialDialog";
import type { CredentialPrompt } from "./useNetworkAction";

const prompt = (over: Partial<CredentialPrompt> = {}): CredentialPrompt => ({
  origin: "https://github.com",
  host: "github.com",
  rejected: false,
  submit: vi.fn(),
  cancel: vi.fn(),
  ...over,
});

const username = () => screen.getByRole("textbox", { name: "Username" });
const token = () => screen.getByLabelText("Token or password");
const signIn = () => screen.getByRole("button", { name: "Sign in" });

// Contract: nothing renders without a prompt; with one it is a modal Sign in dialog.
describe("CredentialDialog rendering", () => {
  it("should render nothing without a prompt", () => {
    renderWithProviders(<CredentialDialog prompt={null} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should title the dialog Sign in to the host as a modal", () => {
    renderWithProviders(<CredentialDialog prompt={prompt()} />);
    expect(screen.getByRole("dialog", { name: "Sign in to github.com" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
  });

  it("should show a Username field and a password field labelled Token or password", () => {
    renderWithProviders(<CredentialDialog prompt={prompt()} />);
    expect(username()).toHaveValue("");
    expect(token()).toHaveAttribute("type", "password");
  });

  it("should show the credential helper note", () => {
    renderWithProviders(<CredentialDialog prompt={prompt()} />);
    expect(
      screen.getByText("Your git credential helper will store these if one is configured."),
    ).toBeInTheDocument();
  });

  it("should start with focus in Username", () => {
    renderWithProviders(<CredentialDialog prompt={prompt()} />);
    expect(username()).toHaveFocus();
  });

  it("should show no rejected note for a first prompt", () => {
    renderWithProviders(<CredentialDialog prompt={prompt()} />);
    expect(screen.queryByText("Those credentials were rejected")).toBeNull();
  });

  it("should show Those credentials were rejected as an alert when rejected", () => {
    renderWithProviders(<CredentialDialog prompt={prompt({ rejected: true })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Those credentials were rejected");
  });
});

// Contract: Sign in needs both fields and submits the username trimmed and the token as typed.
describe("CredentialDialog submit", () => {
  it("should disable Sign in until both fields have text", async () => {
    const { user } = renderWithProviders(<CredentialDialog prompt={prompt()} />);
    expect(signIn()).toBeDisabled();
    await user.type(username(), "me");
    expect(signIn()).toBeDisabled();
    await user.type(token(), "tok");
    expect(signIn()).toBeEnabled();
  });

  it("should keep Sign in disabled for a blank username", async () => {
    const { user } = renderWithProviders(<CredentialDialog prompt={prompt()} />);
    await user.type(username(), "   ");
    await user.type(token(), "tok");
    expect(signIn()).toBeDisabled();
  });

  it("should submit the username trimmed and the token exactly as typed", async () => {
    const p = prompt();
    const { user } = renderWithProviders(<CredentialDialog prompt={p} />);
    await user.type(username(), "  me  ");
    await user.type(token(), " tok ");
    await user.click(signIn());
    expect(p.submit).toHaveBeenCalledExactlyOnceWith("me", " tok ");
  });

  it("should submit when Enter is pressed in the token field", async () => {
    const p = prompt();
    const { user } = renderWithProviders(<CredentialDialog prompt={p} />);
    await user.type(username(), "me");
    await user.type(token(), "tok{Enter}");
    expect(p.submit).toHaveBeenCalledExactlyOnceWith("me", "tok");
  });

  it("should not submit when Enter is pressed with the token empty", async () => {
    const p = prompt();
    const { user } = renderWithProviders(<CredentialDialog prompt={p} />);
    await user.type(username(), "me{Enter}");
    expect(p.submit).not.toHaveBeenCalled();
  });
});

// Contract: the submit handler itself refuses incomplete fields, even when the button is bypassed.
describe("CredentialDialog submit guard", () => {
  it("should not submit a form event with an empty token", async () => {
    const p = prompt();
    const { user } = renderWithProviders(<CredentialDialog prompt={p} />);
    await user.type(username(), "me");
    fireEvent.submit(screen.getByRole("dialog").querySelector("form") as HTMLFormElement);
    expect(p.submit).not.toHaveBeenCalled();
  });

  it("should not submit a form event with a blank username", async () => {
    const p = prompt();
    const { user } = renderWithProviders(<CredentialDialog prompt={p} />);
    await user.type(username(), "  ");
    await user.type(token(), "tok");
    fireEvent.submit(screen.getByRole("dialog").querySelector("form") as HTMLFormElement);
    expect(p.submit).not.toHaveBeenCalled();
  });
});

// Contract: Cancel and Escape cancel; a backdrop click does too.
describe("CredentialDialog cancel", () => {
  it("should cancel when Cancel is pressed", async () => {
    const p = prompt();
    const { user } = renderWithProviders(<CredentialDialog prompt={p} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(p.cancel).toHaveBeenCalledOnce();
  });

  it("should cancel when Escape is pressed", async () => {
    const p = prompt();
    const { user } = renderWithProviders(<CredentialDialog prompt={p} />);
    await user.keyboard("{Escape}");
    expect(p.cancel).toHaveBeenCalledOnce();
  });

  it("should cancel when the backdrop is clicked", () => {
    const p = prompt();
    renderWithProviders(<CredentialDialog prompt={p} />);
    fireEvent.click(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(p.cancel).toHaveBeenCalledOnce();
  });

  it("should not cancel when the dialog body is clicked", () => {
    const p = prompt();
    renderWithProviders(<CredentialDialog prompt={p} />);
    fireEvent.click(screen.getByRole("dialog"));
    expect(p.cancel).not.toHaveBeenCalled();
  });

  it("should not submit when cancelled", async () => {
    const p = prompt();
    const { user } = renderWithProviders(<CredentialDialog prompt={p} />);
    await user.keyboard("{Escape}");
    expect(p.submit).not.toHaveBeenCalled();
  });
});

// Contract: a rejected retry is a new prompt object and starts with empty fields.
describe("CredentialDialog retry", () => {
  it("should start a rejected prompt with empty fields", async () => {
    const { user, rerender } = renderWithProviders(<CredentialDialog prompt={prompt()} />);
    await user.type(username(), "me");
    await user.type(token(), "bad");
    rerender(<CredentialDialog prompt={prompt({ rejected: true })} />);
    expect(username()).toHaveValue("");
    expect(token()).toHaveValue("");
  });

  it("should focus Username again on a rejected retry", async () => {
    const { rerender } = renderWithProviders(<CredentialDialog prompt={prompt()} />);
    rerender(<CredentialDialog prompt={prompt({ rejected: true })} />);
    expect(username()).toHaveFocus();
  });
});

// Contract: on close, focus returns to the opener, else to the fallback.
describe("CredentialDialog focus on close", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const fallback = useRef<HTMLDivElement>(null);
    const p = open ? prompt({ cancel: () => setOpen(false) }) : null;
    return (
      <>
        <div ref={fallback} tabIndex={-1} data-testid="fallback" />
        <button type="button" onClick={() => setOpen(true)}>
          Opener
        </button>
        <CredentialDialog prompt={p} fallbackFocus={fallback} />
      </>
    );
  }

  it("should return focus to the opener when it closes", async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Opener" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });
});
