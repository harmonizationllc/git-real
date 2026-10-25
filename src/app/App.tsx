import { QueryClientProvider } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Toasts } from "../components/Toasts";
import { CloneDialog } from "../features/repo/CloneDialog";
import { StartScreen } from "../features/repo/StartScreen";
import { useOpenRepo } from "../features/repo/useOpenRepo";
import { ShortcutsDialog } from "../features/settings/ShortcutsDialog";
import { pickFolder } from "../lib/ipc";
import { queryClient } from "../lib/query/client";
import { useRepoTabs } from "../lib/store/repoTabs";
import { useShell } from "../lib/store/shell";
import type { ShellActions } from "../lib/store/shell";
import styles from "./App.module.css";
import { closeRepoTab } from "./closeRepoTab";
import { RepoPane } from "./RepoPane";
import { TabBar } from "./TabBar";
import { useGlobalShortcuts } from "./useGlobalShortcuts";

export default function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}

/** The shell proper; inside the query provider so it can hold the single repo opener. */
function AppShell(): React.JSX.Element {
  const tabs = useRepoTabs((s) => s.tabs);
  const activeId = useRepoTabs((s) => s.activeId);
  const activate = useRepoTabs((s) => s.activate);
  const [cloneOpen, setCloneOpen] = useState(false);
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  const rootRef = useRef<HTMLDivElement>(null);
  const dialog = useShell((s) => s.dialog);
  const closeDialog = useShell((s) => s.close);

  // The single opener, shared by the start screen, the shortcuts hook and (later) the palette.
  const opener = useOpenRepo();
  const actions: ShellActions = {
    openRepo: () => void pickFolder("Open repository").then((p) => p !== null && actions.openPath(p)),
    cloneRepo: () => setCloneOpen(true),
    openPath: async (path) => {
      // A failed open from a shortcut or the palette sends the user back to the start screen,
      // where RepoError can offer "Initialize here".
      if (!(await opener.open(path))) activate(null);
    },
  };
  useGlobalShortcuts(actions);

  return (
    <div ref={rootRef} tabIndex={-1} data-focus-target className={styles.root}>
      <header className={styles.header}>
        <TabBar tabs={tabs} activeId={activeId} onActivate={activate} onClose={closeRepoTab} />
      </header>
      <main className={styles.body}>
        {activeTab !== null ? (
          // Keyed so sync state (messages, prompts, running verb) never leaks across tabs.
          <RepoPane key={activeTab.id} tab={activeTab} />
        ) : (
          <StartScreen opener={opener} onClone={actions.cloneRepo} />
        )}
      </main>
      <CloneDialog open={cloneOpen} onClose={() => setCloneOpen(false)} />
      {dialog?.kind === "shortcuts" && (
        <ShortcutsDialog onClose={closeDialog} fallbackFocus={rootRef} />
      )}
      <Toasts />
    </div>
  );
}
