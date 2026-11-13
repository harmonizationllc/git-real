import type { AppError } from "../../lib/ipc";
import { useToasts } from "../../lib/store/toasts";
import type { Toast } from "../../lib/store/toasts";
import { networkMessage } from "./networkMessage";
import type { MessageAction } from "./networkMessage";

export interface ToastErrorOptions {
  /** Runs the network failure's suggested action (Pull, Fetch, Edit remote…). */
  onAction?(kind: MessageAction): void;
  /** Re-runs the failed operation; offered as Retry on a plain error. */
  retry?(): void;
}

/** Raises an error toast for `error` and returns its id. */
export function toastError(error: AppError, opts: ToastErrorOptions = {}): number {
  const { onAction, retry } = opts;
  if (error.kind === "networkFailed") {
    const { title, hint, action, details } = networkMessage(error);
    const toastAction: Toast["action"] =
      action !== null && onAction !== undefined
        ? { label: action.label, run: () => onAction(action.kind) }
        : null;
    return useToasts.getState().notify({
      text: hint ? `${title} ${hint}` : title,
      variant: "error",
      details,
      action: toastAction,
    });
  }
  return useToasts.getState().notify({
    text: error.message,
    variant: "error",
    details: null,
    action: retry ? { label: "Retry", run: retry } : null,
  });
}
