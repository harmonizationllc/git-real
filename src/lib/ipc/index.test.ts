import { describe, expect, it } from "vitest";
import * as ipc from ".";

// Contract: the barrel is the only public entry to the IPC seam.
describe("ipc barrel", () => {
  it.each([
    "openRepo",
    "initRepo",
    "cloneRepo",
    "closeRepo",
    "listRecent",
    "removeRecent",
    "checkGitCli",
    "onCloneProgress",
    "pickFolder",
    "isAppError",
    "toAppError",
    "getStatus",
    "getFileDiff",
    "stagePaths",
    "unstagePaths",
    "stageAll",
    "unstageAll",
    "discardPaths",
    "applyHunk",
    "addToGitignore",
    "onRepoChanged",
  ])("barrel exposes %s as a function", (name) => {
    expect(typeof (ipc as Record<string, unknown>)[name]).toBe("function");
  });

  it("barrel does not expose invoke", () => {
    expect("invoke" in ipc).toBe(false);
  });
});
