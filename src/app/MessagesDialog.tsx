import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { DetailsDialog } from "../components/DetailsDialog";
import { VARIANT_ICON } from "../components/Toasts";
import { useRestoreFocus } from "../components/useRestoreFocus";
import { useMessages } from "../lib/store/messages";
import type { Message } from "../lib/store/messages";
import styles from "./MessagesDialog.module.css";

export interface MessagesDialogProps {
  onClose(): void;
  fallbackFocus: RefObject<HTMLElement | null>;
}

const formatTime = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The Messages dialog: every notice raised this session, newest first. */
export function MessagesDialog({ onClose, fallbackFocus }: MessagesDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const messages = useMessages((s) => s.messages);
  const [selected, setSelected] = useState<Message | null>(null);

  useRestoreFocus(fallbackFocus);
  useLayoutEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  // Opening the dialog is reading it, and an error that lands while it is open is read at once.
  useEffect(() => {
    useMessages.getState().markRead();
  }, [messages]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // The Details dialog is portaled but its keys still bubble here; its Escape is its own.
    if (selected !== null) return;
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
          Messages
        </h2>
        {messages.length === 0 ? (
          <p className={styles.empty}>No messages this session</p>
        ) : (
          <ul className={styles.list}>
            {messages.map((m) => (
              <li key={m.id} className={styles.item} data-variant={m.variant}>
                <span className={styles.icon} aria-hidden="true">
                  {VARIANT_ICON[m.variant]}
                </span>
                <span className={styles.text}>{m.text}</span>
                <span className={styles.time}>{formatTime(m.at)}</span>
                {m.details !== null && (
                  <button
                    type="button"
                    data-variant="ghost"
                    data-size="sm"
                    onClick={() => setSelected(m)}
                  >
                    Details
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            data-variant="neutral"
            disabled={messages.length === 0}
            onClick={() => useMessages.getState().clear()}
          >
            Clear
          </button>
          <button type="button" data-variant="neutral" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <DetailsDialog
        open={selected !== null}
        title={selected?.text ?? ""}
        details={selected?.details ?? ""}
        onClose={() => setSelected(null)}
        fallbackFocus={dialogRef}
      />
    </div>
  );
}
