import type { RepoId } from "../lib/ipc";
import { useShell } from "../lib/store/shell";
import type { RepoTab } from "../lib/store/repoTabs";
import { formatKeys } from "../lib/shortcuts";
import { useShortcutKeys } from "../lib/shortcuts/useShortcutKeys";
import styles from "./TabBar.module.css";

export interface TabBarProps {
  tabs: RepoTab[];
  activeId: RepoId | null;
  onActivate(id: RepoId | null): void;
  onClose(id: RepoId): void;
}

/** A shell button's tooltip: the label, with its chord when bound. */
function titleFor(label: string, keys: string | null): string {
  return keys === null ? label : `${label} (${formatKeys(keys)})`;
}

export function TabBar({ tabs, activeId, onActivate, onClose }: TabBarProps): React.JSX.Element {
  const paletteKeys = useShortcutKeys("palette");
  const settingsKeys = useShortcutKeys("settings");
  return (
    <nav className={styles.root} aria-label="Repositories">
      <div role="tablist" aria-label="Open repositories" className={styles.list}>
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div key={tab.id} className={active ? `${styles.tab} ${styles.active}` : styles.tab}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.summary.path}
                className={styles.label}
                onClick={() => onActivate(tab.id)}
              >
                {tab.summary.name}
              </button>
              <button
                type="button"
                aria-label={`Close ${tab.summary.name}`}
                className={styles.close}
                onClick={() => onClose(tab.id)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="Start screen"
        className={styles.plus}
        onClick={() => onActivate(null)}
      >
        <span aria-hidden="true">+</span>
      </button>
      <button
        type="button"
        aria-label="Command palette"
        title={titleFor("Command palette", paletteKeys)}
        className={styles.shell}
        onClick={() => useShell.getState().open({ kind: "palette" })}
      >
        <span aria-hidden="true">⌘</span>
      </button>
      <button
        type="button"
        aria-label="Settings"
        title={titleFor("Settings", settingsKeys)}
        className={styles.shell}
        onClick={() => useShell.getState().open({ kind: "settings" })}
      >
        <span aria-hidden="true">⚙</span>
      </button>
    </nav>
  );
}
