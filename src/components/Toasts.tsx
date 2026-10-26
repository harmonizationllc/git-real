import { useEffect, useState } from "react";
import { useToasts } from "../lib/store/toasts";
import type { Toast } from "../lib/store/toasts";
import styles from "./Toasts.module.css";

/** How long a toast stays up unless it is dismissed first. */
export const TOAST_MS = 8000;

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

/**
 * One toast; its timer lives and dies with it, so a dismiss or unmount clears it. The timer is
 * held while the toast is hovered or holds focus, and a full TOAST_MS restarts once neither holds.
 */
const VARIANT_ICON: Record<Toast["variant"], string> = {
  info: "i",
  success: "✓",
  error: "!",
};

function ToastItem({ toast }: { toast: Toast }) {
  const { id, text, action, variant, sticky } = toast;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  useEffect(() => {
    // A sticky toast stays until it is dismissed by hand.
    if (held || sticky) return;
    const timer = setTimeout(() => useToasts.getState().dismiss(id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [id, held, sticky]);

  const dismiss = () => useToasts.getState().dismiss(id);

  return (
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
      <p className={styles.text}>{text}</p>
      {action !== null && (
        <button
          type="button"
          onClick={() => {
            action.run();
            dismiss();
          }}
        >
          {action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss notification" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
