import type { MessageAction, NetworkMessage } from "./networkMessage";
import styles from "./NetworkError.module.css";

export interface NetworkErrorProps {
  message: NetworkMessage;
  onAction?(kind: MessageAction): void;
  onDismiss(): void;
}

/** A failed network or sync action: what happened, what to try, and git's own output. */
export function NetworkError({ message, onAction, onDismiss }: NetworkErrorProps) {
  const { title, hint, action, details } = message;
  return (
    <div role="alert" className={styles.root}>
      <p className={styles.title}>{title}</p>
      {hint !== null && <p className={styles.hint}>{hint}</p>}
      {details !== null && (
        <details className={styles.details}>
          <summary>Details</summary>
          <pre className={styles.output}>{details}</pre>
        </details>
      )}
      <div className={styles.actions}>
        {action !== null && onAction && (
          <button type="button" onClick={() => onAction(action.kind)}>
            {action.label}
          </button>
        )}
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
