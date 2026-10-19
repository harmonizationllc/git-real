import type { CommitDetail, GraphRow, RefKind, RefLabel } from "../lib/ipc";

/** A full 40-hex oid whose first seven characters are unique per `n` (0000001 for n = 0). */
export const oidOf = (n: number) => `${(n + 1).toString(16).padStart(7, "0")}${"a".repeat(33)}`;

export const shortOf = (oid: string) => oid.slice(0, 7);

export const ref = (kind: RefKind, name: string, isHead = false): RefLabel => ({
  kind,
  name,
  isHead,
});

/** The graph row at history index `n`: lane 0, no edges or refs unless overridden. */
export const makeRow = (n: number, over: Partial<GraphRow> = {}): GraphRow => ({
  oid: oidOf(n),
  parents: [oidOf(n + 1)],
  subject: `Subject ${n}`,
  authorName: "Alice",
  authorEmail: "alice@x.io",
  authorTime: 1_700_000_000,
  lane: 0,
  edges: [],
  refs: [],
  ...over,
});

export const commitDetail = (over: Partial<CommitDetail> = {}): CommitDetail => ({
  oid: oidOf(0),
  parents: [oidOf(1)],
  message: { subject: "Fix the thing", body: "Line one\nLine two" },
  author: { name: "Alice", email: "alice@x.io", time: 1_700_000_000 },
  committer: { name: "Alice", email: "alice@x.io", time: 1_700_000_000 },
  ...over,
});
