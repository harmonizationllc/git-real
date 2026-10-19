import { useEffect } from "react";
import type { OperationState, RepoId } from "../../lib/ipc";
import { useCommitDraft } from "../../lib/store/commitDraft";
import { commitsThroughBox } from "../merge/operationCopy";
import { useOperationState } from "../merge/useOperationState";

/**
 * Prefills the commit draft with the message of an operation that commits through the box,
 * clears an untouched prefill once it ends, and turns amend off while any operation is in
 * progress; `syncPrefill` never overwrites typed text.
 * Returns the operation state so the box needs no second subscription.
 */
export function useOperationPrefill(repoId: RepoId): OperationState | undefined {
  const { state } = useOperationState(repoId);
  useEffect(() => {
    if (state === undefined) return;
    const { drafts, setAmend, syncPrefill } = useCommitDraft.getState();
    if (commitsThroughBox(state)) {
      syncPrefill(repoId, state.message);
      return;
    }
    // Amend is locked during any operation, so it must not stay on: restore the stashed text.
    if (state.kind !== "none" && drafts[repoId]?.amend === true) setAmend(repoId, false, null);
    syncPrefill(repoId, null);
  }, [repoId, state]);
  return state;
}
