import { useId } from "react";
import { CommitBox } from "../features/commit/CommitBox";
import { DetailPane } from "../features/diff/DetailPane";
import { ChangesPanel } from "../features/worktree/ChangesPanel";
import type { RepoTab } from "../lib/store/repoTabs";
import styles from "./RepoPane.module.css";

export function RepoPane({ tab }: { tab: RepoTab }): React.JSX.Element {
  const headingId = useId();
  const { name, path, headBranch } = tab.summary;
  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <header className={styles.header}>
        <h1 id={headingId} className={styles.name}>
          {name}
        </h1>
        <p className={styles.path}>{path}</p>
        <p className={styles.branch}>{headBranch ?? "detached HEAD"}</p>
      </header>
      <div className={styles.body}>
        {/* Keyed so selection, menu, dialog, draft and mutation state never leak across tabs. */}
        <div key={tab.id} className={styles.sidebar}>
          <ChangesPanel repoId={tab.id} />
          <CommitBox repoId={tab.id} />
        </div>
        <section aria-label="Detail" className={styles.detail}>
          <DetailPane key={tab.id} repoId={tab.id} />
        </section>
      </div>
    </section>
  );
}
