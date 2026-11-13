import { useEffect, useEffectEvent } from "react";
import type { AppError } from "../../lib/ipc";
import { toastError } from "./toastError";

/**
 * Toasts a failed list load, once per error object (a failed Retry is a new error, so it toasts
 * again), and only while there is nothing to show: a failed background refetch that leaves a
 * loaded list on screen stays silent. Returns true while the load has failed with no list, for
 * the panel's placeholder. `refetch` is read through an effect event, so it need not be stable.
 */
export function useLoadFailureToast(
  things: string,
  loaded: boolean,
  error: AppError | null,
  refetch: () => void,
): boolean {
  const toastFailure = useEffectEvent((e: AppError) =>
    toastError({ ...e, message: `Couldn't load ${things}: ${e.message}` }, { retry: refetch }),
  );
  const loadFailed = !loaded && error !== null;
  useEffect(() => {
    if (loadFailed) toastFailure(error);
  }, [loadFailed, error]);
  return loadFailed;
}
