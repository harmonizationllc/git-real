import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { stashApply, stashDrop, stashPop, stashPush, toAppError } from "../../lib/ipc";
import type { AppError, RepoId, StashEntry, StashOutcome } from "../../lib/ipc";
import { mutationKeys, queryKeys } from "../../lib/query/keys";
import { useToasts } from "../../lib/store/toasts";
import { noticeText } from "./stashCopy";

/** An apply or pop that left conflicts, or a pop that applied but kept the stash (`popKept`). */
export interface StashNotice {
  kind: "apply" | "pop" | "popKept";
  index: number;
}

type StashTarget = Pick<StashEntry, "index" | "oid">;

/** What a pop resolves: the failure, or the notice a StashSummary needs to block a second Pop. */
export interface StashRunResult {
  error: AppError | null;
  notice: StashNotice | null;
}

/** Each action resolves with the AppError or null and never rejects (pop: a StashRunResult). */
export interface UseStashActions {
  push(message: string | null, includeUntracked: boolean): Promise<AppError | null>;
  apply(entry: StashTarget): Promise<AppError | null>;
  pop(entry: StashTarget): Promise<StashRunResult>;
  drop(entry: StashTarget): Promise<AppError | null>;
  pending: boolean;
}

type StashRequest =
  | { action: "push"; message: string | null; includeUntracked: boolean }
  | { action: "apply" | "pop" | "drop"; index: number; oid: string };

/** The notice an apply or pop outcome calls for: none when it applied and (for pop) dropped. */
const noticeOf =
  (kind: "apply" | "pop", index: number) =>
  (outcome: StashOutcome): StashNotice | null => {
    switch (outcome) {
      case "conflicts":
        return { kind, index };
      case "appliedNotDropped":
        return { kind: "popKept", index };
      case "applied":
        return null;
    }
  };

/** The notice of an apply or pop; null otherwise. */
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
  // Counted here rather than read from `isPending`, whose observer update lands a tick later.
  const [busy, setBusy] = useState(0);
  const { mutateAsync } = useMutation<StashNotice | null, AppError, StashRequest>({
    mutationKey: mutationKeys.stash(repoId),
    mutationFn: (req) =>
      execute(repoId, req).catch((e: unknown) => {
        throw toAppError(e);
      }),
    // Runs on failure too: a stale stash needs the new list, a failed apply may have partly applied.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
  });

  /** Toasts the notice of an apply or pop; the call site toasts the failure. */
  const run = (req: StashRequest): Promise<StashRunResult> => {
    setBusy((n) => n + 1);
    return mutateAsync(req)
      .then(
        (notice): StashRunResult => {
          if (notice !== null) {
            useToasts.getState().notify({ text: noticeText(notice), variant: "info" });
          }
          return { error: null, notice };
        },
        (error: AppError): StashRunResult => ({ error, notice: null }),
      )
      .finally(() => setBusy((n) => n - 1));
  };

  return {
    push: (message, includeUntracked) =>
      run({ action: "push", message, includeUntracked }).then((r) => r.error),
    apply: ({ index, oid }) => run({ action: "apply", index, oid }).then((r) => r.error),
    pop: ({ index, oid }) => run({ action: "pop", index, oid }),
    drop: ({ index, oid }) => run({ action: "drop", index, oid }).then((r) => r.error),
    pending: busy > 0,
  };
}
