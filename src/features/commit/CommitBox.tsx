import { useState } from "react";
import type { RepoId } from "../../lib/ipc";
import { EMPTY_DRAFT, useCommitDraft } from "../../lib/store/commitDraft";
import { IssuePicker } from "../hosting/IssuePicker";
import { useRepoContext } from "../hosting/useRepoContext";
import { type ActiveOperation, commitButtonLabel, operationNoun } from "../merge/operationCopy";
import { RepoError } from "../repo/RepoError";
import { useStatus } from "../worktree/useStatus";
import { AuthorLine } from "./AuthorLine";
import { commitDisabledReason } from "./commitGate";
import styles from "./CommitBox.module.css";
import { MessageEditor } from "./MessageEditor";
import type { IssueRefInserter } from "./MessageEditor";
import { useCommit } from "./useCommit";
import { useCommitConfig } from "./useCommitConfig";
import { useHeadMessage } from "./useHeadMessage";
import { useOperationPrefill } from "./useOperationPrefill";

export function CommitBox({ repoId }: { repoId: RepoId }): React.JSX.Element {
  const draft = useCommitDraft((s) => s.drafts[repoId] ?? EMPTY_DRAFT);
  const { setSubject, setBody, setAmend } = useCommitDraft.getState();
  const { status } = useStatus(repoId);
  const { config, error: configError, refetch: refetchConfig } = useCommitConfig(repoId);
  const { head } = useHeadMessage(repoId);
  const { commit, pending, error, clearError } = useCommit(repoId);
  const state = useOperationPrefill(repoId);
  const operation: ActiveOperation | null =
    state === undefined || state.kind === "none" ? null : state;
  const { context } = useRepoContext(repoId);
  const account = context?.account ?? null;
  const usable = account !== null && !account.needsReconnect;
  // Wrapped: a bare function passed to setPicker would run as a state updater.
  const [picker, setPicker] = useState<{ insert: IssueRefInserter } | null>(null);
  // An account that stops being usable (disconnect, expired token) takes the open picker with it.
  if (!usable && picker !== null) setPicker(null);

  const reason = commitDisabledReason({
    amend: draft.amend,
    subject: draft.subject,
    status,
    operation: state,
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
        onLinkIssue={usable ? (insert) => setPicker({ insert }) : undefined}
      />
      <div className={styles.actions}>
        <label className={styles.amend}>
          <input
            type="checkbox"
            checked={draft.amend}
            disabled={pending || amendHead === null || operation !== null}
            title={
              operation !== null
                ? `Not available during a ${operationNoun(operation)}`
                : unborn
                  ? "No commit to amend"
                  : undefined
            }
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
          {pending
            ? "Committing…"
            : draft.amend
              ? "Amend commit"
              : (commitButtonLabel(state) ?? "Commit")}
        </button>
      </div>
      {/* Capped so verbose hook output scrolls here instead of squeezing the editor. */}
      <div className={styles.alerts}>
        {error && <RepoError error={error} path={null} onDismiss={clearError} />}
        {configError && <RepoError error={configError} path={null} onDismiss={refetchConfig} />}
      </div>
      {/* A usable account implies a hosted context. */}
      {picker !== null && context && (
        <IssuePicker
          repoId={repoId}
          provider={context.repo.provider}
          onPick={(n) => {
            picker.insert(`#${n}`);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </section>
  );
}
