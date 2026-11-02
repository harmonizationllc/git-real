import { FileHeader } from "git-real";

const noop = () => {};

const frame = { width: 880 } as const;

const common = {
  onViewChange: noop,
  onHistory: noop,
  onClose: noop,
  repoId: 1,
  isStash: false,
} as const;

/** A working-tree file in Diff view with the editor and external diff shortcuts. */
export const Modified = () => (
  <div style={frame}>
    <FileHeader {...common} path="src/features/graph/LaneGraph.tsx" view="diff" scope="unstaged" />
  </div>
);

/** A rename shows old and new path; Blame is selected. */
export const RenamedBlame = () => (
  <div style={frame}>
    <FileHeader
      {...common}
      path="src/features/graph/LaneGraph.tsx"
      oldPath="src/features/graph/Lanes.tsx"
      view="blame"
      scope="staged"
    />
  </div>
);

/** A file in a past commit: Blame disabled with its reason, no editor shortcut. */
export const CommitBlameDisabled = () => (
  <div style={frame}>
    <FileHeader
      {...common}
      path="docs/adr/0004-status-budget.md"
      view="diff"
      scope={{ commit: "a3f9c2e81b7d4056f1e2c9a8d7b6a5f4e3d2c1b0" }}
      blameDisabledReason="Blame is not available for a deleted file."
    />
  </div>
);
