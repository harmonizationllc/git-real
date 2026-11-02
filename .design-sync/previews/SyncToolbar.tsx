import { SyncToolbar } from "git-real";

const noop = () => {};

const ready = { fetch: null, pull: null, push: null, forcePush: null };

const base = {
  gates: ready,
  upstream: { text: "→ origin/main", ahead: 2, behind: 1 },
  upstreamRemote: "origin",
  running: null,
  fetch: noop,
  pull: noop,
  push: noop,
  requestForcePush: noop,
  message: null,
  dismissMessage: noop,
  prompt: null,
  setUpstream: null,
  publish: noop,
  cancelSetUpstream: noop,
  forcePush: null,
  confirmForcePush: noop,
  cancelForcePush: noop,
} as const;

const frame = { width: 560 } as const;

/** A branch two commits ahead of and one behind its upstream. */
export const Idle = () => (
  <div style={frame}>
    <SyncToolbar sync={base} onOpenRemotes={noop} />
  </div>
);

/** A pull in flight: its label changes and every sync button disables. */
export const Busy = () => {
  const busy = "Another network action is running.";
  return (
    <div style={frame}>
      <SyncToolbar
        sync={{
          ...base,
          running: "pull",
          gates: { fetch: busy, pull: busy, push: busy, forcePush: busy },
        }}
        onOpenRemotes={noop}
      />
    </div>
  );
};

/** A local branch that was never published: Pull is gated until an upstream exists. */
export const NoUpstream = () => (
  <div style={frame}>
    <SyncToolbar
      sync={{
        ...base,
        upstream: { text: "no upstream", ahead: 0, behind: 0 },
        upstreamRemote: null,
        gates: {
          fetch: null,
          pull: "This branch has no upstream. Push it to publish.",
          push: null,
          forcePush: "This branch has no upstream. Push it to publish.",
        },
      }}
      onOpenRemotes={noop}
    />
  </div>
);
