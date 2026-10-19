import { describe, expect, it } from "vitest";
import type {
  AppErrorKind,
  BranchList,
  HeadState,
  LocalBranch,
  RemoteBranch,
  RemoteGroup,
  Tracking,
  CommitConfig,
  CommitDetail,
  GraphEdge,
  GraphRow,
  LogPage,
  LogSummary,
  RefKind,
  RefLabel,
  ResetMode,
  Signature,
  CommitMessage,
  CommitOutcome,
  SigningFormat,
  ChangeKind,
  DiffLine,
  FileDiff,
  Hunk,
  HunkSelection,
  RepoChangedPayload,
  StatusEntry,
  WorkingTreeStatus,
} from "./types";

// Compile-time parity with the Rust DTOs: every field is spelled out, so `tsc` fails when a
// field is added, removed or renamed on one side only. Runtime assertions keep the file honest.
describe("worktree DTO shapes", () => {
  it("should accept a StatusEntry carrying every field", () => {
    const entry: StatusEntry = {
      path: "a.txt",
      oldPath: "b.txt",
      index: "renamed",
      worktree: null,
      conflicted: false,
    };
    expect(Object.keys(entry).sort()).toEqual([
      "conflicted",
      "index",
      "oldPath",
      "path",
      "worktree",
    ]);
  });

  it("should accept a WorkingTreeStatus carrying every field", () => {
    const status: WorkingTreeStatus = { entries: [], headUnborn: true };
    expect(Object.keys(status).sort()).toEqual(["entries", "headUnborn"]);
  });

  it("should accept a DiffLine carrying every field", () => {
    const line: DiffLine = {
      kind: "addition",
      oldLineno: null,
      newLineno: 3,
      content: "x\n",
      noNewlineAtEof: true,
    };
    expect(Object.keys(line).sort()).toEqual([
      "content",
      "kind",
      "newLineno",
      "noNewlineAtEof",
      "oldLineno",
    ]);
  });

  it("should accept a Hunk carrying every field", () => {
    const hunk: Hunk = {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      header: "@@ -1,2 +1,3 @@",
      lines: [],
    };
    expect(Object.keys(hunk).sort()).toEqual([
      "header",
      "lines",
      "newLines",
      "newStart",
      "oldLines",
      "oldStart",
    ]);
  });

  it("should accept a FileDiff carrying every field", () => {
    const diff: FileDiff = {
      path: "a.txt",
      oldPath: null,
      scope: "staged",
      change: null,
      isBinary: false,
      hunks: [],
      truncated: false,
      oldEncoding: null,
      newEncoding: null,
    };
    expect(Object.keys(diff).sort()).toEqual([
      "change",
      "hunks",
      "isBinary",
      "newEncoding",
      "oldEncoding",
      "oldPath",
      "path",
      "scope",
      "truncated",
    ]);
  });

  it("should accept a HunkSelection and a RepoChangedPayload carrying every field", () => {
    const selection: HunkSelection = { hunkIndex: 0, lines: null };
    const payload: RepoChangedPayload = { repoId: 1 };
    expect(Object.keys(selection).sort()).toEqual(["hunkIndex", "lines"]);
    expect(Object.keys(payload)).toEqual(["repoId"]);
  });

  it("should cover every ChangeKind and the three new AppErrorKind members", () => {
    const changes: Record<ChangeKind, true> = {
      added: true,
      modified: true,
      deleted: true,
      renamed: true,
      typeChange: true,
      untracked: true,
      conflicted: true,
    };
    const kinds: AppErrorKind[] = ["noChanges", "badSelection", "applyFailed"];
    expect(Object.keys(changes)).toHaveLength(7);
    expect(kinds).toHaveLength(3);
  });
});

// Compile-time parity with the Rust commit DTOs.
describe("commit DTO shapes", () => {
  it("should accept a CommitMessage, CommitConfig and CommitOutcome carrying every field", () => {
    const message: CommitMessage = { subject: "s", body: "b" };
    const config: CommitConfig = { name: "n", email: "e", signing: "openPgp" };
    const outcome: CommitOutcome = { oid: "abc", summary: "s" };
    expect([
      Object.keys(message).sort(),
      Object.keys(config).sort(),
      Object.keys(outcome).sort(),
    ]).toEqual([
      ["body", "subject"],
      ["email", "name", "signing"],
      ["oid", "summary"],
    ]);
  });

  it("should cover every SigningFormat and the three commit AppErrorKind members", () => {
    const formats: Record<SigningFormat, true> = { openPgp: true, x509: true, ssh: true };
    const kinds: AppErrorKind[] = ["emptyMessage", "nothingToCommit", "commitFailed"];
    expect(Object.keys(formats)).toHaveLength(3);
    expect(kinds).toHaveLength(3);
  });
});

// Compile-time parity with the Rust branch DTOs; `tsc` fails until the types exist.
describe("branch DTO shapes", () => {
  it("should accept a Tracking and a LocalBranch carrying every field", () => {
    const tracking: Tracking = { upstream: "origin/main", ahead: 1, behind: null };
    const branch: LocalBranch = { name: "main", oid: "abc", isHead: true, tracking };
    expect(Object.keys(tracking).sort()).toEqual(["ahead", "behind", "upstream"]);
    expect(Object.keys(branch).sort()).toEqual(["isHead", "name", "oid", "tracking"]);
  });

  it("should accept a RemoteBranch, RemoteGroup and BranchList carrying every field", () => {
    const remote: RemoteBranch = { remote: "origin", name: "main", oid: "abc" };
    const group: RemoteGroup = { remote: "origin", branches: [remote] };
    const list: BranchList = {
      head: { kind: "branch", name: "main" },
      local: [],
      remotes: [group],
    };
    expect(Object.keys(remote).sort()).toEqual(["name", "oid", "remote"]);
    expect(Object.keys(group).sort()).toEqual(["branches", "remote"]);
    expect(Object.keys(list).sort()).toEqual(["head", "local", "remotes"]);
  });

  it("should cover every HeadState variant", () => {
    const heads: HeadState[] = [
      { kind: "branch", name: "main" },
      { kind: "detached", oid: "abc" },
      { kind: "unborn", name: "main" },
    ];
    expect(heads.map((h) => h.kind)).toEqual(["branch", "detached", "unborn"]);
  });

  it("should cover the ten branch AppErrorKind members", () => {
    const kinds: AppErrorKind[] = [
      "invalidBranchName",
      "branchExists",
      "branchNotFound",
      "branchNotMerged",
      "cannotDeleteCurrent",
      "unbornHead",
      "revisionNotFound",
      "remoteNotFound",
      "checkoutFailed",
      "pushFailed",
    ];
    expect(kinds).toHaveLength(10);
  });
});

// Compile-time parity with the Rust commit graph DTOs; `tsc` fails until the types exist.
describe("commit graph DTO shapes", () => {
  it("should accept a RefLabel and a GraphEdge carrying every field", () => {
    const label: RefLabel = { kind: "branch", name: "main", isHead: true };
    const edge: GraphEdge = { top: null, bottom: 2 };
    expect(Object.keys(label).sort()).toEqual(["isHead", "kind", "name"]);
    expect(Object.keys(edge).sort()).toEqual(["bottom", "top"]);
  });

  it("should cover every RefKind", () => {
    const kinds: Record<RefKind, true> = { head: true, branch: true, remote: true, tag: true };
    expect(Object.keys(kinds).sort()).toEqual(["branch", "head", "remote", "tag"]);
  });

  it("should accept a GraphRow carrying every field", () => {
    const row: GraphRow = {
      oid: "abc",
      parents: ["def"],
      subject: "s",
      authorName: "n",
      authorEmail: "e",
      authorTime: 1,
      lane: 0,
      edges: [],
      refs: [],
    };
    expect(Object.keys(row).sort()).toEqual([
      "authorEmail",
      "authorName",
      "authorTime",
      "edges",
      "lane",
      "oid",
      "parents",
      "refs",
      "subject",
    ]);
  });

  it("should accept a LogSummary and a LogPage carrying every field", () => {
    const summary: LogSummary = { generation: 1, total: 2, maxLanes: 3 };
    const page: LogPage = { start: 0, rows: [] };
    expect(Object.keys(summary).sort()).toEqual(["generation", "maxLanes", "total"]);
    expect(Object.keys(page).sort()).toEqual(["rows", "start"]);
  });

  it("should accept a Signature and a CommitDetail carrying every field", () => {
    const signature: Signature = { name: "n", email: "e", time: 1 };
    const detail: CommitDetail = {
      oid: "abc",
      parents: [],
      message: { subject: "s", body: "b" },
      author: signature,
      committer: signature,
    };
    expect(Object.keys(signature).sort()).toEqual(["email", "name", "time"]);
    expect(Object.keys(detail).sort()).toEqual([
      "author",
      "committer",
      "message",
      "oid",
      "parents",
    ]);
  });

  it("should cover every ResetMode and the two commit graph AppErrorKind members", () => {
    const modes: Record<ResetMode, true> = { soft: true, mixed: true, hard: true };
    const kinds: AppErrorKind[] = ["logStale", "commitNotFound"];
    expect(Object.keys(modes)).toEqual(["soft", "mixed", "hard"]);
    expect(kinds).toHaveLength(2);
  });
});
