import { create } from "zustand";

export type ToastVariant = "info" | "success" | "error";

export interface Toast {
  id: number;
  text: string;
  action: { label: string; run(): void } | null;
  variant: ToastVariant;
  sticky: boolean;
}

/** The most toasts shown at once; a further one drops the oldest non-error (else the oldest). */
export const MAX_TOASTS = 5;

interface ToastsState {
  toasts: Toast[];
  /** Appends an info toast that times out, and returns its id. */
  show(text: string, action?: Toast["action"]): number;
  /** Appends a toast with a variant; errors stay until dismissed unless `sticky` says otherwise. */
  notify(t: {
    text: string;
    variant: ToastVariant;
    action?: Toast["action"];
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
    set((s) => ({
      toasts: capped(s.toasts, { id, text, action, variant: "info", sticky: false }),
    }));
    return id;
  },
  notify: ({ text, variant, action = null, sticky }) => {
    const id = nextId++;
    const stays = sticky ?? variant === "error";
    set((s) => ({ toasts: capped(s.toasts, { id, text, action, variant, sticky: stays }) }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
