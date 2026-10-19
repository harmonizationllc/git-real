import { describe, expect, it } from "vitest";
import { MAX_PICKER_ROWS, fuzzyMatch, rankFiles } from "./fuzzy";

// Contract: MAX_PICKER_ROWS caps the picker's results.
describe("MAX_PICKER_ROWS", () => {
  it("should be 200", () => {
    expect(MAX_PICKER_ROWS).toBe(200);
  });
});

// Contract: fuzzyMatch is a case-insensitive subsequence match scored by matched span; lower is better.
describe("fuzzyMatch matching", () => {
  it("should score the span from the first to the last matched character", () => {
    expect(fuzzyMatch("abc", "xaxbxc")).toBe(5);
  });

  it("should match a contiguous run with a span equal to the query length", () => {
    expect(fuzzyMatch("src", "src/main.rs")).toBe(3);
  });

  it("should match characters across path separators", () => {
    expect(fuzzyMatch("sm", "src/main.rs")).toBe(5);
  });

  it("should match case-insensitively with an upper-case query", () => {
    expect(fuzzyMatch("SRC", "src/main.rs")).toBe(3);
  });

  it("should match case-insensitively with an upper-case path", () => {
    expect(fuzzyMatch("src", "SRC/MAIN.RS")).toBe(3);
  });

  it("should score an empty query as 0", () => {
    expect(fuzzyMatch("", "anything.ts")).toBe(0);
  });

  it("should walk greedily from the leftmost occurrence of each character", () => {
    // a at 0, b at 2, c at 3: the walk takes the first a, so the later "ab" is never considered.
    expect(fuzzyMatch("abc", "axbcab")).toBe(4);
  });
});

// Contract: a query that is a substring of the basename ranks far above scattered matches.
describe("fuzzyMatch basename bonus", () => {
  it("should subtract 1000 when the whole query is a substring of the basename", () => {
    expect(fuzzyMatch("main", "src/main.rs")).toBe(4 - 1000);
  });

  it("should subtract 1000 for a path without a directory", () => {
    expect(fuzzyMatch("a", "a")).toBe(1 - 1000);
  });

  it("should ignore case when testing the basename substring", () => {
    expect(fuzzyMatch("MAIN", "src/Main.rs")).toBe(4 - 1000);
  });

  it("should not give the bonus when the query only occurs in a directory name", () => {
    expect(fuzzyMatch("src", "src/main.rs")).toBe(3);
  });

  it("should not give the bonus when the query is only a subsequence of the basename", () => {
    expect(fuzzyMatch("mn", "src/main.rs")).toBe(4);
  });
});

// Contract: no match is null.
describe("fuzzyMatch no match", () => {
  it("should return null when a character is missing", () => {
    expect(fuzzyMatch("xyz", "abc")).toBeNull();
  });

  it("should return null when the characters occur in the wrong order", () => {
    expect(fuzzyMatch("ba", "ab")).toBeNull();
  });

  it("should return null when a repeated character occurs fewer times in the path", () => {
    expect(fuzzyMatch("aab", "ab")).toBeNull();
  });

  it("should return null when the query is longer than the path", () => {
    expect(fuzzyMatch("abcd", "abc")).toBeNull();
  });
});

// Contract: rankFiles orders by score then code-unit path order and caps at limit.
describe("rankFiles", () => {
  it("should rank a basename match above a scattered match", () => {
    expect(rankFiles("main", ["m/a/i/n.txt", "src/main.rs"], 2)).toEqual([
      "src/main.rs",
      "m/a/i/n.txt",
    ]);
  });

  it("should rank the tighter span first among non-basename matches", () => {
    expect(rankFiles("ab", ["a/x/b", "a/b"], 2)).toEqual(["a/b", "a/x/b"]);
  });

  it("should drop paths that do not match", () => {
    expect(rankFiles("rs", ["main.rs", "readme.md", "lib.rs"], 10)).toEqual(["lib.rs", "main.rs"]);
  });

  it("should break score ties by code-unit order, not by locale", () => {
    // All three score 1 - 1000. Code-unit order puts "B/a" before "a" before "b/a".
    expect(rankFiles("a", ["b/a", "B/a", "a"], 3)).toEqual(["B/a", "a", "b/a"]);
  });

  it("should return at most limit paths", () => {
    expect(rankFiles("a", ["b/a", "B/a", "a"], 2)).toEqual(["B/a", "a"]);
  });

  it("should return the best paths when the limit cuts the list", () => {
    expect(rankFiles("ab", ["a/x/b", "a/b", "ab"], 1)).toEqual(["ab"]);
  });

  it("should return an empty list for a limit of 0", () => {
    expect(rankFiles("a", ["a"], 0)).toEqual([]);
  });

  it("should return the first limit paths unsorted for an empty query", () => {
    expect(rankFiles("", ["z", "a", "m"], 2)).toEqual(["z", "a"]);
  });

  it("should return every path in input order for an empty query under the limit", () => {
    expect(rankFiles("", ["z", "a", "m"], 10)).toEqual(["z", "a", "m"]);
  });

  it("should return an empty list when no path matches", () => {
    expect(rankFiles("zzz", ["a", "b"], 10)).toEqual([]);
  });

  it("should return an empty list for no paths", () => {
    expect(rankFiles("a", [], 10)).toEqual([]);
  });
});
