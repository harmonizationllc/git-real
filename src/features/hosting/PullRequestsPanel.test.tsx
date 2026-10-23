import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyText,
  hostingCheckoutPullRequest,
  hostingListAccounts,
  hostingListPullRequests,
  hostingRepoContext,
  openExternal,
} from "../../lib/ipc";
import { useLayoutPrefs } from "../../lib/store/layoutPrefs";
import {
  hostingAccount,
  hostingError,
  pullRequest,
  pullRequests,
  repoContext,
} from "../../test/hostingFixtures";
import { authError, networkError } from "../../test/remoteFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { PullRequestsPanel } from "./PullRequestsPanel";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingRepoContext: vi.fn(),
  hostingListPullRequests: vi.fn(),
  hostingCheckoutPullRequest: vi.fn(),
  hostingListAccounts: vi.fn(),
  openExternal: vi.fn(),
  copyText: vi.fn(),
}));

const twoPrs = () => [pullRequest(12), pullRequest(9, { fromFork: true })];

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useLayoutPrefs.setState({ pullRequestsCollapsed: false });
  vi.mocked(hostingRepoContext).mockResolvedValue(repoContext());
  vi.mocked(hostingListPullRequests).mockResolvedValue(twoPrs());
  vi.mocked(hostingListAccounts).mockResolvedValue([]);
  vi.mocked(hostingCheckoutPullRequest).mockResolvedValue({
    kind: "checkedOut",
    branch: "feature-12",
  });
  vi.mocked(openExternal).mockResolvedValue(undefined);
  vi.mocked(copyText).mockResolvedValue(undefined);
});

const toggle = () => screen.getByRole("button", { name: /^Pull requests/ });
const refresh = () => screen.getByRole("button", { name: "Refresh pull requests" });
const row = (n: number) => screen.getByRole("button", { name: new RegExp(`^#${n}\\b`) });
const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 10, clientY: 20 });
const menuItem = (name: string) => screen.getByRole("menuitem", { name });

async function renderPanel() {
  const view = renderWithProviders(<PullRequestsPanel repoId={1} />);
  await screen.findByRole("button", { name: "Pull requests (2)" });
  return view;
}

// Contract: the section exists only for a repository whose origin is on a supported host.
describe("PullRequestsPanel visibility", () => {
  it("renders nothing while the context loads", () => {
    vi.mocked(hostingRepoContext).mockReturnValue(new Promise(() => undefined));
    const { container } = renderWithProviders(<PullRequestsPanel repoId={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is no hosted origin", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(null);
    const { container } = renderWithProviders(<PullRequestsPanel repoId={1} />);
    await waitFor(() => expect(hostingRepoContext).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the context fails to load", async () => {
    vi.mocked(hostingRepoContext).mockRejectedValue({ kind: "io", message: "x" });
    const { container } = renderWithProviders(<PullRequestsPanel repoId={1} />);
    await waitFor(() => expect(hostingRepoContext).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("labels the region by its heading and marks the heading a focus target", async () => {
    await renderPanel();
    expect(screen.getByRole("region", { name: "Pull requests (2)" })).toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: /^Pull requests/ });
    expect(heading).toHaveAttribute("data-focus-target");
    expect(heading).toHaveAttribute("tabindex", "-1");
  });
});

// Contract: without a usable account the section offers to connect and never calls the provider.
describe("PullRequestsPanel account states", () => {
  it("offers Connect… with the provider's name when no account is connected", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(repoContext(null));
    renderWithProviders(<PullRequestsPanel repoId={1} />);
    expect(
      await screen.findByText("Connect your GitHub account to see pull requests"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect…" })).toBeInTheDocument();
  });

  it("names GitLab for a GitLab repository", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue({
      repo: { provider: "gitlab", host: "gitlab.com", namespace: "g", name: "r" },
      account: null,
    });
    renderWithProviders(<PullRequestsPanel repoId={1} />);
    expect(
      await screen.findByText("Connect your GitLab account to see pull requests"),
    ).toBeInTheDocument();
  });

  it("never lists pull requests without an account", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(repoContext(null));
    renderWithProviders(<PullRequestsPanel repoId={1} />);
    await screen.findByRole("button", { name: "Connect…" });
    expect(hostingListPullRequests).not.toHaveBeenCalled();
  });

  it("opens Hosting accounts with the connect form preset to the repository's host", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(repoContext(null));
    const { user } = renderWithProviders(<PullRequestsPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Connect…" }));
    expect(await screen.findByRole("dialog", { name: "Hosting accounts" })).toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "Connect account" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "GitHub" })).toBeChecked();
  });

  it("closes the Hosting accounts dialog it opened and returns focus to Connect…", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(repoContext(null));
    const { user } = renderWithProviders(<PullRequestsPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Connect…" }));
    await screen.findByRole("dialog", { name: "Connect account" });
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Connect account" })).toBeNull(),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Connect…" })).toHaveFocus();
  });

  it("shows the reconnect line and Reconnect for an account that needs it, without listing", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(
      repoContext(hostingAccount({ needsReconnect: true })),
    );
    renderWithProviders(<PullRequestsPanel repoId={1} />);
    expect(await screen.findByText("Token expired or revoked — reconnect")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(hostingListPullRequests).not.toHaveBeenCalled();
  });

  it("shows the reconnect line when the list answers hostingAuth", async () => {
    vi.mocked(hostingListPullRequests).mockRejectedValue(hostingError("hostingAuth"));
    renderWithProviders(<PullRequestsPanel repoId={1} />);
    expect(await screen.findByText("Token expired or revoked — reconnect")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("opens the preset connect form from Reconnect", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(
      repoContext(hostingAccount({ needsReconnect: true })),
    );
    const { user } = renderWithProviders(<PullRequestsPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(await screen.findByRole("dialog", { name: "Connect account" })).toBeInTheDocument();
  });
});

// Contract: heading counts, loading and empty states, and Show more paging.
describe("PullRequestsPanel list", () => {
  it("shows Loading pull requests… and a bare heading before the list arrives", async () => {
    vi.mocked(hostingListPullRequests).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<PullRequestsPanel repoId={1} />);
    expect(await screen.findByText("Loading pull requests…")).toBeInTheDocument();
    expect(toggle()).toHaveTextContent(/^Pull requests$/);
  });

  it("shows the heading with the count and one row per pull request in order", async () => {
    await renderPanel();
    const items = within(screen.getByRole("region")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("#12");
    expect(items[1]).toHaveTextContent("#9");
  });

  it("shows No open pull requests for an empty list", async () => {
    vi.mocked(hostingListPullRequests).mockResolvedValue([]);
    renderWithProviders(<PullRequestsPanel repoId={1} />);
    expect(await screen.findByText("No open pull requests")).toBeInTheDocument();
    expect(toggle()).toHaveTextContent("Pull requests (0)");
  });

  it("shows a plus in the heading and Show more after a full page", async () => {
    vi.mocked(hostingListPullRequests).mockResolvedValue(pullRequests(50));
    renderWithProviders(<PullRequestsPanel repoId={1} />);
    expect(await screen.findByRole("button", { name: "Pull requests (50+)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();
  });

  it("shows no Show more after a short page", async () => {
    await renderPanel();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("loads page 2 on Show more and shows Loading… meanwhile", async () => {
    vi.mocked(hostingListPullRequests)
      .mockResolvedValueOnce(pullRequests(50, 100))
      .mockReturnValueOnce(new Promise(() => undefined));
    const { user } = renderWithProviders(<PullRequestsPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Show more" }));
    expect(hostingListPullRequests).toHaveBeenLastCalledWith(1, 2);
    expect(await screen.findByRole("button", { name: "Loading…" })).toBeInTheDocument();
  });

  it("keeps the loaded list when Show more fails", async () => {
    vi.mocked(hostingListPullRequests)
      .mockResolvedValueOnce(pullRequests(50, 100))
      .mockRejectedValueOnce(networkError("hostUnreachable"));
    const { user } = renderWithProviders(<PullRequestsPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(50);
    expect(screen.getByRole("button", { name: "Pull requests (50+)" })).toBeInTheDocument();
  });

  it("appends page 2 to the list", async () => {
    vi.mocked(hostingListPullRequests)
      .mockResolvedValueOnce(pullRequests(50, 100))
      .mockResolvedValueOnce(pullRequests(2, 40));
    const { user } = renderWithProviders(<PullRequestsPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("button", { name: "Pull requests (52)" })).toBeInTheDocument();
  });
});

// Contract: the status live region is always mounted so a later announcement is read out.
describe("PullRequestsPanel status region", () => {
  it("renders an empty status live region before any action", async () => {
    await renderPanel();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });
});

// Contract: the heading toggle collapses the section, stores the preference and gates fetching.
describe("PullRequestsPanel collapse", () => {
  it("starts expanded", async () => {
    await renderPanel();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("collapsing hides the list, sets aria-expanded false and stores the flag", async () => {
    const { user } = await renderPanel();
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(useLayoutPrefs.getState().pullRequestsCollapsed).toBe(true);
  });

  it("expanding again shows the list and stores false", async () => {
    const { user } = await renderPanel();
    await user.click(toggle());
    await user.click(toggle());
    expect(await screen.findAllByRole("listitem")).toHaveLength(2);
    expect(useLayoutPrefs.getState().pullRequestsCollapsed).toBe(false);
  });

  it("does not fetch while collapsed and fetches once expanded", async () => {
    useLayoutPrefs.setState({ pullRequestsCollapsed: true });
    const { user } = renderWithProviders(<PullRequestsPanel repoId={1} />);
    await screen.findByRole("button", { name: /^Pull requests/ });
    expect(hostingListPullRequests).not.toHaveBeenCalled();
    await user.click(toggle());
    await waitFor(() => expect(hostingListPullRequests).toHaveBeenCalledExactlyOnceWith(1, 1));
  });
});

// Contract: Refresh re-requests the list and is disabled while a request runs.
describe("PullRequestsPanel refresh", () => {
  it("refetches on click", async () => {
    const { user } = await renderPanel();
    await user.click(refresh());
    await waitFor(() => expect(hostingListPullRequests).toHaveBeenCalledTimes(2));
  });

  it("is disabled while the list is fetching", async () => {
    vi.mocked(hostingListPullRequests).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<PullRequestsPanel repoId={1} />);
    await screen.findByText("Loading pull requests…");
    expect(refresh()).toBeDisabled();
  });

  it("is enabled once the list has loaded", async () => {
    await renderPanel();
    await waitFor(() => expect(refresh()).toBeEnabled());
  });
});

// Contract: provider errors show their copy in an alert whose Dismiss retries.
describe("PullRequestsPanel list errors", () => {
  it.each([
    ["hostingNotFound", "This repository isn't visible to your GitHub account."],
    ["hostingUnreachable", "Couldn't reach GitHub. Check your connection."],
    ["hostingRateLimited", "GitHub rate limit reached. Try again in a few minutes."],
  ] as const)("shows the %s text in an alert", async (kind, text) => {
    vi.mocked(hostingListPullRequests).mockRejectedValue(hostingError(kind));
    renderWithProviders(<PullRequestsPanel repoId={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("Dismiss refetches the list", async () => {
    vi.mocked(hostingListPullRequests).mockRejectedValueOnce(hostingError("hostingNotFound"));
    const { user } = renderWithProviders(<PullRequestsPanel repoId={1} />);
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByRole("button", { name: "Pull requests (2)" })).toBeInTheDocument();
    expect(hostingListPullRequests).toHaveBeenCalledTimes(2);
  });
});

// Contract: the row menu offers Check out, Open in browser and Copy link.
describe("PullRequestsPanel context menu", () => {
  it("lists Check out, Open in browser and Copy link", async () => {
    await renderPanel();
    rightClick(row(12));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Check out",
      "Open in browser",
      "Copy link",
    ]);
  });

  it("opens with Shift+F10 and returns focus to the row on Escape", async () => {
    const { user } = await renderPanel();
    row(12).focus();
    await user.keyboard("{Shift>}{F10}{/Shift}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(row(12)).toHaveFocus();
  });

  it("Open in browser opens the pull request's web URL", async () => {
    const { user } = await renderPanel();
    rightClick(row(12));
    await user.click(menuItem("Open in browser"));
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(pullRequest(12).webUrl);
  });

  it("the row's open button opens the same URL", async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "Open #9 in browser" }));
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(pullRequest(9).webUrl);
  });

  it("Copy link copies the web URL", async () => {
    const { user } = await renderPanel();
    rightClick(row(12));
    await user.click(menuItem("Copy link"));
    expect(copyText).toHaveBeenCalledExactlyOnceWith(pullRequest(12).webUrl);
  });

  it("shows a failed copy as an alert that Dismiss clears", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("clipboard denied"));
    const { user } = await renderPanel();
    rightClick(row(12));
    await user.click(menuItem("Copy link"));
    expect(await screen.findByRole("alert")).toHaveTextContent("clipboard denied");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: Check out fetches the head, reports the branch, and confirms before a reset.
describe("PullRequestsPanel checkout", () => {
  it("calls hostingCheckoutPullRequest for the right-clicked pull request and shows the status", async () => {
    const { user } = await renderPanel();
    rightClick(row(12));
    await user.click(menuItem("Check out"));
    expect(hostingCheckoutPullRequest).toHaveBeenCalledExactlyOnceWith(1, 12, false, null);
    expect(await screen.findByRole("status")).toHaveTextContent("Checked out feature-12.");
  });

  it("asks Reset pr/9? with the explanation when the branch has diverged", async () => {
    vi.mocked(hostingCheckoutPullRequest).mockResolvedValue({ kind: "needsReset", branch: "pr/9" });
    const { user } = await renderPanel();
    rightClick(row(9));
    await user.click(menuItem("Check out"));
    const dialog = await screen.findByRole("dialog", { name: "Reset pr/9?" });
    expect(dialog).toHaveTextContent(
      "pr/9 has commits that are not in #9. Resetting moves it to the pull request's head.",
    );
  });

  it("Reset calls again with reset true", async () => {
    vi.mocked(hostingCheckoutPullRequest)
      .mockResolvedValueOnce({ kind: "needsReset", branch: "pr/9" })
      .mockResolvedValueOnce({ kind: "checkedOut", branch: "pr/9" });
    const { user } = await renderPanel();
    rightClick(row(9));
    await user.click(menuItem("Check out"));
    await user.click(await screen.findByRole("button", { name: "Reset" }));
    await waitFor(() => expect(hostingCheckoutPullRequest).toHaveBeenCalledTimes(2));
    expect(hostingCheckoutPullRequest).toHaveBeenLastCalledWith(1, 9, true, null);
    expect(await screen.findByRole("status")).toHaveTextContent("Checked out pr/9.");
  });

  it("Cancel closes the dialog without another call", async () => {
    vi.mocked(hostingCheckoutPullRequest).mockResolvedValue({ kind: "needsReset", branch: "pr/9" });
    const { user } = await renderPanel();
    rightClick(row(9));
    await user.click(menuItem("Check out"));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hostingCheckoutPullRequest).toHaveBeenCalledTimes(1);
  });

  it("shows a network failure with the networkMessage title", async () => {
    vi.mocked(hostingCheckoutPullRequest).mockRejectedValue(
      networkError("hostUnreachable", { verb: "fetch" }),
    );
    const { user } = await renderPanel();
    rightClick(row(12));
    await user.click(menuItem("Check out"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the remote");
  });

  it("shows the sign-in dialog for an https auth failure", async () => {
    vi.mocked(hostingCheckoutPullRequest).mockRejectedValueOnce(authError());
    const { user } = await renderPanel();
    rightClick(row(12));
    await user.click(menuItem("Check out"));
    expect(
      await screen.findByRole("dialog", { name: "Sign in to github.com" }),
    ).toBeInTheDocument();
  });

  it("disables Check out and marks the section busy while a checkout runs", async () => {
    vi.mocked(hostingCheckoutPullRequest).mockReturnValue(new Promise(() => undefined));
    const { user } = await renderPanel();
    expect(screen.getByRole("region")).not.toHaveAttribute("aria-busy");
    rightClick(row(12));
    await user.click(menuItem("Check out"));
    await waitFor(() => expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true"));
    rightClick(row(9));
    expect(menuItem("Check out")).toBeDisabled();
  });
});
