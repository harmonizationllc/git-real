import { BranchRow } from "git-real";

const noop = () => {};
const list = { listStyle: "none", margin: 0, padding: 0, width: 360 } as const;

const local = (
  name: string,
  tracking: { ahead: number | null; behind: number | null } | null,
  worktree: string | null = null,
) => ({
  kind: "local" as const,
  branch: {
    name,
    oid: "9f3c2a71d0b84e5a6c1f7b2e8d4a09c3b5e61f27",
    isHead: false,
    tracking,
    worktree,
  },
});

const remote = (name: string) => ({
  kind: "remote" as const,
  branch: { remote: "origin", name, oid: "4be81c09a7d2f35e6b0c1a8d9e72f4036ab5c1d8" },
});

/** Local branches: the current one, one ahead and behind, one checked out in a linked worktree. */
export const LocalBranches = () => (
  <ul style={list}>
    <BranchRow
      target={local("main", { ahead: 0, behind: 0 })}
      current={true}
      onActivate={noop}
      onContextMenu={noop}
    />
    <BranchRow
      target={local("feature/refs-column-polish", { ahead: 3, behind: 1 })}
      current={false}
      onActivate={noop}
      onContextMenu={noop}
    />
    <BranchRow
      target={local("fix/config-read-crash", { ahead: null, behind: null })}
      current={false}
      onActivate={noop}
      onContextMenu={noop}
    />
    <BranchRow
      target={local("release/0.1", null, "/home/dev/code/git-real-release")}
      current={false}
      onActivate={noop}
      onContextMenu={noop}
    />
  </ul>
);

/** Remote-tracking branches under origin. */
export const RemoteBranches = () => (
  <ul style={list}>
    <BranchRow target={remote("main")} current={false} onActivate={noop} onContextMenu={noop} />
    <BranchRow
      target={remote("feature/refs-column-polish")}
      current={false}
      onActivate={noop}
      onContextMenu={noop}
    />
    <BranchRow
      target={remote("release/0.1")}
      current={false}
      onActivate={noop}
      onContextMenu={noop}
    />
  </ul>
);

const dragBase = {
  onDragStart: noop,
  onDragEnd: noop,
  onDragEnter: noop,
  onDragLeave: noop,
  onDrop: noop,
};

/** Drag-to-merge: the current branch is the drop target with a branch hovering over it. */
export const DragTarget = () => (
  <ul style={list}>
    <BranchRow
      target={local("main", { ahead: 0, behind: 0 })}
      current={true}
      drag={{ ...dragBase, draggable: false, target: true, over: true }}
      onActivate={noop}
      onContextMenu={noop}
    />
    <BranchRow
      target={local("feature/refs-column-polish", { ahead: 3, behind: 1 })}
      current={false}
      drag={{ ...dragBase, draggable: true, target: false, over: false }}
      onActivate={noop}
      onContextMenu={noop}
    />
    <BranchRow
      target={local("fix/config-read-crash", { ahead: 1, behind: 0 })}
      current={false}
      drag={{ ...dragBase, draggable: true, target: false, over: false }}
      onActivate={noop}
      onContextMenu={noop}
    />
  </ul>
);
