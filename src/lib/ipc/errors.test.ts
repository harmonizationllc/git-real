import { describe, expect, it } from "vitest";
import { isAppError, toAppError } from "./errors";
import type { AppErrorKind } from "./types";

const kinds: AppErrorKind[] = [
  "notARepository",
  "alreadyARepository",
  "pathNotFound",
  "gitCliMissing",
  "cloneFailed",
  "io",
  "git",
  "unknownRepo",
  "noChanges",
  "badSelection",
  "applyFailed",
  "tooLarge",
  "emptyMessage",
  "nothingToCommit",
  "commitFailed",
  "binaryFile",
];

// Contract: isAppError is a strict guard for { kind: AppErrorKind, message: string }.
describe("isAppError", () => {
  it.each(kinds)("isAppError accepts kind %s", (kind) => {
    expect(isAppError({ kind, message: "m" })).toBe(true);
  });

  it("isAppError accepts extra keys", () => {
    expect(isAppError({ kind: "io", message: "m", detail: 1 })).toBe(true);
  });

  it.each([null, undefined, "x", 42])("isAppError rejects non-object %s", (value) => {
    expect(isAppError(value)).toBe(false);
  });

  it("isAppError rejects Error instances", () => {
    expect(isAppError(new Error("x"))).toBe(false);
  });

  it.each([{ kind: "io" }, { kind: "io", message: 5 }])(
    "isAppError rejects a missing or non-string message %j",
    (value) => {
      expect(isAppError(value)).toBe(false);
    },
  );

  it.each([{ kind: "bogus", message: "m" }, { kind: 1, message: "m" }, { message: "m" }])(
    "isAppError rejects an unknown or non-string kind %j",
    (value) => {
      expect(isAppError(value)).toBe(false);
    },
  );

  it("isAppError rejects a JSON object whose only kind lives under __proto__", () => {
    const value: unknown = JSON.parse('{"__proto__":{"kind":"io"},"message":"m"}');
    expect(isAppError(value)).toBe(false);
  });

  it.each(["toString", "constructor", "hasOwnProperty"])(
    "isAppError rejects prototype key %s as kind",
    (kind) => {
      expect(isAppError({ kind, message: "m" })).toBe(false);
    },
  );
});

// Contract: the worktree error kinds are recognised by the guard.
describe("isAppError worktree kinds", () => {
  it.each(["noChanges", "badSelection", "applyFailed"])("isAppError accepts kind %s", (kind) => {
    expect(isAppError({ kind, message: "m" })).toBe(true);
  });
});

// Contract: the ten branch-management error kinds are recognised by the guard.
describe("isAppError branch kinds", () => {
  const branchKinds: AppErrorKind[] = [
    "invalidBranchName",
    "branchExists",
    "branchNotFound",
    "branchNotMerged",
    "cannotDeleteCurrent",
    "unbornHead",
    "revisionNotFound",
    "remoteNotFound",
    "checkoutFailed",
    "pushFailed",
  ];

  it.each(branchKinds)("isAppError accepts kind %s", (kind) => {
    expect(isAppError({ kind, message: "m" })).toBe(true);
  });

  it("isAppError still rejects a near-miss kind", () => {
    expect(isAppError({ kind: "branchexists", message: "m" })).toBe(false);
  });
});

// Contract: the commit graph error kinds are recognised by the guard.
describe("isAppError commit graph kinds", () => {
  it.each(["logStale", "commitNotFound"])("isAppError accepts kind %s", (kind) => {
    expect(isAppError({ kind, message: "m" })).toBe(true);
  });

  it.each(["logstale", "commitnotfound", "LogStale"])(
    "isAppError rejects the near-miss kind %s",
    (kind) => {
      expect(isAppError({ kind, message: "m" })).toBe(false);
    },
  );

  it("toAppError returns a logStale error unchanged", () => {
    const err = { kind: "logStale", message: "m" } as const;
    expect(toAppError(err)).toBe(err);
  });
});

// Contract: toAppError coerces any thrown value into an AppError.
describe("toAppError", () => {
  it("should return an AppError unchanged", () => {
    const err = { kind: "noChanges", message: "m" } as const;
    expect(toAppError(err)).toBe(err);
  });

  it("should map an Error to an io error with its message", () => {
    expect(toAppError(new Error("boom"))).toEqual({ kind: "io", message: "boom" });
  });

  it("should map a non-Error to an io error with its string form", () => {
    expect(toAppError("x")).toEqual({ kind: "io", message: "x" });
  });
});

// Coverage: the two new kinds obey the same shape rules as the others.
describe("isAppError commit graph kinds shape", () => {
  it.each(["logStale", "commitNotFound"])("isAppError rejects %s without a message", (kind) => {
    expect(isAppError({ kind })).toBe(false);
  });

  it.each(["logStale", "commitNotFound"])(
    "isAppError rejects %s with a non-string message",
    (kind) => {
      expect(isAppError({ kind, message: 5 })).toBe(false);
    },
  );

  it("isAppError rejects a kind the backend might add later", () => {
    expect(isAppError({ kind: "graphCorrupt", message: "m" })).toBe(false);
  });

  it("isAppError rejects a kind with a trailing space", () => {
    expect(isAppError({ kind: "logStale ", message: "m" })).toBe(false);
  });

  it("toAppError returns a commitNotFound error unchanged", () => {
    const err = { kind: "commitNotFound", message: "m" } as const;
    expect(toAppError(err)).toBe(err);
  });

  it("toAppError wraps a near-miss kind as an io error", () => {
    expect(toAppError({ kind: "logstale", message: "m" })).toEqual({
      kind: "io",
      message: "[object Object]",
    });
  });
});

// Contract: the five GR-10a operation kinds are recognised and wrapped unchanged.
const operationKinds: AppErrorKind[] = [
  "operationFailed",
  "operationInProgress",
  "noOperation",
  "unresolvedConflicts",
  "mergeCommit",
];

describe("isAppError operation kinds", () => {
  it.each(operationKinds)("isAppError accepts %s", (kind) => {
    expect(isAppError({ kind, message: "m" })).toBe(true);
  });

  it.each(operationKinds)("isAppError rejects %s with a non-string message", (kind) => {
    expect(isAppError({ kind, message: 5 })).toBe(false);
  });

  it.each(operationKinds)("toAppError returns %s unchanged", (kind) => {
    const err = { kind, message: "m" };
    expect(toAppError(err)).toBe(err);
  });

  it("isAppError rejects a near-miss operation kind", () => {
    expect(isAppError({ kind: "operationfailed", message: "m" })).toBe(false);
  });
});
