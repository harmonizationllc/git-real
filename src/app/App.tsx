import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { CloneDialog } from "../features/repo/CloneDialog";
import { StartScreen } from "../features/repo/StartScreen";
import { closeRepo, isAppError } from "../lib/ipc";
import type { RepoId } from "../lib/ipc";
import { queryClient } from "../lib/query/client";
import { useCommitDraft } from "../lib/store/commitDraft";
import { useRepoTabs } from "../lib/store/repoTabs";
import { useWorkspace } from "../lib/store/workspace";
import styles from "./App.module.css";
import { RepoPane } from "./RepoPane";
import { TabBar } from "./TabBar";

function closeRepoTab(id: RepoId): void {
  useRepoTabs.getState().closeTab(id);
  useWorkspace.getState().clear(id);
  useCommitDraft.getState().clear(id);
  closeRepo(id).catch((e: unknown) => {
    if (isAppError(e) && e.kind === "unknownRepo") return;
    console.error("close_repo failed", e);
  });
}

export default function App(): React.JSX.Element {
  const tabs = useRepoTabs((s) => s.tabs);
  const activeId = useRepoTabs((s) => s.activeId);
  const activate = useRepoTabs((s) => s.activate);
  const [cloneOpen, setCloneOpen] = useState(false);
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  return (
    <QueryClientProvider client={queryClient}>
      <div className={styles.root}>
        <header className={styles.header}>
          <TabBar tabs={tabs} activeId={activeId} onActivate={activate} onClose={closeRepoTab} />
        </header>
        <main className={styles.body}>
          {activeTab !== null ? (
            <RepoPane tab={activeTab} />
          ) : (
            <StartScreen onClone={() => setCloneOpen(true)} />
          )}
        </main>
        <CloneDialog open={cloneOpen} onClose={() => setCloneOpen(false)} />
      </div>
    </QueryClientProvider>
  );
}
