import { useEffect } from "react";
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

/** One toast; its timer lives and dies with it, so a dismiss or unmount clears it. */
function ToastItem({ toast }: { toast: Toast }) {
  const { id, text, action } = toast;
  useEffect(() => {
    const timer = setTimeout(() => useToasts.getState().dismiss(id), TOAST_MS);
    return () => clearTimeout(timer);
  }, [id]);

  const dismiss = () => useToasts.getState().dismiss(id);

  return (
    <div className={styles.toast}>
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
