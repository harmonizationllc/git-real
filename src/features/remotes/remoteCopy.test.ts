import { describe, expect, it } from "vitest";
import type { AppError } from "../../lib/ipc";
import { remoteFieldError, removeRemoteCopy, tokenHint } from "./remoteCopy";

const err = (kind: AppError["kind"]): AppError => ({ kind, message: "raw" });
const input = (over: Partial<{ name: string; url: string; pushUrl: string | null }> = {}) => ({
  name: "origin",
  url: "/srv/o.git",
  pushUrl: null,
  ...over,
});

// Contract: the remove confirmation names the remote and says what it does and does not touch.
describe("removeRemoteCopy", () => {
  it("should title the confirmation Remove remote origin?", () => {
    expect(removeRemoteCopy("origin").title).toBe("Remove remote origin?");
  });

  it("should say remote-tracking branches are deleted locally and the server is untouched", () => {
    expect(removeRemoteCopy("origin").body).toBe(
      "Its remote-tracking branches are deleted locally. Nothing changes on the server.",
    );
  });

  it("should name whichever remote is given", () => {
    expect(removeRemoteCopy("up/stream").title).toBe("Remove remote up/stream?");
  });
});

// Contract: add/edit errors that belong to a field map to that field; everything else is a panel message.
describe("remoteFieldError", () => {
  it("should map invalidRemoteName to the name field", () => {
    expect(remoteFieldError(err("invalidRemoteName"), input({ name: "bad name" }))).toEqual({
      field: "name",
      text: "bad name is not a valid remote name.",
    });
  });

  it("should map remoteExists to the name field", () => {
    expect(remoteFieldError(err("remoteExists"), input())).toEqual({
      field: "name",
      text: "A remote named origin already exists.",
    });
  });

  it("should map invalidRemoteUrl to the url field", () => {
    expect(remoteFieldError(err("invalidRemoteUrl"), input())).toEqual({
      field: "url",
      text: "Enter a valid URL.",
    });
  });

  it("should return null for remoteNotFound", () => {
    expect(remoteFieldError(err("remoteNotFound"), input())).toBeNull();
  });

  it("should return null for io", () => {
    expect(remoteFieldError(err("io"), input())).toBeNull();
  });

  // Core checks the URL first, then the push URL, and both raise invalidRemoteUrl.
  it("should map invalidRemoteUrl to the pushUrl field when a push URL is set and the URL is plausible", () => {
    expect(remoteFieldError(err("invalidRemoteUrl"), input({ pushUrl: "bad" }))).toEqual({
      field: "pushUrl",
      text: "Enter a valid URL.",
    });
  });

  it("should keep invalidRemoteUrl on the url field when the URL starts with a dash even with a push URL", () => {
    expect(
      remoteFieldError(err("invalidRemoteUrl"), input({ url: "-x", pushUrl: "/srv/p.git" })),
    ).toEqual({ field: "url", text: "Enter a valid URL." });
  });

  it("should keep invalidRemoteUrl on the url field when there is no push URL", () => {
    expect(remoteFieldError(err("invalidRemoteUrl"), input({ pushUrl: null }))?.field).toBe("url");
  });

  it("should use the given name, the new name on Save, for name errors", () => {
    expect(remoteFieldError(err("remoteExists"), input({ name: "renamed" }))?.text).toBe(
      "A remote named renamed already exists.",
    );
  });
});

// Contract (W6): the sign-in dialog's token hint, keyed off the host with any :port removed.
describe("tokenHint", () => {
  const GITHUB = "GitHub needs a personal access token, not your account password.";
  const GENERIC = "Many hosts need a personal access token instead of your password.";

  it.each(["github.com", "www.github.com", "GitHub.com", "WWW.GITHUB.COM", "github.com:443"])(
    "should give the GitHub note for %s",
    (host) => {
      expect(tokenHint(host)).toBe(GITHUB);
    },
  );

  it.each([
    "gitlab.com",
    "git.example.org",
    "127.0.0.1:8080",
    "notgithub.com",
    "github.com.evil.test",
    "gist.github.com",
    "",
  ])("should give the generic note for %s", (host) => {
    expect(tokenHint(host)).toBe(GENERIC);
  });
});
