import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMessages } from "../lib/store/messages";
import type { Message } from "../lib/store/messages";
import { MessagesDialog } from "./MessagesDialog";

const msg = (id: number, text: string, details: string | null = null): Message => ({
  id,
  at: new Date(2026, 10, 13, 9, 5).getTime(),
  text,
  variant: "error",
  details,
});

beforeEach(() => {
  useMessages.setState({ messages: [], unread: false });
});

function setup() {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<MessagesDialog onClose={onClose} fallbackFocus={createRef()} />);
  return { user, onClose };
}

// Contract: the dialog is the per-session history of every toast, newest first.
describe("MessagesDialog", () => {
  it("shows the empty state", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Messages" })).toBeInTheDocument();
    expect(screen.getByText("No messages this session")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("lists messages newest first with their text and time", () => {
    useMessages.setState({ messages: [msg(2, "second"), msg(1, "first")] });
    setup();
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => within(li).getByText(/first|second/).textContent)).toEqual([
      "second",
      "first",
    ]);
    const time = new Date(2026, 10, 13, 9, 5).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(within(items[0]!).getByText(time)).toBeInTheDocument();
  });

  it("marks messages read on open", () => {
    useMessages.setState({ messages: [msg(1, "boom")], unread: true });
    setup();
    expect(useMessages.getState().unread).toBe(false);
  });

  it("marks a message that arrives while open as read at once", () => {
    setup();
    act(() => useMessages.getState().append(msg(1, "late")));
    expect(useMessages.getState().messages).toHaveLength(1);
    expect(useMessages.getState().unread).toBe(false);
  });

  it("focuses Close on open, not the newest row's Details", () => {
    useMessages.setState({ messages: [msg(1, "git said no", "fatal: nope")] });
    setup();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("gives each Details button the message it belongs to as its description", () => {
    useMessages.setState({ messages: [msg(1, "git said no", "fatal: nope")] });
    setup();
    expect(screen.getByRole("button", { name: "Details" })).toHaveAccessibleDescription(
      "git said no",
    );
  });

  it("shows Details only for a message with details, and opens it", async () => {
    useMessages.setState({ messages: [msg(2, "plain"), msg(1, "git said no", "fatal: nope")] });
    const { user } = setup();
    const buttons = screen.getAllByRole("button", { name: "Details" });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0]!);
    expect(await screen.findByText("fatal: nope")).toBeInTheDocument();
  });

  it("Escape in the Details dialog closes only that dialog", async () => {
    useMessages.setState({ messages: [msg(1, "git said no", "fatal: nope")] });
    const { user, onClose } = setup();
    await user.click(screen.getByRole("button", { name: "Details" }));
    await screen.findByText("fatal: nope");
    await user.keyboard("{Escape}");
    expect(screen.queryByText("fatal: nope")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Clear empties the list and is then disabled", async () => {
    useMessages.setState({ messages: [msg(1, "boom")] });
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(useMessages.getState().messages).toEqual([]);
    expect(screen.getByText("No messages this session")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("Close and Escape call onClose", async () => {
    const { user, onClose } = setup();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
