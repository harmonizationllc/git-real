import { useId } from "react";
import { pickFolder } from "../../lib/ipc";
import { RecentList } from "./RecentList";
import { RepoError } from "./RepoError";
import styles from "./StartScreen.module.css";
import { useOpenRepo } from "./useOpenRepo";
import { useRecentRepos } from "./useRecentRepos";

export function StartScreen({ onClone }: { onClone(): void }) {
  const headingId = useId();
  const { recents, isLoading, remove } = useRecentRepos();
  const { open, init, error, errorPath, clearError } = useOpenRepo();

  const pickThen = async (title: string, action: (path: string) => Promise<void>) => {
    const path = await pickFolder(title);
    if (path !== null) await action(path);
  };

  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <h1 id={headingId} className={styles.title}>
        Git Real
      </h1>
      <div className={styles.actions}>
        <button type="button" onClick={() => pickThen("Open repository", open)}>
          Open repository
        </button>
        <button type="button" onClick={onClone}>
          Clone repository
        </button>
        <button type="button" onClick={() => pickThen("Initialize repository", init)}>
          Initialize repository
        </button>
      </div>
      {error !== null && (
        <RepoError error={error} path={errorPath} onInitHere={init} onDismiss={clearError} />
      )}
      <h2 className={styles.subtitle}>Recent repositories</h2>
      {isLoading ? null : recents.length === 0 ? (
        <p className={styles.empty}>No recent repositories</p>
      ) : (
        <RecentList recents={recents} onOpen={open} onRemove={remove} />
      )}
    </section>
  );
}
