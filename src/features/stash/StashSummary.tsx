import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import type { AppError, RepoId, StashEntry, StashFiles } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { commitOf } from "../diff/model/scope";
import { shortOid } from "../graph/model/layout";
import { fullDate } from "../graph/model/relativeTime";
import { useOperationState } from "../merge/useOperationState";
import { RepoError } from "../repo/RepoError";
import { useStatus } from "../worktree/useStatus";
import { StashFeedback } from "./StashFeedback";
import { StashFileGroup } from "./StashFileGroup";
import styles from "./StashSummary.module.css";
import { POP_KEPT_TITLE, stashRef, stashSubject } from "./stashCopy";
import { applyGate } from "./stashGate";
import { useStashActions } from "./useStashActions";
import { useStashFiles } from "./useStashFiles";
import { useStashes } from "./useStashes";

export interface StashSummaryProps {
  repoId: RepoId;
  oid: string;
}

/** The selected stash in the sidebar; Close returns the sidebar to the changes. */
export function StashSummary({ repoId, oid }: StashSummaryProps) {
  const { stashes, error: listError, refetch } = useStashes(repoId);
  const { files, error: filesError, refetch: refetchFiles } = useStashFiles(repoId, oid);
  const entry = stashes?.find((s) => s.oid === oid);
  const untrackedOid = files?.untrackedOid ?? null;

  const close = () => useWorkspace.getState().selectStash(repoId, null);

  /** Clears the stash selection and any file opened from this stash. */
  const vanish = useCallback(() => {
    const { selected, select, selectStash } = useWorkspace.getState();
    const scoped = selected[repoId];
    const from = scoped ? commitOf(scoped.scope) : null;
    if (from !== null && (from === oid || from === untrackedOid)) select(repoId, null);
    selectStash(repoId, null);
  }, [repoId, oid, untrackedOid]);

  // Popped, dropped or changed in a terminal: the stash is no longer there to show.
  const gone =
    (stashes !== undefined && entry === undefined) || filesError?.kind === "revisionNotFound";
  useEffect(() => {
    if (gone) vanish();
  }, [gone, vanish]);

  if (listError !== null) {
    return (
      <div className={styles.root}>
        <RepoError error={listError} path={null} onRetry={refetch} onDismiss={close} />
      </div>
    );
  }
  // Also shown for the one render before `vanish` runs.
  if (entry === undefined) {
    return (
      <div className={styles.root}>
        <p role="status">Loading stash…</p>
      </div>
    );
  }
  return (
    <Details
      repoId={repoId}
      entry={entry}
      files={files}
      filesError={filesError}
      onRetryFiles={refetchFiles}
      onClose={close}
    />
  );
}

interface DetailsProps {
  repoId: RepoId;
  entry: StashEntry;
  files: StashFiles | undefined;
  filesError: AppError | null;
  onRetryFiles(): void;
  onClose(): void;
}

function Details({ repoId, entry, files, filesError, onRetryFiles, onClose }: DetailsProps) {
  const actions = useStashActions(repoId);
  const { status } = useStatus(repoId);
  const { state } = useOperationState(repoId);
  const [confirming, setConfirming] = useState(false);
  const apply = applyGate(status, state);
  // After a pop that applied but kept the stash, another Pop would apply it again.
  const popKept = actions.notice?.kind === "popKept";

  // A newer result must not hide behind an older, undismissed error.
  const run = (action: () => Promise<AppError | null>) => {
    actions.clearError();
    void action();
  };

  // Closes at once, as the Changes discard confirm does; the drop's pending state disables the actions.
  const confirmDrop = () => {
    setConfirming(false);
    run(() => actions.drop(entry));
  };

  let fileList: React.ReactNode;
  if (filesError !== null && filesError.kind !== "revisionNotFound") {
    // Retry only: dismissing would leave the summary without its files and no way back.
    fileList = (
      <div role="alert" className={styles.error}>
        <p className={styles.message}>{filesError.message}</p>
        <button type="button" onClick={onRetryFiles}>
          Retry
        </button>
      </div>
    );
  } else if (files === undefined) {
    fileList = <p role="status">Loading files…</p>;
  } else {
    fileList = (
      <>
        <StashFileGroup
          repoId={repoId}
          title="Changes"
          listLabel="Stashed changes"
          files={files.tracked}
          commit={entry.oid}
        />
        {files.untrackedOid !== null && (
          <StashFileGroup
            repoId={repoId}
            title="Untracked"
            listLabel="Stashed untracked files"
            files={files.untracked}
            commit={files.untrackedOid}
          />
        )}
      </>
    );
  }

  return (
    <section
      aria-label="Stash details"
      aria-busy={actions.pending || undefined}
      className={styles.root}
    >
      <header className={styles.header}>
        <h2 className={styles.title}>{stashRef(entry.index)}</h2>
        <button type="button" aria-label="Close stash details" onClick={onClose}>
          Close
        </button>
      </header>
      <StashFeedback actions={actions} />
      <strong className={styles.subject}>{stashSubject(entry.message)}</strong>
      {entry.branch !== null && (
        <p className={styles.meta}>
          <span className={styles.label}>Branch</span> {entry.branch}
        </p>
      )}
      <p className={styles.meta}>{fullDate(entry.time)}</p>
      <p className={styles.meta}>
        <span className={styles.label}>Base</span>{" "}
        <code className={styles.base} title={entry.base}>
          {shortOid(entry.base)}
        </code>
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          disabled={actions.pending || apply.disabled}
          title={apply.title}
          onClick={() => run(() => actions.apply(entry))}
        >
          Apply
        </button>
        <button
          type="button"
          disabled={actions.pending || apply.disabled || popKept}
          title={popKept ? POP_KEPT_TITLE : apply.title}
          onClick={() => run(() => actions.pop(entry))}
        >
          Pop
        </button>
        <button type="button" disabled={actions.pending} onClick={() => setConfirming(true)}>
          Drop…
        </button>
      </div>
      {fileList}
      <ConfirmDialog
        open={confirming}
        title={`Drop ${stashRef(entry.index)}?`}
        body="This can't be undone."
        confirmLabel="Drop"
        danger
        onConfirm={confirmDrop}
        onCancel={() => setConfirming(false)}
      />
    </section>
  );
}
