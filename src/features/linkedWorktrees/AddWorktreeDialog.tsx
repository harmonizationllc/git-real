import { useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent, RefObject } from "react";
import { flushSync } from "react-dom";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import { pickFolder } from "../../lib/ipc";
import type { AppError, AppErrorKind, LocalBranch, RepoId, WorktreeBranch } from "../../lib/ipc";
import { useBranches } from "../branches/useBranches";
import { RepoError } from "../repo/RepoError";
import styles from "./AddWorktreeDialog.module.css";
import { useLinkedWorktreeActions } from "./useLinkedWorktreeActions";
import { useLinkedWorktrees } from "./useLinkedWorktrees";
import { defaultWorktreePath, folderName, parentFolder } from "./worktreePath";

export interface AddWorktreeDialogProps {
  repoId: RepoId;
  open: boolean;
  /** Prefills the form: "existing" selects that branch; "new" fills the name and start. */
  initial?: WorktreeBranch;
  onClose(): void;
  /** Called after onClose with the new worktree's folder; the opener opens it as a tab. */
  onAdded(path: string): void;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

const PICKER_TITLE = "Choose worktree folder";

export function AddWorktreeDialog(props: AddWorktreeDialogProps) {
  // Mounting the body per open starts every open from `initial` with no error.
  return props.open ? <AddWorktreeDialogBody {...props} /> : null;
}

/** Why a local branch cannot be picked, as an option suffix; null when it can. */
function lockSuffix(b: LocalBranch): string | null {
  if (b.isHead) return " (current)";
  if (b.worktree !== null) return ` (checked out in ${folderName(b.worktree)})`;
  return null;
}

function AddWorktreeDialogBody({
  repoId,
  initial,
  onClose,
  onAdded,
  fallbackFocus,
}: AddWorktreeDialogProps) {
  // Its own instance, so an add error stays in the dialog and never reaches the opener's panel.
  const actions = useLinkedWorktreeActions(repoId);
  const { pending } = actions;
  const { branches } = useBranches(repoId);
  const { list } = useLinkedWorktrees(repoId);
  const titleId = useId();
  const groupName = useId();
  const startName = useId();
  const branchId = useId();
  const nameId = useId();
  const commitId = useId();
  const folderId = useId();
  const [mode, setMode] = useState<WorktreeBranch["kind"]>(initial?.kind ?? "new");
  const [existing, setExisting] = useState(initial?.kind === "existing" ? initial.name : "");
  const [name, setName] = useState(initial?.kind === "new" ? initial.name : "");
  const initialStart = initial?.kind === "new" ? initial.start : null;
  const [startMode, setStartMode] = useState<"head" | "commit">(
    initialStart === null ? "head" : "commit",
  );
  const [start, setStart] = useState(initialStart ?? "");
  const [folder, setFolder] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLSelectElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const commitRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const local = branches?.local ?? [];
  const selected =
    existing !== "" ? existing : (local.find((b) => lockSuffix(b) === null)?.name ?? "");
  // A linked worktree of a bare or separate-git-dir repository has no main row.
  const base = list?.find((w) => w.isMain) ?? list?.find((w) => w.isCurrent);
  const branchName = mode === "new" ? name.trim() : selected;
  let shownFolder = folder;
  if (!folderTouched) shownFolder = base ? defaultWorktreePath(base.path, branchName) : "";
  const blank =
    branchName === "" ||
    shownFolder.trim() === "" ||
    (mode === "new" && startMode === "commit" && start.trim() === "");

  const fieldFor = (kind: AppErrorKind): RefObject<HTMLElement | null> => {
    if (kind === "pathExists") return folderRef;
    if (kind === "revisionNotFound") return commitRef;
    return mode === "new" ? nameRef : branchRef;
  };

  useRestoreFocus(fallbackFocus);
  // Focus the first field on open; useRestoreFocus returns focus on close.
  useLayoutEffect(() => {
    ((mode === "new" ? nameRef : branchRef).current as HTMLElement).focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on open only
  }, []);

  // Disabling the focused control drops focus to the body: hold it on the dialog while pending,
  // then hand it to the field the error concerns.
  useLayoutEffect(() => {
    if (pending) (dialogRef.current as HTMLDivElement).focus();
    else if (error !== null) (fieldFor(error.kind).current as HTMLElement).focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fieldFor reads the current mode
  }, [pending, error]);

  const onSubmit = async (e: FormEvent) => {
    // No pending guard: Add is disabled while blank or pending, so the form cannot submit.
    e.preventDefault();
    // A retry starts clean, so a success never refocuses a field for a stale error.
    setError(null);
    const branch: WorktreeBranch =
      mode === "new"
        ? { kind: "new", name: branchName, start: startMode === "commit" ? start.trim() : null }
        : { kind: "existing", name: branchName };
    const path = shownFolder.trim();
    const result = await actions.add(path, branch);
    if (result !== null) {
      setError(result);
      return;
    }
    onClose();
    onAdded(path);
  };

  const browse = async () => {
    const picked = await pickFolder(PICKER_TITLE, base ? parentFolder(base.path) : undefined);
    if (picked === null) return;
    setFolder(picked);
    setFolderTouched(true);
  };

  const pickCommit = () => {
    // Rendered synchronously so the new field can take focus at once.
    flushSync(() => setStartMode("commit"));
    (commitRef.current as HTMLInputElement).focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !pending) onClose();
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !pending) onClose();
  };

  // No focus trap yet, consistent with ConfirmDialog and PromptDialog.
  return (
    <div className={styles.backdrop} onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          Add worktree
        </h2>
        <form className={styles.form} onSubmit={(e) => void onSubmit(e)}>
          <div className={styles.choices}>
            <label className={styles.check}>
              <input
                type="radio"
                name={groupName}
                checked={mode === "existing"}
                disabled={pending}
                onChange={() => setMode("existing")}
              />
              Existing branch
            </label>
            <label className={styles.check}>
              <input
                type="radio"
                name={groupName}
                checked={mode === "new"}
                disabled={pending}
                onChange={() => setMode("new")}
              />
              New branch
            </label>
          </div>
          {mode === "existing" ? (
            <div className={styles.field}>
              <label htmlFor={branchId}>Branch</label>
              <select
                ref={branchRef}
                id={branchId}
                value={selected}
                disabled={pending}
                onChange={(e) => setExisting(e.target.value)}
              >
                {local.map((b) => {
                  const suffix = lockSuffix(b);
                  return (
                    <option key={b.name} value={b.name} disabled={suffix !== null}>
                      {`${b.name}${suffix ?? ""}`}
                    </option>
                  );
                })}
              </select>
            </div>
          ) : (
            <>
              <div className={styles.field}>
                <label htmlFor={nameId}>Name</label>
                <input
                  ref={nameRef}
                  id={nameId}
                  type="text"
                  value={name}
                  disabled={pending}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className={styles.choices}>
                <label className={styles.check}>
                  <input
                    type="radio"
                    name={startName}
                    checked={startMode === "head"}
                    disabled={pending}
                    onChange={() => setStartMode("head")}
                  />
                  Current HEAD
                </label>
                <label className={styles.check}>
                  <input
                    type="radio"
                    name={startName}
                    checked={startMode === "commit"}
                    disabled={pending}
                    onChange={pickCommit}
                  />
                  Commit
                </label>
              </div>
              {startMode === "commit" && (
                <div className={styles.field}>
                  <label htmlFor={commitId}>Commit</label>
                  <input
                    ref={commitRef}
                    id={commitId}
                    type="text"
                    value={start}
                    disabled={pending}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setStart(e.target.value)}
                  />
                </div>
              )}
            </>
          )}
          <div className={styles.field}>
            <label htmlFor={folderId}>Folder</label>
            <div className={styles.folder}>
              <input
                ref={folderRef}
                id={folderId}
                type="text"
                value={shownFolder}
                disabled={pending}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setFolder(e.target.value);
                  setFolderTouched(true);
                }}
              />
              <button type="button" disabled={pending} onClick={() => void browse()}>
                Browse…
              </button>
            </div>
          </div>
          {error && (
            <RepoError error={error} path={null} variant="panel" onDismiss={() => setError(null)} />
          )}
          <div className={styles.actions}>
            <button type="button" disabled={pending} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={blank || pending}>
              {pending ? "Working…" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
