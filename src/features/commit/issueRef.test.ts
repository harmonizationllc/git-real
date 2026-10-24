import { describe, expect, it } from "vitest";
import { insertIssueRef } from "./issueRef";

// Contract (Review Focus 4): the ref replaces [start, end), gets a space only where a neighbour
// is not whitespace, and the caret lands right after everything inserted, spaces included.
describe("insertIssueRef", () => {
  it.each([
    ["a non-space before and a space after", "Fix login", 3, 3, "#12", "Fix #12 login", 7],
    ["a mid-word position", "Fixlogin", 3, 3, "#12", "Fix #12 login", 8],
    ["the end of the text", "Fix login", 9, 9, "#12", "Fix login #12", 13],
    ["an empty field", "", 0, 0, "#12", "#12", 3],
    ["spaces on both sides already", "Fix  login", 4, 4, "#12", "Fix #12 login", 7],
    ["a selection that is replaced", "Fix login", 4, 9, "#12", "Fix #12", 7],
    ["a newline counted as whitespace", "a\nb", 1, 1, "#1", "a #1\nb", 4],
  ] as const)("should insert at %s", (_name, value, start, end, ref, expected, caret) => {
    expect(insertIssueRef(value, start, end, ref)).toEqual({ value: expected, caret });
  });

  it("should add only a trailing space at the start of the text", () => {
    expect(insertIssueRef("Fix login", 0, 0, "#1")).toEqual({ value: "#1 Fix login", caret: 2 });
  });

  it("should add a space on both sides when a selection sits between two words' letters", () => {
    expect(insertIssueRef("Fixlogin", 3, 8, "#12")).toEqual({ value: "Fix #12", caret: 7 });
  });

  it("should add no leading space after a newline", () => {
    expect(insertIssueRef("a\n", 2, 2, "#5")).toEqual({ value: "a\n#5", caret: 4 });
  });

  it("should add only a trailing space after a newline when a word follows", () => {
    expect(insertIssueRef("a\nb", 2, 2, "#5")).toEqual({ value: "a\n#5 b", caret: 5 });
  });

  it("should add no trailing space before a newline", () => {
    expect(insertIssueRef("ab\nc", 2, 2, "#5")).toEqual({ value: "ab #5\nc", caret: 5 });
  });

  it("should add no leading space after a tab", () => {
    expect(insertIssueRef("a\t", 2, 2, "#5")).toEqual({ value: "a\t#5", caret: 4 });
  });

  it("should not change the text outside the replaced range", () => {
    expect(insertIssueRef("one two three", 4, 7, "#9").value).toBe("one #9 three");
  });
});
