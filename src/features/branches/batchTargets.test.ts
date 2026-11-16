import { describe, expect, it } from "vitest";
import type { BranchList, LocalBranch } from "../../lib/ipc";
import type { BranchTarget } from "./BranchRow";
import { batchTargets, deletableLocal } from "./batchTargets";

const oid = "a".repeat(40);
const local = (name: string, over: Partial<LocalBranch> = {}): LocalBranch => ({
  name,
  oid,
  isHead: false,
  tracking: null,
  worktree: null,
  ...over,
});
const list: BranchList = {
  head: { kind: "branch", name: "main" },
  local: [local("main", { isHead: true }), local("a"), local("b")],
  remotes: [
    {
      remote: "origin",
      branches: [
        { remote: "origin", name: "x", oid },
        { remote: "origin", name: "y", oid },
      ],
    },
    { remote: "up", branches: [{ remote: "up", name: "z", oid }] },
  ],
};
const lt = (name: string): BranchTarget => ({
  kind: "local",
  branch: list.local.find((b) => b.name === name) as LocalBranch,
});
const rt = (remote: string, name: string): BranchTarget => ({
  kind: "remote",
  branch: { remote, name, oid },
});
const ordered = ["local:main", "local:a", "local:b", "origin/x", "origin/y", "up/z"];

describe("batchTargets", () => {
  it("should yield the right-clicked row alone when it is not selected", () => {
    expect(batchTargets(lt("a"), new Set(["local:b"]), ordered, list)).toEqual([lt("a")]);
  });

  it("should yield the selected local rows in display order", () => {
    const r = batchTargets(lt("b"), new Set(["local:b", "local:a"]), ordered, list);
    expect(r).toEqual([lt("a"), lt("b")]);
  });

  it("should yield only the right-clicked row's group from a mixed selection", () => {
    const sel = new Set(["local:a", "origin/x", "up/z", "origin/y"]);
    expect(batchTargets(rt("origin", "y"), sel, ordered, list)).toEqual([
      rt("origin", "x"),
      rt("origin", "y"),
    ]);
    expect(batchTargets(lt("a"), sel, ordered, list)).toEqual([lt("a")]);
  });

  it("should skip selected keys that are no longer in the list", () => {
    const sel = new Set(["local:a", "local:gone"]);
    expect(batchTargets(lt("a"), sel, [...ordered, "local:gone"], list)).toEqual([lt("a")]);
  });
});

describe("deletableLocal", () => {
  it("should drop HEAD, worktree-locked and remote rows", () => {
    const locked = local("w", { worktree: "/tmp/w" });
    const targets: BranchTarget[] = [
      lt("main"),
      lt("a"),
      { kind: "local", branch: locked },
      rt("origin", "x"),
    ];
    expect(deletableLocal(targets).map((b) => b.name)).toEqual(["a"]);
  });
});
