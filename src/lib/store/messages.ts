import { create } from "zustand";
// Type-only, so the toasts store (which imports this one) forms no runtime cycle.
import type { ToastVariant } from "./toasts";

export interface Message {
  /** Equals the id of the toast that produced it. */
  id: number;
  /** `Date.now()` when the notice was raised. */
  at: number;
  text: string;
  variant: ToastVariant;
  details: string | null;
}

/** The most messages kept; a further one drops the oldest. */
export const MAX_MESSAGES = 200;

interface MessagesState {
  /** Newest first. */
  messages: Message[];
  /** True once an error arrives, until `markRead`. */
  unread: boolean;
  append(m: Message): void;
  markRead(): void;
  clear(): void;
}

/** A per-session history of every toast raised, including ones that timed out or were dropped. */
export const useMessages = create<MessagesState>()((set) => ({
  messages: [],
  unread: false,
  append: (m) =>
    set((s) => ({
      messages: [m, ...s.messages].slice(0, MAX_MESSAGES),
      unread: s.unread || m.variant === "error",
    })),
  markRead: () => set({ unread: false }),
  clear: () => set({ messages: [], unread: false }),
}));
