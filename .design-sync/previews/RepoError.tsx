import { RepoError } from "git-real";

const noop = () => {};

const frame = { width: 640 } as const;

/** A transient failure: Retry sits before Dismiss. */
export const Retryable = () => (
  <div style={frame}>
    <RepoError
      error={{
        kind: "io",
        message:
          "Could not read /home/jason/code/git-real/.git/index: Permission denied (os error 13).",
      }}
      path="/home/jason/code/git-real"
      onRetry={noop}
      onDismiss={noop}
    />
  </div>
);

/** A folder that is not a repository offers to initialise one. */
export const NotARepository = () => (
  <div style={frame}>
    <RepoError
      error={{
        kind: "notARepository",
        message: "/home/jason/code/scratch is not a Git repository.",
      }}
      path="/home/jason/code/scratch"
      onInitHere={noop}
      onDismiss={noop}
    />
  </div>
);

/** Only Dismiss, in the compact panel variant used by narrow sidebars. */
export const PanelDismissable = () => (
  <div style={{ width: 300 }}>
    <RepoError
      variant="panel"
      error={{
        kind: "pathNotFound",
        message: "Folder no longer exists.",
      }}
      path="/mnt/work/old-checkout"
      onDismiss={noop}
    />
  </div>
);
