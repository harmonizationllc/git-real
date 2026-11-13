import { beforeEach, describe, expect, it } from "vitest";
import { MAX_MESSAGES, useMessages } from "./messages";
import type { Message } from "./messages";

beforeEach(() => {
  useMessages.setState({ messages: [], unread: false });
});

const msg = (id: number, variant: Message["variant"] = "info"): Message => ({
  id,
  at: id * 1000,
  text: `m${id}`,
  variant,
  details: null,
});

// Contract: a newest-first, capped, per-session log with an unread-error flag.
describe("useMessages", () => {
  it("starts empty and read", () => {
    expect(useMessages.getState().messages).toEqual([]);
    expect(useMessages.getState().unread).toBe(false);
  });

  it("appends newest first", () => {
    useMessages.getState().append(msg(1));
    useMessages.getState().append(msg(2));
    expect(useMessages.getState().messages.map((m) => m.id)).toEqual([2, 1]);
  });

  it("caps at MAX_MESSAGES, keeping the newest", () => {
    for (let i = 1; i <= MAX_MESSAGES + 1; i++) useMessages.getState().append(msg(i));
    const list = useMessages.getState().messages;
    expect(list).toHaveLength(MAX_MESSAGES);
    expect(list[0]?.id).toBe(MAX_MESSAGES + 1);
    expect(list.some((m) => m.id === 1)).toBe(false);
  });

  it("marks unread only for errors", () => {
    useMessages.getState().append(msg(1, "info"));
    expect(useMessages.getState().unread).toBe(false);
    useMessages.getState().append(msg(2, "error"));
    expect(useMessages.getState().unread).toBe(true);
  });

  it("markRead clears unread", () => {
    useMessages.getState().append(msg(1, "error"));
    useMessages.getState().markRead();
    expect(useMessages.getState().unread).toBe(false);
  });

  it("clear empties the list and leaves unread false", () => {
    useMessages.getState().append(msg(1, "error"));
    useMessages.getState().clear();
    expect(useMessages.getState().messages).toEqual([]);
    expect(useMessages.getState().unread).toBe(false);
  });
});
