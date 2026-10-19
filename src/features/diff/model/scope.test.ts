import { describe, expect, it } from "vitest";
import { commitOf, isReadOnly, scopeId } from "./scope";

// Contract: scope helpers turn a DiffScope into a key, a commit oid and a read-only flag.
describe("scopeId", () => {
  it("should return staged for the staged scope", () => {
    expect(scopeId("staged")).toBe("staged");
  });
  it("should return unstaged for the unstaged scope", () => {
    expect(scopeId("unstaged")).toBe("unstaged");
  });
  it("should return commit:<oid> for a commit scope", () => {
    expect(scopeId({ commit: "abc123" })).toBe("commit:abc123");
  });
  it("should differ between two commits", () => {
    expect(scopeId({ commit: "a" })).not.toBe(scopeId({ commit: "b" }));
  });
});

describe("commitOf", () => {
  it("should return null for staged", () => {
    expect(commitOf("staged")).toBeNull();
  });
  it("should return null for unstaged", () => {
    expect(commitOf("unstaged")).toBeNull();
  });
  it("should return the oid for a commit scope", () => {
    expect(commitOf({ commit: "abc123" })).toBe("abc123");
  });
});

describe("isReadOnly", () => {
  it("should be false for staged", () => {
    expect(isReadOnly("staged")).toBe(false);
  });
  it("should be false for unstaged", () => {
    expect(isReadOnly("unstaged")).toBe(false);
  });
  it("should be true for a commit scope", () => {
    expect(isReadOnly({ commit: "abc123" })).toBe(true);
  });
});
