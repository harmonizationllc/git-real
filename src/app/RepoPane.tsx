import { useId } from "react";
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
    </section>
  );
}
