import type { DiffScope, HunkAction } from "../../lib/ipc";
import { isReadOnly, type CommitScope } from "./model/scope";
import styles from "./HunkHeader.module.css";

interface Props {
  header: string;
  scope: DiffScope;
  selectedCount: number;
  disabledReason?: string;
  /** Disables only the whole-hunk form of each button; selected-line actions stay enabled. */
  wholeHunkDisabledReason?: string;
  /** Absent for a read-only viewer, and ignored for a commit scope: no buttons are rendered. */
  onAction?(action: HunkAction): void;
}

/** "Stage hunk" with nothing selected, otherwise "Stage 1 line" / "Stage 3 lines". */
function label(verb: string, n: number, ellipsis = ""): string {
  if (n === 0) return `${verb} hunk${ellipsis}`;
  return `${verb} ${n} ${n === 1 ? "line" : "lines"}${ellipsis}`;
}

export function HunkHeader({
  header,
  scope,
  selectedCount,
  disabledReason,
  wholeHunkDisabledReason,
  onAction,
}: Props) {
  // A global reason wins; the whole-hunk reason applies only while no lines are selected.
  const reason = disabledReason ?? (selectedCount === 0 ? wholeHunkDisabledReason : undefined);
  return (
    <div className={styles.root} data-kind="header">
      <code className={styles.text}>{header}</code>
      {onAction && !isReadOnly(scope) && (
        <Actions
          scope={scope}
          selectedCount={selectedCount}
          disabledReason={reason}
          onAction={onAction}
        />
      )}
    </div>
  );
}

function Actions({
  scope,
  selectedCount,
  disabledReason,
  onAction,
}: {
  scope: Exclude<DiffScope, CommitScope>;
  selectedCount: number;
  disabledReason?: string;
  onAction(action: HunkAction): void;
}) {
  const button = (action: HunkAction, text: string, danger = false) => (
    <button
      type="button"
      className={danger ? styles.danger : styles.action}
      disabled={disabledReason !== undefined}
      title={disabledReason}
      onClick={() => onAction(action)}
    >
      {text}
    </button>
  );
  return (
    <div className={styles.actions}>
      {scope === "unstaged" ? (
        <>
          {button("stage", label("Stage", selectedCount))}
          {button("discard", label("Discard", selectedCount, "…"), true)}
        </>
      ) : (
        button("unstage", label("Unstage", selectedCount))
      )}
    </div>
  );
}
