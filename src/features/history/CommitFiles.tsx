import { useCallback, useRef, useState } from "react";
import { ContextMenu, type MenuItem } from "../../components/ContextMenu";
import type { CommitFile, RepoId } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { commitOf } from "../diff/model/scope";
import { StatusBadge } from "../worktree/StatusBadge";
import { useCommitFiles } from "./useCommitFiles";
import styles from "./CommitFiles.module.css";

export interface CommitFilesProps {
  repoId: RepoId;
  oid: string;
}

interface MenuState {
  x: number;
  y: number;
  file: CommitFile;
}

/** The files a commit changed; a click opens the file's diff in that commit. */
export function CommitFiles({ repoId, oid }: CommitFilesProps) {
  const { files, error, refetch } = useCommitFiles(repoId, oid);
  const selected = useWorkspace((s) => s.selected[repoId] ?? null);
  const select = useWorkspace((s) => s.select);
  const showHistory = useWorkspace((s) => s.showHistory);
  const setCentreView = useWorkspace((s) => s.setCentreView);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const headingRef = useRef<HTMLHeadingElement>(null);

  if (error !== null) {
    // Retry only: dismissing would leave the summary without its files and no way back.
    return (
      <div role="alert" className={styles.error}>
        <p className={styles.message}>{error.message}</p>
        <button type="button" onClick={refetch}>
          Retry
        </button>
      </div>
    );
  }
  if (files === undefined) return <p role="status">Loading files…</p>;

  const open = (file: CommitFile) => select(repoId, { path: file.path, scope: { commit: oid } });
  const isSelected = (file: CommitFile) =>
    selected?.path === file.path && commitOf(selected.scope) === oid;

  const menuItems = (file: CommitFile): MenuItem[] => [
    { id: "history", label: "File history", onSelect: () => showHistory(repoId, file.path) },
    {
      id: "blame",
      label: "Blame at this commit",
      onSelect: () => {
        open(file);
        setCentreView(repoId, "blame");
      },
    },
  ];

  return (
    <section aria-label="Changed files" className={styles.root}>
      <h3
        ref={headingRef}
        tabIndex={-1}
        data-focus-target
        className={styles.heading}
      >{`Files (${files.length})`}</h3>
      <ul className={styles.list}>
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className={styles.row}
              aria-current={isSelected(file) ? "true" : undefined}
              onClick={() => open(file)}
              onContextMenu={(e) => {
                e.preventDefault();
                open(file);
                setMenu({ x: e.clientX, y: e.clientY, file });
              }}
            >
              <StatusBadge kind={file.change} />
              <span className={styles.path}>
                {file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menu === null ? [] : menuItems(menu.file)}
        onClose={closeMenu}
        fallbackFocus={headingRef}
      />
    </section>
  );
}
