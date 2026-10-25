import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkGitCli,
  cloneRepo,
  hostingListAccounts,
  hostingListMyRepos,
  listRecent,
  onCloneProgress,
  pickFolder,
} from "../../lib/ipc";
import type { OpenedRepo, Progress, UnlistenFn } from "../../lib/ipc";
import { useLayoutPrefs } from "../../lib/store/layoutPrefs";
import { useRepoTabs } from "../../lib/store/repoTabs";
import { hostedRepo, hostedRepoPage, hostingAccount } from "../../test/hostingFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { CloneDialog } from "./CloneDialog";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  checkGitCli: vi.fn(),
  cloneRepo: vi.fn(),
  onCloneProgress: vi.fn(),
  pickFolder: vi.fn(),
  listRecent: vi.fn(),
  hostingListAccounts: vi.fn(),
  hostingListMyRepos: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const URL_A = "https://github.com/a/b.git";
const opened: OpenedRepo = {
  id: 7,
  summary: { path: "/home/u/src/b", name: "b", headBranch: "main", isBare: false },
};
const cloneFailed = { kind: "cloneFailed", message: "fatal: repository not found" };

let push: (p: Progress) => void;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  useRepoTabs.setState(useRepoTabs.getInitialState(), true);
  unlisten = vi.fn();
  vi.mocked(checkGitCli).mockResolvedValue({
    available: true,
    path: "/usr/bin/git",
    version: "2.43.0",
    error: null,
  });
  vi.mocked(pickFolder).mockResolvedValue("/home/u/src");
  vi.mocked(listRecent).mockResolvedValue([]);
  vi.mocked(hostingListAccounts).mockResolvedValue([]);
  vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage([hostedRepo()]));
  localStorage.clear();
  useLayoutPrefs.setState({ cloneUrlForm: "https" });
  vi.mocked(onCloneProgress).mockImplementation(async (_id, handler) => {
    push = handler;
    return unlisten as unknown as UnlistenFn;
  });
});

async function fillForm(user: UserEvent, url = URL_A) {
  await user.type(await screen.findByLabelText("Repository URL"), url);
  await user.click(screen.getByRole("button", { name: "Choose folder" }));
  await screen.findByText("Destination: /home/u/src/b");
}

const cloneBtn = () => screen.getByRole("button", { name: "Clone" });
const dialog = () => screen.getByRole("dialog", { name: "Clone repository" });
const dialogBox = dialog;
const bar = () => screen.getByRole("progressbar", { name: "Clone progress" });

async function startClone(onClose = vi.fn()) {
  const view = renderWithProviders(<CloneDialog open onClose={onClose} />);
  await fillForm(view.user);
  await view.user.click(cloneBtn());
  return { ...view, onClose };
}

// Contract: the dialog renders nothing when closed and does not touch git.
describe("CloneDialog closed", () => {
  it("should render nothing and not check git when open is false", () => {
    const { container } = renderWithProviders(<CloneDialog open={false} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    expect(checkGitCli).not.toHaveBeenCalled();
  });
});

// Contract: git availability gates the form (checking, missing, fail-open on error).
describe("CloneDialog git check", () => {
  it("should show the git-missing notice when checkGitCli reports unavailable", async () => {
    vi.mocked(checkGitCli).mockResolvedValue({
      available: false,
      path: null,
      version: null,
      error: "git: command not found",
    });
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    expect(
      await screen.findByText("Git was not found on your PATH. Install Git to clone repositories."),
    ).toBeInTheDocument();
  });

  it("should offer only a Close button when git is missing", async () => {
    vi.mocked(checkGitCli).mockResolvedValue({
      available: false,
      path: null,
      version: null,
      error: "git: command not found",
    });
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await screen.findByText(/Git was not found/);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
  });

  it("should not show the URL field when git is missing", async () => {
    vi.mocked(checkGitCli).mockResolvedValue({
      available: false,
      path: null,
      version: null,
      error: "git: command not found",
    });
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await screen.findByText(/Git was not found/);
    expect(screen.queryByLabelText("Repository URL")).not.toBeInTheDocument();
  });

  it("should call onClose once when Close is clicked in the git-missing state", async () => {
    vi.mocked(checkGitCli).mockResolvedValue({
      available: false,
      path: null,
      version: null,
      error: "git: command not found",
    });
    const onClose = vi.fn();
    const { user } = renderWithProviders(<CloneDialog open onClose={onClose} />);
    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("should show a checking status while the git check is pending", () => {
    vi.mocked(checkGitCli).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking for Git…");
  });

  it("should not show the URL field while the git check is pending", () => {
    vi.mocked(checkGitCli).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    expect(screen.queryByLabelText("Repository URL")).not.toBeInTheDocument();
  });

  it("should show the form when the git check itself fails", async () => {
    vi.mocked(checkGitCli).mockRejectedValue(new Error("ipc down"));
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    expect(await screen.findByLabelText("Repository URL")).toBeInTheDocument();
  });

  it("should expose a dialog named Clone repository", async () => {
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await screen.findByLabelText("Repository URL");
    expect(dialog()).toBeInTheDocument();
  });

  it("should focus the URL field when the form appears", async () => {
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    expect(await screen.findByLabelText("Repository URL")).toHaveFocus();
  });
});

// Contract: Clone is enabled only with a valid URL and a chosen folder; destination is derived.
describe("CloneDialog form", () => {
  it("should disable Clone when nothing has been entered", async () => {
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await screen.findByLabelText("Repository URL");
    expect(cloneBtn()).toBeDisabled();
  });

  it("should keep Clone disabled when only a URL is entered", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.type(await screen.findByLabelText("Repository URL"), URL_A);
    expect(cloneBtn()).toBeDisabled();
  });

  it("should keep Clone disabled when only a folder is chosen", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await screen.findByLabelText("Repository URL");
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    await vi.waitFor(() => expect(pickFolder).toHaveBeenCalled());
    expect(cloneBtn()).toBeDisabled();
  });

  it("should enable Clone once a URL and a folder are set", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await fillForm(user);
    expect(cloneBtn()).toBeEnabled();
  });

  it("should keep Clone disabled and show no destination when the URL is invalid", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.type(await screen.findByLabelText("Repository URL"), "https://x/");
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    await vi.waitFor(() => expect(pickFolder).toHaveBeenCalled());
    expect(cloneBtn()).toBeDisabled();
    expect(screen.queryByText(/Destination:/)).not.toBeInTheDocument();
  });

  it("should show the derived destination from the folder and repo name", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await fillForm(user);
    expect(screen.getByText("Destination: /home/u/src/b")).toBeInTheDocument();
  });

  it("should open the folder picker with the destination folder title", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await fillForm(user);
    expect(pickFolder).toHaveBeenCalledExactlyOnceWith("Choose destination folder");
  });

  it("should use a single separator when the chosen folder ends with a slash", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/home/u/src/");
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await fillForm(user);
    expect(screen.getByText("Destination: /home/u/src/b")).toBeInTheDocument();
  });

  it("should use a single separator when the chosen folder ends with a backslash", async () => {
    vi.mocked(pickFolder).mockResolvedValue("C:\\src\\");
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.type(await screen.findByLabelText("Repository URL"), URL_A);
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    expect(await screen.findByText("Destination: C:\\src/b")).toBeInTheDocument();
  });

  it("should keep the previous folder when the picker is cancelled", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await fillForm(user);
    vi.mocked(pickFolder).mockResolvedValue(null);
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    await vi.waitFor(() => expect(pickFolder).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Destination: /home/u/src/b")).toBeInTheDocument();
  });
});

// Contract: Clone subscribes to progress first, then invokes cloneRepo with a shared numeric id.
describe("CloneDialog clone start", () => {
  it("should call cloneRepo with url, destination and a numeric cloneId", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await fillForm(user);
    vi.spyOn(Date, "now").mockReturnValue(1234);
    await user.click(cloneBtn());
    expect(cloneRepo).toHaveBeenCalledExactlyOnceWith(URL_A, "/home/u/src/b", 1234);
  });

  it("should subscribe to progress with the same cloneId", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await fillForm(user);
    vi.spyOn(Date, "now").mockReturnValue(1234);
    await user.click(cloneBtn());
    expect(onCloneProgress).toHaveBeenCalledExactlyOnceWith(1234, expect.any(Function));
  });

  it("should trim the URL before cloning", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await fillForm(user, `  ${URL_A}  `);
    await user.click(cloneBtn());
    expect(cloneRepo).toHaveBeenCalledWith(URL_A, "/home/u/src/b", expect.any(Number));
  });

  it("should subscribe before invoking the clone", async () => {
    const sub = deferred<UnlistenFn>();
    vi.mocked(onCloneProgress).mockReturnValue(sub.promise);
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await fillForm(user);
    await user.click(cloneBtn());
    expect(cloneRepo).not.toHaveBeenCalled();
    await act(async () => sub.resolve(unlisten as unknown as UnlistenFn));
    expect(cloneRepo).toHaveBeenCalledTimes(1);
  });

  it("should submit when Enter is pressed in the URL field and the form is valid", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await fillForm(user);
    await user.type(screen.getByLabelText("Repository URL"), "{Enter}");
    expect(cloneRepo).toHaveBeenCalledTimes(1);
  });

  it("should not clone when Enter is pressed before a folder is chosen", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.type(await screen.findByLabelText("Repository URL"), `${URL_A}{Enter}`);
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  it("should clone even when the progress subscription fails", async () => {
    vi.mocked(onCloneProgress).mockRejectedValue(new Error("listen failed"));
    vi.mocked(cloneRepo).mockResolvedValue(opened);
    const { onClose } = await startClone();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(cloneRepo).toHaveBeenCalledTimes(1);
  });
});

// Contract: progress UI reflects the latest event and is indeterminate when percent is null.
describe("CloneDialog progress", () => {
  it("should show a starting message and an indeterminate bar before the first event", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    await startClone();
    expect(await screen.findByText("Starting clone…")).toBeInTheDocument();
    expect(bar()).not.toHaveAttribute("value");
  });

  it("should show the percent and message when a progress event arrives", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    await startClone();
    await screen.findByText("Starting clone…");
    act(() => push({ phase: "receiving", percent: 42, message: "Receiving objects: 42%" }));
    expect(bar()).toHaveAttribute("value", "42");
    expect(screen.getByText("Receiving objects: 42%")).toBeInTheDocument();
  });

  it("should become indeterminate when a later event has a null percent", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    await startClone();
    await screen.findByText("Starting clone…");
    act(() => push({ phase: "receiving", percent: 42, message: "Receiving objects: 42%" }));
    act(() => push({ phase: "resolving", percent: null, message: "Resolving deltas" }));
    expect(bar()).not.toHaveAttribute("value");
    expect(screen.getByText("Resolving deltas")).toBeInTheDocument();
  });

  it("should not show a progress bar before the clone starts", async () => {
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await screen.findByLabelText("Repository URL");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("should disable the inputs, Clone and Cancel while cloning", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    await startClone();
    await screen.findByText("Starting clone…");
    expect(screen.getByLabelText("Repository URL")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Choose folder" })).toBeDisabled();
    expect(cloneBtn()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("should not start a second clone when the form is submitted again while cloning", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    await startClone();
    await screen.findByText("Starting clone…");
    fireEvent.submit(screen.getByLabelText("Repository URL").closest("form")!);
    expect(cloneRepo).toHaveBeenCalledTimes(1);
    expect(onCloneProgress).toHaveBeenCalledTimes(1);
  });

  it("should ignore Escape while cloning", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    const { onClose } = await startClone();
    await screen.findByText("Starting clone…");
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Contract: success opens the tab and closes; failure keeps the dialog open with an inline error.
describe("CloneDialog outcome", () => {
  it("should open a tab for the cloned repo when the clone succeeds", async () => {
    const d = deferred<OpenedRepo>();
    vi.mocked(cloneRepo).mockReturnValue(d.promise);
    await startClone();
    await act(async () => d.resolve(opened));
    const { tabs, activeId } = useRepoTabs.getState();
    expect(tabs.map((t) => t.id)).toEqual([7]);
    expect(activeId).toBe(7);
  });

  it("should call onClose once when the clone succeeds", async () => {
    const d = deferred<OpenedRepo>();
    vi.mocked(cloneRepo).mockReturnValue(d.promise);
    const { onClose } = await startClone();
    await act(async () => d.resolve(opened));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("should unlisten exactly once when the clone succeeds", async () => {
    const d = deferred<OpenedRepo>();
    vi.mocked(cloneRepo).mockReturnValue(d.promise);
    await startClone();
    await act(async () => d.resolve(opened));
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("should show the error inline and keep the dialog open when the clone fails", async () => {
    const d = deferred<OpenedRepo>();
    vi.mocked(cloneRepo).mockReturnValue(d.promise);
    const { onClose } = await startClone();
    await act(async () => d.reject(cloneFailed));
    expect(await screen.findByRole("alert")).toHaveTextContent("fatal: repository not found");
    expect(dialog()).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should re-enable Clone and hide the progress bar when the clone fails", async () => {
    const d = deferred<OpenedRepo>();
    vi.mocked(cloneRepo).mockReturnValue(d.promise);
    await startClone();
    await act(async () => d.reject(cloneFailed));
    await screen.findByRole("alert");
    expect(cloneBtn()).toBeEnabled();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("should unlisten exactly once and open no tab when the clone fails", async () => {
    const d = deferred<OpenedRepo>();
    vi.mocked(cloneRepo).mockReturnValue(d.promise);
    await startClone();
    await act(async () => d.reject(cloneFailed));
    await screen.findByRole("alert");
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
    expect(useRepoTabs.getState().tabs).toEqual([]);
  });

  it("should show an io error when the clone rejects with a non-AppError", async () => {
    vi.mocked(cloneRepo).mockRejectedValue(new Error("boom"));
    await startClone();
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });

  it("should clear the error and show starting progress when retrying after a failure", async () => {
    vi.mocked(cloneRepo).mockRejectedValueOnce(cloneFailed);
    const { user } = await startClone();
    await screen.findByRole("alert");
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    await user.click(cloneBtn());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(await screen.findByText("Starting clone…")).toBeInTheDocument();
  });

  it("should clear the clone error when Dismiss is clicked", async () => {
    vi.mocked(cloneRepo).mockRejectedValue(cloneFailed);
    const { user } = await startClone();
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("should not offer Initialize here for a clone error", async () => {
    vi.mocked(cloneRepo).mockRejectedValue({ kind: "notARepository", message: "nope" });
    await startClone();
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /Initialize/ })).not.toBeInTheDocument();
  });
});

// Contract: the subscription is released exactly once, including on unmount.
describe("CloneDialog unsubscribe", () => {
  it("should unlisten once when unmounted while a clone is pending", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    const { unmount } = await startClone();
    await screen.findByText("Starting clone…");
    unmount();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("should unlisten only once when unmounted after a successful clone", async () => {
    vi.mocked(cloneRepo).mockResolvedValue(opened);
    const { unmount } = await startClone();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
    unmount();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("should still unlisten when the subscription resolves after unmount", async () => {
    const sub = deferred<UnlistenFn>();
    vi.mocked(onCloneProgress).mockReturnValue(sub.promise);
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    const { unmount } = await startClone();
    unmount();
    expect(unlisten).not.toHaveBeenCalled();
    await act(async () => sub.resolve(unlisten as unknown as UnlistenFn));
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("should not call unlisten when unmounted without ever cloning", async () => {
    const { unmount } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await screen.findByLabelText("Repository URL");
    unmount();
    expect(unlisten).not.toHaveBeenCalled();
  });
});

// Contract: Cancel and Escape close an idle dialog; reopening starts from a clean form.
describe("CloneDialog dismissal", () => {
  it("should call onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const { user } = renderWithProviders(<CloneDialog open onClose={onClose} />);
    await screen.findByLabelText("Repository URL");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("should call onClose when Escape is pressed while idle", async () => {
    const onClose = vi.fn();
    renderWithProviders(<CloneDialog open onClose={onClose} />);
    await screen.findByLabelText("Repository URL");
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("should not call onClose when a non-Escape key is pressed", async () => {
    const onClose = vi.fn();
    renderWithProviders(<CloneDialog open onClose={onClose} />);
    await screen.findByLabelText("Repository URL");
    fireEvent.keyDown(dialog(), { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should reset the form when the dialog is closed and reopened", async () => {
    const { user, rerender } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await fillForm(user);
    rerender(<CloneDialog open={false} onClose={vi.fn()} />);
    rerender(<CloneDialog open onClose={vi.fn()} />);
    expect(await screen.findByLabelText("Repository URL")).toHaveValue("");
    expect(screen.queryByText(/Destination:/)).not.toBeInTheDocument();
  });
});

// Contract (GR-13c): a Clone source tablist switches between the URL field and the account browser.
describe("CloneDialog source tabs", () => {
  const urlTab = () => screen.getByRole("tab", { name: "URL" });
  const accountTab = () => screen.getByRole("tab", { name: "From account" });
  const urlField = () => screen.getByLabelText("Repository URL");

  async function renderOpen(onClose = vi.fn()) {
    const view = renderWithProviders(<CloneDialog open onClose={onClose} />);
    await screen.findByLabelText("Repository URL");
    return { ...view, onClose };
  }

  it("should show a tablist named Clone source with URL and From account tabs", async () => {
    await renderOpen();
    const list = screen.getByRole("tablist", { name: "Clone source" });
    expect(
      within(list)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["URL", "From account"]);
  });

  it("should select the URL tab by default", async () => {
    await renderOpen();
    expect(urlTab()).toHaveAttribute("aria-selected", "true");
    expect(accountTab()).toHaveAttribute("aria-selected", "false");
  });

  it("should show the URL field and hide the browser by default", async () => {
    await renderOpen();
    expect(urlField()).toBeVisible();
    expect(screen.queryByLabelText("Search repositories")).not.toBeInTheDocument();
  });

  it("should not request repositories while the URL tab is active", async () => {
    await renderOpen();
    await act(() => Promise.resolve());
    expect(hostingListMyRepos).not.toHaveBeenCalled();
  });

  it("should link each tab to its tabpanel", async () => {
    await renderOpen();
    const panel = screen.getByRole("tabpanel", { name: "URL" });
    expect(urlTab()).toHaveAttribute("aria-controls", panel.id);
    expect(accountTab().getAttribute("aria-controls")).not.toBe(panel.id);
    expect(
      document.getElementById(accountTab().getAttribute("aria-controls") as string),
    ).not.toBeNull();
  });

  it("should give only the selected tab a tab stop", async () => {
    await renderOpen();
    expect(urlTab()).toHaveAttribute("tabindex", "0");
    expect(accountTab()).toHaveAttribute("tabindex", "-1");
  });

  it("should show the browser when From account is clicked", async () => {
    vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
    const { user } = await renderOpen();
    await user.click(accountTab());
    expect(accountTab()).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("button", { name: "Use octo/git-real" })).toBeInTheDocument();
    expect(hostingListMyRepos).toHaveBeenCalledWith("github:github.com:octo", "", 1);
  });

  it("should hide the URL field while From account is active", async () => {
    const { user } = await renderOpen();
    await user.click(accountTab());
    expect(screen.queryByLabelText("Repository URL")).not.toBeInTheDocument();
  });

  it("should keep a typed URL when switching to From account and back", async () => {
    const { user } = await renderOpen();
    await user.type(urlField(), URL_A);
    await user.click(accountTab());
    await user.click(urlTab());
    expect(urlField()).toHaveValue(URL_A);
  });

  it("should move to From account and focus it on ArrowRight", async () => {
    const { user } = await renderOpen();
    urlTab().focus();
    await user.keyboard("{ArrowRight}");
    expect(accountTab()).toHaveAttribute("aria-selected", "true");
    expect(accountTab()).toHaveFocus();
  });

  it("should wrap to From account on ArrowLeft from URL", async () => {
    const { user } = await renderOpen();
    urlTab().focus();
    await user.keyboard("{ArrowLeft}");
    expect(accountTab()).toHaveAttribute("aria-selected", "true");
  });

  it("should wrap back to URL on ArrowRight from From account", async () => {
    const { user } = await renderOpen();
    await user.click(accountTab());
    await user.keyboard("{ArrowRight}");
    expect(urlTab()).toHaveAttribute("aria-selected", "true");
    expect(urlTab()).toHaveFocus();
  });

  it("should select the last tab on End and the first on Home", async () => {
    const { user } = await renderOpen();
    urlTab().focus();
    await user.keyboard("{End}");
    expect(accountTab()).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Home}");
    expect(urlTab()).toHaveAttribute("aria-selected", "true");
  });

  it("should ignore other keys on a tab", async () => {
    const { user } = await renderOpen();
    urlTab().focus();
    await user.keyboard("a");
    expect(urlTab()).toHaveAttribute("aria-selected", "true");
  });

  it("should move the tab stop and aria-selected together with the keyboard selection", async () => {
    const { user } = await renderOpen();
    urlTab().focus();
    await user.keyboard("{ArrowRight}");
    expect(accountTab()).toHaveAttribute("tabindex", "0");
    expect(urlTab()).toHaveAttribute("tabindex", "-1");
    expect(urlTab()).toHaveAttribute("aria-selected", "false");
    await user.keyboard("{ArrowLeft}");
    expect(urlTab()).toHaveAttribute("tabindex", "0");
    expect(accountTab()).toHaveAttribute("tabindex", "-1");
    expect(accountTab()).toHaveAttribute("aria-selected", "false");
  });

  it("should keep the selected tab on Home from URL and on End from From account", async () => {
    const { user } = await renderOpen();
    urlTab().focus();
    await user.keyboard("{Home}");
    expect(urlTab()).toHaveAttribute("aria-selected", "true");
    expect(urlTab()).toHaveFocus();
    await user.click(accountTab());
    await user.keyboard("{End}");
    expect(accountTab()).toHaveAttribute("aria-selected", "true");
    expect(accountTab()).toHaveFocus();
  });

  it("should swap the visible panel with the keyboard selection", async () => {
    const { user } = await renderOpen();
    const panelOf = (tab: HTMLElement) =>
      document.getElementById(tab.getAttribute("aria-controls") as string) as HTMLElement;
    expect(panelOf(urlTab())).toBeVisible();
    expect(panelOf(accountTab())).not.toBeVisible();
    urlTab().focus();
    await user.keyboard("{ArrowRight}");
    expect(panelOf(accountTab())).toBeVisible();
    expect(panelOf(urlTab())).not.toBeVisible();
  });

  it("should prevent the default of handled keys only, so Home and End do not scroll", async () => {
    await renderOpen();
    expect(fireEvent.keyDown(urlTab(), { key: "Home" })).toBe(false);
    expect(fireEvent.keyDown(urlTab(), { key: "End" })).toBe(false);
    expect(fireEvent.keyDown(urlTab(), { key: "ArrowRight" })).toBe(false);
    expect(fireEvent.keyDown(urlTab(), { key: "a" })).toBe(true);
  });

  it("should disable both tabs while cloning", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    await startClone();
    await screen.findByText("Starting clone…");
    expect(urlTab()).toBeDisabled();
    expect(accountTab()).toBeDisabled();
  });

  it("should start on the URL tab when reopened after using From account", async () => {
    const { user, rerender } = await renderOpen();
    await user.click(accountTab());
    rerender(<CloneDialog open={false} onClose={vi.fn()} />);
    rerender(<CloneDialog open onClose={vi.fn()} />);
    expect(await screen.findByLabelText("Repository URL")).toBeInTheDocument();
    expect(urlTab()).toHaveAttribute("aria-selected", "true");
  });

  it("should not render the tabs when git is missing", async () => {
    vi.mocked(checkGitCli).mockResolvedValue({
      available: false,
      path: null,
      version: null,
      error: "git: command not found",
    });
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await screen.findByText(/Git was not found/);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  // Escape and Cancel keep working from the From account tab.
  it("should close on Escape from the From account tab", async () => {
    const { user, onClose } = await renderOpen();
    await user.click(accountTab());
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("should close on Cancel from the From account tab", async () => {
    const { user, onClose } = await renderOpen();
    await user.click(accountTab());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// Contract: a pick fills the URL field, activates URL and focuses the field; Destination follows.
describe("CloneDialog repository pick", () => {
  const urlField = () => screen.getByLabelText("Repository URL");
  const HINT = "This repository has no SSH URL; HTTPS was used";

  async function pickFirst(repo = hostedRepo()) {
    vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
    vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage([repo]));
    const view = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await view.user.click(await screen.findByRole("tab", { name: "From account" }));
    await view.user.click(await screen.findByRole("button", { name: `Use ${repo.fullName}` }));
    return view;
  }

  it("should fill the Repository URL field with the HTTPS URL by default", async () => {
    await pickFirst();
    expect(urlField()).toHaveValue("https://github.com/octo/git-real.git");
  });

  it("should fill the field with the SSH URL when SSH is preferred", async () => {
    useLayoutPrefs.setState({ cloneUrlForm: "ssh" });
    await pickFirst();
    expect(urlField()).toHaveValue("git@github.com:octo/git-real.git");
  });

  it("should activate the URL tab after a pick", async () => {
    await pickFirst();
    expect(screen.getByRole("tab", { name: "URL" })).toHaveAttribute("aria-selected", "true");
  });

  it("should focus the Repository URL field after a pick", async () => {
    await pickFirst();
    expect(urlField()).toHaveFocus();
  });

  it("should derive the destination from the picked URL as for a typed one", async () => {
    const { user } = await pickFirst();
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    expect(await screen.findByText("Destination: /home/u/src/git-real")).toBeInTheDocument();
  });

  it("should clone the picked URL", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    const { user } = await pickFirst();
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    await screen.findByText("Destination: /home/u/src/git-real");
    await user.click(cloneBtn());
    expect(cloneRepo).toHaveBeenCalledWith(
      "https://github.com/octo/git-real.git",
      "/home/u/src/git-real",
      expect.any(Number),
    );
  });

  it("should replace a URL typed earlier with the picked one", async () => {
    vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.type(await screen.findByLabelText("Repository URL"), URL_A);
    await user.click(screen.getByRole("tab", { name: "From account" }));
    await user.click(await screen.findByRole("button", { name: "Use octo/git-real" }));
    expect(urlField()).toHaveValue("https://github.com/octo/git-real.git");
  });

  it("should show no hint after a plain pick", async () => {
    await pickFirst();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  // Review Focus 3: SSH chosen for a repository with no SSH URL.
  it("should fall back to HTTPS with a hint when the repository has no SSH URL", async () => {
    useLayoutPrefs.setState({ cloneUrlForm: "ssh" });
    await pickFirst(hostedRepo({ sshUrl: null }));
    expect(urlField()).toHaveValue("https://github.com/octo/git-real.git");
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  // Review M4: the hint appears after the pick, so it must be announced.
  it("should announce the fallback hint as a status", async () => {
    useLayoutPrefs.setState({ cloneUrlForm: "ssh" });
    await pickFirst(hostedRepo({ sshUrl: null }));
    expect(screen.getByRole("status")).toHaveTextContent(HINT);
  });

  // Fix 3: a live region only announces text that changes inside an element that was already
  // there, so one always-mounted region sits between the tabpanels (outside the URL panel) and is
  // merely filled or emptied. The URL input points at it with aria-describedby.
  describe("hint status region", () => {
    const hintNode = () => document.querySelector<HTMLElement>('p[role="status"][id$="-url-hint"]');
    const region = () => hintNode() as HTMLElement;

    async function pickFromAccountTab(repo = hostedRepo()) {
      vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
      vi.mocked(hostingListMyRepos).mockResolvedValue(hostedRepoPage([repo]));
      const view = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
      await view.user.click(await screen.findByRole("tab", { name: "From account" }));
      const before = region();
      await view.user.click(await screen.findByRole("button", { name: `Use ${repo.fullName}` }));
      return { ...view, before };
    }

    it("should render an empty status region before any pick", async () => {
      renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
      await screen.findByLabelText("Repository URL");
      expect(region()).toBeEmptyDOMElement();
    });

    it("should place the region outside both tabpanels", async () => {
      renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
      await screen.findByLabelText("Repository URL");
      expect(region()).toBeInTheDocument();
      expect(screen.getByRole("tabpanel", { name: "URL" })).not.toContainElement(region());
    });

    it("should point the URL input at the region with aria-describedby", async () => {
      renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
      const field = await screen.findByLabelText("Repository URL");
      expect(field.getAttribute("aria-describedby")).toBe(region().id);
    });

    it("should keep the region mounted while the From account tab is active", async () => {
      const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
      await screen.findByLabelText("Repository URL");
      const node = region();
      await user.click(screen.getByRole("tab", { name: "From account" }));
      expect(region()).toBe(node);
      expect(node).toBeVisible();
    });

    it("should keep the region empty after a pick that needs no fallback", async () => {
      await pickFromAccountTab();
      expect(region()).toBeEmptyDOMElement();
    });

    it("should fill the very same node that existed on the From account tab when a pick falls back", async () => {
      useLayoutPrefs.setState({ cloneUrlForm: "ssh" });
      const { before } = await pickFromAccountTab(hostedRepo({ sshUrl: null }));
      expect(region()).toBe(before);
      expect(before).toHaveTextContent(HINT);
      expect(screen.getByLabelText("Repository URL").getAttribute("aria-describedby")).toBe(
        before.id,
      );
    });

    it("should have no hint text while the From account tab is active", async () => {
      useLayoutPrefs.setState({ cloneUrlForm: "ssh" });
      vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
      const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
      await user.click(await screen.findByRole("tab", { name: "From account" }));
      await screen.findByRole("button", { name: "Use octo/git-real" });
      expect(region()).toBeEmptyDOMElement();
    });

    it("should empty the same status element, not remount it, when HTTPS is chosen again", async () => {
      useLayoutPrefs.setState({ cloneUrlForm: "ssh" });
      const { before } = await pickFromAccountTab(hostedRepo({ sshUrl: null }));
      act(() => useLayoutPrefs.getState().setCloneUrlForm("https"));
      expect(region()).toBe(before);
      expect(before).toBeEmptyDOMElement();
    });

    it("should fill the same status element, not remount it, when SSH is chosen later", async () => {
      const { before } = await pickFromAccountTab(hostedRepo({ sshUrl: null }));
      act(() => useLayoutPrefs.getState().setCloneUrlForm("ssh"));
      expect(region()).toBe(before);
      expect(before).toHaveTextContent(HINT);
    });

    it("should empty the status region once the user types in the field", async () => {
      useLayoutPrefs.setState({ cloneUrlForm: "ssh" });
      const { user } = await pickFromAccountTab(hostedRepo({ sshUrl: null }));
      await user.type(urlField(), "x");
      expect(region()).toBeEmptyDOMElement();
    });
  });

  it("should show no hint for SSH when the repository has an SSH URL", async () => {
    useLayoutPrefs.setState({ cloneUrlForm: "ssh" });
    await pickFirst();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it("should show no hint for HTTPS when the repository has no SSH URL", async () => {
    await pickFirst(hostedRepo({ sshUrl: null }));
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it("should re-fill the field with the SSH URL when the preference changes to SSH", async () => {
    await pickFirst();
    act(() => useLayoutPrefs.getState().setCloneUrlForm("ssh"));
    expect(urlField()).toHaveValue("git@github.com:octo/git-real.git");
  });

  it("should re-fill the field with the HTTPS URL when the preference changes back", async () => {
    useLayoutPrefs.setState({ cloneUrlForm: "ssh" });
    await pickFirst();
    act(() => useLayoutPrefs.getState().setCloneUrlForm("https"));
    expect(urlField()).toHaveValue("https://github.com/octo/git-real.git");
  });

  it("should show the hint after the preference changes to SSH for a repository without one", async () => {
    await pickFirst(hostedRepo({ sshUrl: null }));
    act(() => useLayoutPrefs.getState().setCloneUrlForm("ssh"));
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it("should re-fill when SSH is chosen from the radios on the From account tab", async () => {
    const { user } = await pickFirst();
    await user.click(screen.getByRole("tab", { name: "From account" }));
    await user.click(await screen.findByRole("radio", { name: "SSH" }));
    await user.click(screen.getByRole("tab", { name: "URL" }));
    expect(urlField()).toHaveValue("git@github.com:octo/git-real.git");
  });

  it("should not re-fill once the user has typed in the field", async () => {
    const { user } = await pickFirst();
    await user.type(urlField(), "x");
    act(() => useLayoutPrefs.getState().setCloneUrlForm("ssh"));
    expect(urlField()).toHaveValue("https://github.com/octo/git-real.gitx");
  });

  it("should drop the hint once the user has typed in the field", async () => {
    useLayoutPrefs.setState({ cloneUrlForm: "ssh" });
    const { user } = await pickFirst(hostedRepo({ sshUrl: null }));
    await user.type(urlField(), "x");
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it("should not touch a typed URL when the preference changes without a pick", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.type(await screen.findByLabelText("Repository URL"), URL_A);
    act(() => useLayoutPrefs.getState().setCloneUrlForm("ssh"));
    expect(urlField()).toHaveValue(URL_A);
  });

  // R6: Enter in the search field must not submit the clone form.
  it("should not clone when Enter is pressed in the search field", async () => {
    vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
    vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await fillForm(user);
    await user.click(screen.getByRole("tab", { name: "From account" }));
    await user.type(await screen.findByLabelText("Search repositories"), "git{Enter}");
    expect(cloneRepo).not.toHaveBeenCalled();
  });

  // Review I2: the radios sit inside the clone form, so Enter on one must not submit it.
  it.each(["HTTPS", "SSH"])(
    "should not clone when Enter is pressed on the %s radio",
    async (label) => {
      vi.mocked(cloneRepo).mockReturnValue(new Promise(() => {}));
      vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
      const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
      await fillForm(user);
      await user.click(screen.getByRole("tab", { name: "From account" }));
      const radio = await screen.findByRole("radio", { name: label });
      radio.focus();
      await user.keyboard("{Enter}");
      expect(cloneRepo).not.toHaveBeenCalled();
    },
  );
});

// Review Focus 4: accounts can vanish while the tab is open; a filled URL stays.
describe("CloneDialog accounts", () => {
  const NOTICE = "Connect a hosting account to browse your repositories";

  it("should show the connect notice on From account when there are no accounts", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "From account" }));
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
  });

  it("should show the connect notice when the last account disappears", async () => {
    vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
    const { user, queryClient } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.type(await screen.findByLabelText("Repository URL"), URL_A);
    await user.click(screen.getByRole("tab", { name: "From account" }));
    await screen.findByRole("button", { name: "Use octo/git-real" });
    vi.mocked(hostingListAccounts).mockResolvedValue([]);
    await act(() => queryClient.invalidateQueries({ queryKey: ["hosting"] }));
    expect(await screen.findByText(NOTICE)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "URL" }));
    expect(screen.getByLabelText("Repository URL")).toHaveValue(URL_A);
  });

  it("should keep a picked URL when the last account disappears", async () => {
    vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
    const { user, queryClient } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "From account" }));
    await user.click(await screen.findByRole("button", { name: "Use octo/git-real" }));
    vi.mocked(hostingListAccounts).mockResolvedValue([]);
    await act(() => queryClient.invalidateQueries({ queryKey: ["hosting"] }));
    expect(screen.getByLabelText("Repository URL")).toHaveValue(
      "https://github.com/octo/git-real.git",
    );
  });

  // R4: the accounts dialog is a sibling of the clone box, which goes inert behind it.
  it("should open the Hosting accounts dialog from the connect notice", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "From account" }));
    await user.click(await screen.findByRole("button", { name: "Hosting accounts…" }));
    expect(await screen.findByRole("dialog", { name: "Hosting accounts" })).toBeInTheDocument();
  });

  it("should not nest the accounts dialog inside the clone dialog box", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "From account" }));
    await user.click(await screen.findByRole("button", { name: "Hosting accounts…" }));
    const accounts = await screen.findByRole("dialog", { name: "Hosting accounts" });
    expect(dialogBox()).not.toContainElement(accounts);
  });

  it("should make the clone dialog inert while the accounts dialog is open", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "From account" }));
    await user.click(await screen.findByRole("button", { name: "Hosting accounts…" }));
    await screen.findByRole("dialog", { name: "Hosting accounts" });
    expect(dialogBox()).toHaveAttribute("inert");
  });

  it("should not close the clone dialog when Escape closes the accounts dialog", async () => {
    const onClose = vi.fn();
    const { user } = renderWithProviders(<CloneDialog open onClose={onClose} />);
    await user.click(await screen.findByRole("tab", { name: "From account" }));
    await user.click(await screen.findByRole("button", { name: "Hosting accounts…" }));
    fireEvent.keyDown(await screen.findByRole("dialog", { name: "Hosting accounts" }), {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Hosting accounts" })).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogBox()).not.toHaveAttribute("inert");
  });

  // W1: closing the nested accounts dialog returns focus to the element that opened it while that
  // is still connected and enabled; otherwise to the From account tab (R4's fallbackFocus).
  describe.each([
    [
      "Escape",
      () =>
        fireEvent.keyDown(screen.getByRole("dialog", { name: "Hosting accounts" }), {
          key: "Escape",
        }),
    ],
    ["Close", () => fireEvent.click(screen.getByRole("button", { name: "Close" }))],
  ])("cancelling the nested accounts dialog with %s", (_how, close) => {
    const closed = () =>
      waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Hosting accounts" })).not.toBeInTheDocument(),
      );

    it("should focus the Hosting accounts… button that opened it", async () => {
      const onClose = vi.fn();
      const { user } = renderWithProviders(<CloneDialog open onClose={onClose} />);
      await user.click(await screen.findByRole("tab", { name: "From account" }));
      const opener = await screen.findByRole("button", { name: "Hosting accounts…" });
      await user.click(opener);
      await screen.findByRole("dialog", { name: "Hosting accounts" });
      close();
      await closed();
      expect(document.activeElement).toBe(opener);
      expect(screen.getByRole("tab", { name: "From account" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(onClose).not.toHaveBeenCalled();
    });

    it("should focus the Reconnect button that opened it", async () => {
      vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount({ needsReconnect: true })]);
      const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
      await user.click(await screen.findByRole("tab", { name: "From account" }));
      const opener = await screen.findByRole("button", { name: "Reconnect" });
      await user.click(opener);
      await screen.findByRole("dialog", { name: "Hosting accounts" });
      close();
      await closed();
      expect(document.activeElement).toBe(opener);
    });
  });

  it("should focus the From account tab when connecting an account removed the opener", async () => {
    const onClose = vi.fn();
    const { user, queryClient } = renderWithProviders(<CloneDialog open onClose={onClose} />);
    await user.click(await screen.findByRole("tab", { name: "From account" }));
    await user.click(await screen.findByRole("button", { name: "Hosting accounts…" }));
    const accountsDialog = await screen.findByRole("dialog", { name: "Hosting accounts" });
    vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
    await act(() => queryClient.invalidateQueries({ queryKey: ["hosting"] }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Hosting accounts…" })).not.toBeInTheDocument(),
    );
    fireEvent.click(within(accountsDialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Hosting accounts" })).not.toBeInTheDocument(),
    );
    const tab = screen.getByRole("tab", { name: "From account" });
    expect(document.activeElement).toBe(tab);
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(onClose).not.toHaveBeenCalled();
  });

  // Fix 4: an opener recorded as <body> (nothing was focused at the click) is not inside the clone
  // box, so focus goes to the From account tab instead of being "restored" to the body.
  it("should focus the From account tab when the recorded opener is the document body", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "From account" }));
    const opener = await screen.findByRole("button", { name: "Hosting accounts…" });
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(opener);
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: "Hosting accounts" })).getByRole("button", {
        name: "Close",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Hosting accounts" })).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "From account" }));
  });

  it("should not leave focus on the body after the accounts dialog closes", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "From account" }));
    const opener = await screen.findByRole("button", { name: "Hosting accounts…" });
    (document.activeElement as HTMLElement).blur();
    fireEvent.click(opener);
    fireEvent.keyDown(await screen.findByRole("dialog", { name: "Hosting accounts" }), {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Hosting accounts" })).not.toBeInTheDocument(),
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(dialogBox()).toContainElement(document.activeElement as HTMLElement);
  });

  it("should open the accounts dialog preset to the account from Reconnect", async () => {
    vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount({ needsReconnect: true })]);
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "From account" }));
    await user.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(await screen.findByRole("dialog", { name: "Connect account" })).toBeInTheDocument();
  });

  it("should not render the accounts dialog before it is asked for", async () => {
    const { user } = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await user.click(await screen.findByRole("tab", { name: "From account" }));
    await screen.findByText(NOTICE);
    expect(screen.queryByRole("dialog", { name: "Hosting accounts" })).not.toBeInTheDocument();
  });
});

// Fix 5: the dialog owns the selected account, so it survives a trip to the URL tab and back.
describe("CloneDialog selected account", () => {
  const LAB = "gitlab:gitlab.example.com:octo2";
  const OCTO = "github:github.com:octo";

  beforeEach(() => {
    vi.mocked(hostingListAccounts).mockResolvedValue([
      hostingAccount(),
      hostingAccount({
        id: LAB,
        provider: "gitlab",
        host: "gitlab.example.com",
        username: "octo2",
      }),
    ]);
  });

  async function openAccountTab() {
    const view = renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await view.user.click(await screen.findByRole("tab", { name: "From account" }));
    await screen.findByRole("button", { name: "Use octo/git-real" });
    return view;
  }

  it("should start on the first account", async () => {
    await openAccountTab();
    expect(screen.getByLabelText("Account")).toHaveValue(OCTO);
  });

  it("should keep the second account selected after switching to URL and back", async () => {
    const { user } = await openAccountTab();
    await user.selectOptions(screen.getByLabelText("Account"), LAB);
    await user.click(screen.getByRole("tab", { name: "URL" }));
    await user.click(screen.getByRole("tab", { name: "From account" }));
    expect(await screen.findByLabelText("Account")).toHaveValue(LAB);
  });

  it("should request the kept account again, not the first, when the tab returns", async () => {
    const { user } = await openAccountTab();
    await user.selectOptions(screen.getByLabelText("Account"), LAB);
    await user.click(screen.getByRole("tab", { name: "URL" }));
    await user.click(screen.getByRole("tab", { name: "From account" }));
    await screen.findByLabelText("Account");
    await waitFor(() => expect(hostingListMyRepos).toHaveBeenLastCalledWith(LAB, "", 1));
  });

  it("should keep the account after a pick brings the user back to the tab", async () => {
    const { user } = await openAccountTab();
    await user.selectOptions(screen.getByLabelText("Account"), LAB);
    await user.click(await screen.findByRole("button", { name: "Use octo/git-real" }));
    await user.click(screen.getByRole("tab", { name: "From account" }));
    expect(await screen.findByLabelText("Account")).toHaveValue(LAB);
  });

  it("should fall back to the first account when the kept one disappears", async () => {
    const { user, queryClient } = await openAccountTab();
    await user.selectOptions(screen.getByLabelText("Account"), LAB);
    await user.click(screen.getByRole("tab", { name: "URL" }));
    vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
    await act(() => queryClient.invalidateQueries({ queryKey: ["hosting"] }));
    await user.click(screen.getByRole("tab", { name: "From account" }));
    await waitFor(() => expect(hostingListMyRepos).toHaveBeenLastCalledWith(OCTO, "", 1));
    expect(screen.queryByLabelText("Account")).not.toBeInTheDocument();
  });
});

// Fix 6: Escape in the search field clears it first; only an Escape on an empty field closes.
describe("CloneDialog Escape in the repository search", () => {
  async function openSearch() {
    vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
    const onClose = vi.fn();
    const view = renderWithProviders(<CloneDialog open onClose={onClose} />);
    await view.user.click(await screen.findByRole("tab", { name: "From account" }));
    const field = await screen.findByLabelText("Search repositories");
    return { ...view, onClose, field };
  }

  it("should keep the dialog open and empty the field on Escape with text", async () => {
    const { onClose, field } = await openSearch();
    fireEvent.change(field, { target: { value: "git" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(field).toHaveValue("");
  });

  it("should close the dialog on a second Escape once the field is empty", async () => {
    const { onClose, field } = await openSearch();
    fireEvent.change(field, { target: { value: "git" } });
    fireEvent.keyDown(field, { key: "Escape" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("should close the dialog on Escape in an empty search field", async () => {
    const { onClose, field } = await openSearch();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("should still close on Escape from the tab strip while the field has text", async () => {
    const { onClose, field } = await openSearch();
    fireEvent.change(field, { target: { value: "git" } });
    fireEvent.keyDown(screen.getByRole("tab", { name: "From account" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // An Escape that cancels an IME composition belongs to the composition, not to the dialog.
  it("should neither clear nor close on an Escape that cancels an IME composition", async () => {
    const { onClose, field } = await openSearch();
    fireEvent.change(field, { target: { value: "git" } });
    fireEvent.keyDown(field, { key: "Escape", isComposing: true });
    expect(field).toHaveValue("git");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should neither clear nor close on an Escape with keyCode 229 (WebKit after a composition)", async () => {
    const { onClose, field } = await openSearch();
    fireEvent.change(field, { target: { value: "git" } });
    fireEvent.keyDown(field, { key: "Escape", keyCode: 229 });
    expect(field).toHaveValue("git");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should not close on an Escape that cancels an IME composition in the URL field", async () => {
    const onClose = vi.fn();
    renderWithProviders(<CloneDialog open onClose={onClose} />);
    const url = await screen.findByLabelText("Repository URL");
    fireEvent.change(url, { target: { value: "https://example.com/r.git" } });
    fireEvent.keyDown(url, { key: "Escape", isComposing: true });
    expect(url).toHaveValue("https://example.com/r.git");
    expect(onClose).not.toHaveBeenCalled();
  });
});
