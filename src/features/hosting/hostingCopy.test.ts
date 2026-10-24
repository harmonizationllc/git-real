import { describe, expect, it } from "vitest";
import type { AppErrorKind, HostingProvider } from "../../lib/ipc";
import { hostingError } from "../../test/hostingFixtures";
import { networkError } from "../../test/remoteFixtures";
import { networkMessage } from "../remotes/networkMessage";
import {
  DEFAULT_HOST,
  ISSUES_OFF_TEXT,
  PROVIDER_LABEL,
  PUBLISH_FIRST_TEXT,
  RECONNECT_TEXT,
  SCOPE_HINT,
  hostingErrorText,
  hostingMessage,
  issueCountLabel,
  openedToastText,
  prCountLabel,
  pushFirstLabel,
  tokenPageUrl,
} from "./hostingCopy";

const PROVIDERS: [HostingProvider, string][] = [
  ["github", "GitHub"],
  ["gitlab", "GitLab"],
  ["bitbucket", "Bitbucket"],
];

// Contract: provider labels, default hosts and the reconnect line are the verbatim copy.
describe("hostingCopy constants", () => {
  it("should label the providers GitHub, GitLab and Bitbucket", () => {
    expect(PROVIDER_LABEL).toEqual({ github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket" });
  });

  it("should default the hosts to github.com, gitlab.com and bitbucket.org", () => {
    expect(DEFAULT_HOST).toEqual({
      github: "github.com",
      gitlab: "gitlab.com",
      bitbucket: "bitbucket.org",
    });
  });

  it("should word the reconnect text with an em dash", () => {
    expect(RECONNECT_TEXT).toBe("Token expired or revoked — reconnect");
  });

  it("should give the GitHub scope hint", () => {
    expect(SCOPE_HINT.github).toBe(
      "Needs repository contents and pull requests (read and write) and issues (read). A classic token needs the repo scope.",
    );
  });

  it("should give the GitLab scope hint", () => {
    expect(SCOPE_HINT.gitlab).toBe("Needs the api scope (read_api is enough to browse).");
  });

  it("should give the Bitbucket scope hint", () => {
    expect(SCOPE_HINT.bitbucket).toBe(
      "Needs read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:issue:bitbucket and read:user:bitbucket.",
    );
  });
});

// Contract: each hosting error kind has fixed text that names the provider.
describe("hostingErrorText", () => {
  it.each(PROVIDERS)("should explain a rejected token for %s", (provider, label) => {
    expect(hostingErrorText(hostingError("hostingAuth"), provider)).toBe(
      `${label} rejected the token. Check that it is current and has the scopes it needs.`,
    );
  });

  it.each(PROVIDERS)("should say the repository is not visible for %s", (provider, label) => {
    expect(hostingErrorText(hostingError("hostingNotFound"), provider)).toBe(
      `This repository isn't visible to your ${label} account.`,
    );
  });

  it.each(PROVIDERS)("should report the rate limit for %s", (provider, label) => {
    expect(hostingErrorText(hostingError("hostingRateLimited"), provider)).toBe(
      `${label} rate limit reached. Try again in a few minutes.`,
    );
  });

  it.each(PROVIDERS)("should report an unreachable %s", (provider, label) => {
    expect(hostingErrorText(hostingError("hostingUnreachable"), provider)).toBe(
      `Couldn't reach ${label}. Check your connection.`,
    );
  });

  it("should explain a missing keychain", () => {
    expect(hostingErrorText(hostingError("keychainUnavailable"), "github")).toBe(
      "No system keychain is available, so Git Real can't store the token safely.",
    );
  });

  it("should explain an invalid host", () => {
    expect(hostingErrorText(hostingError("invalidHostingHost"), "gitlab")).toBe(
      "Enter a host name such as github.example.com, optionally with :port.",
    );
  });

  it.each(PROVIDERS)("should explain an invalid token for %s", (provider, label) => {
    expect(hostingErrorText(hostingError("invalidToken"), provider)).toBe(
      `Paste the token exactly as ${label} showed it.`,
    );
  });

  it.each<AppErrorKind>(["hostingRejected", "noHostingAccount", "io"])(
    "should fall back to the error message for %s",
    (kind) => {
      expect(hostingErrorText(hostingError(kind, "the message"), "github")).toBe("the message");
    },
  );
});

// Contract: hosting kinds become a plain message; anything else goes through networkMessage.
describe("hostingMessage", () => {
  it("should wrap a hosting kind as a title with no hint, action or details", () => {
    expect(hostingMessage(hostingError("hostingNotFound"), "gitlab")).toEqual({
      title: "This repository isn't visible to your GitLab account.",
      hint: null,
      action: null,
      details: null,
    });
  });

  it("should wrap hostingRejected with the provider's message as the title", () => {
    expect(hostingMessage(hostingError("hostingRejected", "validation failed"), "github")).toEqual({
      title: "validation failed",
      hint: null,
      action: null,
      details: null,
    });
  });

  it("should wrap a keychainUnavailable error", () => {
    expect(hostingMessage(hostingError("keychainUnavailable"), "github").title).toBe(
      "No system keychain is available, so Git Real can't store the token safely.",
    );
  });

  it("should give a networkFailed error the networkMessage", () => {
    const error = networkError("hostUnreachable");
    expect(hostingMessage(error, "github")).toEqual(networkMessage(error));
  });

  it("should give an io error the networkMessage", () => {
    const error = hostingError("io", "disk");
    expect(hostingMessage(error, "github")).toEqual(networkMessage(error));
  });
});

// Contract: the token page differs per provider and uses the account's host where it has one.
describe("tokenPageUrl", () => {
  it("should point GitHub at the fine-grained token page of the host", () => {
    expect(tokenPageUrl("github", "ghe.corp")).toBe(
      "https://ghe.corp/settings/personal-access-tokens/new",
    );
  });

  it("should use github.com for the default GitHub host", () => {
    expect(tokenPageUrl("github", "github.com")).toBe(
      "https://github.com/settings/personal-access-tokens/new",
    );
  });

  it("should point GitLab at the personal access token page of the host", () => {
    expect(tokenPageUrl("gitlab", "gitlab.com")).toBe(
      "https://gitlab.com/-/user_settings/personal_access_tokens",
    );
  });

  it("should point a self-hosted GitLab at its own host", () => {
    expect(tokenPageUrl("gitlab", "git.corp")).toBe(
      "https://git.corp/-/user_settings/personal_access_tokens",
    );
  });

  it("should point Bitbucket at the Atlassian token page", () => {
    expect(tokenPageUrl("bitbucket", "bitbucket.org")).toBe(
      "https://id.atlassian.com/manage-profile/security/api-tokens",
    );
  });
});

// Contract: the panel heading counts the pull requests, with + while more pages exist.
describe("prCountLabel", () => {
  it("should be Pull requests while the count is unknown", () => {
    expect(prCountLabel(null, false)).toBe("Pull requests");
  });

  it("should show the count", () => {
    expect(prCountLabel(3, false)).toBe("Pull requests (3)");
  });

  it("should show zero", () => {
    expect(prCountLabel(0, false)).toBe("Pull requests (0)");
  });

  it("should add a plus while more pages exist", () => {
    expect(prCountLabel(50, true)).toBe("Pull requests (50+)");
  });
});

// Contract: copy of the create pull request dialog and its toast.
describe("create pull request copy", () => {
  it("should explain that an unpublished branch is published first", () => {
    expect(PUBLISH_FIRST_TEXT).toBe(
      "This branch isn't on the remote yet — it will be published first",
    );
  });

  it("should label the push checkbox in the singular for one commit", () => {
    expect(pushFirstLabel(1)).toBe("Push 1 commit first");
  });

  it("should label the push checkbox in the plural for several commits", () => {
    expect(pushFirstLabel(3)).toBe("Push 3 commits first");
  });

  it("should name the opened pull request in the toast", () => {
    expect(openedToastText(124)).toBe("Opened #124");
  });
});

// Contract: the Issues heading counts the issues, with + while more pages exist.
describe("issueCountLabel", () => {
  it("should be Issues while the count is unknown", () => {
    expect(issueCountLabel(null, false)).toBe("Issues");
  });

  it("should show the count", () => {
    expect(issueCountLabel(3, false)).toBe("Issues (3)");
  });

  it("should show zero", () => {
    expect(issueCountLabel(0, false)).toBe("Issues (0)");
  });

  it("should add a plus while more pages exist", () => {
    expect(issueCountLabel(50, true)).toBe("Issues (50+)");
  });
});

// Contract: copy of the Issues panel and the issue picker when the tracker is switched off.
describe("issues copy", () => {
  it("should say that issues are turned off for the repository", () => {
    expect(ISSUES_OFF_TEXT).toBe("Issues are turned off for this repository");
  });
});
