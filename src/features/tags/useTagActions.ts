import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createTag, deleteRemoteTag, deleteTag, pushTag, toAppError } from "../../lib/ipc";
import type { AppError, RepoId } from "../../lib/ipc";
import { mutationKeys, queryKeys } from "../../lib/query/keys";
import { useToasts } from "../../lib/store/toasts";
import { useNetworkAction } from "../remotes/useNetworkAction";
import type { CredentialPrompt } from "../remotes/useNetworkAction";
import { statusText } from "./tagCopy";

/** A successful push or remote delete, worded by `statusText` for its toast. */
export interface TagStatus {
  kind: "pushed" | "deletedRemote";
  name: string;
  remote: string;
}

/** Each action resolves with the AppError or null and never rejects. */
export interface UseTagActions {
  create(name: string, oid: string, message: string | null): Promise<AppError | null>;
  remove(name: string): Promise<AppError | null>;
  /** Resolves null too when the user cancels the sign-in. */
  push(remote: string, name: string): Promise<AppError | null>;
  /** Resolves null too when the user cancels the sign-in. */
  deleteRemote(remote: string, name: string): Promise<AppError | null>;
  /**
   * True while any tag action of this repo runs, in this instance or another (mutationKeys.tag),
   * or while any network action of the repo runs (prompt included).
   */
  pending: boolean;
  /** The sign-in a push or remote delete is waiting on, for CredentialDialog. */
  prompt: CredentialPrompt | null;
}

type LocalRequest =
  | { action: "create"; name: string; oid: string; message: string | null }
  | { action: "remove"; name: string };

function execute(repoId: RepoId, req: LocalRequest): Promise<void> {
  return req.action === "create"
    ? createTag(repoId, req.name, req.oid, req.message)
    : deleteTag(repoId, req.name);
}

export function useTagActions(repoId: RepoId): UseTagActions {
  const queryClient = useQueryClient();
  const network = useNetworkAction(repoId);
  // Counted here rather than read from `isPending`, whose observer update lands a tick later.
  const [busy, setBusy] = useState(0);
  const elsewhere = useIsMutating({ mutationKey: mutationKeys.tag(repoId) }) > 0;
  const { mutateAsync } = useMutation<void, AppError, LocalRequest>({
    mutationKey: mutationKeys.tag(repoId),
    mutationFn: (req) =>
      execute(repoId, req).catch((e: unknown) => {
        throw toAppError(e);
      }),
    // Runs on failure too: a vanished tag needs the new list.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tags(repoId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.log(repoId) }),
      ]),
  });

  const runLocal = (req: LocalRequest): Promise<AppError | null> => {
    setBusy((n) => n + 1);
    return mutateAsync(req)
      .then(
        () => null,
        (e: AppError) => e,
      )
      .finally(() => setBusy((n) => n - 1));
  };

  // Network actions go through the gate, which invalidates the whole repo on every attempt.
  const runRemote = async (
    kind: TagStatus["kind"],
    remote: string,
    name: string,
  ): Promise<AppError | null> => {
    const send = kind === "pushed" ? pushTag : deleteRemoteTag;
    const result = await network.run((c) => send(repoId, remote, name, c));
    if (result.status === "failed") return result.error;
    if (result.status === "ok") {
      useToasts.getState().notify({ text: statusText({ kind, name, remote }), variant: "success" });
    }
    return null;
  };

  return {
    create: (name, oid, message) => runLocal({ action: "create", name, oid, message }),
    remove: (name) => runLocal({ action: "remove", name }),
    push: (remote, name) => runRemote("pushed", remote, name),
    deleteRemote: (remote, name) => runRemote("deletedRemote", remote, name),
    pending: busy > 0 || elsewhere || network.pending,
    prompt: network.prompt,
  };
}
