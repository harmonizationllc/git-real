import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/renderWithProviders";
import { NetworkError } from "./NetworkError";
import type { NetworkMessage } from "./networkMessage";

const message = (over: Partial<NetworkMessage> = {}): NetworkMessage => ({
  title: "Could not reach the remote",
  hint: "Check your network connection and the remote URL.",
  action: null,
  details: "fatal: unable to access",
  ...over,
});

// Contract: title, hint and git's output under a Details disclosure.
describe("NetworkError content", () => {
  it("should render the title, the hint and git's output under Details", () => {
    renderWithProviders(<NetworkError message={message()} onDismiss={vi.fn()} />);
    expect(screen.getByText("Could not reach the remote")).toBeInTheDocument();
    expect(
      screen.getByText("Check your network connection and the remote URL."),
    ).toBeInTheDocument();
    const summary = screen.getByText("Details");
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.closest("details")).toHaveTextContent("fatal: unable to access");
  });

  it("should omit the hint when it is null", () => {
    renderWithProviders(<NetworkError message={message({ hint: null })} onDismiss={vi.fn()} />);
    expect(screen.queryByText("Check your network connection and the remote URL.")).toBeNull();
  });

  it("should omit Details when there is no output", () => {
    renderWithProviders(<NetworkError message={message({ details: null })} onDismiss={vi.fn()} />);
    expect(screen.queryByText("Details")).toBeNull();
  });

  it("should be an alert", () => {
    renderWithProviders(<NetworkError message={message()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the remote");
  });
});

// Contract: an optional action button and an always-present Dismiss.
describe("NetworkError buttons", () => {
  const withAction = message({ action: { kind: "pull", label: "Pull" } });

  it("should call onAction with the action's kind when its button is pressed", async () => {
    const onAction = vi.fn();
    const { user } = renderWithProviders(
      <NetworkError message={withAction} onAction={onAction} onDismiss={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Pull" }));
    expect(onAction).toHaveBeenCalledExactlyOnceWith("pull");
  });

  it("should render no action button without onAction", () => {
    renderWithProviders(<NetworkError message={withAction} onDismiss={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Pull" })).toBeNull();
  });

  it("should render no action button when the message has no action", () => {
    renderWithProviders(
      <NetworkError message={message()} onAction={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Dismiss"]);
  });

  it("should call onDismiss when Dismiss is pressed", async () => {
    const onDismiss = vi.fn();
    const { user } = renderWithProviders(
      <NetworkError message={message()} onDismiss={onDismiss} />,
    );
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

// Contract (M1): flush marks the root so the header can drop its horizontal margin; the attribute
// is present only when flush is true.
describe("NetworkError flush", () => {
  it("should mark the root with data-flush when flush is true", () => {
    renderWithProviders(<NetworkError message={message()} onDismiss={vi.fn()} flush />);
    expect(screen.getByRole("alert")).toHaveAttribute("data-flush");
  });

  it("should not mark the root with data-flush when flush is omitted", () => {
    renderWithProviders(<NetworkError message={message()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("alert")).not.toHaveAttribute("data-flush");
  });

  it("should not mark the root with data-flush when flush is false", () => {
    renderWithProviders(<NetworkError message={message()} onDismiss={vi.fn()} flush={false} />);
    expect(screen.getByRole("alert")).not.toHaveAttribute("data-flush");
  });
});
