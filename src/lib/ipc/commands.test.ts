import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkGitCli,
  cloneRepo,
  closeRepo,
  initRepo,
  listRecent,
  openRepo,
  removeRecent,
} from "./commands";
import { isAppError } from "./errors";
import type { GitCliInfo, OpenedRepo, RecentEntry } from "./types";

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
