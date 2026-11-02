import type { AppError, AppErrorKind, HostingProvider } from "../../lib/ipc";
import { networkMessage } from "../remotes/networkMessage";
import type { NetworkMessage } from "../remotes/networkMessage";

export const PROVIDER_LABEL: Record<HostingProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure DevOps",
};

export const DEFAULT_HOST: Record<HostingProvider, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
  azure: "dev.azure.com",
};

/** The token permissions each provider needs for browsing, checkout and push. */
export const SCOPE_HINT: Record<HostingProvider, string> = {
  github:
    "Needs repository contents and pull requests (read and write) and issues (read). A classic token needs the repo scope.",
  gitlab: "Needs the api scope (read_api is enough to browse).",
  bitbucket:
    "Needs read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:issue:bitbucket and read:user:bitbucket.",
  azure: "Needs Code (Read & write), Work items (Read) and Project and team (Read).",
};

/** The Organization field's hint in the connect dialog. */
export const ORGANIZATION_HINT =
  "The name in dev.azure.com/<organization>; a pasted organization URL works too";

/**
 * The Azure DevOps organization in `input`: a name, or one taken from
 * `[https://]dev.azure.com/<org>[/…]` or `[https://][user@]<org>.visualstudio.com[/…]`; null for
 * anything else. Mirrors the backend's `azure_org`, which stays the authority.
 */
export function azureOrganization(input: string): string | null {
  const typed = input.trim();
  const hasScheme = typed.slice(0, 8).toLowerCase() === "https://";
  const rest = hasScheme ? typed.slice(8) : typed;
  const slash = rest.indexOf("/");
  const host = slash < 0 ? rest : rest.slice(0, slash);
  const authority = host.slice(host.lastIndexOf("@") + 1).toLowerCase();
  let org: string;
  if (authority === "dev.azure.com") {
    org = slash < 0 ? "" : (rest.slice(slash + 1).split("/")[0] as string);
  } else if (authority.endsWith(".visualstudio.com")) {
    org = authority.slice(0, -".visualstudio.com".length);
  } else if (!hasScheme && slash < 0) {
    org = rest;
  } else {
    return null;
  }
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org) ? org : null;
}

export const RECONNECT_TEXT = "Token expired or revoked — reconnect";

/** The provider's page for creating a personal access token; Bitbucket's lives on Atlassian. */
export function tokenPageUrl(provider: HostingProvider, host: string): string {
  switch (provider) {
    case "github":
      return `https://${host}/settings/personal-access-tokens/new`;
    case "gitlab":
      return `https://${host}/-/user_settings/personal_access_tokens`;
    case "bitbucket":
      return "https://id.atlassian.com/manage-profile/security/api-tokens";
    case "azure":
      return host.startsWith("dev.azure.com/")
        ? `https://${host}/_usersSettings/tokens`
        : "https://dev.azure.com/";
  }
}

/** What to tell the user about a failed hosting call; anything else shows its own message. */
export function hostingErrorText(error: AppError, provider: HostingProvider): string {
  const label = PROVIDER_LABEL[provider];
  switch (error.kind) {
    case "hostingAuth":
      // Azure DevOps names the missing scope in the backend's sentence; a blank one falls through.
      return `${label} rejected the token. ${
        (provider === "azure"
          ? error.message.replace(/^the provider rejected the token:/, "").trim()
          : "") || "Check that it is current and has the scopes it needs."
      }`;
    case "hostingNotFound":
      return `This repository isn't visible to your ${label} account.`;
    case "hostingRateLimited":
      return `${label} rate limit reached. Try again in a few minutes.`;
    case "hostingUnreachable":
      return `Couldn't reach ${label}. Check your connection.`;
    case "keychainUnavailable":
      return "No system keychain is available, so Git Real can't store the token safely.";
    case "invalidHostingHost":
      if (provider === "azure")
        return "Enter your Azure DevOps organization name, such as contoso.";
      return "Enter a host name such as github.example.com, optionally with :port.";
    case "invalidToken":
      return `Paste the token exactly as ${label} showed it.`;
    default:
      return error.message;
  }
}

const HOSTING_KINDS: ReadonlySet<AppErrorKind> = new Set<AppErrorKind>([
  "hostingAuth",
  "hostingNotFound",
  "hostingRateLimited",
  "hostingRejected",
  "hostingUnreachable",
  "keychainUnavailable",
  "noHostingAccount",
  "invalidHostingHost",
  "invalidToken",
]);

/** A hosting failure as a plain NetworkError title; git failures keep networkMessage's copy. */
export function hostingMessage(error: AppError, provider: HostingProvider): NetworkMessage {
  return HOSTING_KINDS.has(error.kind)
    ? { title: hostingErrorText(error, provider), hint: null, action: null, details: null }
    : networkMessage(error);
}

/** The panel heading; `more` adds a plus while further pages exist. */
export function prCountLabel(count: number | null, more: boolean): string {
  return count === null ? "Pull requests" : `Pull requests (${count}${more ? "+" : ""})`;
}

/** What the provider calls its issues: Azure DevOps has work items. */
export function issuesNoun(provider: HostingProvider): "issues" | "work items" {
  return provider === "azure" ? "work items" : "issues";
}

/** The Issues heading (Work items on Azure DevOps); `more` adds a plus while further pages exist. */
export function issueCountLabel(
  count: number | null,
  more: boolean,
  provider: HostingProvider,
): string {
  const noun = provider === "azure" ? "Work items" : "Issues";
  return count === null ? noun : `${noun} (${count}${more ? "+" : ""})`;
}

/** The Issues panel's empty state (work items on Azure DevOps). */
export function noIssuesText(provider: HostingProvider): string {
  return `No open ${issuesNoun(provider)}`;
}

/** The issue picker's empty state (work items on Azure DevOps). */
export function noIssuesMatchText(provider: HostingProvider): string {
  return `${noIssuesText(provider)} match`;
}

/** The Issues panel and the issue picker when the repository's tracker is switched off. */
export const ISSUES_OFF_TEXT = "Issues are turned off for this repository";

/** The create dialog's notice when the branch is not on origin yet. */
export const PUBLISH_FIRST_TEXT =
  "This branch isn't on the remote yet — it will be published first";

/** The create dialog's checkbox for an origin upstream that is behind the branch. */
export function pushFirstLabel(ahead: number): string {
  return `Push ${ahead} ${ahead === 1 ? "commit" : "commits"} first`;
}

/** The toast after a pull request is opened. */
export function openedToastText(number: number): string {
  return `Opened #${number}`;
}
