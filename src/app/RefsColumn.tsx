import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SPLIT_HANDLE_WIDTH, SplitHandle } from "../components/SplitHandle";
import { BranchesProvider } from "../features/branches/BranchesProvider";
import { LocalSection } from "../features/branches/LocalSection";
import { RemoteSection } from "../features/branches/RemoteSection";
import { IssuesPanel } from "../features/hosting/IssuesPanel";
import { PullRequestsPanel } from "../features/hosting/PullRequestsPanel";
import type { RemotesTarget } from "../features/remotes/remotesTarget";
import { StashesPanel } from "../features/stash/StashesPanel";
import { WorktreesPanel } from "../features/linkedWorktrees/WorktreesPanel";
import { TagsPanel } from "../features/tags/TagsPanel";
import type { RepoId } from "../lib/ipc";
import { useSettings } from "../lib/store/settings";
import { useWorkspace } from "../lib/store/workspace";
import { setSectionHeight } from "../lib/store/settingsActions";
import { KEY_STEP } from "./layout";
import { REFS_SECTIONS, fitSections, maxSectionHeight, sectionFloor } from "./refsLayout";
import type { RefsSection, ResizableSection, SectionInput } from "./refsLayout";
import styles from "./RefsColumn.module.css";

export interface RefsColumnProps {
  repoId: RepoId;
  onOpenRemotes(target: RemotesTarget): void;
  onCreatePullRequest: (() => void) | null;
}

const LABELS: Record<ResizableSection, string> = {
  local: "Resize Local section",
  remote: "Resize Remote section",
  stashes: "Resize Stashes section",
  tags: "Resize Tags section",
  worktrees: "Resize Worktrees section",
  pullRequests: "Resize Pull requests section",
};

/** The sections container's content height and each section's; null until reported. */
interface Measured {
  root: number | null;
  naturals: Array<number | null>;
}

/**
 * The refs column (spec §3, GR-58): one filter box above Local, Remote, Stashes, Tags, Worktrees,
 * Pull requests and Issues, each sized by its content, or by its dragged height, and fitted to
 * the space below the filter box, with a horizontal handle below each resizable section. An open
 * Local takes the leftover height, else an open Remote, else nothing does. The section dragged
 * last keeps its height when the column is full. Local and Remote share one BranchesProvider.
 */
export function RefsColumn({
  repoId,
  onOpenRemotes,
  onCreatePullRequest,
}: RefsColumnProps): React.JSX.Element {
  const layout = useSettings((s) => s.settings.layout);
  const query = useWorkspace((s) => s.refsFilter[repoId] ?? "");
  const setQuery = (text: string) => useWorkspace.getState().setRefsFilter(repoId, text);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [measured, setMeasured] = useState<Measured>({
    root: null,
    naturals: REFS_SECTIONS.map(() => null),
  });

  // One observer for the sections container (root) and every content wrapper. Entries for any
  // other target (or none) are ignored, and a batch is applied in one functional update, so it
  // causes one render; a batch of ignored entries keeps the previous state, so it causes none.
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      const root = entries.filter((e) => e.target === rootRef.current);
      const sections = entries.flatMap((e) => {
        const index = contentRefs.current.indexOf(e.target as HTMLDivElement);
        return index === -1 ? [] : [{ index, height: e.contentRect.height }];
      });
      setMeasured((prev) => {
        if (root.length === 0 && sections.length === 0) return prev;
        const naturals = [...prev.naturals];
        for (const { index, height } of sections) naturals[index] = height;
        return { root: root.at(-1)?.contentRect.height ?? prev.root, naturals };
      });
    });
    ro.observe(rootRef.current as HTMLDivElement);
    for (const el of contentRefs.current) ro.observe(el as HTMLDivElement);
    return () => ro.disconnect();
  }, []);

  // Until the root and every section have reported (zero counts), the wrappers keep their flex
  // fallback. A section without content (no hosting account) reports 0, takes no space and gets
  // no handle of its own; each rendered handle's track is taken from the container.
  const ready = measured.root !== null && measured.naturals.every((h) => h !== null);
  const hasHandle = REFS_SECTIONS.map((s, i) => s !== "issues" && measured.naturals[i] !== 0);
  const tracks = hasHandle.filter(Boolean).length * SPLIT_HANDLE_WIDTH;
  const container = ready ? (measured.root as number) - tracks : 0;
  const absorber = !layout.localCollapsed ? 0 : !layout.remoteCollapsed ? 1 : null;
  // Each section passes its own stored height, a true height that is only floored.
  const stored: Record<ResizableSection, number | null> = {
    local: layout.branchesHeight,
    remote: layout.remoteHeight,
    stashes: layout.stashesHeight,
    tags: layout.tagsHeight,
    worktrees: layout.worktreesHeight,
    pullRequests: layout.pullRequestsHeight,
  };
  // A collapsed section shows only its header, so its stored height is ignored.
  const collapsed: Record<ResizableSection, boolean> = {
    local: layout.localCollapsed,
    remote: layout.remoteCollapsed,
    stashes: false,
    tags: layout.tagsCollapsed,
    worktrees: layout.worktreesCollapsed,
    pullRequests: layout.pullRequestsCollapsed,
  };
  const inputs: SectionInput[] = REFS_SECTIONS.map((section, i) => ({
    natural: measured.naturals[i] ?? 0,
    fixed: section === "issues" || collapsed[section] ? null : stored[section],
  }));
  const protect = layout.lastResized === null ? null : REFS_SECTIONS.indexOf(layout.lastResized);
  const heights = fitSections(container, inputs, absorber, protect === -1 ? null : protect);

  const panels: Record<RefsSection, ReactNode> = {
    local: <LocalSection />,
    remote: <RemoteSection />,
    stashes: <StashesPanel repoId={repoId} />,
    tags: <TagsPanel repoId={repoId} />,
    worktrees: <WorktreesPanel repoId={repoId} />,
    pullRequests: <PullRequestsPanel repoId={repoId} onCreatePullRequest={onCreatePullRequest} />,
    issues: <IssuesPanel repoId={repoId} />,
  };

  return (
    <div data-testid="refs-column" className={styles.column}>
      <div className={styles.filterBar}>
        <input
          type="search"
          className={styles.filter}
          aria-label="Filter"
          placeholder="Filter"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
          }}
        />
      </div>
      {/* The provider's host block (branch errors, menus, dialogs) renders first, between the
          filter box and the measured container, so a banner never takes a section's height. */}
      <BranchesProvider
        repoId={repoId}
        onOpenRemotes={onOpenRemotes}
        onCreatePullRequest={onCreatePullRequest}
      >
        {/* Measured below the filter box, so the sections share only the space under it. */}
        <div ref={rootRef} data-testid="refs-sections" className={styles.sections}>
          {REFS_SECTIONS.map((section, i) => (
            <Fragment key={section}>
              <div
                data-section={section}
                className={styles.section}
                style={ready ? { height: heights[i], flex: "none" } : undefined}
              >
                <div
                  ref={(el) => {
                    contentRefs.current[i] = el;
                  }}
                >
                  {panels[section]}
                </div>
              </div>
              {section !== "issues" && hasHandle[i] && (
                <SplitHandle
                  label={LABELS[section]}
                  orientation="horizontal"
                  value={ready ? (heights[i] as number) : (stored[section] ?? 0)}
                  min={ready ? sectionFloor(inputs[i]!.natural) : 0}
                  // A collapsed section's handle is inert (max = its content); an open one is
                  // bounded by the column alone, so it can be pulled open past its content.
                  max={
                    ready
                      ? collapsed[section]
                        ? inputs[i]!.natural
                        : maxSectionHeight(container, inputs, i)
                      : Infinity
                  }
                  step={KEY_STEP}
                  // Nothing is stored before measuring, or when the value would not change.
                  onChange={(px) => {
                    if (ready && px !== heights[i]) setSectionHeight(section, px);
                  }}
                  onReset={() => setSectionHeight(section, null)}
                />
              )}
            </Fragment>
          ))}
        </div>
      </BranchesProvider>
    </div>
  );
}
