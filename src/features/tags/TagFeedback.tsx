import { NetworkError } from "../remotes/NetworkError";
import { networkMessage } from "../remotes/networkMessage";
import { RepoError } from "../repo/RepoError";
import styles from "./TagFeedback.module.css";
import { displayError, statusText } from "./tagCopy";
import type { UseTagActions } from "./useTagActions";

export interface TagFeedbackProps {
  actions: UseTagActions;
}

/** The last push status and the last tag action's error, each dismissable. */
export function TagFeedback({ actions }: TagFeedbackProps) {
  return (
    <>
      {actions.status && (
        <div role="status" className={styles.notice}>
          <p className={styles.text}>{statusText(actions.status)}</p>
          <button type="button" onClick={actions.clearStatus}>
            Dismiss
          </button>
        </div>
      )}
      {/* A push or remote delete failure explains itself; anything else shows its message. */}
      {actions.error &&
        (actions.error.kind === "networkFailed" ? (
          <NetworkError message={networkMessage(actions.error)} onDismiss={actions.clearError} />
        ) : (
          <RepoError
            error={displayError(actions.error, actions.lastName)}
            path={null}
            variant="panel"
            onDismiss={actions.clearError}
          />
        ))}
    </>
  );
}
