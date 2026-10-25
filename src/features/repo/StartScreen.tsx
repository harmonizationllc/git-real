import { useId, useState } from "react";
import { pickFolder } from "../../lib/ipc";
import { AccountsDialog } from "../hosting/AccountsDialog";
import { RecentList } from "./RecentList";
import { RepoError } from "./RepoError";
import styles from "./StartScreen.module.css";
import type { UseOpenRepo } from "./useOpenRepo";
import { useRecentRepos } from "./useRecentRepos";

export function StartScreen({ opener, onClone }: { opener: UseOpenRepo; onClone(): void }) {
  const headingId = useId();
  const { recents, isLoading, remove } = useRecentRepos();
  const { open, init, error, errorPath, clearError } = opener;
  const [accountsOpen, setAccountsOpen] = useState(false);

  const pickThen = async (title: string, action: (path: string) => Promise<boolean>) => {
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
        <button type="button" onClick={() => setAccountsOpen(true)}>
          Hosting accounts…
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
      <AccountsDialog open={accountsOpen} onClose={() => setAccountsOpen(false)} />
    </section>
  );
}
