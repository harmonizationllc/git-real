import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { hostingConnect, hostingDisconnect, toAppError } from "../../lib/ipc";
import type { AppError, HostingAccount, HostingProvider } from "../../lib/ipc";
import { mutationKeys } from "../../lib/query/keys";
import { invalidateHosting } from "./useHostingAccounts";

/** Each action resolves with its result or the AppError and never rejects. */
export interface UseAccountActions {
  connect(
    provider: HostingProvider,
    host: string | null,
    token: string,
  ): Promise<{ account: HostingAccount } | { error: AppError }>;
  disconnect(accountId: string): Promise<AppError | null>;
  pending: boolean;
}

/**
 * Connects and disconnects hosting accounts. The token lives in this call only: the mutation's
 * variable is an opaque thunk, and resetting the observer after it settles lets `gcTime: 0` drop
 * the mutation from the cache at once (the useNetworkAction pattern).
 */
export function useAccountActions(): UseAccountActions {
  const queryClient = useQueryClient();
  // Counted here rather than read from `isPending`, whose observer update lands a tick later.
  const [busy, setBusy] = useState(0);
  const { mutateAsync, reset } = useMutation<unknown, AppError, () => Promise<unknown>>({
    mutationKey: mutationKeys.hostingAccount,
    gcTime: 0,
    mutationFn: (attempt) =>
      attempt().catch((e: unknown) => {
        throw toAppError(e);
      }),
    onSettled: () => invalidateHosting(queryClient),
  });

  const run = <T>(attempt: () => Promise<T>): Promise<T> => {
    setBusy((n) => n + 1);
    return (mutateAsync(attempt) as Promise<T>).finally(() => {
      reset();
      setBusy((n) => n - 1);
    });
  };

  return {
    connect: (provider, host, token) =>
      run(() => hostingConnect(provider, host, token)).then(
        (account) => ({ account }),
        (error: AppError) => ({ error }),
      ),
    disconnect: (accountId) =>
      run(() => hostingDisconnect(accountId)).then(
        () => null,
        (error: AppError) => error,
      ),
    pending: busy > 0,
  };
}
