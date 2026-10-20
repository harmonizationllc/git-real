import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOperationState,
  getStatus,
  listStashes,
  stashApply,
  stashDrop,
  stashPop,
  stashPush,
} from "../../lib/ipc";
import type { OperationState, StashEntry, WorkingTreeStatus } from "../../lib/ipc";
import { useWorkspace } from "../../lib/store/workspace";
import { renderWithProviders } from "../../test/renderWithProviders";
import { stashEntry, statusEntry, workingStatus } from "../../test/stashFixtures";
import { relativeTime } from "../graph/model/relativeTime";
import { IN_PROGRESS_TITLE } from "../merge/operationCopy";
import { StashesPanel } from "./StashesPanel";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listStashes: vi.fn(),
  stashPush: vi.fn(),
  stashApply: vi.fn(),
  stashPop: vi.fn(),
  stashDrop: vi.fn(),
  getStatus: vi.fn(),
  getOperationState: vi.fn(),
}));

const merging: OperationState = {
  kind: "merge",
  head: "a".repeat(40),
  branch: "feature",
  message: { subject: "Merge", body: "" },
};

const entries = (): StashEntry[] => [
  stashEntry(0, { message: "On main: first", hasUntracked: true }),
  stashEntry(1, { message: "WIP on dev: abc1234 second", branch: "dev" }),
];

function load(
  over: { stashes?: StashEntry[]; status?: WorkingTreeStatus; state?: OperationState } = {},
) {
  vi.mocked(listStashes).mockResolvedValue(over.stashes ?? entries());
  vi.mocked(getStatus).mockResolvedValue(over.status ?? workingStatus());
  vi.mocked(getOperationState).mockResolvedValue(over.state ?? { kind: "none" });
}

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspace.setState({ selectedStash: {}, selectedCommit: {} });
  load();
  vi.mocked(stashApply).mockResolvedValue("applied");
  vi.mocked(stashPop).mockResolvedValue("applied");
  vi.mocked(stashDrop).mockResolvedValue(undefined);
});

async function renderPanel() {
  const view = renderWithProviders(<StashesPanel repoId={1} />);
  await screen.findByRole("list", { name: "Stash list" });
  return view;
}

const row = (n: number) => screen.getByTitle(entries()[n]!.message);
const rightClick = (el: HTMLElement) => fireEvent.contextMenu(el, { clientX: 10, clientY: 20 });
const menuItem = (name: string) => screen.getByRole("menuitem", { name });
const plus = () => screen.getByRole("button", { name: "Stash changes…" });

// Contract: heading with count, one row per stash, loading, empty and error states.
describe("StashesPanel list", () => {
  it("should show Loading stashes… until the list arrives", async () => {
    vi.mocked(listStashes).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<StashesPanel repoId={1} />);
    expect(await screen.findByText("Loading stashes…")).toBeInTheDocument();
  });

  it("should show the list error with Retry", async () => {
    vi.mocked(listStashes).mockRejectedValueOnce({ kind: "io", message: "list broke" });
    const { user } = renderWithProviders(<StashesPanel repoId={1} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("list broke");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Stash list" })).toBeInTheDocument();
  });

  it("should show Stashes (2) and one row per stash", async () => {
    await renderPanel();
    expect(screen.getByRole("heading", { name: "Stashes (2)" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Stash list" })).getAllByRole("listitem"),
    ).toHaveLength(2);
  });

  it("should show the region labelled by the heading", async () => {
    await renderPanel();
    expect(screen.getByRole("region", { name: "Stashes (2)" })).toBeInTheDocument();
  });

  it("should show the subject, branch and relative time of a row", async () => {
    const time = Math.floor(Date.now() / 1000) - 3 * 3600;
    load({ stashes: [stashEntry(0, { message: "On main: first", time })] });
    await renderPanel();
    const r = screen.getByTitle("On main: first");
    expect(within(r).getByText("first")).toBeInTheDocument();
    expect(within(r).getByText("main")).toBeInTheDocument();
    expect(within(r).getByText(relativeTime(time, Date.now()))).toBeInTheDocument();
  });

  it("should not show a branch for a stash without one", async () => {
    load({ stashes: [stashEntry(0, { message: "custom note", branch: null })] });
    await renderPanel();
    expect(within(screen.getByTitle("custom note")).queryByText("main")).toBeNull();
  });

  it("should mark a stash with untracked files", async () => {
    await renderPanel();
    expect(within(row(0)).getByText("untracked")).toBeInTheDocument();
    expect(within(row(1)).queryByText("untracked")).toBeNull();
  });

  it("should show No stashes for an empty list", async () => {
    load({ stashes: [] });
    renderWithProviders(<StashesPanel repoId={1} />);
    expect(await screen.findByText("No stashes")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Stashes (0)" })).toBeInTheDocument();
  });

  it("should not be busy when idle", async () => {
    await renderPanel();
    expect(screen.getByRole("region")).not.toHaveAttribute("aria-busy");
  });
});

// Contract: clicking or pressing Enter selects the stash in the workspace.
describe("StashesPanel selection", () => {
  it("clicking a row selects the stash", async () => {
    const { user } = await renderPanel();
    await user.click(row(1));
    expect(useWorkspace.getState().selectedStash[1]).toBe(entries()[1]!.oid);
    expect(row(1)).toHaveAttribute("aria-current", "true");
    expect(row(0)).not.toHaveAttribute("aria-current");
  });

  it("clicking a row clears the selected commit", async () => {
    useWorkspace.setState({ selectedCommit: { 1: "c".repeat(40) } });
    const { user } = await renderPanel();
    await user.click(row(0));
    expect(useWorkspace.getState().selectedCommit[1]).toBeNull();
  });

  it("Enter on a focused row selects it", async () => {
    const { user } = await renderPanel();
    row(0).focus();
    await user.keyboard("{Enter}");
    expect(useWorkspace.getState().selectedStash[1]).toBe(entries()[0]!.oid);
  });

  it("marks a row selected from the workspace", async () => {
    useWorkspace.setState({ selectedStash: { 1: entries()[0]!.oid } });
    await renderPanel();
    expect(row(0)).toHaveAttribute("aria-current", "true");
  });

  it("does not mark a stash selected in another repo", async () => {
    useWorkspace.setState({ selectedStash: { 2: entries()[0]!.oid } });
    await renderPanel();
    expect(row(0)).not.toHaveAttribute("aria-current");
  });
});

// Contract: the + button opens the stash dialog, gated by pushGate.
describe("StashesPanel + button", () => {
  it("the + button is named Stash changes… and opens the dialog", async () => {
    const { user } = await renderPanel();
    await waitFor(() => expect(plus()).toBeEnabled());
    await user.click(plus());
    expect(await screen.findByRole("dialog", { name: "Stash changes" })).toBeInTheDocument();
  });

  it("shows the label + and defaults its title to the name", async () => {
    await renderPanel();
    await waitFor(() => expect(plus()).toBeEnabled());
    expect(plus()).toHaveTextContent("+");
    expect(plus()).toHaveAttribute("title", "Stash changes…");
  });

  it("is disabled with no title while status and operation load", async () => {
    vi.mocked(getStatus).mockReturnValue(new Promise(() => undefined));
    await renderPanel();
    expect(plus()).toBeDisabled();
    expect(plus()).toHaveAttribute("title", "Stash changes…");
  });

  it.each([
    ["unborn HEAD", { status: workingStatus([], true) }, "Make a commit first"],
    ["an operation", { state: merging }, IN_PROGRESS_TITLE],
    [
      "index conflicts",
      { status: workingStatus([statusEntry("a", { conflicted: true })]) },
      "Resolve all conflicts first",
    ],
    ["no changes", { status: workingStatus([]) }, "No changes to stash"],
  ])("is disabled for %s with its title", async (_name, over, title) => {
    load(over);
    await renderPanel();
    await waitFor(() => expect(plus()).toHaveAttribute("title", title));
    expect(plus()).toBeDisabled();
  });
});

// Contract: the row context menu offers Apply, Pop and Drop…, gated by applyGate.
describe("StashesPanel context menu", () => {
  it("right-click opens Apply, Pop, Drop…", async () => {
    await renderPanel();
    rightClick(row(0));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Apply",
      "Pop",
      "Drop…",
    ]);
  });

  it("Shift+F10 opens the menu", async () => {
    await renderPanel();
    fireEvent.keyDown(row(0), { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("the ContextMenu key opens the menu", async () => {
    await renderPanel();
    fireEvent.keyDown(row(0), { key: "ContextMenu" });
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("Apply and Pop are disabled with the reason during an operation", async () => {
    load({ state: merging });
    await renderPanel();
    await waitFor(() => expect(plus()).toHaveAttribute("title", IN_PROGRESS_TITLE));
    rightClick(row(0));
    expect(menuItem("Apply")).toBeDisabled();
    expect(menuItem("Apply")).toHaveAttribute("title", IN_PROGRESS_TITLE);
    expect(menuItem("Pop")).toBeDisabled();
    expect(menuItem("Pop")).toHaveAttribute("title", IN_PROGRESS_TITLE);
    expect(menuItem("Drop…")).toBeEnabled();
  });

  it("Apply and Pop are disabled while the index has conflicts", async () => {
    load({ status: workingStatus([statusEntry("a", { conflicted: true })]) });
    await renderPanel();
    await waitFor(() => expect(plus()).toHaveAttribute("title", "Resolve all conflicts first"));
    rightClick(row(0));
    expect(menuItem("Apply")).toBeDisabled();
    expect(menuItem("Apply")).toHaveAttribute("title", "Resolve all conflicts first");
    expect(menuItem("Pop")).toBeDisabled();
    expect(menuItem("Drop…")).toBeEnabled();
  });

  it("Apply and Pop stay enabled with an empty status", async () => {
    load({ status: workingStatus([]) });
    await renderPanel();
    await waitFor(() => expect(plus()).toHaveAttribute("title", "No changes to stash"));
    rightClick(row(0));
    expect(menuItem("Apply")).toBeEnabled();
    expect(menuItem("Pop")).toBeEnabled();
  });

  it("Apply calls stashApply with index and oid", async () => {
    const { user } = await renderPanel();
    await waitFor(() => expect(plus()).toBeEnabled());
    rightClick(row(1));
    await user.click(menuItem("Apply"));
    expect(stashApply).toHaveBeenCalledExactlyOnceWith(1, 1, entries()[1]!.oid);
  });

  it("Pop calls stashPop with index and oid", async () => {
    const { user } = await renderPanel();
    await waitFor(() => expect(plus()).toBeEnabled());
    rightClick(row(0));
    await user.click(menuItem("Pop"));
    expect(stashPop).toHaveBeenCalledExactlyOnceWith(1, 0, entries()[0]!.oid);
  });
});

// Contract: Drop… confirms before dropping.
describe("StashesPanel drop", () => {
  async function askDrop() {
    const view = await renderPanel();
    rightClick(row(1));
    await view.user.click(menuItem("Drop…"));
    return view;
  }

  it("Drop… asks Drop stash@{1}? with This can't be undone.", async () => {
    await askDrop();
    const dialog = await screen.findByRole("dialog", { name: "Drop stash@{1}?" });
    expect(dialog).toHaveTextContent("This can't be undone.");
  });

  it("confirming Drop calls stashDrop and closes", async () => {
    const { user } = await askDrop();
    await user.click(await screen.findByRole("button", { name: "Drop" }));
    expect(stashDrop).toHaveBeenCalledExactlyOnceWith(1, 1, entries()[1]!.oid);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Cancel calls nothing", async () => {
    const { user } = await askDrop();
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(stashDrop).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// Contract: conflict notices, stale and git errors surface in the panel.
describe("StashesPanel feedback", () => {
  async function applyWith(index = 0) {
    const view = await renderPanel();
    await waitFor(() => expect(plus()).toBeEnabled());
    rightClick(row(index));
    await view.user.click(menuItem("Apply"));
    return view;
  }

  it("shows the apply conflict notice and dismisses it", async () => {
    vi.mocked(stashApply).mockResolvedValue("conflicts");
    const { user } = await applyWith();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Applied with conflicts. Resolve them in Changes.",
    );
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the pop notice with the kept suffix", async () => {
    vi.mocked(stashPop).mockResolvedValue("conflicts");
    const { user } = await renderPanel();
    await waitFor(() => expect(plus()).toBeEnabled());
    rightClick(row(0));
    await user.click(menuItem("Pop"));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Applied with conflicts. Resolve them in Changes. The stash was kept; drop it once resolved.",
    );
  });

  it("the next action clears the notice", async () => {
    vi.mocked(stashApply).mockResolvedValueOnce("conflicts");
    const { user } = await applyWith();
    await screen.findByRole("status");
    rightClick(row(0));
    await user.click(menuItem("Apply"));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("shows The stash list changed; it has been refreshed. on staleStash and refetches the list", async () => {
    vi.mocked(stashApply).mockRejectedValue({ kind: "staleStash", message: "raw stale" });
    await applyWith();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The stash list changed; it has been refreshed.",
    );
    await waitFor(() => expect(listStashes).toHaveBeenCalledTimes(2));
  });

  it("shows git's message on operationFailed", async () => {
    vi.mocked(stashApply).mockRejectedValue({ kind: "operationFailed", message: "git said no" });
    await applyWith();
    expect(await screen.findByRole("alert")).toHaveTextContent("git said no");
  });

  it("dismissing an error clears it", async () => {
    vi.mocked(stashApply).mockRejectedValue({ kind: "operationFailed", message: "git said no" });
    const { user } = await applyWith();
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refreshes the status after an action", async () => {
    await applyWith();
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
  });
});

// Coverage: dialog lifecycle from the + button, key handling, and drop/error edge cases.
describe("StashesPanel dialog lifecycle", () => {
  it("Cancel closes the dialog opened from the + button", async () => {
    const { user } = await renderPanel();
    await waitFor(() => expect(plus()).toBeEnabled());
    await user.click(plus());
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Stash changes" })).toBeNull();
    expect(stashPush).not.toHaveBeenCalled();
  });

  it("the dialog can be reopened after closing", async () => {
    const { user } = await renderPanel();
    await waitFor(() => expect(plus()).toBeEnabled());
    await user.click(plus());
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await user.click(plus());
    expect(await screen.findByRole("dialog", { name: "Stash changes" })).toBeInTheDocument();
  });

  it("a successful push from the dialog closes it", async () => {
    vi.mocked(stashPush).mockResolvedValue(undefined);
    const { user } = await renderPanel();
    await waitFor(() => expect(plus()).toBeEnabled());
    await user.click(plus());
    await user.click(await screen.findByRole("button", { name: "Stash" }));
    expect(stashPush).toHaveBeenCalledExactlyOnceWith(1, null, false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("StashesPanel row keys", () => {
  it("F10 without Shift does not open the menu", async () => {
    await renderPanel();
    fireEvent.keyDown(row(0), { key: "F10" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("an unrelated key does not open the menu", async () => {
    await renderPanel();
    fireEvent.keyDown(row(0), { key: "a" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("Shift+F10 and ContextMenu prevent the native contextmenu", async () => {
    await renderPanel();
    expect(fireEvent.keyDown(row(0), { key: "F10", shiftKey: true })).toBe(false);
    expect(fireEvent.keyDown(row(0), { key: "ContextMenu" })).toBe(false);
  });

  it("right-click suppresses the native menu", async () => {
    await renderPanel();
    expect(rightClick(row(0))).toBe(false);
  });

  it("the menu opened by key acts on the focused row's stash", async () => {
    const { user } = await renderPanel();
    await waitFor(() => expect(plus()).toBeEnabled());
    fireEvent.keyDown(row(1), { key: "F10", shiftKey: true });
    await user.click(menuItem("Pop"));
    expect(stashPop).toHaveBeenCalledExactlyOnceWith(1, 1, entries()[1]!.oid);
  });
});

describe("StashesPanel feedback edge cases", () => {
  it("a later action clears an older undismissed error", async () => {
    vi.mocked(stashApply).mockRejectedValueOnce({
      kind: "operationFailed",
      message: "git said no",
    });
    const { user } = await renderPanel();
    await waitFor(() => expect(plus()).toBeEnabled());
    rightClick(row(0));
    await user.click(menuItem("Apply"));
    await screen.findByRole("alert");
    rightClick(row(0));
    await user.click(menuItem("Pop"));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("a failed drop closes the confirm and shows the error", async () => {
    vi.mocked(stashDrop).mockRejectedValue({ kind: "staleStash", message: "raw" });
    const { user } = await renderPanel();
    rightClick(row(1));
    await user.click(menuItem("Drop…"));
    await user.click(await screen.findByRole("button", { name: "Drop" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The stash list changed; it has been refreshed.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is busy while an action runs and not afterwards", async () => {
    let finish: (o: "applied") => void = () => undefined;
    vi.mocked(stashApply).mockReturnValue(new Promise((r) => (finish = r)));
    const { user } = await renderPanel();
    await waitFor(() => expect(plus()).toBeEnabled());
    rightClick(row(0));
    await user.click(menuItem("Apply"));
    await waitFor(() =>
      expect(screen.getByRole("region", { name: /^Stashes/ })).toHaveAttribute("aria-busy", "true"),
    );
    expect(plus()).toBeDisabled();
    finish("applied");
    await waitFor(() =>
      expect(screen.getByRole("region", { name: /^Stashes/ })).not.toHaveAttribute("aria-busy"),
    );
  });
});
