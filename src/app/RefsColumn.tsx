import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SectionHeadSlot } from "../components/SectionHead";
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

/** The sections container's height, each head slot's and each section body's; null until set. */
interface Measured {
  root: number | null;
  heads: Array<number | null>;
  naturals: Array<number | null>;
}

/**
 * The refs column (spec §3, GR-58): one filter box above Local, Remote, Stashes, Tags, Worktrees,
 * Pull requests and Issues, each sized by its content and fitted to the space below the filter
 * box, with a horizontal handle below each resizable section. An open Local takes the leftover
 * height, else an open Remote, else nothing does. Local and Remote share one BranchesProvider.
 * Each panel's header band is portaled into a fixed head slot above the section's scrolling body,
 * so it stays in place while the list scrolls; a section's natural height is head plus body.
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
  const headRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [measured, setMeasured] = useState<Measured>({
    root: null,
    heads: REFS_SECTIONS.map(() => null),
    naturals: REFS_SECTIONS.map(() => null),
  });
  // The head slots as state, so each panel's SectionHead re-renders into its slot once it mounts.
  const [slots, setSlots] = useState<Array<HTMLDivElement | null>>(() =>
    REFS_SECTIONS.map(() => null),
  );
  // One ref callback per slot, created once: an inline callback would detach and re-attach on
  // every render, and its state update would loop. Unchanged elements keep the previous array.
  const [slotRefs] = useState(() =>
    REFS_SECTIONS.map((_, i) => (el: HTMLDivElement | null) => {
      headRefs.current[i] = el;
      setSlots((prev) => {
        if (prev[i] === el) return prev;
        const next = [...prev];
        next[i] = el;
        return next;
      });
    }),
  );

  // One observer for the sections container (root), every head slot and every content wrapper.
  // Entries for any other target (or none) are ignored, and a batch is applied in one functional
  // update, so it causes one render; a batch of ignored entries keeps the previous state.
  useEffect(() => {
    const ro = new ResizeObserver((entries) => {
      const root = entries.filter((e) => e.target === rootRef.current);
      const indexed = (targets: Array<HTMLDivElement | null>) =>
        entries.flatMap((e) => {
          const index = targets.indexOf(e.target as HTMLDivElement);
          return index === -1 ? [] : [{ index, height: e.contentRect.height }];
        });
      const heads = indexed(headRefs.current);
      const sections = indexed(contentRefs.current);
      setMeasured((prev) => {
        if (root.length === 0 && heads.length === 0 && sections.length === 0) return prev;
        const nextHeads = [...prev.heads];
        for (const { index, height } of heads) nextHeads[index] = height;
        const naturals = [...prev.naturals];
        for (const { index, height } of sections) naturals[index] = height;
        return { root: root.at(-1)?.contentRect.height ?? prev.root, heads: nextHeads, naturals };
      });
    });
    ro.observe(rootRef.current as HTMLDivElement);
    for (const el of headRefs.current) ro.observe(el as HTMLDivElement);
    for (const el of contentRefs.current) ro.observe(el as HTMLDivElement);
    return () => ro.disconnect();
  }, []);

  // Until the root, every head slot and every body have reported (zero counts), the wrappers keep
  // their flex fallback. A section without content (no hosting account) reports 0, takes no space
  // and gets no handle of its own; each rendered handle's track is taken from the container.
  const ready =
    measured.root !== null &&
    measured.heads.every((h) => h !== null) &&
    measured.naturals.every((h) => h !== null);
  // A section's natural height is its head slot's plus its body's; null until both have reported.
  const naturals = REFS_SECTIONS.map((_, i) => {
    const [headHeight, bodyHeight] = [measured.heads[i], measured.naturals[i]];
    return headHeight == null || bodyHeight == null ? null : headHeight + bodyHeight;
  });
  const hasHandle = REFS_SECTIONS.map((s, i) => s !== "issues" && naturals[i] !== 0);
  const tracks = hasHandle.filter(Boolean).length * SPLIT_HANDLE_WIDTH;
  const container = ready ? (measured.root as number) - tracks : 0;
  const absorber = !layout.localCollapsed ? 0 : !layout.remoteCollapsed ? 1 : null;
  // Each section passes its own stored height; the absorber's is a true height, only floored.
  const stored: Record<ResizableSection, number | null> = {
    local: layout.branchesHeight,
    remote: layout.remoteHeight,
    stashes: layout.stashesHeight,
    tags: layout.tagsHeight,
    worktrees: layout.worktreesHeight,
    pullRequests: layout.pullRequestsHeight,
  };
  const inputs: SectionInput[] = REFS_SECTIONS.map((section, i) => ({
    natural: naturals[i] ?? 0,
    fixed: section === "issues" ? null : stored[section],
  }));
  const heights = fitSections(container, inputs, absorber);

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
                <div ref={slotRefs[i]} data-section-head className={styles.head} />
                <div data-section-scroll className={styles.scroll}>
                  <div
                    ref={(el) => {
                      contentRefs.current[i] = el;
                    }}
                    className={styles.content}
                  >
                    <SectionHeadSlot.Provider value={slots[i]}>
                      {panels[section]}
                    </SectionHeadSlot.Provider>
                  </div>
                </div>
              </div>
              {section !== "issues" && hasHandle[i] && (
                <SplitHandle
                  label={LABELS[section]}
                  orientation="horizontal"
                  value={ready ? (heights[i] as number) : (stored[section] ?? 0)}
                  min={ready ? sectionFloor(inputs[i]!.natural) : 0}
                  // A non-absorbing section is capped at its content, so an inert (collapsed or empty)
                  // one cannot be dragged; the absorber is bounded by the column alone.
                  max={
                    ready
                      ? Math.min(
                          maxSectionHeight(container, inputs, i),
                          i === absorber ? Infinity : inputs[i]!.natural,
                        )
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
