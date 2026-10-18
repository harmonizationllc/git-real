import type { AppError } from "../../lib/ipc";
import styles from "./RepoError.module.css";

export interface RepoErrorProps {
  error: AppError;
  path: string | null;
  onInitHere?: (path: string) => void;
  /** When given, a Retry button sits before Dismiss. */
  onRetry?(): void;
  onDismiss(): void;
}

export function RepoError({ error, path, onInitHere, onRetry, onDismiss }: RepoErrorProps) {
  const canInit = error.kind === "notARepository" && path !== null && onInitHere !== undefined;
  return (
    <div role="alert" className={styles.root}>
      <p className={styles.message}>{error.message}</p>
      <div className={styles.actions}>
        {canInit && (
          <button type="button" onClick={() => onInitHere(path)}>
            Initialize repository here
          </button>
        )}
        {onRetry && (
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        )}
        <button type="button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
