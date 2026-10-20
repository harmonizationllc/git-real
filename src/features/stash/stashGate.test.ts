import { describe, expect, it } from "vitest";
import type { OperationState } from "../../lib/ipc";
import { statusEntry, workingStatus } from "../../test/stashFixtures";
import { IN_PROGRESS_TITLE } from "../merge/operationCopy";
import { applyGate, pushGate, RESOLVE_FIRST_TITLE } from "./stashGate";

const none: OperationState = { kind: "none" };
const merging: OperationState = {
  kind: "merge",
  head: "a".repeat(40),
  branch: "feature",
  message: { subject: "Merge", body: "" },
};

// Contract: Stash (+ and Stash…) is gated by loading, unborn HEAD, operation, conflicts, emptiness, in that order.
describe("pushGate", () => {
  it("should be disabled without a title while the status is loading", () => {
    expect(pushGate(undefined, none)).toEqual({ disabled: true });
  });

  it("should be disabled without a title while the operation state is loading", () => {
    expect(pushGate(workingStatus(), undefined)).toEqual({ disabled: true });
  });

  it("should explain an unborn HEAD", () => {
    expect(pushGate(workingStatus([], true), none)).toEqual({
      disabled: true,
      title: "Make a commit first",
    });
  });

  it("should check the unborn HEAD before the operation", () => {
    expect(pushGate(workingStatus([], true), merging).title).toBe("Make a commit first");
  });

  it("should explain an operation in progress", () => {
    expect(pushGate(workingStatus(), merging)).toEqual({
      disabled: true,
      title: IN_PROGRESS_TITLE,
    });
  });

  it("should check the operation before conflicts", () => {
    const status = workingStatus([statusEntry("a", { conflicted: true })]);
    expect(pushGate(status, merging).title).toBe(IN_PROGRESS_TITLE);
  });

  it("should explain index conflicts", () => {
    const status = workingStatus([statusEntry("a", { conflicted: true })]);
    expect(pushGate(status, none)).toEqual({
      disabled: true,
      title: "Resolve all conflicts first",
    });
  });

  it("should check conflicts before emptiness", () => {
    const status = workingStatus([statusEntry("a"), statusEntry("b", { conflicted: true })]);
    expect(pushGate(status, none).title).toBe(RESOLVE_FIRST_TITLE);
  });

  it("should explain that there are no changes", () => {
    expect(pushGate(workingStatus([]), none)).toEqual({
      disabled: true,
      title: "No changes to stash",
    });
  });

  it("should be enabled when there are changes", () => {
    expect(pushGate(workingStatus(), none)).toEqual({ disabled: false });
  });

  it("should be enabled for an untracked-only status", () => {
    const status = workingStatus([statusEntry("new.txt", { worktree: "untracked" })]);
    expect(pushGate(status, none)).toEqual({ disabled: false });
  });
});

describe("RESOLVE_FIRST_TITLE", () => {
  it("should read Resolve all conflicts first", () => {
    expect(RESOLVE_FIRST_TITLE).toBe("Resolve all conflicts first");
  });
});

// Contract: Apply and Pop are gated by loading, operation and conflicts; an empty status is fine.
describe("applyGate", () => {
  it("should be disabled without a title while the status is loading", () => {
    expect(applyGate(undefined, none)).toEqual({ disabled: true });
  });

  it("should be disabled without a title while the operation state is loading", () => {
    expect(applyGate(workingStatus(), undefined)).toEqual({ disabled: true });
  });

  it("should explain an operation in progress", () => {
    expect(applyGate(workingStatus(), merging)).toEqual({
      disabled: true,
      title: IN_PROGRESS_TITLE,
    });
  });

  it("should check the operation before conflicts", () => {
    const status = workingStatus([statusEntry("a", { conflicted: true })]);
    expect(applyGate(status, merging).title).toBe(IN_PROGRESS_TITLE);
  });

  it("should explain index conflicts", () => {
    const status = workingStatus([statusEntry("a", { conflicted: true })]);
    expect(applyGate(status, none)).toEqual({
      disabled: true,
      title: "Resolve all conflicts first",
    });
  });

  it("should be enabled when there are changes", () => {
    expect(applyGate(workingStatus(), none)).toEqual({ disabled: false });
  });

  it("should ignore an empty status", () => {
    expect(applyGate(workingStatus([]), none)).toEqual({ disabled: false });
  });

  it("should ignore an unborn HEAD", () => {
    expect(applyGate(workingStatus([], true), none)).toEqual({ disabled: false });
  });
});
