import { act, fireEvent, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCommitConfig,
  getHeadMessage,
  getStatus,
  hostingListIssues,
  hostingRepoContext,
  hostingRepoInfo,
  onRepoChanged,
} from "../../lib/ipc";
import { useCommitDraft } from "../../lib/store/commitDraft";
import { issue, repoContext, repoInfo } from "../../test/hostingFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { CommitBox } from "../commit/CommitBox";

const prefill = vi.hoisted(() => vi.fn());
vi.mock("../commit/useOperationPrefill", () => ({ useOperationPrefill: prefill }));

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getCommitConfig: vi.fn(),
  getHeadMessage: vi.fn(),
  getStatus: vi.fn(),
  hostingListIssues: vi.fn(),
  hostingRepoContext: vi.fn(),
  hostingRepoInfo: vi.fn(),
  onRepoChanged: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  useCommitDraft.setState({ drafts: {} });
  prefill.mockReturnValue(undefined);
  vi.mocked(onRepoChanged).mockResolvedValue(vi.fn());
  vi.mocked(getStatus).mockResolvedValue({ entries: [], headUnborn: false });
  vi.mocked(getCommitConfig).mockResolvedValue({ name: "Ada", email: "ada@x.org", signing: null });
  vi.mocked(getHeadMessage).mockResolvedValue(null);
  vi.mocked(hostingRepoContext).mockResolvedValue(repoContext());
  vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo());
  vi.mocked(hostingListIssues).mockResolvedValue([issue(2)]);
});

// Contract: React.StrictMode (main.tsx) simulates an unmount at mount, which restores focus to
// the opener; the picker must not read that as focus leaving and close itself.
describe("IssuePicker under StrictMode", () => {
  it("should stay open after StrictMode's simulated remount", async () => {
    renderWithProviders(
      <StrictMode>
        <CommitBox repoId={1} />
      </StrictMode>,
    );
    const link = await screen.findByRole("button", { name: "Link issue" });
    screen.getByLabelText("Body").focus();
    fireEvent.click(link);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByRole("dialog", { name: "Link issue" })).toBeInTheDocument();
  });

  it("should keep focus in the search field once open", async () => {
    renderWithProviders(
      <StrictMode>
        <CommitBox repoId={1} />
      </StrictMode>,
    );
    const link = await screen.findByRole("button", { name: "Link issue" });
    screen.getByLabelText("Body").focus();
    fireEvent.click(link);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByLabelText("Search issues")).toHaveFocus();
  });
});
