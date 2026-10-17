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
