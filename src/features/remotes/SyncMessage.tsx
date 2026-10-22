import { NetworkError } from "./NetworkError";
import type { MessageAction } from "./networkMessage";
import type { RemotesTarget } from "./remotesTarget";
import type { SyncActions } from "./useSyncActions";

export interface SyncMessageProps {
  sync: SyncActions;
  onOpenRemotes(target: RemotesTarget): void;
}

/** The last sync failure as a NetworkError, in its own row below the toolbar; its actions drive `sync`. */
export function SyncMessage({ sync, onOpenRemotes }: SyncMessageProps) {
  if (sync.message === null) return null;

  const onAction = (kind: MessageAction) => {
    switch (kind) {
      case "pull":
        sync.pull();
        break;
      case "fetch":
        sync.fetch();
        break;
      case "editRemote":
        onOpenRemotes(
          sync.upstreamRemote === null
            ? { mode: "list" }
            : { mode: "edit", name: sync.upstreamRemote },
        );
        break;
      case "addRemote":
        onOpenRemotes({ mode: "add" });
        break;
    }
  };

  return (
    <NetworkError message={sync.message} onAction={onAction} onDismiss={sync.dismissMessage} />
  );
}
