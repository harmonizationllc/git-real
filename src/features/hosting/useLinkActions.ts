import { useState } from "react";
import { copyText, openExternal, toAppError } from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";

export interface UseLinkActions {
  open(url: string): void;
  copyLink(url: string): void;
  /** The last failed open or copy, until cleared. */
  error: AppError | null;
  clearError(): void;
}

/**
 * Opens or copies a provider URL. A failure lands in `error`, or goes to `onError` when given
 * (then `error` stays null), so a caller can keep one error slot of its own.
 */
export function useLinkActions(onError?: (e: AppError) => void): UseLinkActions {
  const [error, setError] = useState<AppError | null>(null);
  const fail = (e: unknown) => (onError ?? setError)(toAppError(e));

  return {
    open: (url) => void openExternal(url).catch(fail),
    copyLink: (url) => void copyText(url).catch(fail),
    error,
    clearError: () => setError(null),
  };
}
