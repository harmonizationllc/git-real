import { describe, expect, it } from "vitest";
import type { AppErrorKind, HostingProvider } from "../../lib/ipc";
import { hostingError } from "../../test/hostingFixtures";
import { networkError } from "../../test/remoteFixtures";
import { networkMessage } from "../remotes/networkMessage";
import {
  DEFAULT_HOST,
  ISSUES_OFF_TEXT,
  ORGANIZATION_HINT,
  PROVIDER_LABEL,
  PUBLISH_FIRST_TEXT,
  RECONNECT_TEXT,
  SCOPE_HINT,
  azureOrganization,
  hostingErrorText,
  hostingMessage,
  issueCountLabel,
  issuesNoun,
  noIssuesMatchText,
  noIssuesText,
  openedToastText,
  prCountLabel,
  pushFirstLabel,
  tokenPageUrl,
} from "./hostingCopy";

const PROVIDERS: [HostingProvider, string][] = [
  ["github", "GitHub"],
  ["gitlab", "GitLab"],
  ["bitbucket", "Bitbucket"],
  ["azure", "Azure DevOps"],
];

// hostingAuth on Azure DevOps carries the backend's scope sentence, so it has its own test.
const NON_AZURE = PROVIDERS.filter(([provider]) => provider !== "azure");

// Contract: provider labels, default hosts and the reconnect line are the verbatim copy.
describe("hostingCopy constants", () => {
  it("should label the providers GitHub, GitLab, Bitbucket and Azure DevOps", () => {
    expect(PROVIDER_LABEL).toEqual({
      github: "GitHub",
      gitlab: "GitLab",
      bitbucket: "Bitbucket",
      azure: "Azure DevOps",
    });
  });

  it("should default the hosts to github.com, gitlab.com, bitbucket.org and dev.azure.com", () => {
    expect(DEFAULT_HOST).toEqual({
      github: "github.com",
      gitlab: "gitlab.com",
      bitbucket: "bitbucket.org",
      azure: "dev.azure.com",
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

  it("should give the Azure DevOps scope hint and organization hint", () => {
    expect(SCOPE_HINT.azure).toBe(
      "Needs Code (Read & write), Work items (Read) and Project and team (Read).",
    );
    expect(ORGANIZATION_HINT).toBe(
      "The name in dev.azure.com/<organization>; a pasted organization URL works too",
    );
  });

  it("should give the Bitbucket scope hint", () => {
    expect(SCOPE_HINT.bitbucket).toBe(
      "Needs read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:issue:bitbucket and read:user:bitbucket.",
    );
  });
});

// Contract: each hosting error kind has fixed text that names the provider.
describe("hostingErrorText", () => {
  it.each(NON_AZURE)("should explain a rejected token for %s", (provider, label) => {
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

  it("should word the Azure host error and show the backend's scope sentence on hostingAuth", () => {
    expect(hostingErrorText(hostingError("invalidHostingHost"), "azure")).toBe(
      "Enter your Azure DevOps organization name, such as contoso.",
    );
    expect(
      hostingErrorText(
        hostingError(
          "hostingAuth",
          "the provider rejected the token: The token can't read work items. It needs the Work items (Read) scope.",
        ),
        "azure",
      ),
    ).toBe(
      "Azure DevOps rejected the token. The token can't read work items. It needs the Work items (Read) scope.",
    );
  });

  it.each(["the provider rejected the token: ", "the provider rejected the token:    ", "", "   "])(
    "should fall back to the generic sentence for a blank Azure auth tail %j",
    (message) => {
      expect(hostingErrorText(hostingError("hostingAuth", message), "azure")).toBe(
        "Azure DevOps rejected the token. Check that it is current and has the scopes it needs.",
      );
    },
  );

  it("should keep an Azure hostingAuth message that lacks the backend prefix", () => {
    expect(hostingErrorText(hostingError("hostingAuth", "Nope."), "azure")).toBe(
      "Azure DevOps rejected the token. Nope.",
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

  it("should link Azure token creation to the organization's settings or the service root", () => {
    expect(tokenPageUrl("azure", "dev.azure.com/contoso")).toBe(
      "https://dev.azure.com/contoso/_usersSettings/tokens",
    );
    expect(tokenPageUrl("azure", "")).toBe("https://dev.azure.com/");
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
    expect(issueCountLabel(null, false, "github")).toBe("Issues");
  });

  it("should show the count", () => {
    expect(issueCountLabel(3, false, "github")).toBe("Issues (3)");
  });

  it("should show zero", () => {
    expect(issueCountLabel(0, false, "github")).toBe("Issues (0)");
  });

  it("should add a plus while more pages exist", () => {
    expect(issueCountLabel(50, true, "github")).toBe("Issues (50+)");
  });
});

// Contract: the empty states say work items on Azure DevOps and issues everywhere else.
describe("issuesNoun", () => {
  it("should be work items on Azure DevOps and issues elsewhere", () => {
    expect(issuesNoun("azure")).toBe("work items");
    for (const p of ["github", "gitlab", "bitbucket"] as const)
      expect(issuesNoun(p)).toBe("issues");
  });
});

describe("empty-state copy", () => {
  it("should say issues for the issue-tracker providers", () => {
    for (const p of ["github", "gitlab", "bitbucket"] as const) {
      expect(noIssuesText(p)).toBe("No open issues");
      expect(noIssuesMatchText(p)).toBe("No open issues match");
    }
  });

  it("should say work items for Azure DevOps", () => {
    expect(noIssuesText("azure")).toBe("No open work items");
    expect(noIssuesMatchText("azure")).toBe("No open work items match");
  });
});

// Contract: copy of the Issues panel and the issue picker when the tracker is switched off.
describe("issues copy", () => {
  it("should say that issues are turned off for the repository", () => {
    expect(ISSUES_OFF_TEXT).toBe("Issues are turned off for this repository");
  });
});

// Contract: mirrors the backend's azure_org so Connect can be gated before the round trip.
describe("azureOrganization", () => {
  it.each([
    "contoso",
    " contoso ",
    "https://dev.azure.com/contoso/x/_git/y",
    "contoso.visualstudio.com",
    "HTTPS://user@Contoso.VisualStudio.com/proj",
  ])("should parse %j as an organization", (input) => {
    expect(azureOrganization(input)).toBe("contoso");
  });

  it("should keep the case of a typed name or a dev.azure.com path", () => {
    expect(azureOrganization("Contoso")).toBe("Contoso");
    expect(azureOrganization("https://DEV.azure.com/Contoso")).toBe("Contoso");
  });

  it.each([
    "",
    "-x",
    "has space",
    "https://github.com/c",
    "https://contoso",
    "dev.azure.com",
    "a/b",
    "https://dev.azure.com",
  ])("should reject %j", (input) => {
    expect(azureOrganization(input)).toBeNull();
  });
});

// Contract: Azure DevOps calls its issues work items.
describe("issueCountLabel for Azure", () => {
  it("should head the section Work items for Azure", () => {
    expect(issueCountLabel(null, false, "azure")).toBe("Work items");
    expect(issueCountLabel(3, true, "azure")).toBe("Work items (3+)");
    expect(issueCountLabel(null, false, "github")).toBe("Issues");
  });
});
