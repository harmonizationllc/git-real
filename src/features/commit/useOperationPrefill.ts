import { useEffect } from "react";
import type { OperationState, RepoId } from "../../lib/ipc";
import { useCommitDraft } from "../../lib/store/commitDraft";
import { commitsThroughBox } from "../merge/operationCopy";
import { useOperationState } from "../merge/useOperationState";

/**
 * Prefills the commit draft with the message of an operation that commits through the box,
 * and clears an untouched prefill once it ends; `syncPrefill` never overwrites typed text.
 * Returns the operation state so the box needs no second subscription.
 */
export function useOperationPrefill(repoId: RepoId): OperationState | undefined {
  const { state } = useOperationState(repoId);
  useEffect(() => {
    if (state === undefined) return;
    useCommitDraft.getState().syncPrefill(repoId, commitsThroughBox(state) ? state.message : null);
  }, [repoId, state]);
  return state;
}
