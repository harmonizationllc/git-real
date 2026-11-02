import { HunkHeader } from "git-real";

const noop = () => {};

const frame = { width: 760 } as const;

/** Unstaged: Stage and Discard act on the whole hunk when no lines are selected. */
export const Unstaged = () => (
  <div style={frame}>
    <HunkHeader
      header="@@ -42,7 +42,9 @@ export function LaneGraph({ rows }: Props) {"
      scope="unstaged"
      selectedCount={0}
      onAction={noop}
    />
  </div>
);

/** Staged: a single Unstage action; with lines selected it counts them. */
export const Staged = () => (
  <div style={frame}>
    <HunkHeader
      header="@@ -118,6 +120,11 @@ function laneColor(index: number) {"
      scope="staged"
      selectedCount={3}
      onAction={noop}
    />
  </div>
);

/** Buttons disable, with the reason as their tooltip, while another operation runs. */
export const Disabled = () => (
  <div style={frame}>
    <HunkHeader
      header="@@ -7,4 +7,5 @@ import { useRepo } from './useRepo';"
      scope="unstaged"
      selectedCount={0}
      disabledReason="A rebase is in progress."
      onAction={noop}
    />
  </div>
);

/** A commit's diff is read-only: just the range text, no actions. */
export const ReadOnly = () => (
  <div style={frame}>
    <HunkHeader
      header="@@ -1,12 +1,14 @@ # Git Real"
      scope={{ commit: "a3f9c2e81b7d4056f1e2c9a8d7b6a5f4e3d2c1b0" }}
      selectedCount={0}
    />
  </div>
);
