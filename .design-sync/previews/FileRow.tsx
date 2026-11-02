import { FileRow } from "git-real";

const noop = () => {};

const list = { listStyle: "none", margin: 0, padding: 0, width: 520 } as const;

/** A staged section: one modified file, one renamed, one added. */
export const Staged = () => (
  <ul style={list}>
    <FileRow
      entry={{
        path: "src/app/App.tsx",
        oldPath: null,
        index: "modified",
        worktree: null,
        conflicted: false,
      }}
      section="staged"
      kind="modified"
      selected={false}
      disabled={false}
      onClick={noop}
      onContextMenu={noop}
      onPrimary={noop}
    />
    <FileRow
      entry={{
        path: "src/features/graph/LaneGraph.tsx",
        oldPath: "src/features/graph/Lanes.tsx",
        index: "renamed",
        worktree: null,
        conflicted: false,
      }}
      section="staged"
      kind="renamed"
      selected={false}
      disabled={false}
      onClick={noop}
      onContextMenu={noop}
      onPrimary={noop}
    />
    <FileRow
      entry={{
        path: "docs/adr/0005-tokens.md",
        oldPath: null,
        index: "added",
        worktree: null,
        conflicted: false,
      }}
      section="staged"
      kind="added"
      selected={false}
      disabled={false}
      onClick={noop}
      onContextMenu={noop}
      onPrimary={noop}
    />
  </ul>
);

/** An unstaged section with Stage and Discard actions; the second row is selected. */
export const Unstaged = () => (
  <ul style={list}>
    <FileRow
      entry={{
        path: "README.md",
        oldPath: null,
        index: null,
        worktree: "modified",
        conflicted: false,
      }}
      section="unstaged"
      kind="modified"
      selected={false}
      disabled={false}
      onClick={noop}
      onContextMenu={noop}
      onPrimary={noop}
      onDiscard={noop}
    />
    <FileRow
      entry={{
        path: "src/styles/tokens.css",
        oldPath: null,
        index: null,
        worktree: "modified",
        conflicted: false,
      }}
      section="unstaged"
      kind="modified"
      selected={true}
      disabled={false}
      onClick={noop}
      onContextMenu={noop}
      onPrimary={noop}
      onDiscard={noop}
    />
    <FileRow
      entry={{
        path: "notes/scratch.txt",
        oldPath: null,
        index: null,
        worktree: "untracked",
        conflicted: false,
      }}
      section="unstaged"
      kind="untracked"
      selected={false}
      disabled={false}
      onClick={noop}
      onContextMenu={noop}
      onPrimary={noop}
      onDiscard={noop}
    />
  </ul>
);

/** Conflicts section while an operation is running: actions disabled. */
export const ConflictsDisabled = () => (
  <ul style={list}>
    <FileRow
      entry={{
        path: "src/lib/ipc/commands.ts",
        oldPath: null,
        index: null,
        worktree: null,
        conflicted: true,
      }}
      section="conflicts"
      kind="conflicted"
      selected={false}
      disabled={true}
      onClick={noop}
      onContextMenu={noop}
      onPrimary={noop}
    />
  </ul>
);
