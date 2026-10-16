import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../lib/query/client";
import {
  checkGitCli,
  cloneRepo,
  closeRepo,
  listRecent,
  onCloneProgress,
  openRepo,
  pickFolder,
} from "../lib/ipc";
import type { OpenedRepo } from "../lib/ipc";
import { useRepoTabs } from "../lib/store/repoTabs";
import App from "./App";

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  openRepo: vi.fn(),
  initRepo: vi.fn(),
  cloneRepo: vi.fn(),
  closeRepo: vi.fn(),
  listRecent: vi.fn(),
  removeRecent: vi.fn(),
  pickFolder: vi.fn(),
  checkGitCli: vi.fn(),
  onCloneProgress: vi.fn(),
}));

const repo = (id: number, name: string, headBranch: string | null = "main"): OpenedRepo => ({
  id,
  summary: { path: `/r/${name}`, name, headBranch, isBare: false },
});

const startHeading = { level: 1, name: "Git Real" };
const heading = (name: string) => ({ level: 1, name });

beforeEach(() => {
  vi.resetAllMocks();
  useRepoTabs.setState(useRepoTabs.getInitialState(), true);
  queryClient.clear();
  vi.mocked(listRecent).mockResolvedValue([]);
  vi.mocked(closeRepo).mockResolvedValue(undefined);
  vi.mocked(checkGitCli).mockResolvedValue({ available: true, path: "/usr/bin/git" });
  vi.mocked(onCloneProgress).mockResolvedValue(vi.fn());
});

function renderApp(...seed: OpenedRepo[]) {
  for (const r of seed) useRepoTabs.getState().openTab(r);
  return { user: userEvent.setup(), ...render(<App />) };
}

// Contract: start screen shows when no tab is active.
describe("App start screen", () => {
  it("shows start screen with no tabs", async () => {
    renderApp();
    expect(screen.getByRole("heading", startHeading)).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    await screen.findByText("No recent repositories");
  });

  it('"+" from a repo pane shows the start screen while tabs remain', async () => {
    const { user } = renderApp(repo(1, "alpha"));
    await user.click(screen.getByRole("button", { name: "Start screen" }));
    expect(screen.getByRole("heading", startHeading)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "alpha" })).toHaveAttribute("aria-selected", "false");
    await user.click(screen.getByRole("tab", { name: "alpha" }));
    expect(screen.getByRole("heading", heading("alpha"))).toBeInTheDocument();
  });
});

// Contract: repo pane header shows name, path and branch.
describe("App repo pane", () => {
  it("opening a repo shows its pane with name and branch", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/r/alpha");
    vi.mocked(openRepo).mockResolvedValue(repo(1, "alpha"));
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "Open repository" }));
    expect(await screen.findByRole("heading", heading("alpha"))).toBeInTheDocument();
    expect(screen.getByText("/r/alpha")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "alpha" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("heading", startHeading)).toBeNull();
  });

  it("switching tabs changes pane", async () => {
    const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"));
    await user.click(screen.getByRole("tab", { name: "alpha" }));
    expect(screen.getByRole("heading", heading("alpha"))).toBeInTheDocument();
    expect(screen.queryByRole("heading", heading("beta"))).toBeNull();
  });

  it('detached head renders "detached HEAD"', () => {
    renderApp(repo(1, "alpha", null));
    expect(screen.getByText("detached HEAD")).toBeInTheDocument();
  });
});

// Contract: closing a tab calls closeRepo, falls back to a neighbour or the start screen.
describe("App closing tabs", () => {
  it("closing the active tab calls closeRepo and returns to the neighbour", async () => {
    const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"));
    await user.click(screen.getByRole("button", { name: "Close beta" }));
    expect(closeRepo).toHaveBeenCalledExactlyOnceWith(2);
    expect(screen.queryByRole("tab", { name: "beta" })).toBeNull();
    expect(screen.getByRole("heading", heading("alpha"))).toBeInTheDocument();
  });

  it("closing the last tab returns to the start screen", async () => {
    const { user } = renderApp(repo(1, "alpha"));
    await user.click(screen.getByRole("button", { name: "Close alpha" }));
    expect(closeRepo).toHaveBeenCalledExactlyOnceWith(1);
    expect(screen.getByRole("heading", startHeading)).toBeInTheDocument();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("closing a non-active tab keeps the active pane", async () => {
    const { user } = renderApp(repo(1, "alpha"), repo(2, "beta"));
    await user.click(screen.getByRole("button", { name: "Close alpha" }));
    expect(closeRepo).toHaveBeenCalledExactlyOnceWith(1);
    expect(screen.getByRole("heading", heading("beta"))).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "beta" })).toHaveAttribute("aria-selected", "true");
  });

  it("closeRepo rejection with unknownRepo still closes the tab and logs nothing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(closeRepo).mockRejectedValue({ kind: "unknownRepo", message: "unknown repo 1" });
    const { user } = renderApp(repo(1, "alpha"));
    await user.click(screen.getByRole("button", { name: "Close alpha" }));
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByRole("heading", startHeading)).toBeInTheDocument();
    await waitFor(() => expect(closeRepo).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it.each([
    ["an io AppError", { kind: "io", message: "boom" }],
    ["a plain Error", new Error("ipc down")],
  ])(
    "other closeRepo rejections still close the tab and are logged (%s)",
    async (_n, rejection) => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.mocked(closeRepo).mockRejectedValue(rejection);
      const { user } = renderApp(repo(1, "alpha"));
      await user.click(screen.getByRole("button", { name: "Close alpha" }));
      expect(screen.queryAllByRole("tab")).toHaveLength(0);
      await waitFor(() => expect(err).toHaveBeenCalledWith("close_repo failed", rejection));
      err.mockRestore();
    },
  );
});

// Contract: App owns the clone dialog open state.
describe("App clone dialog", () => {
  it("Clone button opens CloneDialog", async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "Clone repository" }));
    expect(await screen.findByRole("dialog", { name: "Clone repository" })).toBeInTheDocument();
  });

  it("cancelling CloneDialog closes it", async () => {
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "Clone repository" }));
    await screen.findByLabelText("Repository URL");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", startHeading)).toBeInTheDocument();
  });

  it("successful clone closes the dialog and activates the new tab", async () => {
    const url = "https://github.com/octocat/Hello-World.git";
    vi.mocked(pickFolder).mockResolvedValue("/home/u/src");
    vi.mocked(cloneRepo).mockResolvedValue(repo(7, "Hello-World"));
    const { user } = renderApp();
    await user.click(screen.getByRole("button", { name: "Clone repository" }));
    await user.type(await screen.findByLabelText("Repository URL"), url);
    await user.click(screen.getByRole("button", { name: "Choose folder" }));
    await screen.findByText("Destination: /home/u/src/Hello-World");
    await user.click(screen.getByRole("button", { name: "Clone" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cloneRepo).toHaveBeenCalledWith(url, "/home/u/src/Hello-World", expect.any(Number));
    expect(screen.getByRole("heading", heading("Hello-World"))).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Hello-World" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
