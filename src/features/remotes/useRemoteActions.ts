import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { addRemote, removeRemote, toAppError, updateRemote } from "../../lib/ipc";
import type { AppError, RepoId } from "../../lib/ipc";
import { mutationKeys, queryKeys } from "../../lib/query/keys";

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
  const { mutateAsync } = useMutation<unknown, AppError, () => Promise<unknown>>({
    mutationKey: mutationKeys.remote(repoId),
    mutationFn: (action) =>
      action().catch((e: unknown) => {
        throw toAppError(e);
      }),
    // Remotes, branches, log and the sync gates all follow the remote config; a failed rename
    // may have partly applied, so this runs on failure too.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
  });

  const run = async (action: () => Promise<unknown>): Promise<AppError | null> => {
    setBusy((n) => n + 1);
    try {
      await mutateAsync(action);
      return null;
    } catch (e) {
      return e as AppError;
    } finally {
      setBusy((n) => n - 1);
    }
  };

  return {
    add: (name, url, pushUrl) => run(() => addRemote(repoId, name, url, pushUrl)),
    update: (name, newName, url, pushUrl) =>
      run(() => updateRemote(repoId, name, newName, url, pushUrl)),
    remove: (name) => run(() => removeRemote(repoId, name)),
    pending: busy > 0,
  };
}
