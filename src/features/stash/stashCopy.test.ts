import { describe, expect, it } from "vitest";
import type { AppError } from "../../lib/ipc";
import {
  displayError,
  noticeText,
  NOTHING_TO_STASH_MESSAGE,
  STALE_MESSAGE,
  stashRef,
  stashSubject,
} from "./stashCopy";

// Contract: user-facing stash copy, verbatim from the spec.
describe("stashRef", () => {
  it("should format stash@{n}", () => {
    expect(stashRef(3)).toBe("stash@{3}");
  });

  it("should format index zero", () => {
    expect(stashRef(0)).toBe("stash@{0}");
  });
});

describe("constants", () => {
  it("should word the stale message", () => {
    expect(STALE_MESSAGE).toBe("The stash list changed; it has been refreshed.");
  });

  it("should word the nothing-to-stash message", () => {
    expect(NOTHING_TO_STASH_MESSAGE).toBe("No local changes to stash.");
  });
});

describe("noticeText", () => {
  it("should tell the user an apply left conflicts", () => {
    expect(noticeText({ kind: "apply", index: 0 })).toBe(
      "Applied with conflicts. Resolve them in Changes.",
    );
  });

  it("should add that a pop kept the stash", () => {
    expect(noticeText({ kind: "pop", index: 0 })).toBe(
      "Applied with conflicts. Resolve them in Changes. The stash was kept; drop it once resolved.",
    );
  });
});

describe("noticeText for a pop that kept its stash", () => {
  it("should say it applied but the stash could not be dropped", () => {
    expect(noticeText({ kind: "popKept", index: 0 })).toBe(
      "Applied, but the stash could not be dropped. Drop it once you no longer need it.",
    );
  });
});

describe("displayError", () => {
  it("should swap the message for staleStash and keep the kind", () => {
    expect(displayError({ kind: "staleStash", message: "raw" })).toEqual({
      kind: "staleStash",
      message: "The stash list changed; it has been refreshed.",
    });
  });

  it("should swap the message for nothingToStash and keep the kind", () => {
    expect(displayError({ kind: "nothingToStash", message: "raw" })).toEqual({
      kind: "nothingToStash",
      message: "No local changes to stash.",
    });
  });

  it("should return any other error unchanged (same object)", () => {
    const error: AppError = { kind: "operationFailed", message: "git said no" };
    expect(displayError(error)).toBe(error);
  });
});

describe("stashSubject", () => {
  it.each([
    ["On main: wip", "wip"],
    ["WIP on main: abc1234 subject", "abc1234 subject"],
    ["WIP on (no branch): abc1234 s", "abc1234 s"],
    ["custom note", "custom note"],
    ["On main:no-space", "On main:no-space"],
    ["On the fence: thinking", "On the fence: thinking"],
    ["On : nameless", "On : nameless"],
    ["On main:wip", "On main:wip"],
    ["On a:b: x", "On a:b: x"],
  ])("should turn %j into %j", (message, expected) => {
    expect(stashSubject(message)).toBe(expected);
  });

  it("should strip only the leading prefix", () => {
    expect(stashSubject("On main: fix: thing")).toBe("fix: thing");
  });
});
