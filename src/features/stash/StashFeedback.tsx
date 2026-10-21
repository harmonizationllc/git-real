import { RepoError } from "../repo/RepoError";
import styles from "./StashFeedback.module.css";
import { displayError, noticeText } from "./stashCopy";
import type { UseStashActions } from "./useStashActions";

export interface StashFeedbackProps {
  actions: UseStashActions;
}

/** The conflict notice and the error of the last stash action, each dismissable. */
export function StashFeedback({ actions }: StashFeedbackProps) {
  return (
    <>
      {actions.notice && (
        <div role="status" className={styles.notice}>
          <p className={styles.text}>{noticeText(actions.notice)}</p>
          <button type="button" onClick={actions.clearNotice}>
            Dismiss
          </button>
        </div>
      )}
      {actions.error && (
        <RepoError
          error={displayError(actions.error)}
          path={null}
          variant="panel"
          onDismiss={actions.clearError}
        />
      )}
    </>
  );
}
