import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commit, getCommitConfig, getHeadMessage, getStatus, onRepoChanged } from "../../lib/ipc";
import type { CommitConfig, StatusEntry, WorkingTreeStatus } from "../../lib/ipc";
import { useCommitDraft } from "../../lib/store/commitDraft";
import { renderWithProviders } from "../../test/renderWithProviders";
import { CommitBox } from "./CommitBox";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  commit: vi.fn(),
  getCommitConfig: vi.fn(),
  getHeadMessage: vi.fn(),
  getStatus: vi.fn(),
  onRepoChanged: vi.fn(),
}));

const entry = (over: Partial<StatusEntry>): StatusEntry => ({
  path: "a.txt",
  oldPath: null,
  index: null,
  worktree: null,
  conflicted: false,
  ...over,
});
const staged: WorkingTreeStatus = { entries: [entry({ index: "modified" })], headUnborn: false };
const clean: WorkingTreeStatus = { entries: [], headUnborn: false };
const config: CommitConfig = { name: "Ada", email: "ada@x.org", signing: null };

beforeEach(() => {
  vi.resetAllMocks();
  useCommitDraft.setState({ drafts: {} });
  vi.mocked(onRepoChanged).mockResolvedValue(vi.fn());
  vi.mocked(getStatus).mockResolvedValue(staged);
  vi.mocked(getCommitConfig).mockResolvedValue(config);
  vi.mocked(getHeadMessage).mockResolvedValue({ subject: "Head subject", body: "Head body" });
  vi.mocked(commit).mockResolvedValue({ oid: "abc", summary: "S" });
});

const button = () => screen.getByRole("button", { name: /Commit|Amend commit|Committing…/ });

describe("CommitBox", () => {
  it("renders as a region named Commit with the author line", async () => {
    renderWithProviders(<CommitBox repoId={1} />);
    expect(screen.getByRole("region", { name: "Commit" })).toBeInTheDocument();
    expect(await screen.findByText("Ada <ada@x.org>")).toBeInTheDocument();
  });

  it("is disabled with Loading… before data arrives", () => {
    vi.mocked(getStatus).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<CommitBox repoId={1} />);
    expect(button()).toBeDisabled();
    expect(button()).toHaveAttribute("title", "Loading…");
  });

  it("is disabled with Stage changes to commit when nothing is staged", async () => {
    vi.mocked(getStatus).mockResolvedValue(clean);
    renderWithProviders(<CommitBox repoId={1} />);
    await waitFor(() => expect(button()).toHaveAttribute("title", "Stage changes to commit"));
  });

  it("is disabled with Enter a commit subject when staged but empty", async () => {
    renderWithProviders(<CommitBox repoId={1} />);
    await waitFor(() => expect(button()).toHaveAttribute("title", "Enter a commit subject"));
  });

  it("commits with the typed subject and body, then clears the editor", async () => {
    const { user } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    await user.type(screen.getByLabelText("Subject"), "Add thing");
    await user.type(screen.getByLabelText("Body"), "Why.");
    await waitFor(() => expect(button()).toBeEnabled());
    expect(button()).not.toHaveAttribute("title");
    await user.click(button());
    expect(commit).toHaveBeenCalledExactlyOnceWith(
      1,
      { subject: "Add thing", body: "Why." },
      false,
    );
    await waitFor(() => expect(screen.getByLabelText("Subject")).toHaveValue(""));
    expect(screen.getByLabelText("Body")).toHaveValue("");
  });

  it("Ctrl+Enter commits when enabled and does nothing when disabled", async () => {
    const { user } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    await user.click(screen.getByLabelText("Subject"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(commit).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Subject"), "S");
    await waitFor(() => expect(button()).toBeEnabled());
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(commit).toHaveBeenCalledOnce();
  });

  it("amend prefills from HEAD, relabels the button, and sends amend: true", async () => {
    vi.mocked(getStatus).mockResolvedValue(clean);
    const { user } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    const amend = screen.getByRole("checkbox", { name: "Amend last commit" });
    await waitFor(() => expect(amend).toBeEnabled());
    await user.click(amend);
    expect(screen.getByLabelText("Subject")).toHaveValue("Head subject");
    expect(screen.getByLabelText("Body")).toHaveValue("Head body");
    expect(screen.getByRole("button", { name: "Amend commit" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Amend commit" }));
    expect(commit).toHaveBeenCalledExactlyOnceWith(
      1,
      { subject: "Head subject", body: "Head body" },
      true,
    );
    await waitFor(() => expect(amend).not.toBeChecked());
  });

  it("unchecking amend restores what was typed", async () => {
    const { user } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    await user.type(screen.getByLabelText("Subject"), "mine");
    const amend = screen.getByRole("checkbox", { name: "Amend last commit" });
    await waitFor(() => expect(amend).toBeEnabled());
    await user.click(amend);
    expect(screen.getByLabelText("Subject")).toHaveValue("Head subject");
    await user.click(amend);
    expect(screen.getByLabelText("Subject")).toHaveValue("mine");
  });

  it("disables the amend checkbox with No commit to amend on an unborn HEAD", async () => {
    vi.mocked(getHeadMessage).mockResolvedValue(null);
    renderWithProviders(<CommitBox repoId={1} />);
    const amend = screen.getByRole("checkbox", { name: "Amend last commit" });
    await waitFor(() => expect(amend).toBeDisabled());
    expect(amend).toHaveAttribute("title", "No commit to amend");
  });

  it("disables everything and says Committing… while pending", async () => {
    let resolve: (v: { oid: string; summary: string }) => void = () => undefined;
    vi.mocked(commit).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { user } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    await user.type(screen.getByLabelText("Subject"), "S");
    await waitFor(() => expect(button()).toBeEnabled());
    await user.click(button());
    expect(screen.getByRole("button", { name: "Committing…" })).toBeDisabled();
    expect(screen.getByLabelText("Subject")).toBeDisabled();
    expect(screen.getByLabelText("Body")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Amend last commit" })).toBeDisabled();
    resolve({ oid: "a", summary: "S" });
    await waitFor(() => expect(screen.getByLabelText("Subject")).toBeEnabled());
  });

  it("shows a multi-line failure with Dismiss and keeps the draft", async () => {
    vi.mocked(commit).mockRejectedValue({ kind: "commitFailed", message: "hook says no\nline 2" });
    const { user } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    await user.type(screen.getByLabelText("Subject"), "S");
    await waitFor(() => expect(button()).toBeEnabled());
    await user.click(button());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("hook says no");
    expect(alert).toHaveTextContent("line 2");
    expect(screen.getByLabelText("Subject")).toHaveValue("S");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a config load failure as an alert", async () => {
    vi.mocked(getCommitConfig).mockRejectedValue({ kind: "git", message: "config broken" });
    renderWithProviders(<CommitBox repoId={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("config broken");
  });

  it("shows the identity reason when the author is not configured", async () => {
    vi.mocked(getCommitConfig).mockResolvedValue({ ...config, email: null });
    renderWithProviders(<CommitBox repoId={1} />);
    expect(await screen.findByText("Author not configured")).toBeInTheDocument();
    expect(button()).toHaveAttribute("title", "Set user.name and user.email in your Git config");
  });

  it("keeps drafts per repository", async () => {
    const { user, unmount } = renderWithProviders(<CommitBox repoId={1} />);
    await screen.findByText("Ada <ada@x.org>");
    await user.type(screen.getByLabelText("Subject"), "one");
    unmount();
    renderWithProviders(<CommitBox repoId={2} />);
    expect(screen.getByLabelText("Subject")).toHaveValue("");
    expect(useCommitDraft.getState().drafts[1]?.subject).toBe("one");
  });
});
