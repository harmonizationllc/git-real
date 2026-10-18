import { useEffect, useId, useRef, useState } from "react";
import { SPLIT_HANDLE_WIDTH, SplitHandle } from "../components/SplitHandle";
import { BranchesPanel } from "../features/branches/BranchesPanel";
import { useBranches } from "../features/branches/useBranches";
import { CommitBox } from "../features/commit/CommitBox";
import { DetailPane } from "../features/diff/DetailPane";
import { ChangesPanel } from "../features/worktree/ChangesPanel";
import type { HeadState } from "../lib/ipc";
import { useRepoChanged } from "../lib/query/useRepoChanged";
import { useLayoutPrefs } from "../lib/store/layoutPrefs";
import type { RepoTab } from "../lib/store/repoTabs";
import { KEY_STEP, REFS_MIN, SIDEBAR_MIN, clampWidths, maxWidth } from "./layout";
import styles from "./RepoPane.module.css";

/** The header's branch line: the live HEAD once the branch list is known, else the snapshot. */
function headLine(head: HeadState | undefined, fallback: string | null): string {
  if (head === undefined) return fallback ?? "detached HEAD";
  switch (head.kind) {
    case "branch":
      return head.name;
    case "detached":
      return `detached at ${head.oid.slice(0, 7)}`;
    case "unborn":
      return `${head.name} (no commits yet)`;
  }
}

export function RepoPane({ tab }: { tab: RepoTab }): React.JSX.Element {
  // The single repo-changed subscription for this tab; it refreshes every query of the repo.
  useRepoChanged(tab.id);
  const headingId = useId();
  const { name, path, headBranch } = tab.summary;
  const { branches } = useBranches(tab.id);
  const refsWidth = useLayoutPrefs((s) => s.refsWidth);
  const sidebarWidth = useLayoutPrefs((s) => s.sidebarWidth);
  const setRefsWidth = useLayoutPrefs((s) => s.setRefsWidth);
  const setSidebarWidth = useLayoutPrefs((s) => s.setSidebarWidth);
  const resetWidth = useLayoutPrefs((s) => s.reset);

  // Measured body width; 0 until the first observation, which leaves the stored widths unclamped.
  const [container, setContainer] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ro = new ResizeObserver(([entry]) => setContainer(entry.contentRect.width));
    ro.observe(bodyRef.current as HTMLDivElement);
    return () => ro.disconnect();
  }, []);

  // The two handle tracks take their share of the body before the columns are fitted.
  const available = Math.max(0, container - 2 * SPLIT_HANDLE_WIDTH);
  const { refs, sidebar } = clampWidths(available, refsWidth, sidebarWidth);

  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <header className={styles.header}>
        <h1 id={headingId} className={styles.name}>
          {name}
        </h1>
        <p className={styles.path}>{path}</p>
        <p className={styles.branch}>{headLine(branches?.head, headBranch)}</p>
      </header>
      <div
        ref={bodyRef}
        className={styles.body}
        style={{ gridTemplateColumns: `${refs}px auto ${sidebar}px auto 1fr` }}
      >
        {/* Keyed so filter, menu, dialog and mutation state never leak across tabs. */}
        <div key={`refs-${tab.id}`} className={styles.refs}>
          <BranchesPanel repoId={tab.id} />
        </div>
        <SplitHandle
          label="Resize branches column"
          value={refs}
          min={REFS_MIN}
          max={maxWidth(available, "refs", sidebar)}
          step={KEY_STEP}
          onChange={setRefsWidth}
          onReset={() => resetWidth("refs")}
        />
        {/* Keyed so selection, menu, dialog, draft and mutation state never leak across tabs. */}
        <div key={tab.id} className={styles.sidebar}>
          <ChangesPanel repoId={tab.id} />
          <CommitBox repoId={tab.id} />
        </div>
        <SplitHandle
          label="Resize changes column"
          value={sidebar}
          min={SIDEBAR_MIN}
          max={maxWidth(available, "sidebar", refs)}
          step={KEY_STEP}
          onChange={setSidebarWidth}
          onReset={() => resetWidth("sidebar")}
        />
        <section aria-label="Detail" className={styles.detail}>
          <DetailPane key={tab.id} repoId={tab.id} />
        </section>
      </div>
    </section>
  );
}
