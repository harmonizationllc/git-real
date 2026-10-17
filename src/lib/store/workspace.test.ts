import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspace } from "./workspace";

beforeEach(() => {
  useWorkspace.setState(useWorkspace.getInitialState(), true);
});

describe("initial state", () => {
  it("should start with no selection for any repo", () => {
    expect(useWorkspace.getState().selected).toEqual({});
  });
});

// Contract: the selected file is tracked per repo id.
describe("select", () => {
  it("should store the selected file for the repo", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "a.txt", scope: "staged" });
  });

  it("should keep selections of different repos independent", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().select(2, { path: "b.txt", scope: "unstaged" });
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "a.txt", scope: "staged" });
    expect(useWorkspace.getState().selected[2]).toEqual({ path: "b.txt", scope: "unstaged" });
  });

  it("should replace the previous selection of the same repo", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().select(1, { path: "b.txt", scope: "unstaged" });
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "b.txt", scope: "unstaged" });
  });

  it("should store null when called with null", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().select(1, null);
    expect(useWorkspace.getState().selected[1]).toBeNull();
  });

  it("should replace the selected record instead of mutating it", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    const before = useWorkspace.getState().selected;
    useWorkspace.getState().select(2, null);
    expect(useWorkspace.getState().selected).not.toBe(before);
  });
});

describe("clear", () => {
  it("should remove the selection of that repo", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().selected[1] ?? null).toBeNull();
  });

  it("should leave other repos untouched", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    useWorkspace.getState().select(2, { path: "b.txt", scope: "staged" });
    useWorkspace.getState().clear(1);
    expect(useWorkspace.getState().selected[2]).toEqual({ path: "b.txt", scope: "staged" });
  });

  it("should leave state unchanged for a repo with no selection", () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "staged" });
    const before = useWorkspace.getState().selected;
    useWorkspace.getState().clear(99);
    expect(useWorkspace.getState().selected).toBe(before);
  });
});
