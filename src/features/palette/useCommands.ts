import { useQuery } from "@tanstack/react-query";
import { listRecent, openInEditor } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useAppearancePrefs } from "../../lib/store/appearancePrefs";
import type { ThemePref } from "../../lib/store/appearancePrefs";
import { useRepoTabs } from "../../lib/store/repoTabs";
import { useShell } from "../../lib/store/shell";
import type { ShellActions } from "../../lib/store/shell";
import type { ShortcutId } from "../../lib/shortcuts";
import { closeRepoTab } from "../../app/closeRepoTab";
import { useExternalTool } from "../settings/useExternalTool";

export type CommandGroup = "Actions" | "Open repositories" | "Recent repositories";

export interface Command {
  id: string;
  label: string;
  detail?: string;
  group: CommandGroup;
  shortcutId?: ShortcutId;
  disabledReason: string | null;
  run(): void;
}

const THEME_LABEL: Record<ThemePref, string> = {
  system: "Theme: System",
  light: "Theme: Light",
  dark: "Theme: Dark",
};

/**
 * The commands the palette lists, in group order: the always-available actions, the active
 * repository's actions (only when a pane has published them), the other open tabs and the recent
 * repositories not already open. It reads the published `repoActions`, never a network hook.
 */
export function useCommands(actions: ShellActions): Command[] {
  const theme = useAppearancePrefs((s) => s.theme);
  const setTheme = useAppearancePrefs((s) => s.setTheme);
  const repoActions = useShell((s) => s.repoActions);
  const tabs = useRepoTabs((s) => s.tabs);
  const activeId = useRepoTabs((s) => s.activeId);
  const activate = useRepoTabs((s) => s.activate);
  const editor = useExternalTool("editor");
  const recent = useQuery({ queryKey: queryKeys.recent, queryFn: () => listRecent() });

  const commands: Command[] = [];

  const push = (c: Omit<Command, "disabledReason"> & { disabledReason?: string | null }) =>
    commands.push({ disabledReason: null, ...c });

  // Always available.
  push({
    id: "openRepo",
    label: "Open repository…",
    group: "Actions",
    shortcutId: "openRepo",
    run: actions.openRepo,
  });
  push({
    id: "cloneRepo",
    label: "Clone repository…",
    group: "Actions",
    shortcutId: "cloneRepo",
    run: actions.cloneRepo,
  });
  push({
    id: "openSettings",
    label: "Open settings",
    group: "Actions",
    shortcutId: "settings",
    run: () => useShell.getState().open({ kind: "settings" }),
  });
  push({
    id: "showShortcuts",
    label: "Show keyboard shortcuts",
    group: "Actions",
    shortcutId: "shortcuts",
    run: () => useShell.getState().open({ kind: "shortcuts" }),
  });
  for (const value of ["system", "light", "dark"] as const) {
    push({
      id: `theme-${value}`,
      label: THEME_LABEL[value],
      group: "Actions",
      detail: theme === value ? "Current" : undefined,
      run: () => setTheme(value),
    });
  }
  push({
    id: "startScreen",
    label: "Go to start screen",
    group: "Actions",
    run: () => activate(null),
  });

  // The active repository's actions, from the pane's published registry.
  if (repoActions !== null) {
    const { gates, path } = repoActions;
    push({
      id: "fetch",
      label: "Fetch",
      group: "Actions",
      shortcutId: "fetch",
      detail: gates.fetch ?? undefined,
      disabledReason: gates.fetch,
      run: repoActions.fetch,
    });
    push({
      id: "pull",
      label: "Pull",
      group: "Actions",
      shortcutId: "pull",
      detail: gates.pull ?? undefined,
      disabledReason: gates.pull,
      run: repoActions.pull,
    });
    push({
      id: "push",
      label: "Push",
      group: "Actions",
      shortcutId: "push",
      detail: gates.push ?? undefined,
      disabledReason: gates.push,
      run: repoActions.push,
    });
    push({
      id: "fileHistory",
      label: "File history…",
      group: "Actions",
      shortcutId: "fileHistory",
      run: repoActions.fileHistory,
    });
    push({
      id: "openInEditor",
      label: "Open repository in editor",
      group: "Actions",
      run: () => void editor.run(() => openInEditor(path)),
    });
    push({
      id: "closeTab",
      label: "Close repository tab",
      group: "Actions",
      shortcutId: "closeTab",
      run: () => closeRepoTab(repoActions.repoId),
    });
  }

  // Every other open tab.
  for (const tab of tabs) {
    if (tab.id === activeId) continue;
    push({
      id: `switch-${tab.id}`,
      label: `Switch to ${tab.summary.name}`,
      group: "Open repositories",
      run: () => activate(tab.id),
    });
  }

  // Recent repositories not already open.
  const openPaths = new Set(tabs.map((t) => t.summary.path));
  for (const repo of recent.data ?? []) {
    if (openPaths.has(repo.path)) continue;
    push({
      id: `open-${repo.path}`,
      label: `Open ${repo.name}`,
      group: "Recent repositories",
      run: () => actions.openPath(repo.path),
    });
  }

  return commands;
}
