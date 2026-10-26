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
import { CreatePullRequestDialog } from "../features/hosting/CreatePullRequestDialog";
import { IssuesPanel } from "../features/hosting/IssuesPanel";
import { PullRequestsPanel } from "../features/hosting/PullRequestsPanel";
import { useRepoContext } from "../features/hosting/useRepoContext";
import { RemotesDialog } from "../features/remotes/RemotesDialog";
import type { RemotesTarget } from "../features/remotes/remotesTarget";
import { SyncMessage } from "../features/remotes/SyncMessage";
import { SyncToolbar } from "../features/remotes/SyncToolbar";
import { useSyncActions } from "../features/remotes/useSyncActions";
import { StashSummary } from "../features/stash/StashSummary";
import { StashesPanel } from "../features/stash/StashesPanel";
import { TagsPanel } from "../features/tags/TagsPanel";
import { ChangesPanel } from "../features/worktree/ChangesPanel";
import type { HeadState, RepoId } from "../lib/ipc";
import { useRepoChanged } from "../lib/query/useRepoChanged";
import { useSettings } from "../lib/store/settings";
import { resetWidth, setRefsWidth, setSidebarWidth } from "../lib/store/settingsActions";
import type { RepoTab } from "../lib/store/repoTabs";
import { useShell } from "../lib/store/shell";
import { useWorkspace } from "../lib/store/workspace";
import { matchesShortcut } from "../lib/shortcuts";
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
  const refsWidth = useSettings((s) => s.settings.layout.refsWidth);
  const sidebarWidth = useSettings((s) => s.settings.layout.sidebarWidth);
  const fileSelected = useWorkspace((s) => Boolean(s.selected[tab.id]));
  const selectedCommit = useWorkspace((s) => s.selectedCommit[tab.id] ?? null);
  const selectedStash = useWorkspace((s) => s.selectedStash[tab.id] ?? null);
  const historyPath = useWorkspace((s) => s.historyPath[tab.id] ?? null);
  const showHistory = useWorkspace((s) => s.showHistory);
  const [picker, setPicker] = useState(false);
  const sync = useSyncActions(tab.id);
  const rootRef = useRef<HTMLElement>(null);
  // The open remotes dialog, tagged with the tab that opened it: switching tabs drops it during
  // render, so it never mounts for another repo and does not reappear on the way back.
  const [remotes, setRemotes] = useState<{ repoId: RepoId; target: RemotesTarget } | null>(null);
  if (remotes !== null && remotes.repoId !== tab.id) setRemotes(null);
  const remotesTarget = remotes !== null && remotes.repoId === tab.id ? remotes.target : null;
  const openRemotes = (target: RemotesTarget) => setRemotes({ repoId: tab.id, target });
  // A pull request needs a usable account and a branch to open it from; the pane is keyed per tab,
  // so the open dialog never carries over to another repo.
  const [createPr, setCreatePr] = useState(false);
  const { context } = useRepoContext(tab.id);
  const account = context?.account ?? null;
  const canCreatePr =
    account !== null && !account.needsReconnect && branches?.head.kind === "branch";
  const onCreatePullRequest = canCreatePr ? () => setCreatePr(true) : null;

  // The window handler is registered once; it reads the latest sync actions (and their gates).
  const syncRef = useRef(sync);
  useEffect(() => {
    syncRef.current = sync;
  });

  // The Repository rows: file history, fetch, pull and push. Never on top of another dialog.
  // matchesShortcut ignores repeats, consumed and composing events; each action ignores itself
  // while gated.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]') !== null) return;
      if (matchesShortcut(e, "fileHistory")) {
        e.preventDefault();
        setPicker(true);
      } else if (matchesShortcut(e, "fetch")) {
        e.preventDefault();
        syncRef.current.fetch();
      } else if (matchesShortcut(e, "pull")) {
        e.preventDefault();
        syncRef.current.pull();
      } else if (matchesShortcut(e, "push")) {
        e.preventDefault();
        syncRef.current.push();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Publish the active pane's repository actions for the command palette, with stable callbacks
  // backed by syncRef so only a gate or the path re-publishes. Cleared when the pane unmounts.
  useEffect(() => {
    useShell.getState().publishRepoActions({
      repoId: tab.id,
      path,
      gates: {
        fetch: sync.gates.fetch,
        pull: sync.gates.pull,
        push: sync.gates.push,
      },
      fetch: () => syncRef.current.fetch(),
      pull: () => syncRef.current.pull(),
      push: () => syncRef.current.push(),
      fileHistory: () => setPicker(true),
    });
    return () => useShell.getState().publishRepoActions(null);
  }, [tab.id, path, sync.gates.fetch, sync.gates.pull, sync.gates.push]);

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
    <section
      ref={rootRef}
      tabIndex={-1}
      data-focus-target
      className={styles.root}
      aria-labelledby={headingId}
    >
      <header className={styles.header}>
        <h1 id={headingId} className={styles.name}>
          {name}
        </h1>
        <p className={styles.path}>{path}</p>
        <div className={styles.syncRow}>
          <p className={styles.branch}>{headLine(branches?.head, headBranch)}</p>
          <SyncToolbar
            sync={sync}
            onOpenRemotes={openRemotes}
            onCreatePullRequest={onCreatePullRequest}
          />
        </div>
        {/* Its own full-width row, so an error never changes the toolbar row's height. */}
        <SyncMessage sync={sync} onOpenRemotes={openRemotes} />
      </header>
      {/* Keyed so the abort dialog and mutation state never leak across tabs. */}
      <OperationBanner key={tab.id} repoId={tab.id} />
      <div
        ref={bodyRef}
        className={styles.body}
        style={{ gridTemplateColumns: `${refs}px auto 1fr auto ${sidebar}px` }}
      >
        {/* Keyed so menu, dialog and mutation state never leak across tabs. */}
        <div key={`refs-${tab.id}`} className={styles.refs}>
          {historyPath === null ? (
            <>
              <BranchesPanel
                repoId={tab.id}
                onOpenRemotes={openRemotes}
                onCreatePullRequest={onCreatePullRequest}
              />
              <StashesPanel repoId={tab.id} />
              <TagsPanel repoId={tab.id} />
              <PullRequestsPanel repoId={tab.id} onCreatePullRequest={onCreatePullRequest} />
              <IssuesPanel repoId={tab.id} />
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
      {remotesTarget !== null && (
        // The pane root takes focus on close when the opener is gone, e.g. a renamed remote's heading.
        <RemotesDialog
          key={tab.id}
          repoId={tab.id}
          target={remotesTarget}
          onClose={() => setRemotes(null)}
          fallbackFocus={rootRef}
        />
      )}
      {createPr && (
        // The pane root takes focus on close when the opener is still disabled by the network gate.
        <CreatePullRequestDialog
          repoId={tab.id}
          onClose={() => setCreatePr(false)}
          fallbackFocus={rootRef}
        />
      )}
    </section>
  );
}
