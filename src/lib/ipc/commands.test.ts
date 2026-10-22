import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import {
  abortOperation,
  addRemote,
  addToGitignore,
  applyHunk,
  checkGitCli,
  checkoutBranch,
  checkoutCommit,
  checkoutRemoteBranch,
  canFastForward,
  cherryPick,
  cloneRepo,
  continueRebase,
  closeRepo,
  commit,
  createBranch,
  createTag,
  deleteBranch,
  deleteRemoteBranch,
  deleteRemoteTag,
  deleteTag,
  discardPaths,
  fetchAll,
  getBlame,
  getOperationState,
  getCommit,
  getCommitFiles,
  getFileHistory,
  listTrackedFiles,
  getCommitConfig,
  getFileContent,
  getFileDiff,
  getHeadMessage,
  getLogPage,
  getLogSummary,
  getStashFiles,
  getStatus,
  initRepo,
  listBranches,
  listRemotes,
  listRecent,
  listStashes,
  listTags,
  mergeBranch,
  openRepo,
  pull,
  pullDefaultMode,
  push,
  pushTag,
  rebaseInteractive,
  rebaseOnto,
  rebasePlan,
  removeRecent,
  removeRemote,
  renameBranch,
  resetToCommit,
  resolveConflicts,
  revertCommit,
  searchLog,
  stageAll,
  stashApply,
  stashDrop,
  stashPop,
  stashPush,
  stagePaths,
  unstageAll,
  unstagePaths,
  updateRemote,
  writeResolution,
} from "./commands";
import { isAppError } from "./errors";
import type {
  BranchList,
  Credentials,
  RemoteInfo,
  FastForwardCheck,
  OperationOutcome,
  OperationState,
  RebaseStep,
  CommitDetail,
  FileDiff,
  GitCliInfo,
  LocalBranch,
  LogPage,
  LogSummary,
  OpenedRepo,
  RecentEntry,
  StashEntry,
  StashFiles,
  TagList,
  WorkingTreeStatus,
} from "./types";

interface Call {
  cmd: string;
  args: unknown;
}

const opened: OpenedRepo = {
  id: 1,
  summary: { path: "/x", name: "x", headBranch: "main", isBare: false },
};
const recent: RecentEntry[] = [{ path: "/a", name: "a", lastOpened: 1700000000 }];

function mockWith(value: unknown): Call[] {
  const calls: Call[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    return value;
  });
  return calls;
}

function mockThrowing(err: unknown): void {
  mockIPC(() => {
    throw err;
  });
}

afterEach(() => {
  clearMocks();
});

// Contract: each wrapper invokes the pinned Rust command name with camelCase args.
describe("command wrappers", () => {
  it("openRepo sends open_repo with path", async () => {
    const calls = mockWith(opened);
    const result = await openRepo("/x");
    expect(calls).toEqual([{ cmd: "open_repo", args: { path: "/x" } }]);
    expect(result).toEqual(opened);
  });

  it("initRepo sends init_repo with path", async () => {
    const calls = mockWith(opened);
    const result = await initRepo("/x");
    expect(calls).toEqual([{ cmd: "init_repo", args: { path: "/x" } }]);
    expect(result).toEqual(opened);
  });

  it("cloneRepo sends clone_repo with url, dest, cloneId", async () => {
    const calls = mockWith(opened);
    const result = await cloneRepo("u", "/d", 7);
    expect(calls).toEqual([{ cmd: "clone_repo", args: { url: "u", dest: "/d", cloneId: 7 } }]);
    expect(result).toEqual(opened);
  });

  it("closeRepo sends close_repo with id", async () => {
    const calls = mockWith(null);
    await closeRepo(3);
    expect(calls).toEqual([{ cmd: "close_repo", args: { id: 3 } }]);
  });

  it("closeRepo resolves to undefined-like void when the backend returns null", async () => {
    mockWith(null);
    await expect(closeRepo(3)).resolves.toBeFalsy();
  });

  it("listRecent sends list_recent with no arguments", async () => {
    const calls = mockWith(recent);
    const result = await listRecent();
    expect(calls).toEqual([{ cmd: "list_recent", args: {} }]);
    expect(result).toEqual(recent);
  });

  it("removeRecent sends remove_recent and returns the updated list", async () => {
    const calls = mockWith(recent);
    const result = await removeRecent("/a");
    expect(calls).toEqual([{ cmd: "remove_recent", args: { path: "/a" } }]);
    expect(result).toEqual(recent);
  });

  it("checkGitCli sends check_git_cli with no arguments", async () => {
    const info: GitCliInfo = { available: false, path: null };
    const calls = mockWith(info);
    const result = await checkGitCli();
    expect(calls).toEqual([{ cmd: "check_git_cli", args: {} }]);
    expect(result).toEqual(info);
  });
});

// Contract: rejections from the backend pass through untouched (spec 5.3).
describe("command rejections", () => {
  it("rejects with the AppError unchanged", async () => {
    const err = { kind: "notARepository", message: "m" };
    mockThrowing(err);
    await expect(openRepo("/x")).rejects.toBe(err);
  });

  it("rejects with a value that isAppError recognises", async () => {
    const err = { kind: "notARepository", message: "m" };
    mockThrowing(err);
    const caught = await openRepo("/x").catch((e: unknown) => e);
    expect(isAppError(caught)).toBe(true);
  });

  it("cloneRepo rejection passes through", async () => {
    const err = { kind: "cloneFailed", message: "fatal: x" };
    mockThrowing(err);
    await expect(cloneRepo("u", "/d", 1)).rejects.toBe(err);
  });

  it.each([
    ["initRepo", () => initRepo("/x")],
    ["closeRepo", () => closeRepo(1)],
    ["listRecent", () => listRecent()],
    ["removeRecent", () => removeRecent("/a")],
    ["checkGitCli", () => checkGitCli()],
  ])("%s rejection passes through", async (_name, call) => {
    const err = { kind: "io", message: "boom" };
    mockThrowing(err);
    await expect(call()).rejects.toBe(err);
  });
});

// Contract: worktree wrappers invoke the pinned Rust command names with camelCase args.
describe("worktree command wrappers", () => {
  const status: WorkingTreeStatus = { entries: [], headUnborn: false };
  const diff: FileDiff = {
    path: "a.txt",
    oldPath: null,
    scope: "unstaged",
    change: "modified",
    isBinary: false,
    hunks: [],
    truncated: false,
    oldEncoding: null,
    newEncoding: null,
  };

  it("getStatus sends get_status with id and returns the status", async () => {
    const calls = mockWith(status);
    const result = await getStatus(1);
    expect(calls).toEqual([{ cmd: "get_status", args: { id: 1 } }]);
    expect(result).toEqual(status);
  });

  it("getFileDiff sends get_file_diff with id, path, scope and ignoreWhitespace", async () => {
    const calls = mockWith(diff);
    const result = await getFileDiff(1, "a.txt", "staged", true);
    expect(calls).toEqual([
      {
        cmd: "get_file_diff",
        args: { id: 1, path: "a.txt", scope: "staged", ignoreWhitespace: true, maxLines: null },
      },
    ]);
    expect(result).toEqual(diff);
  });

  it("getFileDiff forwards maxLines when given", async () => {
    const calls = mockWith(diff);
    await getFileDiff(1, "a.txt", "unstaged", false, 1_000_000);
    expect(calls[0]?.args).toEqual({
      id: 1,
      path: "a.txt",
      scope: "unstaged",
      ignoreWhitespace: false,
      maxLines: 1_000_000,
    });
  });

  it("getFileContent sends get_file_content with id, path, scope and side", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const calls = mockWith(bytes);
    await getFileContent(1, "img.png", "unstaged", "new");
    expect(calls).toEqual([
      { cmd: "get_file_content", args: { id: 1, path: "img.png", scope: "unstaged", side: "new" } },
    ]);
  });

  it("getFileContent returns the bytes the backend answered with", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    mockWith(bytes);
    const result = await getFileContent(1, "img.png", "unstaged", "new");
    expect(result).toBe(bytes);
  });

  it("stagePaths sends stage_paths with id and paths", async () => {
    const calls = mockWith(null);
    await stagePaths(1, ["a", "b"]);
    expect(calls).toEqual([{ cmd: "stage_paths", args: { id: 1, paths: ["a", "b"] } }]);
  });

  it("unstagePaths sends unstage_paths with id and paths", async () => {
    const calls = mockWith(null);
    await unstagePaths(1, ["a"]);
    expect(calls).toEqual([{ cmd: "unstage_paths", args: { id: 1, paths: ["a"] } }]);
  });

  it("stageAll sends stage_all with id only", async () => {
    const calls = mockWith(null);
    await stageAll(2);
    expect(calls).toEqual([{ cmd: "stage_all", args: { id: 2 } }]);
  });

  it("unstageAll sends unstage_all with id only", async () => {
    const calls = mockWith(null);
    await unstageAll(2);
    expect(calls).toEqual([{ cmd: "unstage_all", args: { id: 2 } }]);
  });

  it("discardPaths sends discard_paths with id and paths", async () => {
    const calls = mockWith(null);
    await discardPaths(1, ["a"]);
    expect(calls).toEqual([{ cmd: "discard_paths", args: { id: 1, paths: ["a"] } }]);
  });

  it("applyHunk sends apply_hunk with id, path, action and a hunkIndex selection", async () => {
    const calls = mockWith(null);
    await applyHunk(1, "a.txt", "stage", { hunkIndex: 2, lines: [0, 3] });
    expect(calls).toEqual([
      {
        cmd: "apply_hunk",
        args: { id: 1, path: "a.txt", action: "stage", selection: { hunkIndex: 2, lines: [0, 3] } },
      },
    ]);
  });

  it("applyHunk sends lines null when the whole hunk is selected", async () => {
    const calls = mockWith(null);
    await applyHunk(1, "a.txt", "discard", { hunkIndex: 0, lines: null });
    expect(calls[0]?.args).toEqual({
      id: 1,
      path: "a.txt",
      action: "discard",
      selection: { hunkIndex: 0, lines: null },
    });
  });

  it("addToGitignore sends add_to_gitignore with id and path and returns the pattern", async () => {
    const calls = mockWith("/a.txt");
    const result = await addToGitignore(1, "a.txt");
    expect(calls).toEqual([{ cmd: "add_to_gitignore", args: { id: 1, path: "a.txt" } }]);
    expect(result).toBe("/a.txt");
  });

  it("applyHunk rejection is recognised by isAppError", async () => {
    mockThrowing({ kind: "applyFailed", message: "patch rejected" });
    const caught = await applyHunk(1, "a", "stage", { hunkIndex: 0, lines: null }).catch(
      (e: unknown) => e,
    );
    expect(isAppError(caught)).toBe(true);
  });

  it.each([
    ["getStatus", () => getStatus(1)],
    ["getFileDiff", () => getFileDiff(1, "a", "staged", false)],
    ["getFileContent", () => getFileContent(1, "a", "staged", "old")],
    ["stagePaths", () => stagePaths(1, [])],
    ["unstagePaths", () => unstagePaths(1, [])],
    ["stageAll", () => stageAll(1)],
    ["unstageAll", () => unstageAll(1)],
    ["discardPaths", () => discardPaths(1, [])],
    ["applyHunk", () => applyHunk(1, "a", "stage", { hunkIndex: 0, lines: null })],
    ["addToGitignore", () => addToGitignore(1, "a")],
  ])("%s rejection passes through", async (_name, call) => {
    const err = { kind: "noChanges", message: "nothing" };
    mockThrowing(err);
    await expect(call()).rejects.toBe(err);
  });
});

// Contract: commit wrappers invoke the pinned Rust command names with camelCase args.
describe("commit commands", () => {
  it("getCommitConfig sends get_commit_config with the id", async () => {
    const cfg = { name: "A", email: "a@b.c", signing: null };
    const calls = mockWith(cfg);
    await expect(getCommitConfig(3)).resolves.toEqual(cfg);
    expect(calls).toEqual([{ cmd: "get_commit_config", args: { id: 3 } }]);
  });

  it("getHeadMessage sends get_head_message and passes null through", async () => {
    const calls = mockWith(null);
    await expect(getHeadMessage(3)).resolves.toBeNull();
    expect(calls).toEqual([{ cmd: "get_head_message", args: { id: 3 } }]);
  });

  it("getHeadMessage returns the message when HEAD exists", async () => {
    mockWith({ subject: "S", body: "B" });
    await expect(getHeadMessage(3)).resolves.toEqual({ subject: "S", body: "B" });
  });

  it("commit sends commit with id, message and amend", async () => {
    const out = { oid: "abc", summary: "S" };
    const calls = mockWith(out);
    await expect(commit(3, { subject: "S", body: "B" }, true)).resolves.toEqual(out);
    expect(calls).toEqual([
      { cmd: "commit", args: { id: 3, message: { subject: "S", body: "B" }, amend: true } },
    ]);
  });

  it("commit sends amend false unchanged", async () => {
    const calls = mockWith({ oid: "abc", summary: "S" });
    await commit(3, { subject: "S", body: "" }, false);
    expect(calls[0]?.args).toMatchObject({ amend: false });
  });

  it("commit rejects with the backend's AppError", async () => {
    mockThrowing({ kind: "commitFailed", message: "hook says no" });
    await expect(commit(3, { subject: "S", body: "" }, false)).rejects.toSatisfy(isAppError);
  });

  it("getCommitConfig rejects with the backend's AppError", async () => {
    mockThrowing({ kind: "unknownRepo", message: "gone" });
    await expect(getCommitConfig(3)).rejects.toMatchObject({ kind: "unknownRepo" });
  });
});

// Contract: branch wrappers invoke the pinned Rust command names with camelCase args.
describe("branch commands", () => {
  const list: BranchList = {
    head: { kind: "branch", name: "main" },
    local: [{ name: "main", oid: "abc", isHead: true, tracking: null }],
    remotes: [],
  };
  const created: LocalBranch = { name: "topic", oid: "abc", isHead: false, tracking: null };

  it("listBranches sends list_branches with the id and returns the list", async () => {
    const calls = mockWith(list);
    await expect(listBranches(3)).resolves.toEqual(list);
    expect(calls).toEqual([{ cmd: "list_branches", args: { id: 3 } }]);
  });

  it("createBranch sends create_branch with id, name, startPoint and checkout", async () => {
    const calls = mockWith(created);
    await expect(createBranch(3, "topic", "main", true)).resolves.toEqual(created);
    expect(calls).toEqual([
      {
        cmd: "create_branch",
        args: { id: 3, name: "topic", startPoint: "main", checkout: true },
      },
    ]);
  });

  it("createBranch sends a null startPoint unchanged", async () => {
    const calls = mockWith(created);
    await createBranch(3, "topic", null, false);
    expect(calls[0]?.args).toEqual({ id: 3, name: "topic", startPoint: null, checkout: false });
  });

  it("renameBranch sends rename_branch with id, oldName and newName", async () => {
    const calls = mockWith(null);
    await renameBranch(3, "old", "new");
    expect(calls).toEqual([
      { cmd: "rename_branch", args: { id: 3, oldName: "old", newName: "new" } },
    ]);
  });

  it("deleteBranch sends delete_branch with id, name and force", async () => {
    const calls = mockWith(null);
    await deleteBranch(3, "topic", true);
    expect(calls).toEqual([{ cmd: "delete_branch", args: { id: 3, name: "topic", force: true } }]);
  });

  it("deleteBranch sends force false unchanged", async () => {
    const calls = mockWith(null);
    await deleteBranch(3, "topic", false);
    expect(calls[0]?.args).toMatchObject({ force: false });
  });

  it("checkoutBranch sends checkout_branch with id and name", async () => {
    const calls = mockWith(null);
    await checkoutBranch(3, "topic");
    expect(calls).toEqual([{ cmd: "checkout_branch", args: { id: 3, name: "topic" } }]);
  });

  it("checkoutRemoteBranch sends checkout_remote_branch with id, remote and name", async () => {
    const calls = mockWith(null);
    await checkoutRemoteBranch(3, "origin", "feature/x");
    expect(calls).toEqual([
      {
        cmd: "checkout_remote_branch",
        args: { id: 3, remote: "origin", name: "feature/x" },
      },
    ]);
  });

  it("deleteRemoteBranch sends delete_remote_branch with id, remote and name", async () => {
    const calls = mockWith(null);
    await deleteRemoteBranch(3, "origin", "topic");
    expect(calls).toEqual([
      {
        cmd: "delete_remote_branch",
        args: { id: 3, remote: "origin", name: "topic", credentials: null },
      },
    ]);
  });

  it("branch rejection is recognised by isAppError", async () => {
    mockThrowing({ kind: "branchNotMerged", message: "not merged" });
    await expect(deleteBranch(3, "topic", false)).rejects.toSatisfy(isAppError);
  });

  it.each([
    ["listBranches", () => listBranches(1)],
    ["createBranch", () => createBranch(1, "a", null, false)],
    ["renameBranch", () => renameBranch(1, "a", "b")],
    ["deleteBranch", () => deleteBranch(1, "a", false)],
    ["checkoutBranch", () => checkoutBranch(1, "a")],
    ["checkoutRemoteBranch", () => checkoutRemoteBranch(1, "origin", "a")],
    ["deleteRemoteBranch", () => deleteRemoteBranch(1, "origin", "a")],
  ])("%s rejection passes through", async (_name, call) => {
    const err = { kind: "checkoutFailed", message: "nope" };
    mockThrowing(err);
    await expect(call()).rejects.toBe(err);
  });
});

// Contract: the commit graph wrappers invoke the pinned Rust command names with camelCase args.
describe("commit graph command wrappers", () => {
  it("getLogSummary sends get_log_summary with id", async () => {
    const summary: LogSummary = { generation: 4, total: 10, maxLanes: 2 };
    const calls = mockWith(summary);
    const result = await getLogSummary(3);
    expect(calls).toEqual([{ cmd: "get_log_summary", args: { id: 3 } }]);
    expect(result).toEqual(summary);
  });

  it("getLogPage sends get_log_page with id, generation, start and count", async () => {
    const page: LogPage = { start: 500, rows: [] };
    const calls = mockWith(page);
    const result = await getLogPage(3, 4, 500, 500);
    expect(calls).toEqual([
      { cmd: "get_log_page", args: { id: 3, generation: 4, start: 500, count: 500 } },
    ]);
    expect(result).toEqual(page);
  });

  it("searchLog sends search_log with id, generation and query", async () => {
    const calls = mockWith([2, 9]);
    const result = await searchLog(3, 4, "fix");
    expect(calls).toEqual([{ cmd: "search_log", args: { id: 3, generation: 4, query: "fix" } }]);
    expect(result).toEqual([2, 9]);
  });

  it("getCommit sends get_commit with id and oid", async () => {
    const sig = { name: "n", email: "e", time: 1 };
    const detail: CommitDetail = {
      oid: "abc",
      parents: [],
      message: { subject: "s", body: "" },
      author: sig,
      committer: sig,
    };
    const calls = mockWith(detail);
    const result = await getCommit(3, "abc");
    expect(calls).toEqual([{ cmd: "get_commit", args: { id: 3, oid: "abc" } }]);
    expect(result).toEqual(detail);
  });

  it("checkoutCommit sends checkout_commit with id and oid", async () => {
    const calls = mockWith(null);
    await checkoutCommit(3, "abc");
    expect(calls).toEqual([{ cmd: "checkout_commit", args: { id: 3, oid: "abc" } }]);
  });

  it.each(["soft", "mixed", "hard"] as const)(
    "resetToCommit sends reset_to_commit with id, oid and mode %s",
    async (mode) => {
      const calls = mockWith(null);
      await resetToCommit(3, "abc", mode);
      expect(calls).toEqual([{ cmd: "reset_to_commit", args: { id: 3, oid: "abc", mode } }]);
    },
  );
});

// Contract: a rejected commit graph command surfaces the backend's AppError unchanged.
describe("commit graph command rejections", () => {
  it.each([
    ["getLogSummary", () => getLogSummary(1)],
    ["getLogPage", () => getLogPage(1, 1, 0, 500)],
    ["searchLog", () => searchLog(1, 1, "x")],
    ["getCommit", () => getCommit(1, "abc")],
    ["checkoutCommit", () => checkoutCommit(1, "abc")],
    ["resetToCommit", () => resetToCommit(1, "abc", "hard")],
  ])("%s rejection passes through", async (_name, call) => {
    const err = { kind: "logStale", message: "stale" };
    mockThrowing(err);
    await expect(call()).rejects.toBe(err);
  });
});

// Coverage: zero and empty arguments are sent, not dropped, and keep their number type.
describe("commit graph command argument edges", () => {
  it("getLogPage sends zero generation and start as numbers", async () => {
    const calls = mockWith({ start: 0, rows: [] });
    await getLogPage(0, 0, 0, 1);
    expect(calls).toEqual([
      { cmd: "get_log_page", args: { id: 0, generation: 0, start: 0, count: 1 } },
    ]);
  });

  it("getLogPage sends count and generation as numbers, not strings", async () => {
    const calls = mockWith({ start: 500, rows: [] });
    await getLogPage(3, 12, 500, 500);
    const args = calls[0]?.args as Record<string, unknown>;
    expect([typeof args.generation, typeof args.start, typeof args.count]).toEqual([
      "number",
      "number",
      "number",
    ]);
  });

  it("getLogPage sends only the four documented keys", async () => {
    const calls = mockWith({ start: 0, rows: [] });
    await getLogPage(3, 4, 0, 500);
    expect(Object.keys(calls[0]?.args as object).sort()).toEqual([
      "count",
      "generation",
      "id",
      "start",
    ]);
  });

  it("searchLog sends an empty query unchanged", async () => {
    const calls = mockWith([]);
    await searchLog(3, 4, "");
    expect(calls).toEqual([{ cmd: "search_log", args: { id: 3, generation: 4, query: "" } }]);
  });

  it("searchLog resolves to an empty array when nothing matches", async () => {
    mockWith([]);
    await expect(searchLog(3, 4, "zzz")).resolves.toEqual([]);
  });

  it("getLogPage rejects with a logStale error as is", async () => {
    const err = { kind: "logStale", message: "stale" };
    mockThrowing(err);
    await expect(getLogPage(1, 1, 0, 500)).rejects.toMatchObject({ kind: "logStale" });
  });

  it("getCommit rejects with a commitNotFound error as is", async () => {
    const err = { kind: "commitNotFound", message: "nope" };
    mockThrowing(err);
    await expect(getCommit(1, "dead")).rejects.toBe(err);
  });

  it("checkoutCommit resolves to undefined", async () => {
    mockWith(null);
    await expect(checkoutCommit(1, "abc")).resolves.toBeNull();
  });
});

// Contract: GR-9 history wrappers invoke the pinned command names with camelCase args.
describe("history command wrappers", () => {
  it("listTrackedFiles sends list_tracked_files with id", async () => {
    const calls = mockWith(["a.ts"]);
    const result = await listTrackedFiles(5);
    expect(calls).toEqual([{ cmd: "list_tracked_files", args: { id: 5 } }]);
    expect(result).toEqual(["a.ts"]);
  });

  it("getCommitFiles sends get_commit_files with id and oid", async () => {
    const calls = mockWith([]);
    await getCommitFiles(5, "abc");
    expect(calls).toEqual([{ cmd: "get_commit_files", args: { id: 5, oid: "abc" } }]);
  });

  it("getFileHistory sends get_file_history with id, generation and path", async () => {
    const calls = mockWith([]);
    await getFileHistory(5, 7, "src/a.ts");
    expect(calls).toEqual([
      { cmd: "get_file_history", args: { id: 5, generation: 7, path: "src/a.ts" } },
    ]);
  });

  it("getBlame sends get_blame with id, path and oid", async () => {
    const calls = mockWith({ oid: "abc", path: "a", hunks: [], lines: [] });
    await getBlame(5, "a", "abc");
    expect(calls).toEqual([{ cmd: "get_blame", args: { id: 5, path: "a", oid: "abc" } }]);
  });

  it("getBlame passes a null oid through unchanged", async () => {
    const calls = mockWith({ oid: "abc", path: "a", hunks: [], lines: [] });
    await getBlame(5, "a", null);
    expect(calls[0]?.args).toHaveProperty("oid", null);
    expect(calls).toEqual([{ cmd: "get_blame", args: { id: 5, path: "a", oid: null } }]);
  });

  it("getBlame rejects with a binaryFile error as is", async () => {
    const err = { kind: "binaryFile", message: "binary" };
    mockThrowing(err);
    await expect(getBlame(5, "a.png", null)).rejects.toBe(err);
  });

  it("getCommitFiles rejects with a commitNotFound error as is", async () => {
    const err = { kind: "commitNotFound", message: "nope" };
    mockThrowing(err);
    await expect(getCommitFiles(5, "dead")).rejects.toBe(err);
  });
});

describe("getFileDiff with a commit scope", () => {
  it("getFileDiff sends scope as a { commit } object", async () => {
    const calls = mockWith({});
    await getFileDiff(1, "a.ts", { commit: "abc" }, false);
    expect((calls[0]?.args as { scope: unknown }).scope).toEqual({ commit: "abc" });
  });
});

// Contract: each GR-10a wrapper invokes the pinned Rust command with camelCase args.
describe("merge operation wrappers", () => {
  it("getOperationState sends get_operation_state with id and returns the state", async () => {
    const state: OperationState = { kind: "none" };
    const calls = mockWith(state);
    const result = await getOperationState(2);
    expect(calls).toEqual([{ cmd: "get_operation_state", args: { id: 2 } }]);
    expect(result).toEqual(state);
  });

  it("mergeBranch sends merge_branch with id, branch and mode", async () => {
    const outcome: OperationOutcome = "conflicts";
    const calls = mockWith(outcome);
    const result = await mergeBranch(2, "feature", "fastForward");
    expect(calls).toEqual([
      { cmd: "merge_branch", args: { id: 2, branch: "feature", mode: "fastForward" } },
    ]);
    expect(result).toBe("conflicts");
  });

  it("rebaseOnto sends rebase_onto with id and onto", async () => {
    const calls = mockWith("completed");
    const result = await rebaseOnto(2, "main");
    expect(calls).toEqual([{ cmd: "rebase_onto", args: { id: 2, onto: "main" } }]);
    expect(result).toBe("completed");
  });

  // GR-10c: interactive rebase.
  it("rebasePlan sends rebase_plan with id and base", async () => {
    const commits = [
      { oid: "a".repeat(40), subject: "add a", author: { name: "n", email: "e", time: 1 } },
    ];
    const calls = mockWith(commits);
    const result = await rebasePlan(2, "main");
    expect(calls).toEqual([{ cmd: "rebase_plan", args: { id: 2, base: "main" } }]);
    expect(result).toEqual(commits);
  });

  it("rebaseInteractive sends rebase_interactive with id, base and steps", async () => {
    const steps: RebaseStep[] = [
      { action: "pick", oid: "a".repeat(40) },
      { action: "squash", oid: "b".repeat(40) },
    ];
    const calls = mockWith("stopped");
    const result = await rebaseInteractive(2, "main", steps);
    expect(calls).toEqual([{ cmd: "rebase_interactive", args: { id: 2, base: "main", steps } }]);
    expect(result).toBe("stopped");
  });

  it("rebaseInteractive passes an empty step list through unchanged", async () => {
    const calls = mockWith("completed");
    await rebaseInteractive(2, "main", []);
    expect(calls).toEqual([
      { cmd: "rebase_interactive", args: { id: 2, base: "main", steps: [] } },
    ]);
  });

  it("rebasePlan resolves with an empty list when the backend returns none", async () => {
    mockWith([]);
    expect(await rebasePlan(2, "main")).toEqual([]);
  });

  it("cherryPick sends cherry_pick with id and oid", async () => {
    const calls = mockWith("completed");
    const result = await cherryPick(2, "abc");
    expect(calls).toEqual([{ cmd: "cherry_pick", args: { id: 2, oid: "abc" } }]);
    expect(result).toBe("completed");
  });

  it("revertCommit sends revert_commit with id and oid", async () => {
    const calls = mockWith("completed");
    const result = await revertCommit(2, "abc");
    expect(calls).toEqual([{ cmd: "revert_commit", args: { id: 2, oid: "abc" } }]);
    expect(result).toBe("completed");
  });

  it("abortOperation sends abort_operation with id", async () => {
    const calls = mockWith(null);
    await abortOperation(2);
    expect(calls).toEqual([{ cmd: "abort_operation", args: { id: 2 } }]);
  });

  it("continueRebase sends continue_rebase with id", async () => {
    const calls = mockWith("conflicts");
    const result = await continueRebase(2);
    expect(calls).toEqual([{ cmd: "continue_rebase", args: { id: 2 } }]);
    expect(result).toBe("conflicts");
  });

  it("resolveConflicts sends resolve_conflicts with id, paths and side", async () => {
    const calls = mockWith(null);
    await resolveConflicts(2, ["a.txt", "b/c.txt"], "theirs");
    expect(calls).toEqual([
      { cmd: "resolve_conflicts", args: { id: 2, paths: ["a.txt", "b/c.txt"], side: "theirs" } },
    ]);
  });

  it("writeResolution sends write_resolution with id, path, text and stage", async () => {
    const calls = mockWith(null);
    await writeResolution(2, "a.txt", "x\n", true);
    expect(calls).toEqual([
      { cmd: "write_resolution", args: { id: 2, path: "a.txt", text: "x\n", stage: true } },
    ]);
  });

  it("canFastForward sends can_fast_forward with id and branch", async () => {
    const check: FastForwardCheck = "diverged";
    const calls = mockWith(check);
    const result = await canFastForward(2, "feature");
    expect(calls).toEqual([{ cmd: "can_fast_forward", args: { id: 2, branch: "feature" } }]);
    expect(result).toBe("diverged");
  });

  it.each([
    ["getOperationState", () => getOperationState(1)],
    ["mergeBranch", () => mergeBranch(1, "b", "merge")],
    ["rebaseOnto", () => rebaseOnto(1, "b")],
    ["cherryPick", () => cherryPick(1, "a")],
    ["revertCommit", () => revertCommit(1, "a")],
    ["abortOperation", () => abortOperation(1)],
    ["continueRebase", () => continueRebase(1)],
    ["resolveConflicts", () => resolveConflicts(1, ["a"], "ours")],
    ["writeResolution", () => writeResolution(1, "a", "x", false)],
    ["canFastForward", () => canFastForward(1, "b")],
    ["rebasePlan", () => rebasePlan(1, "b")],
    ["rebaseInteractive", () => rebaseInteractive(1, "b", [])],
  ])("%s rejects with the backend AppError", async (_name, call) => {
    mockThrowing({ kind: "operationInProgress", message: "busy" });
    await expect(call()).rejects.toEqual({ kind: "operationInProgress", message: "busy" });
  });
});

// Contract: stash wrappers invoke the pinned Rust command names with camelCase args (GR-11a).
describe("stash command wrappers", () => {
  const entry: StashEntry = {
    index: 0,
    oid: "w".repeat(40),
    message: "On main: wip",
    branch: "main",
    time: 1700000000,
    base: "b".repeat(40),
    hasUntracked: false,
  };
  const files: StashFiles = { tracked: [], untracked: [], untrackedOid: null };

  it("listStashes sends list_stashes with id", async () => {
    const calls = mockWith([entry]);
    const result = await listStashes(2);
    expect(calls).toEqual([{ cmd: "list_stashes", args: { id: 2 } }]);
    expect(result).toEqual([entry]);
  });

  it("getStashFiles sends get_stash_files with id and oid", async () => {
    const calls = mockWith(files);
    const result = await getStashFiles(2, "w");
    expect(calls).toEqual([{ cmd: "get_stash_files", args: { id: 2, oid: "w" } }]);
    expect(result).toEqual(files);
  });

  it("stashPush sends stash_push with id, message and includeUntracked", async () => {
    const calls = mockWith(null);
    await stashPush(2, "wip", true);
    expect(calls).toEqual([
      { cmd: "stash_push", args: { id: 2, message: "wip", includeUntracked: true } },
    ]);
  });

  it("stashPush sends a null message through", async () => {
    const calls = mockWith(null);
    await stashPush(2, null, false);
    expect(calls).toEqual([
      { cmd: "stash_push", args: { id: 2, message: null, includeUntracked: false } },
    ]);
  });

  it("stashApply sends stash_apply with id, index and oid", async () => {
    const calls = mockWith("conflicts");
    const result = await stashApply(2, 1, "w");
    expect(calls).toEqual([{ cmd: "stash_apply", args: { id: 2, index: 1, oid: "w" } }]);
    expect(result).toBe("conflicts");
  });

  it("stashPop sends stash_pop with id, index and oid", async () => {
    const calls = mockWith("applied");
    const result = await stashPop(2, 1, "w");
    expect(calls).toEqual([{ cmd: "stash_pop", args: { id: 2, index: 1, oid: "w" } }]);
    expect(result).toBe("applied");
  });

  it("stashDrop sends stash_drop with id, index and oid", async () => {
    const calls = mockWith(null);
    await stashDrop(2, 1, "w");
    expect(calls).toEqual([{ cmd: "stash_drop", args: { id: 2, index: 1, oid: "w" } }]);
  });

  it.each([
    ["listStashes", () => listStashes(1)],
    ["getStashFiles", () => getStashFiles(1, "w")],
    ["stashPush", () => stashPush(1, null, false)],
    ["stashApply", () => stashApply(1, 0, "w")],
    ["stashPop", () => stashPop(1, 0, "w")],
    ["stashDrop", () => stashDrop(1, 0, "w")],
  ])("%s rejects with the backend AppError", async (_name, call) => {
    mockThrowing({ kind: "staleStash", message: "the stash list changed; reload it" });
    await expect(call()).rejects.toEqual({
      kind: "staleStash",
      message: "the stash list changed; reload it",
    });
  });
});

// Contract: the GR-11b tag wrappers send the documented command names and camelCase args.
describe("tag command wrappers", () => {
  const oid = "c".repeat(40);

  it("listTags sends list_tags with id", async () => {
    const list: TagList = { tags: [], remotes: [] };
    const calls = mockWith(list);
    const result = await listTags(2);
    expect(calls).toEqual([{ cmd: "list_tags", args: { id: 2 } }]);
    expect(result).toEqual(list);
  });

  it("createTag sends create_tag with id, name, oid and message", async () => {
    const calls = mockWith(null);
    await createTag(2, "v1", oid, "Release");
    expect(calls).toEqual([
      { cmd: "create_tag", args: { id: 2, name: "v1", oid, message: "Release" } },
    ]);
  });

  it("createTag sends a null message through", async () => {
    const calls = mockWith(null);
    await createTag(2, "v1", oid, null);
    expect(calls).toEqual([{ cmd: "create_tag", args: { id: 2, name: "v1", oid, message: null } }]);
  });

  it("deleteTag sends delete_tag with id and name", async () => {
    const calls = mockWith(null);
    await deleteTag(2, "v1");
    expect(calls).toEqual([{ cmd: "delete_tag", args: { id: 2, name: "v1" } }]);
  });

  it("pushTag sends push_tag with id, remote and name", async () => {
    const calls = mockWith(null);
    await pushTag(2, "origin", "v1");
    expect(calls).toEqual([
      { cmd: "push_tag", args: { id: 2, remote: "origin", name: "v1", credentials: null } },
    ]);
  });

  it("deleteRemoteTag sends delete_remote_tag with id, remote and name", async () => {
    const calls = mockWith(null);
    await deleteRemoteTag(2, "origin", "v1");
    expect(calls).toEqual([
      {
        cmd: "delete_remote_tag",
        args: { id: 2, remote: "origin", name: "v1", credentials: null },
      },
    ]);
  });

  it.each([
    ["listTags", () => listTags(1)],
    ["createTag", () => createTag(1, "v1", oid, null)],
    ["deleteTag", () => deleteTag(1, "v1")],
    ["pushTag", () => pushTag(1, "origin", "v1")],
    ["deleteRemoteTag", () => deleteRemoteTag(1, "origin", "v1")],
  ])("%s rejects with the backend AppError", async (_name, call) => {
    mockThrowing({ kind: "tagNotFound", message: "no tag named v1" });
    await expect(call()).rejects.toEqual({ kind: "tagNotFound", message: "no tag named v1" });
  });
});

// Contract: the GR-12 wrappers invoke the pinned Rust command names with camelCase args.
describe("remote command wrappers", () => {
  const creds: Credentials = { origin: "https://h", username: "me", token: "t" };

  it("fetchAll sends fetch with id and null credentials", async () => {
    const calls = mockWith(null);
    await fetchAll(2);
    expect(calls).toEqual([{ cmd: "fetch", args: { id: 2, credentials: null } }]);
  });

  it("fetchAll sends the credentials through", async () => {
    const calls = mockWith(null);
    await fetchAll(2, creds);
    expect(calls).toEqual([{ cmd: "fetch", args: { id: 2, credentials: creds } }]);
  });

  it("pullDefaultMode sends pull_default_mode with id", async () => {
    const calls = mockWith("merge");
    await pullDefaultMode(2);
    expect(calls).toEqual([{ cmd: "pull_default_mode", args: { id: 2 } }]);
  });

  it("pullDefaultMode passes the mode through", async () => {
    mockWith("rebase");
    await expect(pullDefaultMode(2)).resolves.toBe("rebase");
  });

  it("pull sends mode and null credentials by default", async () => {
    const calls = mockWith("completed");
    await pull(2, "rebase");
    expect(calls).toEqual([{ cmd: "pull", args: { id: 2, mode: "rebase", credentials: null } }]);
  });

  it("pull sends the credentials through", async () => {
    const calls = mockWith("completed");
    await pull(2, "merge", creds);
    expect(calls).toEqual([{ cmd: "pull", args: { id: 2, mode: "merge", credentials: creds } }]);
  });

  it("pull passes the outcome through", async () => {
    mockWith("conflicts");
    await expect(pull(2, "merge")).resolves.toBe("conflicts");
  });

  it("push sends target, force, expectedBranch and credentials", async () => {
    const calls = mockWith(null);
    const target = { kind: "setUpstream", remote: "origin", branch: "b" } as const;
    await push(2, target, true, "main", creds);
    expect(calls).toEqual([
      {
        cmd: "push",
        args: { id: 2, target, force: true, expectedBranch: "main", credentials: creds },
      },
    ]);
  });

  it("push sends null credentials by default", async () => {
    const calls = mockWith(null);
    await push(2, { kind: "upstream" }, false, "main");
    expect(calls).toEqual([
      {
        cmd: "push",
        args: {
          id: 2,
          target: { kind: "upstream" },
          force: false,
          expectedBranch: "main",
          credentials: null,
        },
      },
    ]);
  });

  it("listRemotes sends list_remotes with id and returns the list", async () => {
    const list: RemoteInfo[] = [{ name: "origin", fetchUrl: "/f", pushUrl: null }];
    const calls = mockWith(list);
    const result = await listRemotes(2);
    expect(calls).toEqual([{ cmd: "list_remotes", args: { id: 2 } }]);
    expect(result).toEqual(list);
  });

  it("addRemote sends name, url and a null pushUrl", async () => {
    const calls = mockWith(null);
    await addRemote(2, "origin", "/f", null);
    expect(calls).toEqual([
      { cmd: "add_remote", args: { id: 2, name: "origin", url: "/f", pushUrl: null } },
    ]);
  });

  it("addRemote sends a push url through", async () => {
    const calls = mockWith(null);
    await addRemote(2, "origin", "/f", "/p");
    expect(calls).toEqual([
      { cmd: "add_remote", args: { id: 2, name: "origin", url: "/f", pushUrl: "/p" } },
    ]);
  });

  it("updateRemote sends name, newName, url and pushUrl", async () => {
    const calls = mockWith(null);
    await updateRemote(2, "origin", "up", "/f", "/p");
    expect(calls).toEqual([
      {
        cmd: "update_remote",
        args: { id: 2, name: "origin", newName: "up", url: "/f", pushUrl: "/p" },
      },
    ]);
  });

  it("removeRemote sends name", async () => {
    const calls = mockWith(null);
    await removeRemote(2, "origin");
    expect(calls).toEqual([{ cmd: "remove_remote", args: { id: 2, name: "origin" } }]);
  });

  it("pushTag, deleteRemoteTag and deleteRemoteBranch send null credentials by default", async () => {
    const calls = mockWith(null);
    await pushTag(2, "origin", "v1");
    await deleteRemoteTag(2, "origin", "v1");
    await deleteRemoteBranch(2, "origin", "b");
    expect(calls.map((c) => (c.args as { credentials: unknown }).credentials)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("pushTag, deleteRemoteTag and deleteRemoteBranch send the given credentials", async () => {
    const calls = mockWith(null);
    await pushTag(2, "origin", "v1", creds);
    await deleteRemoteTag(2, "origin", "v1", creds);
    await deleteRemoteBranch(2, "origin", "b", creds);
    expect(calls).toEqual([
      { cmd: "push_tag", args: { id: 2, remote: "origin", name: "v1", credentials: creds } },
      {
        cmd: "delete_remote_tag",
        args: { id: 2, remote: "origin", name: "v1", credentials: creds },
      },
      {
        cmd: "delete_remote_branch",
        args: { id: 2, remote: "origin", name: "b", credentials: creds },
      },
    ]);
  });

  const failure = {
    kind: "networkFailed",
    message: "x",
    network: { verb: "fetch", kind: "hostUnreachable", https: false, origin: null },
  };

  it.each([
    ["fetchAll", () => fetchAll(1)],
    ["pullDefaultMode", () => pullDefaultMode(1)],
    ["pull", () => pull(1, "merge")],
    ["push", () => push(1, { kind: "upstream" }, false)],
    ["listRemotes", () => listRemotes(1)],
    ["addRemote", () => addRemote(1, "o", "/f", null)],
    ["updateRemote", () => updateRemote(1, "o", "o", "/f", null)],
    ["removeRemote", () => removeRemote(1, "o")],
  ])("%s rejects with the backend AppError", async (_name, call) => {
    mockThrowing(failure);
    await expect(call()).rejects.toEqual(failure);
  });
});
