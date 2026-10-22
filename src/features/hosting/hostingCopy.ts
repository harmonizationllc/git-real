import type { AppError, AppErrorKind, HostingProvider } from "../../lib/ipc";
import { networkMessage } from "../remotes/networkMessage";
import type { NetworkMessage } from "../remotes/networkMessage";

export const PROVIDER_LABEL: Record<HostingProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
};

export const DEFAULT_HOST: Record<HostingProvider, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

/** The token permissions each provider needs for browsing, checkout and push. */
export const SCOPE_HINT: Record<HostingProvider, string> = {
  github:
    "Needs repository contents and pull requests (read and write) and issues (read). A classic token needs the repo scope.",
  gitlab: "Needs the api scope (read_api is enough to browse).",
  bitbucket:
    "Needs read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:issue:bitbucket and read:user:bitbucket.",
};

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
  }
}

/** What to tell the user about a failed hosting call; anything else shows its own message. */
export function hostingErrorText(error: AppError, provider: HostingProvider): string {
  const label = PROVIDER_LABEL[provider];
  switch (error.kind) {
    case "hostingAuth":
      return `${label} rejected the token. Check that it is current and has the scopes it needs.`;
    case "hostingNotFound":
      return `This repository isn't visible to your ${label} account.`;
    case "hostingRateLimited":
      return `${label} rate limit reached. Try again in a few minutes.`;
    case "hostingUnreachable":
      return `Couldn't reach ${label}. Check your connection.`;
    case "keychainUnavailable":
      return "No system keychain is available, so Git Real can't store the token safely.";
    case "invalidHostingHost":
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
