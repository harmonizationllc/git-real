import { StatusBadge } from "git-real";

const KINDS = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "typeChange",
  "untracked",
  "conflicted",
] as const;

const WORDS: Record<(typeof KINDS)[number], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  typeChange: "type change",
  untracked: "untracked",
  conflicted: "conflicted",
};

/** Every change kind the badge can show, with its label beside it. */
export const AllKinds = () => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
    {KINDS.map((kind) => (
      <span key={kind} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
        <StatusBadge kind={kind} />
        <span style={{ fontSize: "var(--text-sm)" }}>{WORDS[kind]}</span>
      </span>
    ))}
  </div>
);

export const Modified = () => <StatusBadge kind="modified" />;

export const Conflicted = () => <StatusBadge kind="conflicted" />;
