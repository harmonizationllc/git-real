import { describe, expect, it } from "vitest";
import type {
  AppErrorKind,
  CommitConfig,
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
