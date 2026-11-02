import { NetworkError } from "git-real";

const noop = () => {};

const frame = { width: 560 } as const;

/** A failure with a suggested next step, a hint and git's output behind Details. */
export const WithAction = () => (
  <div style={frame}>
    <NetworkError
      message={{
        title: "The remote branch moved since your last fetch",
        hint: "Fetch and review the new commits before forcing again.",
        action: { kind: "fetch", label: "Fetch" },
        details:
          "To github.com:harmonizationllc/git-real.git\n ! [rejected]        feature/tokens -> feature/tokens (stale info)",
      }}
      onAction={noop}
      onDismiss={noop}
    />
  </div>
);

/** No suggested action: Dismiss is the only button. */
export const DismissOnly = () => (
  <div style={frame}>
    <NetworkError
      message={{
        title: "Could not reach the remote",
        hint: "Check your network connection and the remote URL.",
        action: null,
        details: null,
      }}
      onDismiss={noop}
    />
  </div>
);

/** `flush` drops the side margin so the panel lines up inside a padded container. */
export const Flush = () => (
  <div
    style={{
      ...frame,
      padding: "0 var(--space-3, 12px)",
      background: "var(--color-surface, transparent)",
    }}
  >
    <NetworkError
      flush
      message={{
        title: "Host key not trusted",
        hint: "Connect once from a terminal (ssh -T git@github.com) to verify and save the host key.",
        action: null,
        details: null,
      }}
      onDismiss={noop}
    />
  </div>
);
