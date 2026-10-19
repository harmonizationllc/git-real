import { useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import type { RepoId } from "../../lib/ipc";
import { useBranches } from "../branches/useBranches";
import { RepoError } from "../repo/RepoError";
import { useStatus } from "../worktree/useStatus";
import styles from "./OperationBanner.module.css";
import { bannerTitle, headName, operationNoun } from "./operationCopy";
import type { ActiveOperation } from "./operationCopy";
import { useIntegrationActions } from "./useIntegrationActions";
import { useOperationState } from "./useOperationState";

const RESOLVE_FIRST = "Resolve all conflicts first";

export interface OperationBannerProps {
  repoId: RepoId;
}

/** A strip naming the in-progress operation, with Abort… and its way to finish. */
export function OperationBanner({ repoId }: OperationBannerProps) {
  const { state } = useOperationState(repoId);
  if (state === undefined || state.kind === "none") return null;
  return <ActiveBanner repoId={repoId} state={state} />;
}

interface ActiveBannerProps {
  repoId: RepoId;
  state: ActiveOperation;
}

// Mounted only while an operation is active, so its action error and dialog state reset when
// the operation ends and never carry over to the next one.
function ActiveBanner({ repoId, state }: ActiveBannerProps) {
  const { branches } = useBranches(repoId);
  const { status } = useStatus(repoId);
  const { run, pending, error, clearError } = useIntegrationActions(repoId);
  const [confirming, setConfirming] = useState(false);

  const head = headName(branches?.head);
  const conflicts = status?.entries.filter((e) => e.conflicted).length ?? 0;
  const blockedTitle = conflicts > 0 ? RESOLVE_FIRST : undefined;

  const openAbort = () => {
    clearError();
    setConfirming(true);
  };
  // Closes on failure too: the dialog has no error slot, the banner shows the error.
  const confirmAbort = async () => {
    await run({ action: "abort" });
    setConfirming(false);
  };

  return (
    <section
      aria-label="Operation in progress"
      aria-busy={pending || undefined}
      className={styles.root}
    >
      <p className={styles.title}>{bannerTitle(state, head, conflicts)}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.danger} disabled={pending} onClick={openAbort}>
          Abort…
        </button>
        {state.kind === "rebase" ? (
          <button
            type="button"
            disabled={conflicts > 0 || pending}
            title={blockedTitle}
            onClick={() => void run({ action: "continue" })}
          >
            Continue
          </button>
        ) : (
          <button
            type="button"
            disabled={conflicts > 0}
            title={blockedTitle}
            // "commit-subject" is the subject input's id, owned by features/commit MessageEditor.
            onClick={() => document.getElementById("commit-subject")?.focus()}
          >
            Go to commit
          </button>
        )}
      </div>
      {error && <RepoError error={error} path={null} onDismiss={clearError} />}
      <ConfirmDialog
        open={confirming}
        title={`Abort ${operationNoun(state)}?`}
        body="The working tree and index return to their state before the operation started. Resolved conflicts are lost."
        confirmLabel="Abort"
        danger
        pending={pending}
        onConfirm={() => void confirmAbort()}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
