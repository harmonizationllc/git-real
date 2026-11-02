import { SyncMessage } from "git-real";

const noop = () => {};

const ready = { fetch: null, pull: null, push: null, forcePush: null };

const sync = (message: {
  title: string;
  hint: string | null;
  action: { kind: "pull" | "fetch" | "editRemote" | "addRemote"; label: string } | null;
  details: string | null;
}) =>
  ({
    gates: ready,
    upstream: { text: "→ origin/main", ahead: 1, behind: 0 },
    upstreamRemote: "origin",
    running: null,
    fetch: noop,
    pull: noop,
    push: noop,
    requestForcePush: noop,
    message,
    dismissMessage: noop,
    prompt: null,
    setUpstream: null,
    publish: noop,
    cancelSetUpstream: noop,
    forcePush: null,
    confirmForcePush: noop,
    cancelForcePush: noop,
  }) as const;

const frame = { width: 560, padding: "0 var(--space-3, 12px)" } as const;

/** A rejected push offers Pull as the next step. */
export const PushRejected = () => (
  <div style={frame}>
    <SyncMessage
      onOpenRemotes={noop}
      sync={sync({
        title: "The remote has commits you don't have",
        hint: "Pull, then push again.",
        action: { kind: "pull", label: "Pull" },
        details:
          "! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'git@github.com:harmonizationllc/git-real.git'",
      })}
    />
  </div>
);

/** A missing repository points at the remote's URL. */
export const RepoNotFound = () => (
  <div style={frame}>
    <SyncMessage
      onOpenRemotes={noop}
      sync={sync({
        title: "Repository not found",
        hint: "Check the remote URL, and that your account can access it.",
        action: { kind: "editRemote", label: "Edit remote…" },
        details: null,
      })}
    />
  </div>
);

/** No automatic fix: only a hint and Dismiss. */
export const SignInRequired = () => (
  <div style={frame}>
    <SyncMessage
      onOpenRemotes={noop}
      sync={sync({
        title: "Sign-in required",
        hint: "Set up a git credential helper for this host, then try again.",
        action: null,
        details: null,
      })}
    />
  </div>
);
