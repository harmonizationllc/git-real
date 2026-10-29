import { describe, expect, it } from "vitest";
import {
  defaultWorktreePath,
  folderName,
  parentFolder,
  samePath,
  trimTrailingSeparators,
} from "./worktreePath";

// Contract: two paths are the same when they match after dropping trailing separators.
describe("samePath", () => {
  it("ignores a trailing slash", () => {
    expect(samePath("/repos/app-feat-a/", "/repos/app-feat-a")).toBe(true);
    expect(samePath("/repos/app-feat-a", "/repos/app-feat-a//")).toBe(true);
  });

  it("ignores a trailing backslash", () => {
    expect(samePath("C:\\src\\app\\", "C:\\src\\app")).toBe(true);
  });

  it("tells different paths apart", () => {
    expect(samePath("/repos/app", "/repos/app-feat-a")).toBe(false);
    expect(samePath("/repos/app/x", "/repos/app")).toBe(false);
  });
});

// Contract: the default folder is a sibling of the main worktree named after the branch.
describe("defaultWorktreePath", () => {
  it("replaces slashes in the branch", () => {
    expect(defaultWorktreePath("/repos/app", "feat/x")).toBe("/repos/app-feat-x");
  });

  it("replaces every slash in a nested branch", () => {
    expect(defaultWorktreePath("/repos/app", "a/b/c")).toBe("/repos/app-a-b-c");
  });

  it("keeps a backslash separator", () => {
    expect(defaultWorktreePath("C:\\src\\app", "x")).toBe("C:\\src\\app-x");
  });

  it("uses worktree for a blank branch", () => {
    expect(defaultWorktreePath("/repos/app", "")).toBe("/repos/app-worktree");
    expect(defaultWorktreePath("/repos/app", "  ")).toBe("/repos/app-worktree");
  });

  it("ignores a trailing separator on the main path", () => {
    expect(defaultWorktreePath("/repos/app/", "x")).toBe("/repos/app-x");
  });
});

// Contract: the folder name is the last non-empty path segment on either separator.
describe("folderName", () => {
  it("takes the last segment and ignores a trailing slash", () => {
    expect(folderName("/repos/app-feat-a/")).toBe("app-feat-a");
  });

  it("splits on a backslash", () => {
    expect(folderName("C:\\src\\app")).toBe("app");
  });

  it("returns a bare name unchanged", () => {
    expect(folderName("app")).toBe("app");
  });

  it("returns a path without segments unchanged", () => {
    expect(folderName("/")).toBe("/");
  });
});

// Contract: the parent folder is the path less its last segment.
describe("parentFolder", () => {
  it("drops the last segment on either separator", () => {
    expect(parentFolder("/repos/app")).toBe("/repos");
    expect(parentFolder("C:\\src\\app\\")).toBe("C:\\src");
  });

  it("is empty for a top-level or bare name", () => {
    expect(parentFolder("/app")).toBe("");
    expect(parentFolder("app")).toBe("");
  });
});

describe("trimTrailingSeparators", () => {
  it("drops trailing slashes and backslashes", () => {
    expect(trimTrailingSeparators("/repos/app//")).toBe("/repos/app");
    expect(trimTrailingSeparators("C:\\src\\app\\")).toBe("C:\\src\\app");
  });

  it("leaves a path without a trailing separator alone", () => {
    expect(trimTrailingSeparators("/repos/app")).toBe("/repos/app");
  });

  it("reduces a separator-only string to empty", () => {
    expect(trimTrailingSeparators("/")).toBe("");
    expect(trimTrailingSeparators("\\")).toBe("");
  });
});
