import { RefLabels } from "git-real";

const cell = {
  width: 440,
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: "var(--text-sm)",
  whiteSpace: "nowrap",
} as const;

const subject = <span style={{ color: "var(--color-text-muted)" }}>fix(graph): panel variant</span>;

/** HEAD, a local branch, a remote branch and a tag on one commit. */
export const HeadAndBranches = () => (
  <div style={cell}>
    <RefLabels
      refs={[
        { kind: "branch", name: "main", isHead: true },
        { kind: "remote", name: "origin/main", isHead: false },
        { kind: "tag", name: "v0.3.0", isHead: false },
      ]}
    />
    {subject}
  </div>
);

/** More refs than fit: the overflow collapses into a +n pill. */
export const Many = () => (
  <div style={{ ...cell, width: 320 }}>
    <RefLabels
      refs={[
        { kind: "branch", name: "feature/refs-column-polish", isHead: false },
        { kind: "remote", name: "origin/feature/refs-column-polish", isHead: false },
        { kind: "tag", name: "v0.3.0-rc.1", isHead: false },
        { kind: "branch", name: "release/0.3", isHead: false },
        { kind: "tag", name: "v0.3.0", isHead: false },
      ]}
    />
    {subject}
  </div>
);

/** A detached HEAD sitting on a tagged commit. */
export const SingleTag = () => (
  <div style={cell}>
    <RefLabels
      refs={[
        { kind: "head", name: "HEAD", isHead: true },
        { kind: "tag", name: "v0.1.0", isHead: false },
      ]}
    />
    {subject}
  </div>
);
