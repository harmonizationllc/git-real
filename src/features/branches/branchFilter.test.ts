import { describe, expect, it } from "vitest";
import type { BranchList } from "../../lib/ipc";
import { filterBranches } from "./branchFilter";

const list: BranchList = {
  head: { kind: "branch", name: "main" },
  local: [
    { name: "main", oid: "a".repeat(40), isHead: true, tracking: null },
    { name: "Feature/Login", oid: "b".repeat(40), isHead: false, tracking: null },
    { name: "release", oid: "c".repeat(40), isHead: false, tracking: null },
  ],
  remotes: [
    {
      remote: "origin",
      branches: [
        { remote: "origin", name: "main", oid: "a".repeat(40) },
        { remote: "origin", name: "feature", oid: "d".repeat(40) },
      ],
    },
    {
      remote: "upstream",
      branches: [{ remote: "upstream", name: "dev", oid: "e".repeat(40) }],
    },
  ],
};

// Contract: an empty or blank query returns the input unchanged.
describe("filterBranches empty query", () => {
  it("should return the same object when the query is empty", () => {
    expect(filterBranches(list, "")).toBe(list);
  });

  it("should return the same object when the query is only whitespace", () => {
    expect(filterBranches(list, "   ")).toBe(list);
  });
});

// Contract: local branches match case-insensitively on the name.
describe("filterBranches local branches", () => {
  it("should match a local branch regardless of the query case", () => {
    expect(filterBranches(list, "MAIN").local.map((b) => b.name)).toEqual(["main"]);
  });

  it("should match a local branch whose name has capitals when the query is lowercase", () => {
    expect(filterBranches(list, "feature/log").local.map((b) => b.name)).toEqual(["Feature/Login"]);
  });

  it("should match a substring anywhere in the name", () => {
    expect(filterBranches(list, "eas").local.map((b) => b.name)).toEqual(["release"]);
  });

  it("should preserve the original order of matching local branches", () => {
    expect(filterBranches(list, "e").local.map((b) => b.name)).toEqual([
      "Feature/Login",
      "release",
    ]);
  });

  it("should trim the query before matching", () => {
    expect(filterBranches(list, "  release ").local.map((b) => b.name)).toEqual(["release"]);
  });

  it("should return no local branches when nothing matches", () => {
    expect(filterBranches(list, "zzz").local).toEqual([]);
  });

  it("should keep the head state of the input", () => {
    expect(filterBranches(list, "zzz").head).toEqual(list.head);
  });
});

// Contract: remote branches match on `remote/name`.
describe("filterBranches remote branches", () => {
  it("should match a remote branch by its remote prefix and name", () => {
    const out = filterBranches(list, "origin/f");
    expect(out.remotes[0]?.branches.map((b) => b.name)).toEqual(["feature"]);
  });

  it("should match a remote branch by a substring of its name", () => {
    const out = filterBranches(list, "feat");
    expect(out.remotes[0]?.branches.map((b) => b.name)).toEqual(["feature"]);
  });

  it("should match a remote branch by the remote name alone", () => {
    const out = filterBranches(list, "upstream");
    expect(out.remotes[1]?.branches.map((b) => b.name)).toEqual(["dev"]);
  });

  it("should not match the name alone against a different remote prefix", () => {
    const out = filterBranches(list, "upstream/main");
    expect(out.remotes[0]?.branches).toEqual([]);
  });

  it("should preserve the order of remote groups", () => {
    expect(filterBranches(list, "e").remotes.map((g) => g.remote)).toEqual(["origin", "upstream"]);
  });

  it("should keep a remote group with no matches as an empty group", () => {
    const out = filterBranches(list, "origin/f");
    expect(out.remotes[1]).toEqual({ remote: "upstream", branches: [] });
  });

  it("should keep the local group empty when only remote branches match", () => {
    expect(filterBranches(list, "origin/f").local).toEqual([]);
  });
});

// Contract: matching is a literal, locale-independent substring test on the lowercased text.
describe("filterBranches literal matching", () => {
  const accented: BranchList = {
    head: { kind: "branch", name: "main" },
    local: [
      { name: "Éclair", oid: "a".repeat(40), isHead: false, tracking: null },
      { name: "feature-x", oid: "b".repeat(40), isHead: false, tracking: null },
      { name: "feature login", oid: "c".repeat(40), isHead: false, tracking: null },
    ],
    remotes: [],
  };

  it("should fold non-ASCII case so a lowercase query matches an uppercase accented name", () => {
    expect(filterBranches(accented, "éc").local.map((b) => b.name)).toEqual(["Éclair"]);
  });

  it("should fold non-ASCII case so an uppercase query matches a lowercase accented name", () => {
    expect(filterBranches(accented, "ÉCL").local.map((b) => b.name)).toEqual(["Éclair"]);
  });

  it("should treat regex metacharacters in the query literally", () => {
    expect(filterBranches(accented, "feature.x").local).toEqual([]);
    expect(filterBranches(accented, "feature-x").local.map((b) => b.name)).toEqual(["feature-x"]);
  });

  it("should keep whitespace inside the query significant", () => {
    expect(filterBranches(accented, "feature login").local.map((b) => b.name)).toEqual([
      "feature login",
    ]);
    expect(filterBranches(accented, "feature  login").local).toEqual([]);
  });
});
