import { useEffect, useRef } from "react";
import { matchesShortcut } from "../lib/shortcuts";
import { useRepoTabs } from "../lib/store/repoTabs";
import { useShell } from "../lib/store/shell";
import type { ShellActions } from "../lib/store/shell";
import { closeRepoTab } from "./closeRepoTab";

/**
 * One window keydown listener for the `always` and Navigation shortcuts: the palette, shortcuts and
 * settings dialogs, open/clone, and close/next/prev tab. It does nothing while any dialog is open
 * (R14) and calls `preventDefault` only when it acts. The Repository and Commit rows stay in
 * `RepoPane` and `MessageEditor`.
 */
export function useGlobalShortcuts(actions: ShellActions): void {
  // Read at event time, so the single listener always sees the latest actions.
  const actionsRef = useRef(actions);
  useEffect(() => {
    actionsRef.current = actions;
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]') !== null) return;
      const shell = useShell.getState();
      if (matchesShortcut(e, "palette")) {
        e.preventDefault();
        shell.open({ kind: "palette" });
      } else if (matchesShortcut(e, "shortcuts")) {
        e.preventDefault();
        shell.open({ kind: "shortcuts" });
      } else if (matchesShortcut(e, "settings")) {
        e.preventDefault();
        shell.open({ kind: "settings" });
      } else if (matchesShortcut(e, "openRepo")) {
        e.preventDefault();
        actionsRef.current.openRepo();
      } else if (matchesShortcut(e, "cloneRepo")) {
        e.preventDefault();
        actionsRef.current.cloneRepo();
      } else if (matchesShortcut(e, "closeTab")) {
        const { activeId } = useRepoTabs.getState();
        if (activeId === null) return;
        e.preventDefault();
        closeRepoTab(activeId);
      } else {
        // Capture the direction before preventDefault, since matchesShortcut ignores a
        // defaultPrevented event once it is consumed.
        const next = matchesShortcut(e, "nextTab");
        if (!next && !matchesShortcut(e, "prevTab")) return;
        const { tabs, activeId, activate } = useRepoTabs.getState();
        const index = tabs.findIndex((t) => t.id === activeId);
        if (index === -1) return;
        e.preventDefault();
        // Wraps: next after the last is the first, previous before the first is the last.
        const delta = next ? 1 : -1;
        activate(tabs[(index + delta + tabs.length) % tabs.length].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
