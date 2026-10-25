import { describe, expect, it } from "vitest";
import { hostedRepo } from "../../test/hostingFixtures";
import { cloneUrlFor } from "./cloneUrlFor";

// Contract: the preferred clone URL, falling back to HTTPS (and saying so) when SSH is missing.
describe("cloneUrlFor", () => {
  it("should return the HTTPS URL without a fallback when https is preferred", () => {
    expect(cloneUrlFor(hostedRepo(), "https")).toEqual({
      url: "https://github.com/octo/git-real.git",
      fellBack: false,
    });
  });

  it("should return the SSH URL without a fallback when ssh is preferred and available", () => {
    expect(cloneUrlFor(hostedRepo(), "ssh")).toEqual({
      url: "git@github.com:octo/git-real.git",
      fellBack: false,
    });
  });

  it("should fall back to the HTTPS URL and say so when ssh is preferred but sshUrl is null", () => {
    expect(cloneUrlFor(hostedRepo({ sshUrl: null }), "ssh")).toEqual({
      url: "https://github.com/octo/git-real.git",
      fellBack: true,
    });
  });

  it("should not report a fallback for https when sshUrl is null", () => {
    expect(cloneUrlFor(hostedRepo({ sshUrl: null }), "https")).toEqual({
      url: "https://github.com/octo/git-real.git",
      fellBack: false,
    });
  });

  // An empty string is as unusable as null: the field must not be filled with "".
  it("should fall back to the HTTPS URL and say so when ssh is preferred but sshUrl is empty", () => {
    expect(cloneUrlFor(hostedRepo({ sshUrl: "" }), "ssh")).toEqual({
      url: "https://github.com/octo/git-real.git",
      fellBack: true,
    });
  });
});
