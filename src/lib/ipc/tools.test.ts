// Task 5: Failing tests for tools IPC wrappers.
// Imports reference modules/symbols that do not yet exist — red phase.

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { openExternalDiff, openExternalMerge, openInEditor } from "./tools";
import type { ExternalDiffScope } from "./types";

type Call = { cmd: string; args: Record<string, unknown> };

function mockWith(value: unknown): Call[] {
  const calls: Call[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args as Record<string, unknown>) ?? {} });
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

// Contract: openInEditor invokes open_in_editor with { path, repoId }.
// R18: repoId defaults to null when omitted; passing a RepoId sends it as-is.
describe("openInEditor", () => {
  it("sends open_in_editor with path and repoId null when omitted", async () => {
    const calls = mockWith(null);
    await openInEditor("/some/file.ts");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("open_in_editor");
    expect(calls[0].args).toEqual({ path: "/some/file.ts", repoId: null });
  });

  it("openInEditor sends repoId null when omitted", async () => {
    const calls = mockWith(null);
    await openInEditor("/another/file.rs");
    expect(calls[0].args).toEqual({ path: "/another/file.rs", repoId: null });
  });

  it("openInEditor sends the repo id when given", async () => {
    const calls = mockWith(null);
    await openInEditor("relative/file.ts", 42);
    expect(calls[0].args).toEqual({ path: "relative/file.ts", repoId: 42 });
  });

  it("openInEditor rejection passes through", async () => {
    const err = { kind: "noExternalTool", message: "no editor" };
    mockThrowing(err);
    await expect(openInEditor("/f")).rejects.toBe(err);
  });
});

// Contract: openExternalDiff invokes open_external_diff with { repoId, path, scope }.
describe("openExternalDiff", () => {
  it("sends open_external_diff with repoId, path and unstaged scope", async () => {
    const calls = mockWith(null);
    const scope: ExternalDiffScope = { kind: "unstaged" };
    await openExternalDiff(1, "src/a.ts", scope);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("open_external_diff");
    expect(calls[0].args).toEqual({ repoId: 1, path: "src/a.ts", scope });
  });

  it("sends open_external_diff with staged scope", async () => {
    const calls = mockWith(null);
    const scope: ExternalDiffScope = { kind: "staged" };
    await openExternalDiff(2, "b.ts", scope);
    expect(calls[0].args).toEqual({ repoId: 2, path: "b.ts", scope });
  });

  it("sends open_external_diff with commit scope including oid", async () => {
    const calls = mockWith(null);
    const scope: ExternalDiffScope = { kind: "commit", oid: "deadbeef" };
    await openExternalDiff(3, "c.ts", scope);
    expect(calls[0].args).toEqual({ repoId: 3, path: "c.ts", scope });
  });

  it("openExternalDiff rejection passes through", async () => {
    const err = { kind: "externalToolFailed", message: "meld failed" };
    mockThrowing(err);
    const scope: ExternalDiffScope = { kind: "unstaged" };
    await expect(openExternalDiff(1, "d.ts", scope)).rejects.toBe(err);
  });
});

// Contract: openExternalMerge invokes open_external_merge with { repoId, path }.
describe("openExternalMerge", () => {
  it("sends open_external_merge with repoId and path", async () => {
    const calls = mockWith(null);
    await openExternalMerge(4, "conflict.txt");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("open_external_merge");
    expect(calls[0].args).toEqual({ repoId: 4, path: "conflict.txt" });
  });

  it("openExternalMerge rejection passes through", async () => {
    const err = { kind: "noExternalTool", message: "no merge tool" };
    mockThrowing(err);
    await expect(openExternalMerge(4, "c.txt")).rejects.toBe(err);
  });
});
