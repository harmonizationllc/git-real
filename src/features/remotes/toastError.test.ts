import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppError } from "../../lib/ipc";
import { useMessages } from "../../lib/store/messages";
import { useToasts } from "../../lib/store/toasts";
import { toastError } from "./toastError";

const plain: AppError = { kind: "cloneFailed", message: "nope" };
const behind: AppError = {
  kind: "networkFailed",
  message: "! [rejected] main -> main (fetch first)",
  network: {
    kind: "pushRejectedNonFastForward",
    verb: "push",
    https: true,
    origin: null,
    host: null,
    reason: null,
  },
};

const last = () => useToasts.getState().toasts.at(-1)!;

beforeEach(() => {
  useToasts.setState({ toasts: [] });
  useMessages.setState({ messages: [], unread: false });
});

// Contract: toastError maps an AppError to an error toast (spec "Error to toast mapping").
describe("toastError", () => {
  it("toasts a plain error's message with no details", () => {
    toastError(plain);
    expect(last()).toMatchObject({
      text: "nope",
      variant: "error",
      details: null,
      action: null,
    });
  });

  it("adds a Retry action when retry is given", () => {
    const retry = vi.fn();
    toastError(plain, { retry });
    const { action } = last();
    expect(action?.label).toBe("Retry");
    action?.run();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("toasts a network failure's title and hint with git's output as details", () => {
    toastError(behind);
    expect(last()).toMatchObject({
      text: "The remote has commits you don't have Pull, then push again.",
      variant: "error",
      details: behind.message,
    });
  });

  it("carries the network action only when onAction is given", () => {
    const onAction = vi.fn();
    toastError(behind, { onAction });
    const { action } = last();
    expect(action?.label).toBe("Pull");
    action?.run();
    expect(onAction).toHaveBeenCalledWith("pull");

    toastError(behind);
    expect(last().action).toBeNull();
  });

  it("ignores retry for a network failure", () => {
    toastError(behind, { retry: vi.fn() });
    expect(last().action).toBeNull();
  });

  it("returns the toast id", () => {
    const id = toastError(plain);
    expect(last().id).toBe(id);
  });
});
