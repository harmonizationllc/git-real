import { useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import type { AppError, BranchList, HostingProvider, RepoId, Tracking } from "../../lib/ipc";
import { useBranches } from "../branches/useBranches";
import { CredentialDialog } from "../remotes/CredentialDialog";
import { NetworkError } from "../remotes/NetworkError";
import { useRemotes } from "../remotes/useRemotes";
import styles from "./CreatePullRequestDialog.module.css";
import { defaultTarget, originBranchName, prPushPlan } from "./createPrPlan";
import type { PrPushPlan } from "./createPrPlan";
import { PUBLISH_FIRST_TEXT, hostingMessage, pushFirstLabel } from "./hostingCopy";
import { useCreatePullRequest } from "./useCreatePullRequest";
import type { CreatePrInput } from "./useCreatePullRequest";
import { usePullRequestDraft } from "./usePullRequestDraft";
import { useRepoContext } from "./useRepoContext";
import { useRepoInfo } from "./useRepoInfo";

export interface CreatePullRequestDialogProps {
  repoId: RepoId;
  onClose(): void;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

/** What the form opens with, frozen once known so a refetch never remounts or resets it. */
interface Base {
  /** The branch the pull request is opened from, even if HEAD moves meanwhile. */
  local: string;
  /** origin's branches other than the source, as the Target options. */
  targets: string[];
  target: string;
  provider: HostingProvider;
}

interface Seed {
  title: string;
  body: string;
}

/** The local branch's upstream, or null when it has none or is not listed. */
const trackingOf = (list: BranchList, name: string): Tracking | null =>
  list.local.find((b) => b.name === name)?.tracking ?? null;

/**
 * Opens a pull request from the current branch into one of origin's branches, publishing or
 * pushing the branch first when it needs it. The form waits for the branches, the hosting context,
 * the repository info and the draft, then keeps what it opened with.
 */
export function CreatePullRequestDialog({
  repoId,
  onClose,
  fallbackFocus,
}: CreatePullRequestDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const { branches } = useBranches(repoId);
  const { remotes } = useRemotes(repoId);
  const { context } = useRepoContext(repoId);
  const repoInfo = useRepoInfo(repoId, true);
  const remoteNames = remotes?.map((r) => r.name) ?? [];
  const [base, setBase] = useState<Base | null>(null);
  const [seed, setSeed] = useState<Seed | null>(null);

  let blocked: string | null = null;
  if (base === null && branches !== undefined) {
    const head = branches.head;
    if (head.kind !== "branch") {
      blocked = "Check out a branch to open a pull request.";
    } else if (
      remotes !== undefined &&
      context &&
      (repoInfo.info !== undefined || repoInfo.error !== null)
    ) {
      // The source's own name on origin is never a target.
      const tracking = trackingOf(branches, head.name);
      const source = originBranchName(head.name, tracking, prPushPlan(tracking, remoteNames));
      const targets = (
        branches.remotes.find((g) => g.remote === "origin")?.branches.map((b) => b.name) ?? []
      ).filter((n) => n !== source);
      if (targets.length === 0) blocked = "origin has no branches to target. Fetch first.";
      else {
        setBase({
          local: head.name,
          targets,
          // Non-empty targets always give a default.
          target: defaultTarget(repoInfo.info, targets) as string,
          provider: context.repo.provider,
        });
      }
    }
  }

  // The draft is read once, for the default target; after seeding it is no longer observed, so a
  // network action's refresh of the repository does not ask for it again.
  const draft = usePullRequestDraft(repoId, seed === null ? (base?.target ?? null) : null);
  if (seed === null && draft.settled) {
    setSeed({ title: draft.draft?.title ?? "", body: draft.draft?.body ?? "" });
  }

  // The upstream stays live: after a publish the notice goes and a retry pushes nothing.
  const local = base?.local ?? "";
  const tracking = branches === undefined ? null : trackingOf(branches, local);
  const create = useCreatePullRequest(repoId, local, tracking, remoteNames);
  const { pending, error } = create;
  const ready = seed !== null;

  useRestoreFocus(fallbackFocus);
  // The box holds focus while loading and while pending; Title takes it once the form is up and
  // again after a failure. Here rather than in the form: layout effects run child first, and the
  // restore above must record the opener before anything inside takes focus.
  useLayoutEffect(() => {
    ((ready && !pending ? titleRef.current : dialogRef.current) as HTMLElement).focus();
  }, [ready, pending, error]);

  // A backdrop click does not cancel: it would throw away a typed description.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !pending) onClose();
  };

  let body: React.ReactNode;
  if (blocked !== null) {
    body = (
      <>
        <p className={styles.note}>{blocked}</p>
        <div className={styles.actions}>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </>
    );
  } else if (base === null || seed === null) {
    body = <p className={styles.note}>Loading…</p>;
  } else {
    body = (
      <>
        {repoInfo.error !== null && (
          <NetworkError
            message={hostingMessage(repoInfo.error, base.provider)}
            onDismiss={repoInfo.refetch}
          />
        )}
        <CreatePrForm
          base={base}
          seed={seed}
          plan={create.plan}
          pending={pending}
          error={error}
          titleRef={titleRef}
          onSubmit={async (input) => {
            if ((await create.submit(input)) !== null) onClose();
          }}
          onDismissError={create.clearError}
          onCancel={onClose}
        />
      </>
    );
  }

  return (
    <>
      <div className={styles.backdrop}>
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className={styles.dialog}
          tabIndex={-1}
          inert={create.prompt !== null}
          onKeyDown={onKeyDown}
        >
          <h2 id={titleId} className={styles.title}>
            Create pull request
          </h2>
          {body}
        </div>
      </div>
      {/* Last, so the sign-in for the push paints above the box. */}
      <CredentialDialog prompt={create.prompt} fallbackFocus={dialogRef} />
    </>
  );
}

interface CreatePrFormProps {
  base: Base;
  seed: Seed;
  plan: PrPushPlan;
  pending: boolean;
  error: AppError | null;
  titleRef: RefObject<HTMLInputElement | null>;
  onSubmit(input: CreatePrInput): Promise<void>;
  onDismissError(): void;
  onCancel(): void;
}

/** The fields, started from the seed; typed text is never overwritten. */
function CreatePrForm({
  base,
  seed,
  plan,
  pending,
  error,
  titleRef,
  onSubmit,
  onDismissError,
  onCancel,
}: CreatePrFormProps) {
  const sourceId = useId();
  const targetId = useId();
  const titleFieldId = useId();
  const bodyId = useId();
  const [title, setTitle] = useState(seed.title);
  const [body, setBody] = useState(seed.body);
  const [target, setTarget] = useState(base.target);
  const [pushFirst, setPushFirst] = useState(true);

  // A disabled submit button blocks implicit submission, so a blank or pending form never gets here.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void onSubmit({ title, body, target, pushFirst });
  };

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.field}>
        <label htmlFor={sourceId}>Source</label>
        <input id={sourceId} type="text" value={base.local} readOnly />
      </div>
      <div className={styles.field}>
        <label htmlFor={targetId}>Target</label>
        <select
          id={targetId}
          value={target}
          disabled={pending}
          onChange={(e) => setTarget(e.target.value)}
        >
          {base.targets.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor={titleFieldId}>Title</label>
        <input
          ref={titleRef}
          id={titleFieldId}
          type="text"
          value={title}
          disabled={pending}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className={styles.field}>
        <label htmlFor={bodyId}>Description</label>
        <textarea
          id={bodyId}
          className={styles.body}
          value={body}
          disabled={pending}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      {plan.kind === "publish" && <p className={styles.note}>{PUBLISH_FIRST_TEXT}</p>}
      {plan.kind === "push" && (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={pushFirst}
            disabled={pending}
            onChange={(e) => setPushFirst(e.target.checked)}
          />
          {pushFirstLabel(plan.ahead)}
        </label>
      )}
      {error !== null && (
        <NetworkError message={hostingMessage(error, base.provider)} onDismiss={onDismissError} />
      )}
      <div className={styles.actions}>
        <button type="button" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" disabled={pending || title.trim() === ""}>
          {pending ? "Creating…" : "Create pull request"}
        </button>
      </div>
    </form>
  );
}
