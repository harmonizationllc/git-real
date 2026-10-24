import { describe, expect, it } from "vitest";
import type { Tracking } from "../../lib/ipc";
import { repoInfo } from "../../test/hostingFixtures";
import { defaultTarget, originBranchName, prPushPlan, pushTargetFor } from "./createPrPlan";
import type { PrPushPlan } from "./createPrPlan";

const tracking = (
  upstream: string,
  ahead: number | null = 0,
  behind: number | null = 0,
): Tracking => ({
  upstream,
  ahead,
  behind,
});

const publish: PrPushPlan = { kind: "publish" };
const none: PrPushPlan = { kind: "none" };
const push2: PrPushPlan = { kind: "push", ahead: 2 };

// Contract: a branch is published when its upstream is not on origin or is gone; pushed when ahead.
describe("prPushPlan", () => {
  it("should publish when there is no upstream", () => {
    expect(prPushPlan(null, ["origin"])).toEqual(publish);
  });

  it("should publish when the upstream is on another remote", () => {
    expect(prPushPlan(tracking("fork/feat"), ["origin", "fork"])).toEqual(publish);
  });

  it("should publish when the upstream is gone", () => {
    expect(prPushPlan(tracking("origin/feat", null, null), ["origin"])).toEqual(publish);
  });

  it("should push the ahead count when the origin upstream is ahead", () => {
    expect(prPushPlan(tracking("origin/feat", 2), ["origin"])).toEqual(push2);
  });

  it("should need nothing when the origin upstream is level", () => {
    expect(prPushPlan(tracking("origin/feat", 0), ["origin"])).toEqual(none);
  });

  it("should need nothing when the origin upstream is only behind", () => {
    expect(prPushPlan(tracking("origin/feat", 0, 3), ["origin"])).toEqual(none);
  });

  it("should publish when the upstream is on origin but origin is not a remote", () => {
    expect(prPushPlan(tracking("origin/feat", 1), [])).toEqual(publish);
  });
});

// Contract: the head branch's name on origin is the local name when publishing, else the upstream's.
describe("originBranchName", () => {
  it("should strip origin/ from the upstream when not publishing", () => {
    expect(originBranchName("feat", tracking("origin/renamed"), none)).toBe("renamed");
  });

  it("should strip origin/ from the upstream when pushing", () => {
    expect(originBranchName("feat", tracking("origin/renamed", 2), push2)).toBe("renamed");
  });

  it("should keep slashes after the remote name", () => {
    expect(originBranchName("feat", tracking("origin/feature/login"), none)).toBe("feature/login");
  });

  it("should use the local name when publishing without an upstream", () => {
    expect(originBranchName("feat", null, publish)).toBe("feat");
  });

  it("should use the local name when publishing despite an upstream on another remote", () => {
    expect(originBranchName("feat", tracking("fork/other"), publish)).toBe("feat");
  });
});

// Contract: the default target is the provider's default branch, else main, else the first branch.
describe("defaultTarget", () => {
  it("should pick the provider's default branch when origin has it", () => {
    expect(defaultTarget(repoInfo({ defaultBranch: "develop" }), ["main", "develop"])).toBe(
      "develop",
    );
  });

  it("should fall back to main when the default branch is not on origin", () => {
    expect(defaultTarget(repoInfo({ defaultBranch: "trunk" }), ["dev", "main"])).toBe("main");
  });

  it("should fall back to main when the provider has no default branch", () => {
    expect(defaultTarget(repoInfo({ defaultBranch: null }), ["dev", "main"])).toBe("main");
  });

  it("should fall back to the first branch when neither is present", () => {
    expect(defaultTarget(repoInfo({ defaultBranch: "trunk" }), ["dev", "next"])).toBe("dev");
  });

  it("should use main when the info is undefined and main is present", () => {
    expect(defaultTarget(undefined, ["x", "main"])).toBe("main");
  });

  it("should use the first branch when the info is undefined and main is absent", () => {
    expect(defaultTarget(undefined, ["x"])).toBe("x");
  });

  it("should be null when origin has no branches", () => {
    expect(defaultTarget(repoInfo(), [])).toBeNull();
  });
});

// Contract: what the create command pushes first, if anything.
describe("pushTargetFor", () => {
  it("should set the upstream on origin when publishing", () => {
    expect(pushTargetFor(publish, false, "feat")).toEqual({
      kind: "setUpstream",
      remote: "origin",
      branch: "feat",
    });
  });

  it("should publish even when push-first is true", () => {
    expect(pushTargetFor(publish, true, "feat")).toEqual({
      kind: "setUpstream",
      remote: "origin",
      branch: "feat",
    });
  });

  it("should push to the upstream when ahead and push-first is true", () => {
    expect(pushTargetFor(push2, true, "feat")).toEqual({ kind: "upstream" });
  });

  it("should not push when ahead but push-first is false", () => {
    expect(pushTargetFor(push2, false, "feat")).toBeNull();
  });

  it("should not push when there is nothing to push", () => {
    expect(pushTargetFor(none, true, "feat")).toBeNull();
  });
});
