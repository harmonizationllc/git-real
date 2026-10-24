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
import { hostedRepo, hostingAccount } from "../../test/hostingFixtures";
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
  vi.mocked(checkGitCli).mockResolvedValue({ available: true, path: "/usr/bin/git" });
  vi.mocked(pickFolder).mockResolvedValue("/home/u/src");
  vi.mocked(listRecent).mockResolvedValue([]);
  vi.mocked(hostingListAccounts).mockResolvedValue([]);
  vi.mocked(hostingListMyRepos).mockResolvedValue([hostedRepo()]);
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
    vi.mocked(checkGitCli).mockResolvedValue({ available: false, path: null });
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    expect(
      await screen.findByText("Git was not found on your PATH. Install Git to clone repositories."),
    ).toBeInTheDocument();
  });

  it("should offer only a Close button when git is missing", async () => {
    vi.mocked(checkGitCli).mockResolvedValue({ available: false, path: null });
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await screen.findByText(/Git was not found/);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
  });

  it("should not show the URL field when git is missing", async () => {
    vi.mocked(checkGitCli).mockResolvedValue({ available: false, path: null });
    renderWithProviders(<CloneDialog open onClose={vi.fn()} />);
    await screen.findByText(/Git was not found/);
    expect(screen.queryByLabelText("Repository URL")).not.toBeInTheDocument();
  });

  it("should call onClose once when Close is clicked in the git-missing state", async () => {
    vi.mocked(checkGitCli).mockResolvedValue({ available: false, path: null });
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
    vi.mocked(checkGitCli).mockResolvedValue({ available: false, path: null });
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
    vi.mocked(hostingListMyRepos).mockResolvedValue([repo]);
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
