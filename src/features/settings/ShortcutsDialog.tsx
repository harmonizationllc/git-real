import { useId, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { useRestoreFocus } from "../../components/useRestoreFocus";
import { ShortcutSettings } from "./ShortcutSettings";
import styles from "./ShortcutsDialog.module.css";

export interface ShortcutsDialogProps {
  onClose(): void;
  fallbackFocus: RefObject<HTMLElement | null>;
}

/** The Keyboard shortcuts dialog: the reference of every shortcut and where they are changed. */
export function ShortcutsDialog({ onClose, fallbackFocus }: ShortcutsDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useRestoreFocus(fallbackFocus);
  useLayoutEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    onClose();
  };

  return (
    <div className={styles.backdrop} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.dialog}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className={styles.title}>
          Keyboard shortcuts
        </h2>
        <ShortcutSettings />
        <div className={styles.actions}>
          <button data-variant="neutral" type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
