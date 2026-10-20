import { useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";
import { useRestoreFocus } from "../../../components/useRestoreFocus";
import type { AppError, RebaseCommit, RepoId } from "../../../lib/ipc";
import { RepoError } from "../../repo/RepoError";
import type { UseIntegrationActions } from "../useIntegrationActions";
import styles from "./RebaseDialog.module.css";
import { RebaseStepRow } from "./RebaseStepRow";
import {
  canStart,
  foldBlocked,
  initialPlan,
  move,
  setAction,
  summary,
  summaryText,
  toSteps,
} from "./model/plan";
import { useRebasePlan } from "./useRebasePlan";

export interface RebaseDialogProps {
  repoId: RepoId;
  /** What git is given: a full oid or a branch name. */
  base: string;
  /** What the title and messages show for `base`. */
  label: string;
  /** The current branch name. */
  head: string;
  run: UseIntegrationActions["run"];
  pending: boolean;
  onClose(): void;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

function planMessage(error: AppError, head: string, label: string): string {
  if (error.kind === "badSelection") return `${head} and ${label} share no history.`;
  if (error.kind === "mergeCommit") {
    return "The range contains a merge commit, which cannot be rebased interactively yet.";
  }
  return error.message;
}

/** The interactive rebase plan; rendered only while open, so its state starts fresh each time. */
export function RebaseDialog({
  repoId,
  base,
  label,
  head,
  run,
  pending,
  onClose,
  fallbackFocus,
}: RebaseDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const { commits, error, loading } = useRebasePlan(repoId, base);

  useRestoreFocus(fallbackFocus);
  // Focus the dialog box itself, which outlives every body state, so Escape keeps working when
  // the plan replaces the loading status; useRestoreFocus returns focus on close.
  useLayoutEffect(() => {
    (dialogRef.current as HTMLDivElement).focus();
  }, []);
  // Start disables the focused button, which drops focus to the body: hold it on the dialog while
  // pending. Alerts never take focus, so a failed run leaves it here too.
  useLayoutEffect(() => {
    if (pending) (dialogRef.current as HTMLDivElement).focus();
  }, [pending]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !pending) onClose();
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !pending) onClose();
  };

  const cancelOnly = (
    <div className={styles.actions}>
      <button type="button" disabled={pending} onClick={onClose}>
        Cancel
      </button>
    </div>
  );

  let body: ReactNode;
  if (loading) {
    body = (
      <>
        <p role="status">Loading commits…</p>
        {cancelOnly}
      </>
    );
  } else if (error !== null) {
    body = (
      <>
        <p role="alert" className={styles.message}>
          {planMessage(error, head, label)}
        </p>
        {cancelOnly}
      </>
    );
  } else {
    // A settled query without an error has data.
    const list = commits as RebaseCommit[];
    body =
      list.length === 0 ? (
        <>
          <p className={styles.message}>
            {`Nothing to rebase: ${head} has no commits after ${label}.`}
          </p>
          {cancelOnly}
        </>
      ) : (
        // Keyed by the commit list, so a refetch that changes it resets the plan.
        <Plan
          key={list.map((c) => c.oid).join()}
          commits={list}
          base={base}
          run={run}
          pending={pending}
          onClose={onClose}
        />
      );
  }

  // No focus trap yet, consistent with the other dialogs; tracked as a GR-3 follow-up.
  return (
    <div className={styles.backdrop} onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={styles.dialog}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          {`Rebase ${head} onto ${label} interactively`}
        </h2>
        {body}
      </div>
    </div>
  );
}

interface PlanProps {
  commits: RebaseCommit[];
  base: string;
  run: UseIntegrationActions["run"];
  pending: boolean;
  onClose(): void;
}

interface DragState {
  from: number;
  over: number | null;
}

/** The editable plan for one commit list, with its own Cancel and Start buttons. */
function Plan({ commits, base, run, pending, onClose }: PlanProps) {
  const [steps, setSteps] = useState(() => initialPlan(commits));
  const [drag, setDrag] = useState<DragState | null>(null);
  const [runError, setRunError] = useState<AppError | null>(null);

  const start = async () => {
    const err = await run({ action: "rebaseInteractive", base, steps: toSteps(steps) });
    if (err === null) onClose();
    else setRunError(err);
  };

  return (
    <>
      <ol aria-label="Commits to rebase" className={styles.list} onDragEnd={() => setDrag(null)}>
        {steps.map((step, i) => (
          // Keyed by oid, so a move keeps the row's DOM node and focus follows the commit.
          <RebaseStepRow
            key={step.oid}
            step={step}
            index={i}
            count={steps.length}
            blocked={foldBlocked(steps, i)}
            disabled={pending}
            dragging={drag?.from === i}
            dropTarget={drag?.over === i}
            onAction={(action) => setSteps(setAction(steps, i, action))}
            onMove={(to) => setSteps(move(steps, i, to))}
            onDragStart={() => setDrag({ from: i, over: null })}
            onDragOver={() => {
              if (drag) setDrag({ ...drag, over: i });
            }}
            onDrop={() => {
              if (drag) setSteps(move(steps, drag.from, i));
              setDrag(null);
            }}
          />
        ))}
      </ol>
      <p className={styles.summary}>{summaryText(summary(steps))}</p>
      {runError && <RepoError error={runError} path={null} onDismiss={() => setRunError(null)} />}
      <div className={styles.actions}>
        <button type="button" disabled={pending} onClick={onClose}>
          Cancel
        </button>
        <button type="button" disabled={pending || !canStart(steps)} onClick={() => void start()}>
          {pending ? "Working…" : "Start rebase"}
        </button>
      </div>
    </>
  );
}
