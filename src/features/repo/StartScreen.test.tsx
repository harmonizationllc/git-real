import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initRepo, listRecent, openRepo, pickFolder, removeRecent } from "../../lib/ipc";
import type { OpenedRepo, RecentEntry } from "../../lib/ipc";
import { useRepoTabs } from "../../lib/store/repoTabs";
import { renderWithProviders } from "../../test/renderWithProviders";
import { StartScreen } from "./StartScreen";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  openRepo: vi.fn(),
  initRepo: vi.fn(),
  listRecent: vi.fn(),
  removeRecent: vi.fn(),
  pickFolder: vi.fn(),
}));

const entry = (name: string, path = `/home/u/${name}`): RecentEntry => ({
  name,
  path,
  lastOpened: 1,
});
const opened = (path: string, id = 1): OpenedRepo => ({
  id,
  summary: { path, name: path.split("/").pop()!, headBranch: "main", isBare: false },
});

const EMPTY = "No recent repositories";
const openBtn = { name: "Open repository" };
const initBtn = { name: "Initialize repository" };
const initHereBtn = { name: "Initialize repository here" };

beforeEach(() => {
  vi.resetAllMocks();
  useRepoTabs.setState(useRepoTabs.getInitialState(), true);
  vi.mocked(listRecent).mockResolvedValue([]);
});

// Contract: static structure of the start screen.
describe("StartScreen layout", () => {
  it("should render the heading and the three action buttons", async () => {
    renderWithProviders(<StartScreen onClone={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 1, name: "Git Real" })).toBeInTheDocument();
    expect(screen.getByRole("button", openBtn)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clone repository" })).toBeInTheDocument();
    expect(screen.getByRole("button", initBtn)).toBeInTheDocument();
    await screen.findByText(EMPTY);
  });
});

// Contract: recents section shows the list, an empty message, and nothing while loading.
describe("StartScreen recents", () => {
  it("should render recents from listRecent", async () => {
    vi.mocked(listRecent).mockResolvedValue([entry("a"), entry("b")]);
    renderWithProviders(<StartScreen onClone={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "a /home/u/a" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "b /home/u/b" })).toBeInTheDocument();
  });

  it("should show the empty message when there are no recents", async () => {
    renderWithProviders(<StartScreen onClone={vi.fn()} />);
    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
  });

  it("should not show the empty message while recents are loading", () => {
    vi.mocked(listRecent).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<StartScreen onClone={vi.fn()} />);
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("should call removeRecent and drop the row when remove is clicked", async () => {
    vi.mocked(listRecent).mockResolvedValue([entry("a"), entry("b")]);
    vi.mocked(removeRecent).mockResolvedValue([entry("b")]);
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: "Remove a from recent repositories" }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: "a /home/u/a" })).toBeNull());
    expect(removeRecent).toHaveBeenCalledExactlyOnceWith("/home/u/a");
    expect(screen.getByRole("button", { name: "b /home/u/b" })).toBeInTheDocument();
  });

  it("should open a tab for a recent entry when its row is clicked", async () => {
    vi.mocked(listRecent).mockResolvedValue([entry("a")]);
    vi.mocked(openRepo).mockResolvedValue(opened("/home/u/a"));
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "a /home/u/a" }));
    await waitFor(() => expect(useRepoTabs.getState().tabs).toHaveLength(1));
    expect(openRepo).toHaveBeenCalledExactlyOnceWith("/home/u/a");
  });
});

// Contract: Open flows through the folder picker to openRepo and opens a tab.
describe("StartScreen open", () => {
  it("should pick a folder, call openRepo and open a tab when Open is clicked", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/r");
    vi.mocked(openRepo).mockResolvedValue(opened("/r"));
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(screen.getByRole("button", openBtn));
    await waitFor(() => expect(useRepoTabs.getState().tabs).toHaveLength(1));
    expect(pickFolder).toHaveBeenCalledExactlyOnceWith("Open repository");
    expect(openRepo).toHaveBeenCalledExactlyOnceWith("/r");
    expect(useRepoTabs.getState().tabs[0].summary.path).toBe("/r");
  });

  it("should call nothing and show no error when the open picker is cancelled", async () => {
    vi.mocked(pickFolder).mockResolvedValue(null);
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(screen.getByRole("button", openBtn));
    await waitFor(() => expect(pickFolder).toHaveBeenCalled());
    expect(openRepo).not.toHaveBeenCalled();
    expect(initRepo).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should render the error when openRepo rejects", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/r");
    vi.mocked(openRepo).mockRejectedValue({ kind: "pathNotFound", message: "No such path" });
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(screen.getByRole("button", openBtn));
    expect(await screen.findByRole("alert")).toHaveTextContent("No such path");
  });

  it("should refresh recents when an open succeeds", async () => {
    vi.mocked(listRecent)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([entry("r", "/r")]);
    vi.mocked(pickFolder).mockResolvedValue("/r");
    vi.mocked(openRepo).mockResolvedValue(opened("/r"));
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await screen.findByText(EMPTY);
    await user.click(screen.getByRole("button", openBtn));
    expect(await screen.findByRole("button", { name: "r /r" })).toBeInTheDocument();
  });
});

// Contract: a failed open of a non-repository offers init at that same path.
describe("StartScreen initialize here", () => {
  it("should call initRepo with the failed path and open a tab when Initialize here is clicked", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/r");
    vi.mocked(openRepo).mockRejectedValue({ kind: "notARepository", message: "Not a repo" });
    vi.mocked(initRepo).mockResolvedValue(opened("/r"));
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(screen.getByRole("button", openBtn));
    await user.click(await screen.findByRole("button", initHereBtn));
    await waitFor(() => expect(useRepoTabs.getState().tabs).toHaveLength(1));
    expect(initRepo).toHaveBeenCalledExactlyOnceWith("/r");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should show pathNotFound without an init offer and keep the entry when a missing recent is reopened", async () => {
    vi.mocked(listRecent).mockResolvedValue([entry("gone")]);
    vi.mocked(openRepo).mockRejectedValue({ kind: "pathNotFound", message: "Path is gone" });
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "gone /home/u/gone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Path is gone");
    expect(screen.queryByRole("button", initHereBtn)).toBeNull();
    expect(screen.getByRole("button", { name: "gone /home/u/gone" })).toBeInTheDocument();
  });

  it("should hide the error when Dismiss is clicked", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/r");
    vi.mocked(openRepo).mockRejectedValue({ kind: "pathNotFound", message: "No such path" });
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(screen.getByRole("button", openBtn));
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: Initialize flows through the folder picker to initRepo.
describe("StartScreen initialize", () => {
  it("should pick a folder, call initRepo and open a tab when Initialize is clicked", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/n");
    vi.mocked(initRepo).mockResolvedValue(opened("/n"));
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(screen.getByRole("button", initBtn));
    await waitFor(() => expect(useRepoTabs.getState().tabs).toHaveLength(1));
    expect(pickFolder).toHaveBeenCalledExactlyOnceWith("Initialize repository");
    expect(initRepo).toHaveBeenCalledExactlyOnceWith("/n");
    expect(openRepo).not.toHaveBeenCalled();
  });

  it("should call nothing when the initialize picker is cancelled", async () => {
    vi.mocked(pickFolder).mockResolvedValue(null);
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(screen.getByRole("button", initBtn));
    await waitFor(() => expect(pickFolder).toHaveBeenCalled());
    expect(initRepo).not.toHaveBeenCalled();
    expect(openRepo).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: Clone delegates to the parent without opening a picker.
describe("StartScreen clone", () => {
  it("should call onClone and not the picker when Clone is clicked", async () => {
    const onClone = vi.fn();
    const { user } = renderWithProviders(<StartScreen onClone={onClone} />);
    await user.click(screen.getByRole("button", { name: "Clone repository" }));
    expect(onClone).toHaveBeenCalledOnce();
    expect(pickFolder).not.toHaveBeenCalled();
  });
});

// Contract: failures of init and non-AppError rejections surface in the error panel.
describe("StartScreen init failure", () => {
  it("should render the error and open no tab when initRepo rejects", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/r");
    vi.mocked(initRepo).mockRejectedValue({ kind: "io", message: "permission denied" });
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(screen.getByRole("button", initBtn));
    expect(await screen.findByRole("alert")).toHaveTextContent("permission denied");
    expect(screen.queryByRole("button", initHereBtn)).toBeNull();
    expect(useRepoTabs.getState().tabs).toHaveLength(0);
  });

  it("should render the error message when openRepo rejects with a plain Error", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/r");
    vi.mocked(openRepo).mockRejectedValue(new Error("ipc unavailable"));
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(screen.getByRole("button", openBtn));
    expect(await screen.findByRole("alert")).toHaveTextContent("ipc unavailable");
  });

  it("should clear the error panel when a later open succeeds", async () => {
    vi.mocked(pickFolder).mockResolvedValue("/r");
    vi.mocked(openRepo)
      .mockRejectedValueOnce({ kind: "pathNotFound", message: "No such path" })
      .mockResolvedValueOnce(opened("/r"));
    const { user } = renderWithProviders(<StartScreen onClone={vi.fn()} />);
    await user.click(screen.getByRole("button", openBtn));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", openBtn));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(useRepoTabs.getState().tabs).toHaveLength(1);
  });
});
