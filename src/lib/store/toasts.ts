import { create } from "zustand";

export interface Toast {
  id: number;
  text: string;
  action: { label: string; run(): void } | null;
}

interface ToastsState {
  toasts: Toast[];
  /** Appends a toast and returns its id. */
  show(text: string, action?: Toast["action"]): number;
  dismiss(id: number): void;
}

// Outside the state, so resetting the toasts in a test keeps ids increasing.
let nextId = 1;

/** Short-lived notices shown by the app shell; the component times them out. */
export const useToasts = create<ToastsState>()((set) => ({
  toasts: [],
  show: (text, action = null) => {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, text, action }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
