import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutRemoteBranch, listBranches, removeRemote, updateSettings } from "../../lib/ipc";
import type { BranchList, LocalBranch } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { useWorkspace } from "../../lib/store/workspace";
import { renderWithProviders } from "../../test/renderWithProviders";
import { resetSettings, seedSettings } from "../../test/settingsStore";
import { useCanFastForward } from "../merge/useCanFastForward";
import { useIntegrationActions } from "../merge/useIntegrationActions";
import { useOperationState } from "../merge/useOperationState";
import { BranchesProvider } from "./BranchesProvider";
import { RemoteSection } from "./RemoteSection";

vi.mock("../merge/useOperationState", () => ({ useOperationState: vi.fn() }));
vi.mock("../merge/useIntegrationActions", () => ({ useIntegrationActions: vi.fn() }));
vi.mock("../merge/useCanFastForward", () => ({ useCanFastForward: vi.fn() }));

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  updateSettings: vi.fn(),
  listBranches: vi.fn(),
  checkoutRemoteBranch: vi.fn(),
  removeRemote: vi.fn(),
}));

const oid = (c: string) => c.repeat(40);
const localBranch = (name: string, isHead = false): LocalBranch => ({
  name,
  oid: oid("a"),
  isHead,
  tracking: null,
  worktree: null,
});
const list = (over: Partial<BranchList> = {}): BranchList => ({
  head: { kind: "branch", name: "main" },
  local: [localBranch("main", true)],
  remotes: [
    {
      remote: "origin",
      branches: [
        { remote: "origin", name: "main", oid: oid("a") },
        { remote: "origin", name: "other", oid: oid("b") },
      ],
    },
    { remote: "up", branches: [{ remote: "up", name: "main", oid: oid("c") }] },
  ],
  ...over,
});

const onOpenRemotes = vi.fn();

beforeEach(async () => {
  vi.resetAllMocks();
  await resetSettings();
  useWorkspace.setState({ refsFilter: {} });
  vi.mocked(useOperationState).mockReturnValue({
    state: { kind: "none" },
    error: null,
    refetch: vi.fn(),
  });
  vi.mocked(useCanFastForward).mockReturnValue({ check: "possible", isLoading: false });
  vi.mocked(useIntegrationActions).mockReturnValue({
    run: vi.fn(),
    pending: false,
    error: null,
    clearError: vi.fn(),
  });
  vi.mocked(listBranches).mockResolvedValue(list());
  vi.mocked(checkoutRemoteBranch).mockResolvedValue(undefined);
  vi.mocked(removeRemote).mockResolvedValue(undefined);
});

function renderRemote() {
  return renderWithProviders(
    <BranchesProvider repoId={1} onOpenRemotes={onOpenRemotes} onCreatePullRequest={null}>
      <RemoteSection />
    </BranchesProvider>,
  );
}

const toggle = () => screen.getByRole("button", { name: /^Remote \(/ });
const remoteRow = (remote: string, name: string) =>
  screen.getByTitle(`refs/remotes/${remote}/${name}`);
const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 40, clientY: 60 });
const setFilter = (text: string) => act(() => useWorkspace.getState().setRefsFilter(1, text));

// Contract (spec: Local and Remote sections): Remote (n) counts every remote's branches.
describe("RemoteSection heading", () => {
  it("should render a level-2 Remote (n) heading summing every remote", async () => {
    renderRemote();
    await waitFor(() => expect(toggle()).toHaveTextContent("Remote (3)"));
    expect(screen.getByRole("heading", { level: 2, name: "Remote (3)" })).toContainElement(
      toggle(),
    );
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("should render one sub-group per remote headed by its name", async () => {
    renderRemote();
    await screen.findByRole("list", { name: "origin branches" });
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Remote (3)",
    ]);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "origin",
      "up",
    ]);
    expect(screen.getByRole("heading", { level: 2 }).closest(".gr-section-header")).not.toBeNull();
    expect(screen.getByRole("list", { name: "up branches" })).toBeInTheDocument();
  });

  it("should label the count Remote (s of n) while filtering", async () => {
    renderRemote();
    await screen.findByRole("list", { name: "origin branches" });
    setFilter("oth");
    expect(toggle()).toHaveTextContent("Remote (1 of 3)");
    expect(
      within(screen.getByRole("region", { name: "up" })).getByText("No matches"),
    ).toBeVisible();
  });

  it("should render the section as the Remote branches region", async () => {
    renderRemote();
    expect(await screen.findByRole("region", { name: "Remote branches" })).toBeInTheDocument();
  });

  it("should show No remotes when the repository has none", async () => {
    vi.mocked(listBranches).mockResolvedValue(list({ remotes: [] }));
    renderRemote();
    expect(await screen.findByText("No remotes")).toBeInTheDocument();
    expect(toggle()).toHaveTextContent("Remote (0)");
  });
});

// Contract: the toggle stores remoteCollapsed; a collapsed Remote renders only its header row.
describe("RemoteSection collapse", () => {
  it("should collapse to the header row and store remoteCollapsed true", async () => {
    const { user } = renderRemote();
    await screen.findByRole("list", { name: "origin branches" });
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "origin" })).toBeNull();
    expect(useSettings.getState().settings.layout.remoteCollapsed).toBe(true);
  });

  it("should expand again and store remoteCollapsed false", async () => {
    await seedSettings({ layout: { remoteCollapsed: true } });
    const { user } = renderRemote();
    await waitFor(() => expect(toggle()).toHaveTextContent("Remote (3)"));
    expect(screen.queryByRole("list", { name: "origin branches" })).toBeNull();
    await user.click(toggle());
    expect(await screen.findByRole("list", { name: "origin branches" })).toBeInTheDocument();
    expect(useSettings.getState().settings.layout.remoteCollapsed).toBe(false);
  });

  it("should show the matches while filtering a collapsed Remote, leaving the preference", async () => {
    await seedSettings({ layout: { remoteCollapsed: true } });
    useWorkspace.getState().setRefsFilter(1, "oth");
    renderRemote();
    expect(await screen.findByRole("list", { name: "origin branches" })).toBeInTheDocument();
    expect(remoteRow("origin", "other")).toBeInTheDocument();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(useSettings.getState().settings.layout.remoteCollapsed).toBe(true);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

// Contract: the sub-heading menu and row menu still reach the provider's actions.
describe("RemoteSection actions", () => {
  it("should remove a remote from its sub-heading's Remove remote…", async () => {
    const { user } = renderRemote();
    rightClick(await screen.findByRole("heading", { level: 3, name: "origin" }));
    await user.click(screen.getByRole("menuitem", { name: "Remove remote…" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove remote origin?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeRemote).toHaveBeenCalledExactlyOnceWith(1, "origin"));
  });

  it("should open the remotes dialog for the sub-heading's Edit remote…", async () => {
    const { user } = renderRemote();
    rightClick(await screen.findByRole("heading", { level: 3, name: "up" }));
    await user.click(screen.getByRole("menuitem", { name: "Edit remote…" }));
    expect(onOpenRemotes).toHaveBeenCalledExactlyOnceWith({ mode: "edit", name: "up" });
  });

  it("should check out a remote row from its Checkout item", async () => {
    const { user } = renderRemote();
    await screen.findByRole("list", { name: "origin branches" });
    rightClick(remoteRow("origin", "other"));
    await user.click(screen.getByRole("menuitem", { name: "Checkout" }));
    expect(checkoutRemoteBranch).toHaveBeenCalledExactlyOnceWith(1, "origin", "other");
  });
});
