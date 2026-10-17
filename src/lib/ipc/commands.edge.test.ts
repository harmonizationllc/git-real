import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { applyHunk, discardPaths, stagePaths, unstagePaths } from "./commands";

afterEach(() => clearMocks());

function capture(): { cmd: string; args: unknown }[] {
  const calls: { cmd: string; args: unknown }[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args });
    return null;
  });
  return calls;
}

describe("worktree command argument edges", () => {
  it("should send an empty paths array unchanged for discardPaths", async () => {
    const calls = capture();
    await discardPaths(1, []);
    expect(calls).toEqual([{ cmd: "discard_paths", args: { id: 1, paths: [] } }]);
  });

  it.each([
    ["stagePaths", stagePaths, "stage_paths"],
    ["unstagePaths", unstagePaths, "unstage_paths"],
  ])("should send an empty paths array unchanged for %s", async (_n, fn, cmd) => {
    const calls = capture();
    await fn(1, []);
    expect(calls).toEqual([{ cmd, args: { id: 1, paths: [] } }]);
  });

  it("should send discard paths in the given order without dedup or normalisation", async () => {
    const calls = capture();
    await discardPaths(1, ["b", "a", "b"]);
    expect(calls[0]?.args).toEqual({ id: 1, paths: ["b", "a", "b"] });
  });

  it("should pass applyHunk line indexes [0, 2] through unchanged", async () => {
    const calls = capture();
    await applyHunk(1, "a.txt", "unstage", { hunkIndex: 1, lines: [0, 2] });
    expect(calls[0]?.args).toEqual({
      id: 1,
      path: "a.txt",
      action: "unstage",
      selection: { hunkIndex: 1, lines: [0, 2] },
    });
  });

  it("should keep an empty lines array distinct from null in applyHunk", async () => {
    const calls = capture();
    await applyHunk(1, "a.txt", "stage", { hunkIndex: 0, lines: [] });
    expect(calls[0]?.args).toMatchObject({ selection: { hunkIndex: 0, lines: [] } });
  });
});
