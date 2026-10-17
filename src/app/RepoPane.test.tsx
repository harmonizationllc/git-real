import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getStatus, onRepoChanged } from "../lib/ipc";
import type { RepoTab } from "../lib/store/repoTabs";
import { renderWithProviders } from "../test/renderWithProviders";
import { RepoPane } from "./RepoPane";

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getStatus: vi.fn(),
  onRepoChanged: vi.fn(),
}));

const tab = (id: number, headBranch: string | null = "main"): RepoTab => ({
  id,
  summary: { path: `/r/repo${id}`, name: `repo${id}`, headBranch, isBare: false },
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(onRepoChanged).mockResolvedValue(vi.fn());
  vi.mocked(getStatus).mockResolvedValue({ entries: [], headUnborn: false });
});

// Contract: header as before, then a body with the changes panel and a detail placeholder.
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

  it("should render the detail placeholder", async () => {
    renderWithProviders(<RepoPane tab={tab(1)} />);
    expect(screen.getByRole("region", { name: "Detail" })).toHaveTextContent(
      "Select a file to view its diff",
    );
    await screen.findByRole("region", { name: "Changes" });
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
});
