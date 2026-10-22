import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toAppError } from "../../lib/ipc";
import type { AppError, Credentials, RepoId } from "../../lib/ipc";
import { mutationKeys, queryKeys } from "../../lib/query/keys";

export interface CredentialPrompt {
  origin: string;
  /** `origin` without the scheme, for the title. */
  host: string;
  /** True after credentials the user entered were refused. */
  rejected: boolean;
  submit(username: string, token: string): void;
  cancel(): void;
}

export type NetworkResult<T> =
  { status: "ok"; value: T } | { status: "failed"; error: AppError } | { status: "cancelled" };

export interface UseNetworkAction {
  run<T>(action: (credentials: Credentials | null) => Promise<T>): Promise<NetworkResult<T>>;
  /** A run of this instance is in flight (prompt included), or any network action of the repo runs. */
  pending: boolean;
  prompt: CredentialPrompt | null;
}

/** The HTTPS origin a credential prompt can answer for, or null when a prompt cannot help. */
function promptOrigin(error: AppError): string | null {
  const n = error.network;
  if (error.kind !== "networkFailed" || n === undefined || !n.https) return null;
  if (n.kind !== "httpsAuthRequired" && n.kind !== "httpsAuthRejected") return null;
  return n.origin;
}

/** True when a prompt can help: an HTTPS auth failure on a known origin. */
export function needsCredentials(error: AppError): boolean {
  return promptOrigin(error) !== null;
}

/**
 * The single gate for every network mutation: runs the action without
 * credentials, asks for them on an HTTPS auth failure, retries until they work
 * or the user cancels. Credentials live in this call only: each attempt reaches
 * the mutation as an opaque thunk, and resetting the observer after it settles
 * lets `gcTime: 0` drop the mutation from the cache at once.
 */
export function useNetworkAction(repoId: RepoId): UseNetworkAction {
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState<CredentialPrompt | null>(null);
  // Read synchronously by run(): the prompt state lags a render.
  const asking = useRef(false);
  // Counted here: `isPending` lags a tick, and the prompt wait is not a mutation.
  const [busy, setBusy] = useState(0);
  const elsewhere = useIsMutating({ mutationKey: mutationKeys.network(repoId) }) > 0;
  const { mutateAsync, reset } = useMutation<unknown, AppError, () => Promise<unknown>>({
    mutationKey: mutationKeys.network(repoId),
    gcTime: 0,
    mutationFn: (attempt) =>
      attempt().catch((e: unknown) => {
        throw toAppError(e);
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
  });

  const ask = (origin: string, rejected: boolean) =>
    new Promise<Credentials | null>((resolve) => {
      const close = (credentials: Credentials | null) => {
        asking.current = false;
        setPrompt(null);
        resolve(credentials);
      };
      asking.current = true;
      setPrompt({
        origin,
        host: origin.replace(/^https?:\/\//, ""),
        rejected,
        submit: (username, token) => close({ origin, username, token }),
        cancel: () => close(null),
      });
    });

  const run = async <T>(
    action: (credentials: Credentials | null) => Promise<T>,
  ): Promise<NetworkResult<T>> => {
    // One prompt at a time: a run started while it is open is ignored.
    if (asking.current) return { status: "cancelled" };
    setBusy((n) => n + 1);
    try {
      let credentials: Credentials | null = null;
      for (;;) {
        try {
          const value = (await mutateAsync(() => action(credentials)).finally(reset)) as T;
          return { status: "ok", value };
        } catch (e) {
          const error = e as AppError;
          const origin = promptOrigin(error);
          if (origin === null) return { status: "failed", error };
          credentials = await ask(origin, credentials !== null);
          if (credentials === null) return { status: "cancelled" };
        }
      }
    } finally {
      setBusy((n) => n - 1);
    }
  };

  return { run, pending: busy > 0 || elsewhere, prompt };
}
