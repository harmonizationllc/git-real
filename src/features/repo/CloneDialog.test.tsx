import { act, fireEvent, screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkGitCli, cloneRepo, listRecent, onCloneProgress, pickFolder } from "../../lib/ipc";
import type { OpenedRepo, Progress, UnlistenFn } from "../../lib/ipc";
import { useRepoTabs } from "../../lib/store/repoTabs";
import { renderWithProviders } from "../../test/renderWithProviders";
import { CloneDialog } from "./CloneDialog";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  checkGitCli: vi.fn(),
  cloneRepo: vi.fn(),
  onCloneProgress: vi.fn(),
  pickFolder: vi.fn(),
  listRecent: vi.fn(),
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
