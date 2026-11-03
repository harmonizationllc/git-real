import { useState } from "react";
import type { RepoId, ShortcutKeycaps } from "../lib/ipc";
import { useShell } from "../lib/store/shell";
import type { RepoTab } from "../lib/store/repoTabs";
import { formatKeys } from "../lib/shortcuts";
import { useKeycaps, useShortcutKeys } from "../lib/shortcuts/useShortcutKeys";
import styles from "./TabBar.module.css";

export interface TabBarProps {
  tabs: RepoTab[];
  activeId: RepoId | null;
  onActivate(id: RepoId | null): void;
  onClose(id: RepoId): void;
  /** Move the tab with `id` so it ends up at `toIndex`. */
  onMove(id: RepoId, toIndex: number): void;
}

/** Drag data type for a tab: never text/plain, so dropping on a text field pastes nothing. */
const TAB_MIME = "application/x-git-real-tab";

/** A shell button's tooltip: the label, with its chord when bound. */
function titleFor(label: string, keys: string | null, keycaps: ShortcutKeycaps): string {
  return keys === null ? label : `${label} (${formatKeys(keys, keycaps)})`;
}

export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onMove,
}: TabBarProps): React.JSX.Element {
  const paletteKeys = useShortcutKeys("palette");
  const settingsKeys = useShortcutKeys("settings");
  const keycaps = useKeycaps();
  const [drag, setDrag] = useState<{ id: RepoId; over: RepoId | null } | null>(null);
  return (
    <nav className={styles.root} aria-label="Repositories">
      <div
        role="tablist"
        aria-label="Open repositories"
        className={styles.list}
        onDragEnd={() => setDrag(null)}
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className={active ? `${styles.tab} ${styles.active}` : styles.tab}
              draggable
              data-dragging={drag?.id === tab.id ? "true" : undefined}
              data-drop-target={drag?.over === tab.id && drag.id !== tab.id ? "true" : undefined}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(TAB_MIME, String(tab.id));
                setDrag({ id: tab.id, over: null });
              }}
              onDragOver={(e) => {
                if (drag === null) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDrag({ id: drag.id, over: tab.id });
              }}
              onDrop={(e) => {
                if (drag === null) return;
                e.preventDefault();
                if (drag.id !== tab.id) onMove(drag.id, tabs.indexOf(tab));
                setDrag(null);
              }}
            >
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
                data-variant="icon"
                data-size="sm"
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
        data-variant="icon"
        data-fill="neutral"
        onClick={() => onActivate(null)}
      >
        <span aria-hidden="true">+</span>
      </button>
      <button
        type="button"
        aria-label="Command palette"
        title={titleFor("Command palette", paletteKeys, keycaps)}
        className={styles.shell}
        data-variant="icon"
        onClick={() => useShell.getState().open({ kind: "palette" })}
      >
        <span aria-hidden="true">⌘</span>
      </button>
      <button
        type="button"
        aria-label="Settings"
        title={titleFor("Settings", settingsKeys, keycaps)}
        className={styles.shell}
        data-variant="icon"
        onClick={() => useShell.getState().open({ kind: "settings" })}
      >
        <span aria-hidden="true">⚙</span>
      </button>
    </nav>
  );
}
