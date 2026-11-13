import { useCallback, useId, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { SectionHead } from "../../components/SectionHead";
import { copyText, toAppError } from "../../lib/ipc";
import type { AppError, RepoId, TagEntry } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { setTagsCollapsed } from "../../lib/store/settingsActions";
import { useWorkspace } from "../../lib/store/workspace";
import { BranchTreeItems, useCollapsedFolders } from "../branches/BranchTreeItems";
import { filterTags, isFiltering } from "../branches/branchFilter";
import { buildBranchTree } from "../branches/branchTree";
import { useBranches } from "../branches/useBranches";
import { CredentialDialog } from "../remotes/CredentialDialog";
import { toastError } from "../remotes/toastError";
import { useLoadFailureToast } from "../remotes/useLoadFailureToast";
import { CreateTagDialog } from "./CreateTagDialog";
import { TagRow } from "./TagRow";
import styles from "./TagsPanel.module.css";
import { headCommit } from "./headCommit";
import { sectionCountLabel } from "../branches/sectionCountLabel";
import { MAKE_COMMIT_FIRST, NO_REMOTES_TITLE, displayError } from "./tagCopy";
import { useTagActions } from "./useTagActions";
import { useTags } from "./useTags";

export interface TagsPanelProps {
  repoId: RepoId;
}

interface MenuState {
  x: number;
  y: number;
  tag: TagEntry;
}

type Confirm =
  { kind: "delete"; name: string } | { kind: "deleteRemote"; name: string; remote: string };

const CREATE_LABEL = "Create tag…";

export function TagsPanel({ repoId }: TagsPanelProps) {
  const headingId = useId();
  const bodyId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { list, error: listError, refetch } = useTags(repoId);
  const actions = useTagActions(repoId);
  const { branches } = useBranches(repoId);
  const query = useWorkspace((s) => s.refsFilter[repoId] ?? "");
  const collapsed = useSettings((s) => s.settings.layout.tagsCollapsed);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [creating, setCreating] = useState(false);
  const closeMenu = useCallback(() => setMenu(null), []);

  const filtering = isFiltering(query);
  // Memoised, so the folder tree is rebuilt only when the list or the query changes.
  const shown = useMemo(() => (list ? filterTags(list.tags, query) : []), [list, query]);
  const tree = useMemo(() => buildBranchTree(shown), [shown]);
  const { collapsed: collapsedFolders, toggle: toggleFolder } = useCollapsedFolders();
  // The filter shows its matches even when collapsed; the stored preference applies once it clears.
  const expanded = filtering || !collapsed;
  const head = headCommit(branches);
  const remotes = list?.remotes ?? [];

  const loadFailed = useLoadFailureToast("tags", list !== undefined, listError, refetch);

  // The failure is toasted here, from the resolved result; no push failure offers an action
  // (the panel has no remotes access), but the toast still carries git's output as Details.
  const run = (action: () => Promise<AppError | null>, name: string) => {
    void action().then((e) => {
      if (e !== null) toastError(displayError(e, name));
    });
  };

  // Disabled, so never selected; closing the menu stands in for an action.
  const noRemote = (id: string, label: string): MenuItem => ({
    id,
    label,
    disabled: true,
    title: NO_REMOTES_TITLE,
    onSelect: closeMenu,
  });

  const remoteItems = (tag: TagEntry): MenuItem[] =>
    remotes.length === 0
      ? [noRemote("push", "Push to remote"), noRemote("deleteRemote", "Delete from remote…")]
      : [
          ...remotes.map((remote) => ({
            id: `push:${remote}`,
            label: `Push to ${remote}`,
            disabled: actions.pending,
            onSelect: () => run(() => actions.push(remote, tag.name), tag.name),
          })),
          ...remotes.map((remote) => ({
            id: `deleteRemote:${remote}`,
            label: `Delete from ${remote}…`,
            danger: true,
            disabled: actions.pending,
            onSelect: () => setConfirm({ kind: "deleteRemote", name: tag.name, remote }),
          })),
        ];

  const menuItems = (tag: TagEntry): MenuItem[] => [
    {
      id: "copy",
      label: "Copy name",
      onSelect: () => void copyText(tag.name).catch((e: unknown) => toastError(toAppError(e))),
    },
    ...remoteItems(tag),
    {
      id: "delete",
      label: "Delete tag…",
      danger: true,
      disabled: actions.pending,
      onSelect: () => setConfirm({ kind: "delete", name: tag.name }),
    },
  ];

  // Closes at once, as the stash drop confirm does; the action's pending state disables the menu.
  const confirmAction = (c: Confirm) => {
    setConfirm(null);
    run(
      () => (c.kind === "delete" ? actions.remove(c.name) : actions.deleteRemote(c.remote, c.name)),
      c.name,
    );
  };

  let body: React.ReactNode;
  if (!expanded) {
    body = null;
  } else if (loadFailed) {
    body = <p className={styles.empty}>Couldn't load tags</p>;
  } else if (list === undefined) {
    body = <p role="status">Loading tags…</p>;
  } else if (list.tags.length === 0) {
    body = <p className={styles.empty}>No tags</p>;
  } else if (shown.length === 0) {
    body = <p className={styles.empty}>No matches</p>;
  } else {
    body = (
      <ul aria-label="Tag list" className={styles.list}>
        <BranchTreeItems
          nodes={tree}
          collapsed={collapsedFolders}
          onToggle={toggleFolder}
          listNoun="tags"
          renderBranch={(tag) => (
            <TagRow
              key={tag.name}
              tag={tag}
              onSelect={() => useWorkspace.getState().selectCommit(repoId, tag.target)}
              onContextMenu={(x, y) => setMenu({ x, y, tag })}
            />
          )}
        />
      </ul>
    );
  }

  let addTitle: string | undefined;
  if (branches !== undefined)
    addTitle = branches.head.kind === "unborn" ? MAKE_COMMIT_FIRST : CREATE_LABEL;

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={actions.pending || undefined}
      className={styles.root}
    >
      <SectionHead>
        <div className={`gr-section-header ${styles.header}`}>
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            data-focus-target
            className={`gr-section-heading ${styles.heading}`}
          >
            <button
              type="button"
              className="gr-section-toggle"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => setTagsCollapsed(!collapsed)}
            >
              {sectionCountLabel("Tags", shown.length, list?.tags.length, filtering)}
            </button>
          </h2>
          <button
            data-variant="icon"
            data-size="sm"
            type="button"
            className={styles.add}
            aria-label={CREATE_LABEL}
            title={addTitle}
            disabled={head === null || actions.pending}
            onClick={() => setCreating(true)}
          >
            +
          </button>
        </div>
      </SectionHead>
      <div id={bodyId}>{body}</div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu === null ? [] : menuItems(menu.tag)}
        onClose={closeMenu}
        fallbackFocus={headingRef}
      />
      {confirm?.kind === "delete" && (
        <ConfirmDialog
          open
          title={`Delete tag ${confirm.name}?`}
          body="The tag is removed from this repository only."
          confirmLabel="Delete"
          danger
          onConfirm={() => confirmAction(confirm)}
          onCancel={() => setConfirm(null)}
          fallbackFocus={headingRef}
        />
      )}
      {confirm?.kind === "deleteRemote" && (
        <ConfirmDialog
          open
          title={`Delete tag ${confirm.name} from ${confirm.remote}?`}
          body="Others who already fetched it keep their copy."
          confirmLabel="Delete"
          danger
          onConfirm={() => confirmAction(confirm)}
          onCancel={() => setConfirm(null)}
          fallbackFocus={headingRef}
        />
      )}
      {creating && head !== null && (
        <CreateTagDialog
          repoId={repoId}
          oid={head}
          open
          onClose={() => setCreating(false)}
          fallbackFocus={headingRef}
        />
      )}
      {/* Last, so it paints above any other dialog of the panel. */}
      <CredentialDialog prompt={actions.prompt} fallbackFocus={headingRef} />
    </section>
  );
}
