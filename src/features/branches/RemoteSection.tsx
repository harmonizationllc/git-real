import { useId } from "react";
import type { BranchList } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { setRemoteCollapsed } from "../../lib/store/settingsActions";
import { BranchGroup, BranchSectionHeader } from "./BranchGroup";
import { sectionCountLabel } from "./sectionCountLabel";
import { useBranchesContext } from "./BranchesProvider";
import groupStyles from "./BranchGroup.module.css";
import styles from "./BranchesPanel.module.css";

/** Every remote-tracking branch across the list's remotes. */
const remoteCount = (list: BranchList | undefined): number =>
  list?.remotes.reduce((n, g) => n + g.branches.length, 0) ?? 0;

/**
 * The Remote column section (spec: Local and Remote sections): a collapsible "Remote (n)" heading
 * counting every remote's branches, then one group per remote whose name heading keeps its menu.
 * Loading and list errors are shown by Local and the provider, so Remote shows its header alone.
 */
export function RemoteSection() {
  const bodyId = useId();
  const { branches, shown, filtering, pending, row, openHeadingMenu } = useBranchesContext();
  const collapsed = useSettings((s) => s.settings.layout.remoteCollapsed);
  // The filter shows its matches even when collapsed; the stored preference applies once it clears.
  const expanded = filtering || !collapsed;

  let body: React.ReactNode = null;
  if (expanded && shown !== undefined) {
    body =
      shown.remotes.length === 0 ? (
        <p className={groupStyles.empty}>No remotes</p>
      ) : (
        shown.remotes.map((group) => (
          <BranchGroup
            key={group.remote}
            heading={group.remote}
            listLabel={`${group.remote} branches`}
            filtered={filtering}
            count={group.branches.length}
            onHeadingContextMenu={(x, y) => openHeadingMenu(group.remote, x, y)}
          >
            {group.branches.map((branch) =>
              row({ kind: "remote", branch }, `${branch.remote}/${branch.name}`, false),
            )}
          </BranchGroup>
        ))
      );
  }

  return (
    <section aria-label="Remote branches" aria-busy={pending || undefined} className={styles.root}>
      <BranchSectionHeader
        label={sectionCountLabel(
          "Remote",
          remoteCount(shown),
          branches === undefined ? undefined : remoteCount(branches),
          filtering,
        )}
        expanded={expanded}
        bodyId={bodyId}
        onToggle={() => setRemoteCollapsed(!collapsed)}
      />
      <div id={bodyId}>{body}</div>
    </section>
  );
}
