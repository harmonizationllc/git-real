import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { addRemote, removeRemote, toAppError, updateRemote } from "../../lib/ipc";
import type { AppError, RepoId } from "../../lib/ipc";
import { mutationKeys, queryKeys } from "../../lib/query/keys";
import { useAutoFetchState } from "../../lib/store/autoFetch";

/** One remote config edit; add and update may make fetch work again, remove cannot. */
interface RemoteEdit {
  action: () => Promise<unknown>;
  wakesAutoFetch: boolean;
}

/** Each action resolves with the AppError or null and never rejects. */
export interface UseRemoteActions {
  add(name: string, url: string, pushUrl: string | null): Promise<AppError | null>;
  update(
    name: string,
    newName: string,
    url: string,
    pushUrl: string | null,
  ): Promise<AppError | null>;
  remove(name: string): Promise<AppError | null>;
  /** True while an action of this instance runs. */
  pending: boolean;
}

/** Remote config edits: local only, so they bypass the network gate. */
export function useRemoteActions(repoId: RepoId): UseRemoteActions {
  const queryClient = useQueryClient();
  // Counted here rather than read from `isPending`, whose observer update lands a tick later.
  const [busy, setBusy] = useState(0);
  const { mutateAsync } = useMutation<unknown, AppError, RemoteEdit>({
    mutationKey: mutationKeys.remote(repoId),
    mutationFn: ({ action }) =>
      action().catch((e: unknown) => {
        throw toAppError(e);
      }),
    // A new or edited remote may make fetch work again: clear a pause and ask for a fetch.
    onSuccess: (_data, { wakesAutoFetch }) => {
      if (!wakesAutoFetch) return;
      const autoFetch = useAutoFetchState.getState();
      autoFetch.resume(repoId);
      autoFetch.request(repoId);
    },
    // Remotes, branches, log and the sync gates all follow the remote config; a failed rename
    // may have partly applied, so this runs on failure too.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
  });

  const run = async (
    action: () => Promise<unknown>,
    { wakesAutoFetch = false }: { wakesAutoFetch?: boolean } = {},
  ): Promise<AppError | null> => {
    setBusy((n) => n + 1);
    try {
      await mutateAsync({ action, wakesAutoFetch });
      return null;
    } catch (e) {
      return e as AppError;
    } finally {
      setBusy((n) => n - 1);
    }
  };

  return {
    add: (name, url, pushUrl) =>
      run(() => addRemote(repoId, name, url, pushUrl), { wakesAutoFetch: true }),
    update: (name, newName, url, pushUrl) =>
      run(() => updateRemote(repoId, name, newName, url, pushUrl), { wakesAutoFetch: true }),
    remove: (name) => run(() => removeRemote(repoId, name)),
    pending: busy > 0,
  };
}
