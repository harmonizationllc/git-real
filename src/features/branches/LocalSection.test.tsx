import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutBranch, createBranch, listBranches, updateSettings } from "../../lib/ipc";
import type { BranchList, LocalBranch } from "../../lib/ipc";
import { useSettings } from "../../lib/store/settings";
import { useWorkspace } from "../../lib/store/workspace";
import { renderWithProviders } from "../../test/renderWithProviders";
import { resetSettings, seedSettings } from "../../test/settingsStore";
import { useCanFastForward } from "../merge/useCanFastForward";
import { useIntegrationActions } from "../merge/useIntegrationActions";
import { useOperationState } from "../merge/useOperationState";
import { BranchesProvider } from "./BranchesProvider";
import { LocalSection } from "./LocalSection";

vi.mock("../merge/useOperationState", () => ({ useOperationState: vi.fn() }));
vi.mock("../merge/useIntegrationActions", () => ({ useIntegrationActions: vi.fn() }));
vi.mock("../merge/useCanFastForward", () => ({ useCanFastForward: vi.fn() }));

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  updateSettings: vi.fn(),
  listBranches: vi.fn(),
  createBranch: vi.fn(),
  checkoutBranch: vi.fn(),
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
  local: [localBranch("main", true), localBranch("feature")],
  remotes: [{ remote: "origin", branches: [{ remote: "origin", name: "main", oid: oid("a") }] }],
  ...over,
});

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
  vi.mocked(createBranch).mockResolvedValue(localBranch("topic"));
  vi.mocked(checkoutBranch).mockResolvedValue(undefined);
});

function renderLocal() {
  return renderWithProviders(
    <BranchesProvider repoId={1} onCreatePullRequest={null}>
      <LocalSection />
    </BranchesProvider>,
  );
}

const toggle = () => screen.getByRole("button", { name: /^Local \(/ });
const localRow = (name: string) => screen.getByTitle(`refs/heads/${name}`);
const setFilter = (text: string) => act(() => useWorkspace.getState().setRefsFilter(1, text));

// Contract (spec: Local and Remote sections): a collapsible Local (n) section.
describe("LocalSection heading", () => {
  it("should render a level-2 Local (n) heading holding an expanded toggle", async () => {
    renderLocal();
    await waitFor(() => expect(toggle()).toHaveTextContent("Local (2)"));
    expect(screen.getByRole("heading", { level: 2, name: "Local (2)" })).toContainElement(toggle());
    expect(screen.getByRole("heading", { level: 2 }).closest(".gr-section-header")).not.toBeNull();
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    const controlled = document.getElementById(toggle().getAttribute("aria-controls") as string);
    expect(controlled).toContainElement(screen.getByRole("list", { name: "Local branches" }));
  });

  it("should label the count Local (s of n) while filtering", async () => {
    renderLocal();
    await screen.findByRole("list", { name: "Local branches" });
    setFilter("feat");
    expect(toggle()).toHaveTextContent("Local (1 of 2)");
  });

  it("should render the section as the Local branches region and focus target", async () => {
    renderLocal();
    const region = await screen.findByRole("region", { name: "Local branches" });
    expect(region).toHaveAttribute("data-focus-target");
    expect(region).toHaveAttribute("tabindex", "-1");
  });

  it("should show the Loading branches… status while the list is pending", () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => {}));
    renderLocal();
    expect(screen.getByRole("status")).toHaveTextContent("Loading branches…");
  });

  it("should show the unborn row in the body", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      list({ head: { kind: "unborn", name: "main" }, local: [] }),
    );
    renderLocal();
    expect(await screen.findByText("main (no commits yet)")).toBeInTheDocument();
  });
});

// Contract: the toggle stores localCollapsed; a collapsed Local renders only its header row.
describe("LocalSection collapse", () => {
  it("should collapse to the header row and store localCollapsed true", async () => {
    const { user } = renderLocal();
    await screen.findByRole("list", { name: "Local branches" });
    await user.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "Local branches" })).toBeNull();
    expect(screen.getByRole("button", { name: "New branch…" })).toBeInTheDocument();
    expect(useSettings.getState().settings.layout.localCollapsed).toBe(true);
  });

  it("should expand again and store localCollapsed false", async () => {
    await seedSettings({ layout: { localCollapsed: true } });
    const { user } = renderLocal();
    await waitFor(() => expect(toggle()).toHaveTextContent("Local (2)"));
    expect(screen.queryByRole("list", { name: "Local branches" })).toBeNull();
    await user.click(toggle());
    expect(await screen.findByRole("list", { name: "Local branches" })).toBeInTheDocument();
    expect(useSettings.getState().settings.layout.localCollapsed).toBe(false);
  });

  it("should show the matches while filtering a collapsed Local, leaving the preference", async () => {
    await seedSettings({ layout: { localCollapsed: true } });
    useWorkspace.getState().setRefsFilter(1, "feat");
    renderLocal();
    const listEl = await screen.findByRole("list", { name: "Local branches" });
    expect(within(listEl).getAllByRole("listitem")).toHaveLength(1);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(useSettings.getState().settings.layout.localCollapsed).toBe(true);
    expect(updateSettings).not.toHaveBeenCalled();
  });
});

// Contract: New branch… sits in the header row and opens the provider's create dialog.
describe("LocalSection New branch…", () => {
  it("should place New branch… in the header row beside the heading", async () => {
    renderLocal();
    const button = await screen.findByRole("button", { name: "New branch…" });
    expect(button.parentElement).toContainElement(screen.getByRole("heading", { level: 2 }));
  });

  it("should open the create dialog and create the branch", async () => {
    const { user } = renderLocal();
    await user.click(await screen.findByRole("button", { name: "New branch…" }));
    const dialog = await screen.findByRole("dialog", { name: "New branch" });
    await user.type(within(dialog).getByLabelText("Name"), "topic");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(createBranch).toHaveBeenCalledExactlyOnceWith(1, "topic", null, true);
  });

  it("should style New branch… as a small ghost button on the band", async () => {
    renderLocal();
    const button = await screen.findByRole("button", { name: "New branch…" });
    expect(button).toHaveAttribute("data-variant", "ghost");
    expect(button).toHaveAttribute("data-size", "sm");
  });

  it("should disable New branch… with Make a commit first on an unborn HEAD", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      list({ head: { kind: "unborn", name: "main" }, local: [] }),
    );
    renderLocal();
    const button = await screen.findByRole("button", { name: "New branch…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Make a commit first");
  });

  it("should check out a local row through the provider", async () => {
    const { user } = renderLocal();
    await screen.findByRole("list", { name: "Local branches" });
    await user.dblClick(localRow("feature"));
    expect(checkoutBranch).toHaveBeenCalledExactlyOnceWith(1, "feature");
  });
});
