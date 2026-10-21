import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { createTag, deleteRemoteTag, deleteTag, pushTag, toAppError } from "../../lib/ipc";
import type { AppError, RepoId } from "../../lib/ipc";
import { mutationKeys, queryKeys } from "../../lib/query/keys";

/** A successful push or remote delete, for the status line. */
export interface TagStatus {
  kind: "pushed" | "deletedRemote";
  name: string;
  remote: string;
}

/** Each action resolves with the AppError or null and never rejects. */
export interface UseTagActions {
  create(name: string, oid: string, message: string | null): Promise<AppError | null>;
  remove(name: string): Promise<AppError | null>;
  push(remote: string, name: string): Promise<AppError | null>;
  deleteRemote(remote: string, name: string): Promise<AppError | null>;
  /** True while any tag action of this repo runs, in this instance or another (mutationKeys.tag). */
  pending: boolean;
  error: AppError | null;
  /** The last successful push or remote delete; cleared when the next action starts. */
  status: TagStatus | null;
  /** The tag named by the latest action, for error copy. */
  lastName: string | null;
  clearError(): void;
  clearStatus(): void;
}

type TagRequest =
  | { action: "create"; name: string; oid: string; message: string | null }
  | { action: "remove"; name: string }
  | { action: "push" | "deleteRemote"; remote: string; name: string };

function execute(repoId: RepoId, req: TagRequest): Promise<void> {
  switch (req.action) {
    case "create":
      return createTag(repoId, req.name, req.oid, req.message);
    case "remove":
      return deleteTag(repoId, req.name);
    case "push":
      return pushTag(repoId, req.remote, req.name);
    case "deleteRemote":
      return deleteRemoteTag(repoId, req.remote, req.name);
  }
}

export function useTagActions(repoId: RepoId): UseTagActions {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<TagStatus | null>(null);
  const [lastName, setLastName] = useState<string | null>(null);
  // Counted here rather than read from `isPending`, whose observer update lands a tick later.
  const [busy, setBusy] = useState(0);
  const elsewhere = useIsMutating({ mutationKey: mutationKeys.tag(repoId) }) > 0;
  const mutation = useMutation<void, AppError, TagRequest>({
    mutationKey: mutationKeys.tag(repoId),
    mutationFn: (req) =>
      execute(repoId, req).catch((e: unknown) => {
        throw toAppError(e);
      }),
    // Runs on failure too: a vanished tag needs the new list.
    onSettled: (_data, _error, req) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tags(repoId) }),
        req.action === "create" || req.action === "remove"
          ? queryClient.invalidateQueries({ queryKey: queryKeys.log(repoId) })
          : undefined,
      ]),
  });
  const { mutateAsync } = mutation;

  const run = (req: TagRequest): Promise<AppError | null> => {
    setStatus(null);
    setLastName(req.name);
    setBusy((n) => n + 1);
    return mutateAsync(req)
      .then(
        () => {
          if (req.action === "push" || req.action === "deleteRemote")
            setStatus({
              kind: req.action === "push" ? "pushed" : "deletedRemote",
              name: req.name,
              remote: req.remote,
            });
          return null;
        },
        (e: AppError) => e,
      )
      .finally(() => setBusy((n) => n - 1));
  };

  return {
    create: (name, oid, message) => run({ action: "create", name, oid, message }),
    remove: (name) => run({ action: "remove", name }),
    push: (remote, name) => run({ action: "push", remote, name }),
    deleteRemote: (remote, name) => run({ action: "deleteRemote", remote, name }),
    pending: busy > 0 || elsewhere,
    error: mutation.error,
    status,
    lastName,
    clearError: mutation.reset,
    clearStatus: () => setStatus(null),
  };
}
