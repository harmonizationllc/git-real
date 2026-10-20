import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { stashApply, stashDrop, stashPop, stashPush, toAppError } from "../../lib/ipc";
import type { AppError, RepoId, StashEntry, StashOutcome } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

/** An apply or pop that left conflicts in the working tree. */
export interface StashNotice {
  kind: "apply" | "pop";
  index: number;
}

type StashTarget = Pick<StashEntry, "index" | "oid">;

/** Each action resolves with the AppError or null and never rejects. */
export interface UseStashActions {
  push(message: string | null, includeUntracked: boolean): Promise<AppError | null>;
  apply(entry: StashTarget): Promise<AppError | null>;
  pop(entry: StashTarget): Promise<AppError | null>;
  drop(entry: StashTarget): Promise<AppError | null>;
  pending: boolean;
  error: AppError | null;
  notice: StashNotice | null;
  clearError(): void;
  clearNotice(): void;
}

type StashRequest =
  | { action: "push"; message: string | null; includeUntracked: boolean }
  | { action: "apply" | "pop" | "drop"; index: number; oid: string };

/** The notice an apply or pop outcome calls for: one only when it left conflicts. */
const noticeOf =
  (kind: StashNotice["kind"], index: number) =>
  (outcome: StashOutcome): StashNotice | null =>
    outcome === "conflicts" ? { kind, index } : null;

/** The conflict notice of an apply or pop; null otherwise. */
function execute(repoId: RepoId, req: StashRequest): Promise<StashNotice | null> {
  switch (req.action) {
    case "push":
      return stashPush(repoId, req.message, req.includeUntracked).then(() => null);
    case "apply":
      return stashApply(repoId, req.index, req.oid).then(noticeOf("apply", req.index));
    case "pop":
      return stashPop(repoId, req.index, req.oid).then(noticeOf("pop", req.index));
    case "drop":
      return stashDrop(repoId, req.index, req.oid).then(() => null);
  }
}

export function useStashActions(repoId: RepoId): UseStashActions {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<StashNotice | null>(null);
  // Counted here rather than read from `isPending`, whose observer update lands a tick later.
  const [busy, setBusy] = useState(0);
  const mutation = useMutation<StashNotice | null, AppError, StashRequest>({
    mutationFn: (req) =>
      execute(repoId, req).catch((e: unknown) => {
        throw toAppError(e);
      }),
    // Runs on failure too: a stale stash needs the new list, a failed apply may have partly applied.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
  });
  const { mutateAsync } = mutation;

  const run = (req: StashRequest): Promise<AppError | null> => {
    setNotice(null);
    setBusy((n) => n + 1);
    return mutateAsync(req)
      .then(
        (next) => {
          setNotice(next);
          return null;
        },
        (e: AppError) => e,
      )
      .finally(() => setBusy((n) => n - 1));
  };

  return {
    push: (message, includeUntracked) => run({ action: "push", message, includeUntracked }),
    apply: ({ index, oid }) => run({ action: "apply", index, oid }),
    pop: ({ index, oid }) => run({ action: "pop", index, oid }),
    drop: ({ index, oid }) => run({ action: "drop", index, oid }),
    pending: busy > 0,
    error: mutation.error,
    notice,
    clearError: mutation.reset,
    clearNotice: () => setNotice(null),
  };
}
