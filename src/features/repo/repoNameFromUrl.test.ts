import { describe, expect, it } from "vitest";
import { repoNameFromUrl } from "./repoNameFromUrl";

// Contract: derive a repository directory name from a clone URL, or null when none exists.
describe("repoNameFromUrl", () => {
  it.each([
    ["https://github.com/a/b.git", "b"],
    ["git@github.com:a/b.git", "b"],
    ["https://x/a/b/", "b"],
    ["ssh://git@host/a/b", "b"],
    ["git@host:b.git", "b"],
    ["https://x/a/b.git/", "b"],
    ["/local/path/repo", "repo"],
  ])("should return the name when the url is %j", (url, expected) => {
    expect(repoNameFromUrl(url)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace only"],
    ["https://x/", "host with trailing slash only"],
    ["https://x", "host only"],
    ["https://x/a/.git", "only a .git suffix remains"],
  ])("should return null when the url is %j (%s)", (url) => {
    expect(repoNameFromUrl(url)).toBeNull();
  });
});
