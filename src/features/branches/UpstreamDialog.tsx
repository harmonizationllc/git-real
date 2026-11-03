import { useId, useLayoutEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, MouseEvent, RefObject } from "react";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import type { AppError } from "../../lib/ipc";
import styles from "./UpstreamDialog.module.css";

export interface UpstreamDialogProps {
  /** The local branch being edited. */
  branch: string;
  /** Its current upstream short name (`origin/main`), or null. */
  current: string | null;
  /** Remote-tracking short names to offer, in display order. */
  candidates: string[];
  error: AppError | null;
  pending: boolean;
  /** null clears the upstream. */
  onConfirm(upstream: string | null): void;
  onCancel(): void;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

/** Changes or clears the upstream of an existing local branch. */
export function UpstreamDialog({
  branch,
  current,
  candidates,
  error,
  pending,
  onConfirm,
  onCancel,
  fallbackFocus,
}: UpstreamDialogProps) {
  const titleId = useId();
  const selectId = useId();
  const errorId = useId();
  const [selected, setSelected] = useState(current ?? "");
  const selectRef = useRef<HTMLSelectElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useRestoreFocus(fallbackFocus);
  useLayoutEffect(() => {
    (selectRef.current as HTMLSelectElement).focus();
  }, []);

  // Disabling the focused control drops focus to the body: hold it on the dialog while pending,
  // then hand it back to the select when the save failed.
  useLayoutEffect(() => {
    if (pending) (dialogRef.current as HTMLDivElement).focus();
    else if (error !== null) (selectRef.current as HTMLSelectElement).focus();
  }, [pending, error]);

  // The current upstream and the selection stay selectable even when no longer a candidate
  // (gone remote branch, or one pruned after a failed save), so the select shows what Save sends.
  const options = [...candidates];
  for (const keep of [current, selected]) {
    if (keep !== null && keep !== "" && !options.includes(keep)) options.push(keep);
  }
  const unchanged = selected === (current ?? "");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pending || unchanged) return;
    onConfirm(selected === "" ? null : selected);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !pending) onCancel();
  };

  const onBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && !pending) onCancel();
  };

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
          Upstream for {branch}
        </h2>
        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.field}>
            <label htmlFor={selectId}>Upstream</label>
            <select
              ref={selectRef}
              id={selectId}
              className={styles.select}
              value={selected}
              disabled={pending}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">None</option>
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p id={errorId} role="alert" className={styles.error}>
              {error.message}
            </p>
          )}
          <div className={styles.actions}>
            <button data-variant="neutral" type="button" disabled={pending} onClick={onCancel}>
              Cancel
            </button>
            <button data-variant="primary" type="submit" disabled={pending || unchanged}>
              {pending ? "Working…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
