import { create } from "zustand";
import { useMessages } from "./messages";

export type ToastVariant = "info" | "success" | "error";

export interface Toast {
  id: number;
  text: string;
  action: { label: string; run(): void } | null;
  variant: ToastVariant;
  sticky: boolean;
  /** Raw output (e.g. git's) behind the notice, shown in a Details dialog. */
  details: string | null;
}

/** The most toasts shown at once; a further one drops the oldest non-error (else the oldest). */
export const MAX_TOASTS = 5;

interface ToastsState {
  toasts: Toast[];
  /** Appends an info toast that times out, and returns its id. */
  show(text: string, action?: Toast["action"]): number;
  /** Appends a toast with a variant; every toast times out unless `sticky` is true. */
  notify(t: {
    text: string;
    variant: ToastVariant;
    action?: Toast["action"];
    details?: string | null;
    sticky?: boolean;
  }): number;
  dismiss(id: number): void;
}

// Outside the state, so resetting the toasts in a test keeps ids increasing.
let nextId = 1;

/** Appends `toast`, capped at MAX_TOASTS by dropping the oldest non-error (else the oldest). */
function capped(list: Toast[], toast: Toast): Toast[] {
  const next = [...list, toast];
  if (next.length <= MAX_TOASTS) return next;
  const nonError = next.slice(0, MAX_TOASTS).findIndex((t) => t.variant !== "error");
  next.splice(nonError === -1 ? 0 : nonError, 1);
  return next;
}

/** Short-lived notices shown by the app shell; the component times out the non-sticky ones. */
export const useToasts = create<ToastsState>()((set) => ({
  toasts: [],
  show: (text, action = null) => {
    const id = nextId++;
    useMessages.getState().append({ id, at: Date.now(), text, variant: "info", details: null });
    set((s) => ({
      toasts: capped(s.toasts, {
        id,
        text,
        action,
        variant: "info",
        sticky: false,
        details: null,
      }),
    }));
    return id;
  },
  notify: ({ text, variant, action = null, details = null, sticky = false }) => {
    const id = nextId++;
    useMessages.getState().append({ id, at: Date.now(), text, variant, details });
    set((s) => ({ toasts: capped(s.toasts, { id, text, action, variant, sticky, details }) }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
