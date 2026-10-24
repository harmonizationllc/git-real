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

/** Opens or copies a provider URL; a failure lands in `error`. */
export function useLinkActions(): UseLinkActions {
  const [error, setError] = useState<AppError | null>(null);
  const fail = (e: unknown) => setError(toAppError(e));

  return {
    open: (url) => void openExternal(url).catch(fail),
    copyLink: (url) => void copyText(url).catch(fail),
    error,
    clearError: () => setError(null),
  };
}
