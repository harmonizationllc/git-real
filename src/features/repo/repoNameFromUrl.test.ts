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
    ["  https://github.com/a/b.git  ", "b"],
    ["HTTPS://GitHub.com/a/b", "b"],
    ["repo.git", "repo"],
    ["https://x/a/b.git.git", "b.git"],
    ["https://host:8443/a/b.git", "b"],
    ["git@host:a/b/", "b"],
  ])("should return the name when the url is %j", (url, expected) => {
    expect(repoNameFromUrl(url)).toBe(expected);
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace only"],
    ["https://x/", "host with trailing slash only"],
    ["https://x", "host only"],
    ["https://x/a/.git", "only a .git suffix remains"],
    ["git@host:", "scp host with empty path"],
    ["ssh://git@host:22/", "ssh host and port only"],
    [".git", "bare .git"],
  ])("should return null when the url is %j (%s)", (url) => {
    expect(repoNameFromUrl(url)).toBeNull();
  });
});
