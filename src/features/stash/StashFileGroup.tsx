import type { CommitFile, RepoId } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { commitOf } from "../diff/model/scope";
import { StatusBadge } from "../worktree/StatusBadge";
import styles from "./StashFileGroup.module.css";

export interface StashFileGroupProps {
  repoId: RepoId;
  /** The visible heading; the count is appended. */
  title: string;
  listLabel: string;
  files: CommitFile[];
  /** The commit the files' diffs are read from: the stash itself or its untracked commit. */
  commit: string;
}

/** One group of a stash's files; a heading and a list, not a landmark. */
export function StashFileGroup({ repoId, title, listLabel, files, commit }: StashFileGroupProps) {
  const selected = useWorkspace((s) => s.selected[repoId] ?? null);
  const select = useWorkspace((s) => s.select);
  const isSelected = (file: CommitFile) =>
    selected?.path === file.path && commitOf(selected.scope) === commit;

  return (
    <div className={styles.group}>
      <h3 className={styles.heading}>{`${title} (${files.length})`}</h3>
      <ul aria-label={listLabel} className={styles.list}>
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className={styles.row}
              aria-current={isSelected(file) ? "true" : undefined}
              onClick={() => select(repoId, { path: file.path, scope: { commit } })}
            >
              <StatusBadge kind={file.change} />
              <span className={styles.path}>
                {file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
