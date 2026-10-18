import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import {
  addToGitignore,
  applyHunk,
  checkGitCli,
  cloneRepo,
  closeRepo,
  discardPaths,
  getFileContent,
  getFileDiff,
  getStatus,
  initRepo,
  listRecent,
  openRepo,
  removeRecent,
  stageAll,
  stagePaths,
  unstageAll,
  unstagePaths,
} from "./commands";
import { isAppError } from "./errors";
import type { FileDiff, GitCliInfo, OpenedRepo, RecentEntry, WorkingTreeStatus } from "./types";

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
