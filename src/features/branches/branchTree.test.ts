import { describe, expect, it } from "vitest";
import { buildBranchTree, lastSegment, visibleBranchKeys } from "./branchTree";

const b = (name: string) => ({ name });

describe("lastSegment", () => {
  it("should return the name itself without a slash and the last segment with one", () => {
    expect(lastSegment("main")).toBe("main");
    expect(lastSegment("feature/ui/toolbar")).toBe("toolbar");
  });
});

describe("buildBranchTree", () => {
  it("should leave a flat list as branch nodes in input order", () => {
    expect(buildBranchTree([b("main"), b("dev")])).toEqual([
      { kind: "branch", branch: b("main") },
      { kind: "branch", branch: b("dev") },
    ]);
  });

  it("should put folders before loose branches at every level and nest to any depth", () => {
    const tree = buildBranchTree([
      b("feature/fix-1"),
      b("feature/fix-2"),
      b("feature/ui/toolbar"),
      b("main"),
      b("release/1.2"),
      b("a/b/c/d"),
    ]);
    expect(tree).toEqual([
      {
        kind: "folder",
        name: "feature",
        path: "feature",
        children: [
          {
            kind: "folder",
            name: "ui",
            path: "feature/ui",
            children: [{ kind: "branch", branch: b("feature/ui/toolbar") }],
          },
          { kind: "branch", branch: b("feature/fix-1") },
          { kind: "branch", branch: b("feature/fix-2") },
        ],
      },
      {
        kind: "folder",
        name: "release",
        path: "release",
        children: [{ kind: "branch", branch: b("release/1.2") }],
      },
      {
        kind: "folder",
        name: "a",
        path: "a",
        children: [
          {
            kind: "folder",
            name: "b",
            path: "a/b",
            children: [
              {
                kind: "folder",
                name: "c",
                path: "a/b/c",
                children: [{ kind: "branch", branch: b("a/b/c/d") }],
              },
            ],
          },
        ],
      },
      { kind: "branch", branch: b("main") },
    ]);
  });

  it("should keep a folder's first-appearance order and not merge prefix-sharing names", () => {
    const tree = buildBranchTree([b("feature-x"), b("feature/one"), b("zeta/a"), b("alpha")]);
    expect(tree.map((n) => (n.kind === "folder" ? `${n.path}/` : n.branch.name))).toEqual([
      "feature/",
      "zeta/",
      "feature-x",
      "alpha",
    ]);
  });

  it("should return an empty tree for no branches", () => {
    expect(buildBranchTree([])).toEqual([]);
  });
});

describe("visibleBranchKeys", () => {
  const keyOf = (b: { name: string }) => `local:${b.name}`;
  const tree = () =>
    buildBranchTree([{ name: "a" }, { name: "f/x" }, { name: "f/y" }, { name: "z" }]);

  it("should list branch keys depth-first in display order", () => {
    expect(visibleBranchKeys(tree(), new Set(), "", keyOf)).toEqual([
      "local:f/x",
      "local:f/y",
      "local:a",
      "local:z",
    ]);
  });

  it("should skip the children of a collapsed folder", () => {
    expect(visibleBranchKeys(tree(), new Set(["f"]), "", keyOf)).toEqual(["local:a", "local:z"]);
  });

  it("should match a collapsed folder by its prefixed key", () => {
    const keys = visibleBranchKeys(tree(), new Set(["origin:f"]), "origin:", keyOf);
    expect(keys).toEqual(["local:a", "local:z"]);
  });

  it("should not collapse a folder whose unprefixed path is in the set", () => {
    expect(visibleBranchKeys(tree(), new Set(["f"]), "origin:", keyOf)).toHaveLength(4);
  });

  it("should skip a nested folder under a collapsed parent", () => {
    const nested = buildBranchTree([{ name: "f/g/x" }, { name: "f/y" }, { name: "z" }]);
    expect(visibleBranchKeys(nested, new Set(["f"]), "", keyOf)).toEqual(["local:z"]);
    expect(visibleBranchKeys(nested, new Set(["f/g"]), "", keyOf)).toEqual([
      "local:f/y",
      "local:z",
    ]);
  });
});
