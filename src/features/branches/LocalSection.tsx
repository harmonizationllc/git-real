import { useId } from "react";
import type { HeadState } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { setLocalCollapsed } from "../../lib/store/settingsActions";
import { BranchGroupBody, BranchSectionHeader, sectionCountLabel } from "./BranchGroup";
import { useBranchesContext } from "./BranchesProvider";
import styles from "./BranchesPanel.module.css";

/** The non-interactive first Local row for a HEAD that is not on a born branch. */
function headRow(head: HeadState) {
  if (head.kind === "branch") return undefined;
  const text =
    head.kind === "detached"
      ? `Detached at ${head.oid.slice(0, 7)}`
      : `${head.name} (no commits yet)`;
  return (
    <p className={styles.headRow} aria-current="true">
      {text}
    </p>
  );
}

/**
 * The Local column section (spec: Local and Remote sections): a collapsible "Local (n)" heading
 * with New branch… at its right, then the unborn or detached row and the local branches. Its root
 * is the focus fallback of the shared branch dialogs and menus.
 */
export function LocalSection() {
  const bodyId = useId();
  const { branches, shown, filtering, loading, pending, rootRef, row, openNewBranch } =
    useBranchesContext();
  const collapsed = useSettings((s) => s.settings.layout.localCollapsed);
  // The filter shows its matches even when collapsed; the stored preference applies once it clears.
  const expanded = filtering || !collapsed;
  const unborn = branches?.head.kind === "unborn";

  let body: React.ReactNode = null;
  if (!expanded) {
    body = null;
  } else if (loading) {
    body = <p role="status">Loading branches…</p>;
  } else if (branches !== undefined && shown !== undefined) {
    body = (
      <BranchGroupBody
        listLabel="Local branches"
        filtered={filtering}
        count={shown.local.length}
        leading={headRow(branches.head)}
      >
        {shown.local.map((branch) =>
          row({ kind: "local", branch }, `local:${branch.name}`, branch.isHead),
        )}
      </BranchGroupBody>
    );
  }

  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      data-focus-target
      aria-label="Local branches"
      aria-busy={pending || undefined}
      className={styles.root}
    >
      <BranchSectionHeader
        label={sectionCountLabel(
          "Local",
          shown?.local.length ?? 0,
          branches?.local.length ?? 0,
          filtering,
        )}
        expanded={expanded}
        bodyId={bodyId}
        onToggle={() => setLocalCollapsed(!collapsed)}
      >
        {branches !== undefined && (
          <button
            type="button"
            className={styles.newBranch}
            data-variant="ghost"
            data-size="sm"
            disabled={unborn || pending}
            title={unborn ? "Make a commit first" : undefined}
            onClick={openNewBranch}
          >
            New branch…
          </button>
        )}
      </BranchSectionHeader>
      <div id={bodyId}>{body}</div>
    </section>
  );
}
