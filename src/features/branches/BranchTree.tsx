import { useCallback, useState, type ReactNode } from "react";
import type { BranchNode } from "./branchTree";
import styles from "./BranchTree.module.css";

export interface BranchTreeItemsProps<B> {
  nodes: BranchNode<B>[];
  /** Collapsed folder keys; a folder's key is `keyPrefix + path`. */
  collapsed: ReadonlySet<string>;
  onToggle(key: string): void;
  /** Prepended to each folder path to form its key, e.g. "origin:" (a colon cannot appear in a ref name); default "". */
  keyPrefix?: string;
  /** Renders one branch `<li>`; must set its own React key. */
  renderBranch(branch: B): ReactNode;
}

/** The `<li>` items of one tree level: folder items with their nested `<ul>`, then branch items. */
export function BranchTreeItems<B>(props: BranchTreeItemsProps<B>): ReactNode {
  const { nodes, collapsed, onToggle, keyPrefix = "", renderBranch } = props;
  return nodes.map((node) => {
    if (node.kind === "branch") return renderBranch(node.branch);
    const key = keyPrefix + node.path;
    const expanded = !collapsed.has(key);
    return (
      <li key={`folder:${node.path}`} className={styles.folderItem}>
        <button
          type="button"
          className={styles.folder}
          aria-expanded={expanded}
          onClick={() => onToggle(key)}
        >
          <span className={styles.folderName}>{node.name}</span>
        </button>
        {expanded && (
          <ul aria-label={`${node.path} branches`} className={styles.children}>
            <BranchTreeItems {...props} nodes={node.children} />
          </ul>
        )}
      </li>
    );
  });
}

/** Collapsed folder keys for one section; empty on mount so every folder starts expanded. */
export function useCollapsedFolders(): {
  collapsed: ReadonlySet<string>;
  toggle(key: string): void;
} {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  return { collapsed, toggle };
}
