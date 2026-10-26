import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SPLIT_HANDLE_WIDTH, SplitHandle } from "../components/SplitHandle";
import { BranchesPanel } from "../features/branches/BranchesPanel";
import { IssuesPanel } from "../features/hosting/IssuesPanel";
import { PullRequestsPanel } from "../features/hosting/PullRequestsPanel";
import type { RemotesTarget } from "../features/remotes/remotesTarget";
import { StashesPanel } from "../features/stash/StashesPanel";
import { TagsPanel } from "../features/tags/TagsPanel";
import type { RepoId } from "../lib/ipc";
import { useSettings } from "../lib/store/settings";
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
  branches: "Resize Branches section",
  stashes: "Resize Stashes section",
  tags: "Resize Tags section",
  pullRequests: "Resize Pull requests section",
};

/** The column root's content height and each section's content height; null until reported. */
interface Measured {
  root: number | null;
  naturals: Array<number | null>;
}

/**
 * The refs column (spec §3): Branches, Stashes, Tags, Pull requests and Issues, each sized by
 * its content and fitted to the column, with a horizontal handle below each resizable section.
 */
export function RefsColumn({
  repoId,
  onOpenRemotes,
  onCreatePullRequest,
}: RefsColumnProps): React.JSX.Element {
  const layout = useSettings((s) => s.settings.layout);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [measured, setMeasured] = useState<Measured>({
    root: null,
    naturals: REFS_SECTIONS.map(() => null),
  });

  // One observer for the root and every content wrapper. Entries for any other target (or none)
  // are ignored, and a batch is applied in one functional update, so it causes one render; a batch
  // of ignored entries keeps the previous state, so it causes none.
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
  const inputs: SectionInput[] = REFS_SECTIONS.map((section, i) => ({
    natural: measured.naturals[i] ?? 0,
    fixed: section === "issues" ? null : layout[`${section}Height`],
  }));
  const heights = fitSections(container, inputs).map(Math.round);

  const panels: Record<RefsSection, ReactNode> = {
    branches: (
      <BranchesPanel
        repoId={repoId}
        onOpenRemotes={onOpenRemotes}
        onCreatePullRequest={onCreatePullRequest}
      />
    ),
    stashes: <StashesPanel repoId={repoId} />,
    tags: <TagsPanel repoId={repoId} />,
    pullRequests: <PullRequestsPanel repoId={repoId} onCreatePullRequest={onCreatePullRequest} />,
    issues: <IssuesPanel repoId={repoId} />,
  };

  return (
    <div ref={rootRef} data-testid="refs-column" className={styles.column}>
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
              value={ready ? (heights[i] as number) : (layout[`${section}Height`] ?? 0)}
              min={ready ? sectionFloor(inputs[i]!.natural) : 0}
              // Capped at the content, so an inert (collapsed or empty) section cannot be dragged.
              max={
                ready
                  ? Math.min(maxSectionHeight(container, inputs, i), inputs[i]!.natural)
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
  );
}
