import { useRef, useState } from "react";
import type { MouseEvent } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ContextMenu } from "../../components/ContextMenu";
import type { MenuItem } from "../../components/ContextMenu";
import { CredentialDialog } from "./CredentialDialog";
import { NetworkError } from "./NetworkError";
import type { MessageAction } from "./networkMessage";
import type { RemotesTarget } from "./remotesTarget";
import { SetUpstreamDialog } from "./SetUpstreamDialog";
import { busyLabel, forcePushCopy } from "./syncCopy";
import type { SyncVerb } from "./syncCopy";
import styles from "./SyncToolbar.module.css";
import type { SyncActions } from "./useSyncActions";

export interface SyncToolbarProps {
  sync: SyncActions;
  onOpenRemotes(target: RemotesTarget): void;
}

type OpenMenu = { verb: "pull" | "push"; x: number; y: number };

/** The header's sync controls: upstream state, Fetch, Pull, Push, Remotes…, and their dialogs. */
export function SyncToolbar({ sync, onOpenRemotes }: SyncToolbarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const { gates, upstream, running } = sync;

  const label = (verb: SyncVerb, idle: string) => (running === verb ? busyLabel(verb) : idle);

  const openMenu = (verb: OpenMenu["verb"]) => (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ verb, x: r.left, y: r.bottom });
  };

  const menuItems: MenuItem[] =
    menu?.verb === "push"
      ? [
          {
            id: "force",
            label: "Force push (with lease)…",
            disabled: gates.forcePush !== null,
            title: gates.forcePush ?? undefined,
            onSelect: sync.requestForcePush,
          },
        ]
      : [
          { id: "merge", label: "Pull (merge)", onSelect: () => sync.pull("merge") },
          { id: "rebase", label: "Pull (rebase)", onSelect: () => sync.pull("rebase") },
        ];

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

  const force =
    sync.forcePush &&
    forcePushCopy(sync.forcePush.local, sync.forcePush.remote, sync.forcePush.upstream);

  return (
    <>
      <div
        ref={rootRef}
        role="group"
        aria-label="Sync"
        tabIndex={-1}
        data-focus-target
        className={styles.root}
      >
        {upstream !== null && (
          <span className={styles.upstream}>
            <span>{upstream.text}</span>
            {upstream.ahead > 0 && (
              <span role="img" aria-label={`${upstream.ahead} ahead`}>
                ↑{upstream.ahead}
              </span>
            )}
            {upstream.behind > 0 && (
              <span role="img" aria-label={`${upstream.behind} behind`}>
                ↓{upstream.behind}
              </span>
            )}
          </span>
        )}
        <button
          type="button"
          disabled={gates.fetch !== null}
          title={gates.fetch ?? undefined}
          onClick={() => sync.fetch()}
        >
          {label("fetch", "Fetch")}
        </button>
        <span className={styles.split}>
          <button
            type="button"
            disabled={gates.pull !== null}
            title={gates.pull ?? undefined}
            onClick={() => sync.pull()}
          >
            {label("pull", "Pull")}
          </button>
          <button
            type="button"
            aria-label="Pull options"
            aria-haspopup="menu"
            disabled={gates.pull !== null}
            title={gates.pull ?? undefined}
            onClick={openMenu("pull")}
          >
            ▾
          </button>
        </span>
        <span className={styles.split}>
          <button
            type="button"
            disabled={gates.push !== null}
            title={gates.push ?? undefined}
            onClick={() => sync.push()}
          >
            {label("push", "Push")}
          </button>
          <button
            type="button"
            aria-label="Push options"
            aria-haspopup="menu"
            disabled={gates.push !== null}
            title={gates.push ?? undefined}
            onClick={openMenu("push")}
          >
            ▾
          </button>
        </span>
        <button type="button" onClick={() => onOpenRemotes({ mode: "list" })}>
          Remotes…
        </button>
      </div>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
        fallbackFocus={rootRef}
      />
      {sync.message !== null && (
        <NetworkError message={sync.message} onAction={onAction} onDismiss={sync.dismissMessage} />
      )}
      {sync.setUpstream !== null && (
        <SetUpstreamDialog
          remotes={sync.setUpstream.remotes}
          branch={sync.setUpstream.branch}
          error={sync.setUpstream.error}
          pending={running === "push"}
          onPublish={sync.publish}
          onCancel={sync.cancelSetUpstream}
          fallbackFocus={rootRef}
        />
      )}
      <ConfirmDialog
        open={force !== null}
        title={force?.title ?? ""}
        body={force?.body}
        confirmLabel="Force push"
        danger
        pending={running === "push"}
        onConfirm={sync.confirmForcePush}
        onCancel={sync.cancelForcePush}
        fallbackFocus={rootRef}
      />
      {/* Last, so a sign-in asked for during Publish or Force push paints above that dialog. */}
      <CredentialDialog prompt={sync.prompt} fallbackFocus={rootRef} />
    </>
  );
}
