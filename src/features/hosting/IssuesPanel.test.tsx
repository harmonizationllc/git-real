import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyText,
  hostingListAccounts,
  hostingListIssues,
  hostingRepoContext,
  hostingRepoInfo,
  openExternal,
} from "../../lib/ipc";
import { useLayoutPrefs } from "../../lib/store/layoutPrefs";
import {
  hostingAccount,
  hostingError,
  issue,
  repoContext,
  repoInfo,
} from "../../test/hostingFixtures";
import { networkError } from "../../test/remoteFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { ISSUES_OFF_TEXT } from "./hostingCopy";
import { IssuesPanel } from "./IssuesPanel";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingRepoContext: vi.fn(),
  hostingRepoInfo: vi.fn(),
  hostingListIssues: vi.fn(),
  hostingListAccounts: vi.fn(),
  openExternal: vi.fn(),
  copyText: vi.fn(),
}));

const twoIssues = () => [issue(12), issue(9, { labels: ["ui", "help wanted"] })];
const manyIssues = (n: number, start = 100) =>
  Array.from({ length: n }, (_, i) => issue(start - i));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  useLayoutPrefs.setState({ issuesCollapsed: false });
  vi.mocked(hostingRepoContext).mockResolvedValue(repoContext());
  vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo());
  vi.mocked(hostingListIssues).mockResolvedValue(twoIssues());
  vi.mocked(hostingListAccounts).mockResolvedValue([]);
  vi.mocked(openExternal).mockResolvedValue(undefined);
  vi.mocked(copyText).mockResolvedValue(undefined);
});

const toggle = () => screen.getByRole("button", { name: /^Issues/ });
const refresh = () => screen.getByRole("button", { name: "Refresh issues" });
const row = (n: number) => screen.getByRole("button", { name: new RegExp(`^#${n}\\b`) });
const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 10, clientY: 20 });
const menuItem = (name: string) => screen.getByRole("menuitem", { name });

async function renderPanel() {
  const view = renderWithProviders(<IssuesPanel repoId={1} />);
  await screen.findByRole("button", { name: "Issues (2)" });
  return view;
}

// Contract: the section exists only for a repository whose origin is on a supported host.
describe("IssuesPanel visibility", () => {
  it("renders nothing while the context loads", () => {
    vi.mocked(hostingRepoContext).mockReturnValue(new Promise(() => undefined));
    const { container } = renderWithProviders(<IssuesPanel repoId={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there is no hosted origin", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(null);
    const { container } = renderWithProviders(<IssuesPanel repoId={1} />);
    await waitFor(() => expect(hostingRepoContext).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the context fails to load", async () => {
    vi.mocked(hostingRepoContext).mockRejectedValue({ kind: "io", message: "x" });
    const { container } = renderWithProviders(<IssuesPanel repoId={1} />);
    await waitFor(() => expect(hostingRepoContext).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("labels the region by its heading and marks the heading a focus target", async () => {
    await renderPanel();
    expect(screen.getByRole("region", { name: "Issues (2)" })).toBeInTheDocument();
    const heading = screen.getByRole("heading", { name: /^Issues/ });
    expect(heading).toHaveAttribute("data-focus-target");
    expect(heading).toHaveAttribute("tabindex", "-1");
  });
});

// Contract (Review Focus 5): the section starts collapsed and a collapsed section calls no provider.
describe("IssuesPanel collapse", () => {
  const collapsedPanel = async () => {
    useLayoutPrefs.setState(useLayoutPrefs.getInitialState());
    const view = renderWithProviders(<IssuesPanel repoId={1} />);
    await screen.findByRole("button", { name: /^Issues/ });
    return view;
  };

  it("starts collapsed by default", async () => {
    await collapsedPanel();
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("shows a bare Issues heading and no body while collapsed", async () => {
    await collapsedPanel();
    expect(toggle()).toHaveTextContent(/^Issues$/);
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("does not request issues while collapsed", async () => {
    await collapsedPanel();
    await waitFor(() => expect(hostingRepoContext).toHaveBeenCalled());
    expect(hostingListIssues).not.toHaveBeenCalled();
  });

  it("does not request the repository info while collapsed", async () => {
    await collapsedPanel();
    await waitFor(() => expect(hostingRepoContext).toHaveBeenCalled());
    expect(hostingRepoInfo).not.toHaveBeenCalled();
  });

  it("expanding requests the repository info for the repo and then page 1 of the issues", async () => {
    const { user } = await collapsedPanel();
    await user.click(toggle());
    await waitFor(() => expect(hostingListIssues).toHaveBeenCalledExactlyOnceWith(1, "", 1));
    expect(hostingRepoInfo).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.mocked(hostingRepoInfo).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(hostingListIssues).mock.invocationCallOrder[0] as number,
    );
  });

  it("expanding lists the issues and stores false", async () => {
    const { user } = await collapsedPanel();
    await user.click(toggle());
    expect(await screen.findAllByRole("listitem")).toHaveLength(2);
    expect(useLayoutPrefs.getState().issuesCollapsed).toBe(false);
  });

  it("collapsing hides the list, sets aria-expanded false and stores the flag", async () => {
    const { user } = await renderPanel();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(useLayoutPrefs.getState().issuesCollapsed).toBe(true);
  });
});

// Contract (Review Focus 5): no issues call before the repository info answers, and none when
// the repository has issues turned off.
describe("IssuesPanel issues switched off", () => {
  it("does not request issues until the repository info answers", async () => {
    vi.mocked(hostingRepoInfo).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<IssuesPanel repoId={1} />);
    expect(await screen.findByText("Loading issues…")).toBeInTheDocument();
    await waitFor(() => expect(hostingRepoInfo).toHaveBeenCalled());
    expect(hostingListIssues).not.toHaveBeenCalled();
  });

  it("does not request issues when they are turned off", async () => {
    vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo({ issuesEnabled: false }));
    renderWithProviders(<IssuesPanel repoId={1} />);
    await screen.findByText(ISSUES_OFF_TEXT);
    expect(hostingListIssues).not.toHaveBeenCalled();
  });

  it("shows Issues are turned off for this repository", async () => {
    vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo({ issuesEnabled: false }));
    renderWithProviders(<IssuesPanel repoId={1} />);
    expect(
      await screen.findByText("Issues are turned off for this repository"),
    ).toBeInTheDocument();
  });

  it("keeps the heading bare when issues are turned off", async () => {
    vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo({ issuesEnabled: false }));
    renderWithProviders(<IssuesPanel repoId={1} />);
    await screen.findByText(ISSUES_OFF_TEXT);
    expect(toggle()).toHaveTextContent(/^Issues$/);
  });

  it("still asks for the issues when the repository info fails", async () => {
    vi.mocked(hostingRepoInfo).mockRejectedValue(hostingError("hostingNotFound"));
    renderWithProviders(<IssuesPanel repoId={1} />);
    expect(await screen.findByRole("button", { name: "Issues (2)" })).toBeInTheDocument();
    expect(hostingListIssues).toHaveBeenCalledExactlyOnceWith(1, "", 1);
  });

  it("shows the reconnect line when the repository info answers hostingAuth", async () => {
    vi.mocked(hostingRepoInfo).mockRejectedValue(hostingError("hostingAuth"));
    renderWithProviders(<IssuesPanel repoId={1} />);
    expect(await screen.findByText("Token expired or revoked — reconnect")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });
});

// Contract: without a usable account the section offers to connect and never calls the provider.
describe("IssuesPanel account states", () => {
  it("offers Connect… with the provider's name when no account is connected", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(repoContext(null));
    renderWithProviders(<IssuesPanel repoId={1} />);
    expect(
      await screen.findByText("Connect your GitHub account to see issues"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect…" })).toBeInTheDocument();
  });

  it("names GitLab for a GitLab repository", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue({
      repo: { provider: "gitlab", host: "gitlab.com", namespace: "g", name: "r" },
      account: null,
    });
    renderWithProviders(<IssuesPanel repoId={1} />);
    expect(
      await screen.findByText("Connect your GitLab account to see issues"),
    ).toBeInTheDocument();
  });

  it("never calls the provider without an account", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(repoContext(null));
    renderWithProviders(<IssuesPanel repoId={1} />);
    await screen.findByRole("button", { name: "Connect…" });
    expect(hostingListIssues).not.toHaveBeenCalled();
    expect(hostingRepoInfo).not.toHaveBeenCalled();
  });

  it("opens Hosting accounts with the connect form preset to the repository's host", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(repoContext(null));
    const { user } = renderWithProviders(<IssuesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Connect…" }));
    expect(await screen.findByRole("dialog", { name: "Hosting accounts" })).toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "Connect account" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "GitHub" })).toBeChecked();
  });

  it("shows the reconnect line and Reconnect for an account that needs it, without calling", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(
      repoContext(hostingAccount({ needsReconnect: true })),
    );
    renderWithProviders(<IssuesPanel repoId={1} />);
    expect(await screen.findByText("Token expired or revoked — reconnect")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    expect(hostingListIssues).not.toHaveBeenCalled();
    expect(hostingRepoInfo).not.toHaveBeenCalled();
  });

  it("shows the reconnect line when the list answers hostingAuth", async () => {
    vi.mocked(hostingListIssues).mockRejectedValue(hostingError("hostingAuth"));
    renderWithProviders(<IssuesPanel repoId={1} />);
    expect(await screen.findByText("Token expired or revoked — reconnect")).toBeInTheDocument();
  });

  it("opens the preset connect form from Reconnect", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(
      repoContext(hostingAccount({ needsReconnect: true })),
    );
    const { user } = renderWithProviders(<IssuesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(await screen.findByRole("dialog", { name: "Connect account" })).toBeInTheDocument();
  });
});

// Contract: heading counts, loading and empty states, and Show more paging.
describe("IssuesPanel list", () => {
  it("shows Loading issues… and a bare heading before the list arrives", async () => {
    vi.mocked(hostingListIssues).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<IssuesPanel repoId={1} />);
    expect(await screen.findByText("Loading issues…")).toBeInTheDocument();
    expect(toggle()).toHaveTextContent(/^Issues$/);
  });

  it("shows the heading with the count and one row per issue in order", async () => {
    await renderPanel();
    const items = within(screen.getByRole("region")).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("#12");
    expect(items[1]).toHaveTextContent("#9");
  });

  it("shows each issue's labels as badges", async () => {
    await renderPanel();
    const second = screen.getAllByRole("listitem")[1] as HTMLElement;
    expect(within(second).getByText("ui")).toBeInTheDocument();
    expect(within(second).getByText("help wanted")).toBeInTheDocument();
  });

  it("shows No open issues for an empty list", async () => {
    vi.mocked(hostingListIssues).mockResolvedValue([]);
    renderWithProviders(<IssuesPanel repoId={1} />);
    expect(await screen.findByText("No open issues")).toBeInTheDocument();
    expect(toggle()).toHaveTextContent("Issues (0)");
  });

  it("shows a plus in the heading and Show more after a full page", async () => {
    vi.mocked(hostingListIssues).mockResolvedValue(manyIssues(50));
    renderWithProviders(<IssuesPanel repoId={1} />);
    expect(await screen.findByRole("button", { name: "Issues (50+)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();
  });

  it("shows no Show more after a short page", async () => {
    await renderPanel();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("loads page 2 on Show more and shows Loading… meanwhile", async () => {
    vi.mocked(hostingListIssues)
      .mockResolvedValueOnce(manyIssues(50, 100))
      .mockReturnValueOnce(new Promise(() => undefined));
    const { user } = renderWithProviders(<IssuesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Show more" }));
    expect(hostingListIssues).toHaveBeenLastCalledWith(1, "", 2);
    expect(await screen.findByRole("button", { name: "Loading…" })).toBeInTheDocument();
  });

  it("appends page 2 to the list", async () => {
    vi.mocked(hostingListIssues)
      .mockResolvedValueOnce(manyIssues(50, 100))
      .mockResolvedValueOnce(manyIssues(2, 40));
    const { user } = renderWithProviders(<IssuesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("button", { name: "Issues (52)" })).toBeInTheDocument();
  });

  it("keeps the loaded list when Show more fails", async () => {
    vi.mocked(hostingListIssues)
      .mockResolvedValueOnce(manyIssues(50, 100))
      .mockRejectedValueOnce(networkError("hostUnreachable"));
    const { user } = renderWithProviders(<IssuesPanel repoId={1} />);
    await user.click(await screen.findByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(50);
    expect(screen.getByRole("button", { name: "Issues (50+)" })).toBeInTheDocument();
  });
});

// Contract: Refresh re-requests the list and is disabled while collapsed, unusable or fetching.
describe("IssuesPanel refresh", () => {
  it("refetches the list on click", async () => {
    const { user } = await renderPanel();
    await waitFor(() => expect(refresh()).toBeEnabled());
    await user.click(refresh());
    await waitFor(() => expect(hostingListIssues).toHaveBeenCalledTimes(2));
  });

  it("asks the repository info again on click", async () => {
    const { user } = await renderPanel();
    await waitFor(() => expect(refresh()).toBeEnabled());
    await user.click(refresh());
    await waitFor(() => expect(hostingRepoInfo).toHaveBeenCalledTimes(2));
  });

  it("lists the issues after Refresh when they were turned back on", async () => {
    vi.mocked(hostingRepoInfo)
      .mockResolvedValueOnce(repoInfo({ issuesEnabled: false }))
      .mockResolvedValue(repoInfo());
    const { user } = renderWithProviders(<IssuesPanel repoId={1} />);
    await screen.findByText(ISSUES_OFF_TEXT);
    await waitFor(() => expect(refresh()).toBeEnabled());
    await user.click(refresh());
    expect(await screen.findByRole("button", { name: "Issues (2)" })).toBeInTheDocument();
  });

  it("is disabled while the list is fetching", async () => {
    vi.mocked(hostingListIssues).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<IssuesPanel repoId={1} />);
    await screen.findByText("Loading issues…");
    await waitFor(() => expect(hostingListIssues).toHaveBeenCalled());
    expect(refresh()).toBeDisabled();
  });

  it("is enabled once the list has loaded", async () => {
    await renderPanel();
    await waitFor(() => expect(refresh()).toBeEnabled());
  });

  it("is disabled while the section is collapsed", async () => {
    useLayoutPrefs.setState({ issuesCollapsed: true });
    renderWithProviders(<IssuesPanel repoId={1} />);
    await screen.findByRole("button", { name: /^Issues/ });
    expect(refresh()).toBeDisabled();
  });

  it("is disabled without a usable account", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(
      repoContext(hostingAccount({ needsReconnect: true })),
    );
    renderWithProviders(<IssuesPanel repoId={1} />);
    await screen.findByRole("button", { name: "Reconnect" });
    expect(refresh()).toBeDisabled();
  });
});

// Contract: provider errors show their copy in an alert whose Dismiss retries.
describe("IssuesPanel list errors", () => {
  it.each([
    ["hostingNotFound", "This repository isn't visible to your GitHub account."],
    ["hostingUnreachable", "Couldn't reach GitHub. Check your connection."],
    ["hostingRateLimited", "GitHub rate limit reached. Try again in a few minutes."],
  ] as const)("shows the %s text in an alert", async (kind, text) => {
    vi.mocked(hostingListIssues).mockRejectedValue(hostingError(kind));
    renderWithProviders(<IssuesPanel repoId={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(text);
  });

  it("Dismiss refetches the list", async () => {
    vi.mocked(hostingListIssues).mockRejectedValueOnce(hostingError("hostingNotFound"));
    const { user } = renderWithProviders(<IssuesPanel repoId={1} />);
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByRole("button", { name: "Issues (2)" })).toBeInTheDocument();
    expect(hostingListIssues).toHaveBeenCalledTimes(2);
  });
});

// Contract: the row menu offers Open in browser and Copy link.
describe("IssuesPanel context menu", () => {
  it("lists Open in browser and Copy link", async () => {
    await renderPanel();
    rightClick(row(12));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
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

  it("Open in browser opens the issue's web URL", async () => {
    const { user } = await renderPanel();
    rightClick(row(12));
    await user.click(menuItem("Open in browser"));
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(issue(12).webUrl);
  });

  it("the row's open button opens the same URL", async () => {
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "Open #9 in browser" }));
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(issue(9).webUrl);
  });

  it("Copy link copies the web URL", async () => {
    const { user } = await renderPanel();
    rightClick(row(12));
    await user.click(menuItem("Copy link"));
    expect(copyText).toHaveBeenCalledExactlyOnceWith(issue(12).webUrl);
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

  it("shows a failed open as an alert", async () => {
    vi.mocked(openExternal).mockRejectedValue(new Error("no browser"));
    const { user } = await renderPanel();
    await user.click(screen.getByRole("button", { name: "Open #12 in browser" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no browser");
  });
});
