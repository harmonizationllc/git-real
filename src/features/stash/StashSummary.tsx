import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import type { AppError, RepoId, StashEntry, StashFiles } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { shortOid } from "../graph/model/layout";
import { fullDate } from "../graph/model/relativeTime";
import { useOperationState } from "../merge/useOperationState";
import { toastError } from "../remotes/toastError";
import { RepoError } from "../repo/RepoError";
import { useStatus } from "../worktree/useStatus";
import { StashFileGroup } from "./StashFileGroup";
import styles from "./StashSummary.module.css";
import { POP_KEPT_TITLE, displayError, stashRef, stashSubject } from "./stashCopy";
import { applyGate } from "./stashGate";
import { useStashActions } from "./useStashActions";
import { useStashFiles } from "./useStashFiles";
import { useStashes } from "./useStashes";

export interface StashSummaryProps {
  repoId: RepoId;
  oid: string;
}

/** The selected stash in the sidebar; Close returns the sidebar to the changes and closes a diff opened from this stash. */
export function StashSummary({ repoId, oid }: StashSummaryProps) {
  const { stashes, error: listError, refetch } = useStashes(repoId);
  const { files, error: filesError, refetch: refetchFiles } = useStashFiles(repoId, oid);
  const entry = stashes?.find((s) => s.oid === oid);
  const untrackedOid = files?.untrackedOid ?? null;

  /** Clears the stash selection and any file opened from this stash; Close and a vanished stash share it. */
  const vanish = useCallback(() => {
    const { clearFileFrom, selectStash } = useWorkspace.getState();
    clearFileFrom(repoId, [oid, untrackedOid]);
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
        <RepoError error={listError} path={null} onRetry={refetch} onDismiss={vanish} />
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
      onClose={vanish}
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  const apply = applyGate(status, state);
  // After a pop that applied but kept the stash, another Pop would apply it again; the next
  // action of any kind clears it.
  const [popKept, setPopKept] = useState(false);

  // The failure is toasted here, from the resolved result; the hook toasts the notice.
  const run = (action: () => Promise<AppError | null>) => {
    setPopKept(false);
    void action().then((e) => {
      if (e !== null) toastError(displayError(e));
    });
  };

  const pop = () => {
    setPopKept(false);
    void actions.pop(entry).then(({ error, notice }) => {
      if (error !== null) toastError(displayError(error));
      setPopKept(notice?.kind === "popKept");
    });
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
        <button data-variant="neutral" data-size="sm" type="button" onClick={onRetryFiles}>
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
        <h2 ref={headingRef} tabIndex={-1} data-focus-target className={styles.title}>
          {stashRef(entry.index)}
        </h2>
        <button
          data-variant="ghost"
          data-size="sm"
          type="button"
          aria-label="Close stash details"
          onClick={onClose}
        >
          Close
        </button>
      </header>
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
          data-variant="neutral"
          data-size="sm"
          type="button"
          disabled={actions.pending || apply.disabled}
          title={apply.title}
          onClick={() => run(() => actions.apply(entry))}
        >
          Apply
        </button>
        <button
          data-variant="neutral"
          data-size="sm"
          type="button"
          disabled={actions.pending || apply.disabled || popKept}
          title={apply.title ?? (popKept ? POP_KEPT_TITLE : undefined)}
          onClick={pop}
        >
          Pop
        </button>
        <button
          data-variant="danger"
          data-size="sm"
          type="button"
          disabled={actions.pending}
          onClick={() => setConfirming(true)}
        >
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
        fallbackFocus={headingRef}
      />
    </section>
  );
}
