import { useCallback, useId, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import { copyText, toAppError } from "../../lib/ipc";
import type { AppError, RepoId, TagEntry } from "../../lib/ipc";
import { useLayoutPrefs } from "../../lib/store/layoutPrefs";
import { useWorkspace } from "../../lib/store/workspace";
import { filterTags, isFiltering } from "../branches/branchFilter";
import { useBranches } from "../branches/useBranches";
import { RepoError } from "../repo/RepoError";
import { CreateTagDialog } from "./CreateTagDialog";
import { TagFeedback } from "./TagFeedback";
import { TagRow } from "./TagRow";
import styles from "./TagsPanel.module.css";
import { headCommit } from "./headCommit";
import { MAKE_COMMIT_FIRST, NO_REMOTES_TITLE, tagCountLabel } from "./tagCopy";
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
  const collapsed = useLayoutPrefs((s) => s.tagsCollapsed);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [creating, setCreating] = useState(false);
  const [copyError, setCopyError] = useState<AppError | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const filtering = isFiltering(query);
  const shown = list ? filterTags(list.tags, query) : [];
  // The filter shows its matches even when collapsed; the stored preference applies once it clears.
  const expanded = filtering || !collapsed;
  const head = headCommit(branches);
  const remotes = list?.remotes ?? [];

  // A newer result must not hide behind an older, undismissed error.
  const run = (action: () => Promise<AppError | null>) => {
    actions.clearError();
    setCopyError(null);
    void action();
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
            onSelect: () => run(() => actions.push(remote, tag.name)),
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
      onSelect: () => void copyText(tag.name).catch((e: unknown) => setCopyError(toAppError(e))),
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
    run(() =>
      c.kind === "delete" ? actions.remove(c.name) : actions.deleteRemote(c.remote, c.name),
    );
  };

  let body: React.ReactNode;
  if (!expanded) {
    body = null;
  } else if (listError !== null) {
    body = <RepoError error={listError} path={null} onRetry={refetch} onDismiss={refetch} />;
  } else if (list === undefined) {
    body = <p role="status">Loading tags…</p>;
  } else if (list.tags.length === 0) {
    body = <p className={styles.empty}>No tags</p>;
  } else if (shown.length === 0) {
    body = <p className={styles.empty}>No matches</p>;
  } else {
    body = (
      <ul aria-label="Tag list" className={styles.list}>
        {shown.map((tag) => (
          <TagRow
            key={tag.name}
            tag={tag}
            onSelect={() => useWorkspace.getState().selectCommit(repoId, tag.target)}
            onContextMenu={(x, y) => setMenu({ x, y, tag })}
          />
        ))}
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
      <div className={styles.header}>
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          data-focus-target
          className={styles.heading}
        >
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => useLayoutPrefs.getState().setTagsCollapsed(!collapsed)}
          >
            {tagCountLabel(shown.length, list?.tags.length ?? 0, filtering)}
          </button>
        </h2>
        <button
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
      <TagFeedback actions={actions} />
      {copyError && (
        <RepoError error={copyError} path={null} onDismiss={() => setCopyError(null)} />
      )}
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
    </section>
  );
}
