import { useEffect, useId, useState } from "react";
import { useToasts } from "../lib/store/toasts";
import { DetailsDialog } from "./DetailsDialog";
import type { Toast } from "../lib/store/toasts";
import styles from "./Toasts.module.css";

/** How long a toast stays up unless it is dismissed first. */
export const TOAST_MS = 8000;

/** How long an error toast stays up: longer, since there is more to read. */
export const ERROR_TOAST_MS = 12_000;

/** The app's toasts, newest last, in a live region that is always mounted so it is announced. */
export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div role="status" aria-live="polite" className={styles.root}>
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

/** The glyph that marks each variant, in a toast and in the Messages dialog. */
export const VARIANT_ICON: Record<Toast["variant"], string> = {
  info: "i",
  success: "✓",
  error: "!",
};

/**
 * One toast; its timer lives and dies with it, so a dismiss or unmount clears it. The timer is
 * held while the toast is hovered, focused, or its Details dialog is open, and a full TOAST_MS
 * (ERROR_TOAST_MS for an error) restarts once none of those holds.
 */
function ToastItem({ toast }: { toast: Toast }) {
  const { id, text, action, variant, sticky, details } = toast;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const textId = useId();
  const held = hovered || focused || detailsOpen;
  useEffect(() => {
    // A sticky toast stays until it is dismissed by hand.
    if (held || sticky) return;
    const ms = variant === "error" ? ERROR_TOAST_MS : TOAST_MS;
    const timer = setTimeout(() => useToasts.getState().dismiss(id), ms);
    return () => clearTimeout(timer);
  }, [id, held, sticky, variant]);

  const dismiss = () => useToasts.getState().dismiss(id);

  return (
    <>
      <div
        className={styles.toast}
        data-variant={variant}
        role={variant === "error" ? "alert" : undefined}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
        }}
      >
        <span className={styles.icon} aria-hidden="true">
          {VARIANT_ICON[variant]}
        </span>
        <p id={textId} className={styles.text}>
          {text}
        </p>
        {details !== null && (
          <button
            type="button"
            data-variant="ghost"
            data-size="sm"
            aria-describedby={textId}
            onClick={() => setDetailsOpen(true)}
          >
            Details
          </button>
        )}
        {action !== null && (
          <button
            type="button"
            data-variant="ghost"
            data-size="sm"
            onClick={() => {
              action.run();
              dismiss();
            }}
          >
            {action.label}
          </button>
        )}
        <button
          type="button"
          data-variant="icon"
          data-size="sm"
          aria-label="Dismiss notification"
          onClick={dismiss}
        >
          ×
        </button>
      </div>
      {details !== null && (
        <DetailsDialog
          open={detailsOpen}
          title={text}
          details={details}
          onClose={() => setDetailsOpen(false)}
        />
      )}
    </>
  );
}
