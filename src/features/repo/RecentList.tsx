import type { RecentEntry } from "../../lib/ipc";
import styles from "./RecentList.module.css";

export interface RecentListProps {
  recents: RecentEntry[];
  onOpen(path: string): void;
  onRemove(path: string): void;
}

export function RecentList({ recents, onOpen, onRemove }: RecentListProps) {
  return (
    <ul aria-label="Recent repositories" className={styles.list}>
      {recents.map(({ path, name }) => (
        <li key={path} className={styles.item}>
          <button type="button" className={styles.row} onClick={() => onOpen(path)}>
            <span className={styles.name}>{name}</span> <span className={styles.path}>{path}</span>
          </button>
          <button
            type="button"
            className={styles.remove}
            aria-label={`Remove ${name} from recent repositories`}
            onClick={() => onRemove(path)}
          >
            <span aria-hidden="true">×</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
