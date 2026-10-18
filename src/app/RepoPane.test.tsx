import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  commit,
  getCommitConfig,
  getFileDiff,
  getHeadMessage,
  getStatus,
  onRepoChanged,
} from "../lib/ipc";
import type { RepoTab } from "../lib/store/repoTabs";
import { EMPTY_DRAFT, useCommitDraft } from "../lib/store/commitDraft";
import { useWorkspace } from "../lib/store/workspace";
import { renderWithProviders } from "../test/renderWithProviders";
import { FULL_DIFF_LINES } from "../features/diff/model/limits";
import { RepoPane } from "./RepoPane";

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  commit: vi.fn(),
  getCommitConfig: vi.fn(),
  getFileDiff: vi.fn(),
  getHeadMessage: vi.fn(),
  getStatus: vi.fn(),
  onRepoChanged: vi.fn(),
}));

const tab = (id: number, headBranch: string | null = "main"): RepoTab => ({
  id,
  summary: { path: `/r/repo${id}`, name: `repo${id}`, headBranch, isBare: false },
});

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspace.setState({ selected: {} });
  useCommitDraft.setState({ drafts: {} });
  vi.mocked(getFileDiff).mockReturnValue(new Promise(() => undefined));
  vi.mocked(onRepoChanged).mockResolvedValue(vi.fn());
  vi.mocked(getStatus).mockResolvedValue({ entries: [], headUnborn: false });
  vi.mocked(getCommitConfig).mockResolvedValue({ name: "A", email: "a@b.c", signing: null });
  vi.mocked(getHeadMessage).mockResolvedValue(null);
});

// Contract: header as before, then a body with the changes panel and the detail pane.
describe("RepoPane", () => {
  it("should render the repo name as the level 1 heading", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(screen.getByRole("heading", { level: 1, name: "repo1" })).toBeInTheDocument();
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should render the path and branch in the header", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(screen.getByText("/r/repo1")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should render detached HEAD when there is no branch", async () => {
    renderWithProviders(<RepoPane tab={tab(1, null)} />);
    expect(screen.getByText("detached HEAD")).toBeInTheDocument();
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should render the changes panel", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(await screen.findByRole("region", { name: "Changes" })).toBeInTheDocument();
  });

  it("should render the detail pane with its empty prompt", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(screen.getByRole("region", { name: "Detail" })).toHaveTextContent(
      "Select a file to view its diff",
    );
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should show the selected file's diff in the detail pane", async () => {
    vi.mocked(getStatus).mockResolvedValue({
      entries: [
        { path: "a.txt", oldPath: null, index: null, worktree: "modified", conflicted: false },
      ],
      headUnborn: false,
    });
    renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "modified a.txt" }));
    expect(screen.getByRole("region", { name: "Detail" })).toHaveTextContent("Loading diff…");
    expect(getFileDiff).toHaveBeenCalledWith(1, "a.txt", "unstaged", false, undefined);
  });

  it("should load the status for the tab's repo id", async () => {
    renderWithProviders(<RepoPane tab={tab(7)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(getStatus).toHaveBeenCalledWith(7);
  });

  it("should reload the status for the new repo when the tab changes", async () => {
    const { rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    await screen.findByRole("region", { name: "Changes" });
    rerender(<RepoPane tab={tab(2)} />);
    await screen.findByRole("region", { name: "Changes" });
    expect(getStatus).toHaveBeenCalledWith(2);
  });

  it("should reset panel-local state when the active tab changes", async () => {
    vi.mocked(getStatus).mockResolvedValue({
      entries: [
        { path: "a.txt", oldPath: null, index: null, worktree: "modified", conflicted: false },
      ],
      headUnborn: false,
    });
    const { rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    const row = await screen.findByRole("button", { name: "modified a.txt" });
    fireEvent.click(row);
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-pressed", "true");

    rerender(<RepoPane tab={tab(2)} />);
    const next = await screen.findByRole("button", { name: "modified a.txt" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(next).toHaveAttribute("aria-pressed", "false");
  });
});

// Contract: the detail pane is bound to the tab's repo id and starts fresh for another tab.
describe("RepoPane detail pane per tab", () => {
  const diffOf = () =>
    Promise.resolve({
      path: "a.txt",
      oldPath: null,
      scope: "unstaged" as const,
      change: "modified" as const,
      isBinary: false,
      hunks: [],
      truncated: true,
      oldEncoding: null,
      newEncoding: null,
    });

  it("should fetch the selected file's diff for the tab's own repo id", async () => {
    useWorkspace.getState().select(7, { path: "a.txt", scope: "unstaged" });
    renderWithProviders(<RepoPane tab={tab(7)} />);
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenCalledWith(7, "a.txt", "unstaged", false, undefined),
    );
  });

  it("should not show another repo's selection in the detail pane", async () => {
    useWorkspace.getState().select(1, { path: "a.txt", scope: "unstaged" });
    renderWithProviders(<RepoPane tab={tab(2)} />);
    expect(screen.getByRole("region", { name: "Detail" })).toHaveTextContent(
      "Select a file to view its diff",
    );
    expect(getFileDiff).not.toHaveBeenCalled();
    await screen.findByRole("region", { name: "Changes" });
  });

  it("should not carry the lifted line cap to the next tab showing the same path", async () => {
    vi.mocked(getFileDiff).mockImplementation(diffOf);
    useWorkspace.getState().select(1, { path: "a.txt", scope: "unstaged" });
    useWorkspace.getState().select(2, { path: "a.txt", scope: "unstaged" });
    const { rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load full diff" }));
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenLastCalledWith(1, "a.txt", "unstaged", false, FULL_DIFF_LINES),
    );

    rerender(<RepoPane tab={tab(2)} />);
    await waitFor(() =>
      expect(getFileDiff).toHaveBeenCalledWith(2, "a.txt", "unstaged", false, undefined),
    );
    expect(getFileDiff).not.toHaveBeenCalledWith(2, "a.txt", "unstaged", false, FULL_DIFF_LINES);
  });

  it("should render the commit box below the changes panel in the sidebar", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    const changes = await screen.findByRole("region", { name: "Changes" });
    const commitBox = screen.getByRole("region", { name: "Commit" });
    expect(changes.parentElement).toBe(commitBox.parentElement);
    expect(
      changes.compareDocumentPosition(commitBox) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("should show a different commit draft per tab", async () => {
    useCommitDraft.setState({ drafts: { 1: { ...EMPTY_DRAFT, subject: "one" } } });
    const { rerender } = renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(screen.getByLabelText("Subject")).toHaveValue("one");
    rerender(<RepoPane tab={tab(2)} />);
    expect(screen.getByLabelText("Subject")).toHaveValue("");
    await screen.findByRole("region", { name: "Changes" });
  });
});

describe("RepoPane commit box state per tab", () => {
  it("does not carry a commit failure to another tab", async () => {
    vi.mocked(getStatus).mockResolvedValue({
      entries: [
        { path: "a.txt", oldPath: null, index: "modified", worktree: null, conflicted: false },
      ],
      headUnborn: false,
    });
    vi.mocked(commit).mockRejectedValue({ kind: "commitFailed", message: "hook says no" });
    const { rerender, user } = renderWithProviders(<RepoPane tab={tab(1)} />);
    const subject = screen.getByLabelText("Subject");
    await user.type(subject, "S");
    const commitButton = screen.getByRole("button", { name: "Commit" });
    await waitFor(() => expect(commitButton).toBeEnabled());
    await user.click(commitButton);
    expect(await screen.findByRole("alert")).toHaveTextContent("hook says no");
    rerender(<RepoPane tab={tab(2)} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByLabelText("Subject")).toHaveValue("");
  });
});
