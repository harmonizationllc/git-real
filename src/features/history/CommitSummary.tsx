import { useState } from "react";
import { copyText, toAppError } from "../../lib/ipc";
import type { AppError, CommitDetail, RepoId, Signature } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { shortOid } from "../graph/model/layout";
import { fullDate } from "../graph/model/relativeTime";
import { RepoError } from "../repo/RepoError";
import { useCommitDetail } from "./useCommitDetail";
import styles from "./CommitSummary.module.css";

export interface CommitSummaryProps {
  repoId: RepoId;
  oid: string;
}

const sameSignature = (a: Signature, b: Signature) =>
  a.name === b.name && a.email === b.email && a.time === b.time;

function Person({ label, who }: { label: string; who: Signature }) {
  return (
    <p className={styles.person}>
      <span className={styles.label}>{label}</span>{" "}
      {`${who.name} <${who.email}> · ${fullDate(who.time)}`}
    </p>
  );
}

/** The selected commit's metadata in the sidebar; Close returns the sidebar to the changes. */
export function CommitSummary({ repoId, oid }: CommitSummaryProps) {
  const { commit, error, refetch } = useCommitDetail(repoId, oid);
  const selectCommit = useWorkspace((s) => s.selectCommit);
  const close = () => selectCommit(repoId, null);

  if (error !== null) {
    return (
      <div className={styles.root}>
        <RepoError error={error} path={null} onRetry={refetch} onDismiss={close} />
      </div>
    );
  }
  if (commit === undefined) {
    return (
      <div className={styles.root}>
        <p role="status">Loading commit…</p>
      </div>
    );
  }
  return <Details repoId={repoId} commit={commit} onClose={close} />;
}

interface DetailsProps {
  repoId: RepoId;
  commit: CommitDetail;
  onClose(): void;
}

function Details({ repoId, commit, onClose }: DetailsProps) {
  const selectCommit = useWorkspace((s) => s.selectCommit);
  const [copyError, setCopyError] = useState<AppError | null>(null);
  const { oid, parents, message, author, committer } = commit;

  const copy = () => void copyText(oid).catch((e: unknown) => setCopyError(toAppError(e)));

  return (
    <section aria-label="Commit details" className={styles.root}>
      <header className={styles.header}>
        <h2 className={styles.title}>{`Commit ${shortOid(oid)}`}</h2>
        <button type="button" onClick={copy}>
          Copy
        </button>
        <button type="button" aria-label="Close commit details" onClick={onClose}>
          Close
        </button>
      </header>
      {copyError !== null && (
        <RepoError error={copyError} path={null} onDismiss={() => setCopyError(null)} />
      )}
      <code className={styles.hash}>{oid}</code>
      <Person label="Author" who={author} />
      {!sameSignature(author, committer) && <Person label="Committer" who={committer} />}
      {parents.length > 0 && (
        <p className={styles.parents}>
          <span className={styles.label}>Parents</span>
          {parents.map((parent) => (
            <button
              key={parent}
              type="button"
              className={styles.parent}
              title={parent}
              onClick={() => selectCommit(repoId, parent)}
            >
              {shortOid(parent)}
            </button>
          ))}
        </p>
      )}
      <strong className={styles.subject}>{message.subject}</strong>
      {message.body !== "" && <p className={styles.body}>{message.body}</p>}
    </section>
  );
}
