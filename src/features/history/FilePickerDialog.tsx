import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { RepoId } from "../../lib/ipc";
import { RepoError } from "../repo/RepoError";
import { MAX_PICKER_ROWS, rankFiles } from "../../lib/fuzzy";
import { useTrackedFiles } from "./useTrackedFiles";
import styles from "./FilePickerDialog.module.css";

export interface FilePickerDialogProps {
  repoId: RepoId;
  open: boolean;
  onPick(path: string): void;
  onCancel(): void;
}

const NO_FILES: string[] = [];
/** How far each navigation key moves the active option; Enter (0) picks it. */
const STEPS: Partial<Record<string, number>> = { ArrowDown: 1, ArrowUp: -1, Enter: 0 };

export function FilePickerDialog(props: FilePickerDialogProps) {
  // Mounting the body per open resets the query and the active option every time.
  return props.open ? <FilePickerBody {...props} /> : null;
}

/** A fuzzy finder over the tracked files; the search input keeps focus and drives the listbox. */
function FilePickerBody({ repoId, onPick, onCancel }: FilePickerDialogProps) {
  const titleId = useId();
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const { files, error, refetch } = useTrackedFiles(repoId, true);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(
    () => rankFiles(query.trim(), files ?? NO_FILES, MAX_PICKER_ROWS),
    [query, files],
  );

  // Focus the input on open and restore focus on close, in one layout effect so it is
  // StrictMode-safe and the restore runs before another dialog's autoFocus.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement;
    (inputRef.current as HTMLInputElement).focus();
    return () => previous.focus();
  }, []);

  // A refetch can shrink the list under the active row, so every use reads the clamped index.
  const current = Math.min(active, results.length - 1);

  const move = (index: number) => {
    setActive(index);
    (document.getElementById(optionId(index)) as HTMLElement).scrollIntoView({ block: "nearest" });
  };

  const onDialogKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
  };

  // On the input only, so Enter on Retry or Dismiss still clicks the button.
  const onInputKeyDown = (e: KeyboardEvent) => {
    const step = STEPS[e.key];
    if (step === undefined) return;
    // The input would otherwise move its caret, and there is no form to submit.
    e.preventDefault();
    if (results.length === 0) return;
    if (step === 0) onPick(results[current]);
    // The ends clamp rather than wrap.
    else move(Math.min(Math.max(current + step, 0), results.length - 1));
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) onCancel();
  };

  let body: React.ReactNode;
  if (error !== null) {
    body = <RepoError error={error} path={null} onRetry={refetch} onDismiss={onCancel} />;
  } else if (files === undefined) {
    body = <p role="status">Loading files…</p>;
  } else if (results.length === 0) {
    body = <p className={styles.empty}>No matching files</p>;
  }

  // No focus trap yet, consistent with the other dialogs; a shared DialogShell is a follow-up.
  return (
    <div className={styles.backdrop} onClick={onBackdropClick}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
        onKeyDown={onDialogKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          File history
        </h2>
        <input
          ref={inputRef}
          type="search"
          aria-label="Find file"
          placeholder="Type a file name"
          aria-controls={listId}
          aria-activedescendant={results.length > 0 ? optionId(current) : undefined}
          value={query}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={onInputKeyDown}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        {body}
        <ul id={listId} role="listbox" aria-label="Files" className={styles.list}>
          {results.map((path, index) => (
            <li
              key={path}
              id={optionId(index)}
              role="option"
              aria-selected={index === current}
              className={styles.option}
              onClick={() => onPick(path)}
            >
              {path}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
