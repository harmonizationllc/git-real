import { useEffect, useId, useRef, useState } from "react";
import { SPLIT_HANDLE_WIDTH, SplitHandle } from "../components/SplitHandle";
import { BranchesPanel } from "../features/branches/BranchesPanel";
import { useBranches } from "../features/branches/useBranches";
import { CommitBox } from "../features/commit/CommitBox";
import { DetailPane } from "../features/diff/DetailPane";
import { GraphPanel } from "../features/graph/GraphPanel";
import { OperationBanner } from "../features/merge/OperationBanner";
import { CommitSummary } from "../features/history/CommitSummary";
import { FileHistoryPanel } from "../features/history/FileHistoryPanel";
import { FilePickerDialog } from "../features/history/FilePickerDialog";
import { StashSummary } from "../features/stash/StashSummary";
import { StashesPanel } from "../features/stash/StashesPanel";
import { ChangesPanel } from "../features/worktree/ChangesPanel";
import type { HeadState } from "../lib/ipc";
import { useRepoChanged } from "../lib/query/useRepoChanged";
import { useLayoutPrefs } from "../lib/store/layoutPrefs";
import type { RepoTab } from "../lib/store/repoTabs";
import { useWorkspace } from "../lib/store/workspace";
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
  const fileSelected = useWorkspace((s) => Boolean(s.selected[tab.id]));
  const selectedCommit = useWorkspace((s) => s.selectedCommit[tab.id] ?? null);
  const selectedStash = useWorkspace((s) => s.selectedStash[tab.id] ?? null);
  const historyPath = useWorkspace((s) => s.historyPath[tab.id] ?? null);
  const showHistory = useWorkspace((s) => s.showHistory);
  const [picker, setPicker] = useState(false);

  // Ctrl+Shift+H (Cmd+Shift+H) opens the file picker; never on top of another dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Shift reports "H", and Caps Lock can flip it, so compare in lower case.
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== "h") return;
      if (document.querySelector('[role="dialog"]') !== null) return;
      e.preventDefault();
      setPicker(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      {/* Keyed so the abort dialog and mutation state never leak across tabs. */}
      <OperationBanner key={tab.id} repoId={tab.id} />
      <div
        ref={bodyRef}
        className={styles.body}
        style={{ gridTemplateColumns: `${refs}px auto 1fr auto ${sidebar}px` }}
      >
        {/* Keyed so filter, menu, dialog and mutation state never leak across tabs. */}
        <div key={`refs-${tab.id}`} className={styles.refs}>
          {historyPath === null ? (
            <>
              <BranchesPanel repoId={tab.id} />
              <StashesPanel repoId={tab.id} />
            </>
          ) : (
            // Keyed so a newly picked file starts at the top with a fresh keyboard anchor.
            <FileHistoryPanel key={historyPath} repoId={tab.id} path={historyPath} />
          )}
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
        {/* The diff of a selected file replaces the graph until it is closed. */}
        <section aria-label="History" className={styles.center}>
          {fileSelected ? (
            <DetailPane key={tab.id} repoId={tab.id} />
          ) : (
            <GraphPanel key={tab.id} repoId={tab.id} />
          )}
        </section>
        {/* The handle sits before the column it sizes, so its directions are inverted. */}
        <SplitHandle
          label="Resize changes column"
          side="after"
          value={sidebar}
          min={SIDEBAR_MIN}
          max={maxWidth(available, "sidebar", refs)}
          step={KEY_STEP}
          onChange={setSidebarWidth}
          onReset={() => resetWidth("sidebar")}
        />
        {/* Keyed so selection, menu, dialog, draft and mutation state never leak across tabs. */}
        <div key={tab.id} className={styles.sidebar}>
          {selectedCommit !== null ? (
            <CommitSummary repoId={tab.id} oid={selectedCommit} />
          ) : selectedStash !== null ? (
            // Keyed so a newly selected stash never shows the previous one's notice or dialog.
            <StashSummary key={selectedStash} repoId={tab.id} oid={selectedStash} />
          ) : (
            <>
              <ChangesPanel repoId={tab.id} />
              <CommitBox repoId={tab.id} />
            </>
          )}
        </div>
      </div>
      <FilePickerDialog
        repoId={tab.id}
        open={picker}
        onPick={(p) => {
          showHistory(tab.id, p);
          setPicker(false);
        }}
        onCancel={() => setPicker(false)}
      />
    </section>
  );
}
