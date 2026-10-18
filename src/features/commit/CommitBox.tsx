import type { RepoId } from "../../lib/ipc";
import { EMPTY_DRAFT, useCommitDraft } from "../../lib/store/commitDraft";
import { RepoError } from "../repo/RepoError";
import { useStatus } from "../worktree/useStatus";
import { AuthorLine } from "./AuthorLine";
import { commitDisabledReason } from "./commitGate";
import styles from "./CommitBox.module.css";
import { MessageEditor } from "./MessageEditor";
import { useCommit } from "./useCommit";
import { useCommitConfig } from "./useCommitConfig";
import { useHeadMessage } from "./useHeadMessage";

export function CommitBox({ repoId }: { repoId: RepoId }): React.JSX.Element {
  const draft = useCommitDraft((s) => s.drafts[repoId] ?? EMPTY_DRAFT);
  const { setSubject, setBody, setAmend } = useCommitDraft.getState();
  const { status } = useStatus(repoId);
  const { config, error: configError, refetch: refetchConfig } = useCommitConfig(repoId);
  const { head } = useHeadMessage(repoId);
  const { commit, pending, error, clearError } = useCommit(repoId);

  const reason = commitDisabledReason({
    amend: draft.amend,
    subject: draft.subject,
    status,
    config,
  });
  const canCommit = reason === null && !pending;
  const submit = () => {
    if (canCommit) commit({ subject: draft.subject, body: draft.body }, draft.amend);
  };
  // The checkbox is disabled while HEAD loads (undefined) and on an unborn HEAD (null).
  const amendHead = head ?? null;
  const unborn = head === null;

  return (
    <section aria-label="Commit" className={styles.root}>
      <AuthorLine config={config} />
      <MessageEditor
        subject={draft.subject}
        body={draft.body}
        disabled={pending}
        onSubjectChange={(v) => setSubject(repoId, v)}
        onBodyChange={(v) => setBody(repoId, v)}
        onSubmit={submit}
      />
      <div className={styles.actions}>
        <label className={styles.amend}>
          <input
            type="checkbox"
            checked={draft.amend}
            disabled={pending || amendHead === null}
            title={unborn ? "No commit to amend" : undefined}
            onChange={(e) => setAmend(repoId, e.target.checked, amendHead)}
          />
          Amend last commit
        </label>
        <button
          type="button"
          className={styles.button}
          disabled={!canCommit}
          title={pending ? undefined : (reason ?? undefined)}
          onClick={submit}
        >
          {pending ? "Committing…" : draft.amend ? "Amend commit" : "Commit"}
        </button>
      </div>
      {/* Capped so verbose hook output scrolls here instead of squeezing the editor. */}
      <div className={styles.alerts}>
        {error && <RepoError error={error} path={null} onDismiss={clearError} />}
        {configError && <RepoError error={configError} path={null} onDismiss={refetchConfig} />}
      </div>
    </section>
  );
}
