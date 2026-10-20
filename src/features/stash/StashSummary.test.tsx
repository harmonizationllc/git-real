import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOperationState,
  getStashFiles,
  getStatus,
  listStashes,
  stashApply,
  stashDrop,
  stashPop,
} from "../../lib/ipc";
import type { OperationState, StashEntry, StashOutcome } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useWorkspace } from "../../lib/store/workspace";
import { oidOf } from "../../test/graphFixtures";
import { commitFile } from "../../test/historyFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { stashEntry, stashFiles, workingStatus } from "../../test/stashFixtures";
import { fullDate } from "../graph/model/relativeTime";
import { shortOid } from "../graph/model/layout";
import { IN_PROGRESS_TITLE } from "../merge/operationCopy";
import { StashSummary } from "./StashSummary";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listStashes: vi.fn(),
  getStashFiles: vi.fn(),
  stashApply: vi.fn(),
  stashPop: vi.fn(),
  stashDrop: vi.fn(),
  getStatus: vi.fn(),
  getOperationState: vi.fn(),
}));

const U = "9".repeat(40);
const W_ENTRY: StashEntry = stashEntry(1, { message: "On main: my work", hasUntracked: true });
const W = W_ENTRY.oid;
const FILES = stashFiles({
  tracked: [commitFile("a.txt"), commitFile("b.txt", { change: "renamed", oldPath: "old.txt" })],
  untracked: [commitFile("new.txt", { change: "added" })],
  untrackedOid: U,
});
const merging: OperationState = {
  kind: "merge",
  head: "a".repeat(40),
  branch: "feature",
  message: { subject: "Merge", body: "" },
};

beforeEach(() => {
  vi.resetAllMocks();
  useWorkspace.setState({ selectedStash: { 1: W }, selected: {}, selectedCommit: {} });
  vi.mocked(listStashes).mockResolvedValue([stashEntry(0), W_ENTRY]);
  vi.mocked(getStashFiles).mockResolvedValue(FILES);
  vi.mocked(getStatus).mockResolvedValue(workingStatus());
  vi.mocked(getOperationState).mockResolvedValue({ kind: "none" });
  vi.mocked(stashApply).mockResolvedValue("applied");
  vi.mocked(stashPop).mockResolvedValue("applied");
  vi.mocked(stashDrop).mockResolvedValue(undefined);
});

async function renderSummary() {
  const view = renderWithProviders(<StashSummary repoId={1} oid={W} />);
  await screen.findByRole("heading", { name: "stash@{1}" });
  return view;
}

const details = () => screen.getByRole("region", { name: "Stash details" });
const inDetails = () => within(details());
const fileBtn = (name: string) => inDetails().getByRole("button", { name });

// Contract: header, metadata and Close.
describe("StashSummary header", () => {
  it("should show Loading stash… until the list arrives", async () => {
    vi.mocked(listStashes).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<StashSummary repoId={1} oid={W} />);
    expect(await screen.findByText("Loading stash…")).toBeInTheDocument();
  });

  it("should show the list error with Retry", async () => {
    vi.mocked(listStashes).mockRejectedValueOnce({ kind: "io", message: "list broke" });
    const { user } = renderWithProviders(<StashSummary repoId={1} oid={W} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("list broke");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "stash@{1}" })).toBeInTheDocument();
  });

  it("should show stash@{1}, the message, branch, date and base short id", async () => {
    await renderSummary();
    expect(inDetails().getByText("my work")).toBeInTheDocument();
    expect(inDetails().getByText(/main/, { selector: "*:not(strong)" })).toBeInTheDocument();
    expect(inDetails().getByText(fullDate(W_ENTRY.time))).toBeInTheDocument();
    const base = inDetails().getByText(shortOid(oidOf(0)));
    expect(base).toHaveAttribute("title", oidOf(0));
  });

  it("should not show a branch line for a stash without a branch", async () => {
    vi.mocked(listStashes).mockResolvedValue([
      stashEntry(1, { message: "custom note", branch: null }),
    ]);
    await renderSummary();
    expect(inDetails().queryByText(/^Branch/)).toBeNull();
  });

  it("Close clears the stash selection", async () => {
    const { user } = await renderSummary();
    await user.click(screen.getByRole("button", { name: "Close stash details" }));
    expect(useWorkspace.getState().selectedStash[1]).toBeNull();
  });

  it("Close leaves a file opened from the stash alone", async () => {
    useWorkspace.setState({ selected: { 1: { path: "a.txt", scope: { commit: W } } } });
    const { user } = await renderSummary();
    await user.click(screen.getByRole("button", { name: "Close stash details" }));
    expect(useWorkspace.getState().selected[1]).toEqual({ path: "a.txt", scope: { commit: W } });
  });

  it("should request the files for the stash oid", async () => {
    await renderSummary();
    expect(getStashFiles).toHaveBeenCalledWith(1, W);
  });
});

// Contract: Changes and Untracked groups (headings, not regions) with clickable rows.
describe("StashSummary files", () => {
  it("lists Changes and Untracked groups with status badges", async () => {
    await renderSummary();
    expect(await inDetails().findByRole("heading", { name: /^Changes/ })).toBeInTheDocument();
    expect(inDetails().getByRole("heading", { name: /^Untracked/ })).toBeInTheDocument();
    expect(inDetails().getAllByRole("img", { name: "modified" })).toHaveLength(1);
    expect(inDetails().getByRole("img", { name: "added" })).toBeInTheDocument();
  });

  it("does not make the Changes group a region", async () => {
    await renderSummary();
    await inDetails().findByRole("heading", { name: /^Changes/ });
    expect(screen.queryByRole("region", { name: "Changes" })).toBeNull();
  });

  it("shows a rename as old → new", async () => {
    await renderSummary();
    expect(
      await inDetails().findByRole("button", { name: "renamed old.txt → b.txt" }),
    ).toBeInTheDocument();
  });

  it("hides the Untracked group when the stash has none", async () => {
    vi.mocked(getStashFiles).mockResolvedValue(stashFiles({ tracked: [commitFile("a.txt")] }));
    await renderSummary();
    await inDetails().findByRole("heading", { name: /^Changes/ });
    expect(inDetails().queryByRole("heading", { name: /^Untracked/ })).toBeNull();
  });

  it("clicking a tracked file selects it with the stash commit scope", async () => {
    const { user } = await renderSummary();
    await user.click(await inDetails().findByRole("button", { name: "modified a.txt" }));
    expect(useWorkspace.getState().selected[1]).toEqual({
      path: "a.txt",
      scope: { commit: W },
      source: "stash",
    });
    expect(fileBtn("modified a.txt")).toHaveAttribute("aria-current", "true");
  });

  it("clicking an untracked file selects it with the untracked commit scope", async () => {
    const { user } = await renderSummary();
    await user.click(await inDetails().findByRole("button", { name: "added new.txt" }));
    expect(useWorkspace.getState().selected[1]).toEqual({
      path: "new.txt",
      scope: { commit: U },
      source: "stash",
    });
    expect(fileBtn("added new.txt")).toHaveAttribute("aria-current", "true");
  });

  it("does not mark a same-named file opened from another scope", async () => {
    useWorkspace.setState({ selected: { 1: { path: "a.txt", scope: "unstaged" } } });
    await renderSummary();
    expect(await inDetails().findByRole("button", { name: "modified a.txt" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("shows a files error other than revisionNotFound with Retry", async () => {
    vi.mocked(getStashFiles).mockRejectedValueOnce({ kind: "git", message: "files broke" });
    const { user } = await renderSummary();
    expect(await inDetails().findByRole("alert")).toHaveTextContent("files broke");
    await user.click(inDetails().getByRole("button", { name: "Retry" }));
    expect(await inDetails().findByRole("button", { name: "modified a.txt" })).toBeInTheDocument();
  });
});

// Contract: Apply, Pop, Drop… act on this stash, gated like the panel.
describe("StashSummary actions", () => {
  it("Apply and Pop call the wrappers with index and oid", async () => {
    const { user } = await renderSummary();
    const apply = inDetails().getByRole("button", { name: "Apply" });
    await waitFor(() => expect(apply).toBeEnabled());
    await user.click(apply);
    await user.click(inDetails().getByRole("button", { name: "Pop" }));
    expect(stashApply).toHaveBeenCalledExactlyOnceWith(1, 1, W);
    expect(stashPop).toHaveBeenCalledExactlyOnceWith(1, 1, W);
  });

  it("Apply is disabled with the reason during an operation", async () => {
    vi.mocked(getOperationState).mockResolvedValue(merging);
    await renderSummary();
    const apply = inDetails().getByRole("button", { name: "Apply" });
    await waitFor(() => expect(apply).toHaveAttribute("title", IN_PROGRESS_TITLE));
    expect(apply).toBeDisabled();
    expect(inDetails().getByRole("button", { name: "Pop" })).toBeDisabled();
    expect(inDetails().getByRole("button", { name: "Drop…" })).toBeEnabled();
  });

  it("Drop… confirms with Drop stash@{1}? then calls stashDrop", async () => {
    const { user } = await renderSummary();
    await user.click(inDetails().getByRole("button", { name: "Drop…" }));
    const dialog = await screen.findByRole("dialog", { name: "Drop stash@{1}?" });
    expect(dialog).toHaveTextContent("This can't be undone.");
    await user.click(within(dialog).getByRole("button", { name: "Drop" }));
    expect(stashDrop).toHaveBeenCalledExactlyOnceWith(1, 1, W);
  });

  it("closes the confirm as soon as Drop is confirmed, before the drop settles", async () => {
    vi.mocked(stashDrop).mockReturnValue(new Promise(() => undefined));
    const { user } = await renderSummary();
    await user.click(inDetails().getByRole("button", { name: "Drop…" }));
    const dialog = await screen.findByRole("dialog", { name: "Drop stash@{1}?" });
    await user.click(within(dialog).getByRole("button", { name: "Drop" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(details()).toHaveAttribute("aria-busy", "true"));
    expect(inDetails().getByRole("button", { name: "Drop…" })).toBeDisabled();
  });

  it("Pop that applies but keeps the stash shows the kept notice and stays open", async () => {
    vi.mocked(stashPop).mockResolvedValue("appliedNotDropped" as StashOutcome);
    const { user } = await renderSummary();
    const pop = inDetails().getByRole("button", { name: "Pop" });
    await waitFor(() => expect(pop).toBeEnabled());
    await user.click(pop);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Applied, but the stash could not be dropped. Drop it once you no longer need it.",
    );
    expect(details()).toBeInTheDocument();
  });

  async function popKept() {
    vi.mocked(stashPop).mockResolvedValue("appliedNotDropped" as StashOutcome);
    const view = await renderSummary();
    const pop = inDetails().getByRole("button", { name: "Pop" });
    await waitFor(() => expect(pop).toBeEnabled());
    await view.user.click(pop);
    await screen.findByRole("status");
    return { ...view, pop };
  }

  it("disables Pop with the Drop hint after a pop that kept the stash", async () => {
    const { pop } = await popKept();
    await waitFor(() => expect(pop).toBeDisabled());
    expect(pop).toHaveAttribute("title", "Already applied. Use Drop… to remove the stash.");
    expect(inDetails().getByRole("button", { name: "Apply" })).toBeEnabled();
    expect(inDetails().getByRole("button", { name: "Drop…" })).toBeEnabled();
  });

  it("shows the gate reason on Pop when the gate and the kept notice both disable it", async () => {
    vi.mocked(stashPop).mockResolvedValue("appliedNotDropped" as StashOutcome);
    const { user } = await renderSummary();
    const pop = inDetails().getByRole("button", { name: "Pop" });
    await waitFor(() => expect(pop).toBeEnabled());
    vi.mocked(getOperationState).mockResolvedValue(merging);
    await user.click(pop);
    await screen.findByRole("status");
    await waitFor(() => expect(pop).toHaveAttribute("title", IN_PROGRESS_TITLE));
    expect(pop).toBeDisabled();
  });

  it("clears the kept notice and its Pop hint when Drop is confirmed", async () => {
    vi.mocked(stashDrop).mockReturnValue(new Promise(() => undefined));
    const { user, pop } = await popKept();
    await waitFor(() => expect(pop).toBeDisabled());
    await user.click(inDetails().getByRole("button", { name: "Drop…" }));
    const dialog = await screen.findByRole("dialog", { name: "Drop stash@{1}?" });
    await user.click(within(dialog).getByRole("button", { name: "Drop" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(pop).not.toHaveAttribute("title");
  });

  it("re-enables Pop when the kept notice is dismissed", async () => {
    const { user, pop } = await popKept();
    await user.click(inDetails().getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(pop).toBeEnabled());
    expect(pop).not.toHaveAttribute("title");
  });

  it("re-enables Pop when a new action clears the kept notice", async () => {
    const { user, pop } = await popKept();
    await waitFor(() => expect(pop).toBeDisabled());
    await user.click(inDetails().getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    await waitFor(() => expect(pop).toBeEnabled());
  });

  it("keeps Pop enabled after a pop with conflicts", async () => {
    vi.mocked(stashPop).mockResolvedValue("conflicts");
    const { user } = await renderSummary();
    const pop = inDetails().getByRole("button", { name: "Pop" });
    await waitFor(() => expect(pop).toBeEnabled());
    await user.click(pop);
    await screen.findByRole("status");
    await waitFor(() => expect(pop).toBeEnabled());
  });

  it("Cancel on the drop dialog drops nothing", async () => {
    const { user } = await renderSummary();
    await user.click(inDetails().getByRole("button", { name: "Drop…" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(stashDrop).not.toHaveBeenCalled();
  });

  it("shows the pop conflict notice", async () => {
    vi.mocked(stashPop).mockResolvedValue("conflicts");
    const { user } = await renderSummary();
    const pop = inDetails().getByRole("button", { name: "Pop" });
    await waitFor(() => expect(pop).toBeEnabled());
    await user.click(pop);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Applied with conflicts. Resolve them in Changes. The stash was kept; drop it once resolved.",
    );
  });

  it("shows the stale message on staleStash", async () => {
    vi.mocked(stashApply).mockRejectedValue({ kind: "staleStash", message: "raw" });
    const { user } = await renderSummary();
    const apply = inDetails().getByRole("button", { name: "Apply" });
    await waitFor(() => expect(apply).toBeEnabled());
    await user.click(apply);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The stash list changed; it has been refreshed.",
    );
  });

  it("returns focus to the stash heading when Drop is cancelled and its opener never had focus", async () => {
    const { user } = await renderSummary();
    fireEvent.click(inDetails().getByRole("button", { name: "Drop…" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Drop stash@{1}?" })).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(screen.getByRole("heading", { name: "stash@{1}" })).toHaveFocus();
  });

  it("should mark the stash heading as a programmatic focus target", async () => {
    await renderSummary();
    const target = await screen.findByRole("heading", { name: "stash@{1}" });
    expect(target).toHaveAttribute("data-focus-target");
    expect(target).toHaveAttribute("tabindex", "-1");
  });
});

// Contract (Review Focus 5): a stash that leaves the list clears the selection and files opened from it.
describe("StashSummary vanishing stash", () => {
  async function vanish(queryClient: { invalidateQueries: (o: object) => Promise<void> }) {
    vi.mocked(listStashes).mockResolvedValue([stashEntry(0)]);
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(1) }));
  }

  it("should clear the selection when the stash leaves the list", async () => {
    const { queryClient } = await renderSummary();
    await vanish(queryClient);
    await waitFor(() => expect(useWorkspace.getState().selectedStash[1]).toBeNull());
  });

  it("clears a file opened from the vanished stash", async () => {
    useWorkspace.setState({ selected: { 1: { path: "a.txt", scope: { commit: W } } } });
    const { queryClient } = await renderSummary();
    await vanish(queryClient);
    await waitFor(() => expect(useWorkspace.getState().selected[1]).toBeNull());
  });

  it("clears a file opened from the vanished stash's untracked commit", async () => {
    useWorkspace.setState({ selected: { 1: { path: "new.txt", scope: { commit: U } } } });
    const { queryClient } = await renderSummary();
    await inDetails().findByRole("heading", { name: /^Untracked/ });
    await vanish(queryClient);
    await waitFor(() => expect(useWorkspace.getState().selected[1]).toBeNull());
  });

  it("keeps an unrelated opened file", async () => {
    const other = { path: "x.txt", scope: { commit: oidOf(5) } };
    useWorkspace.setState({ selected: { 1: other } });
    const { queryClient } = await renderSummary();
    await vanish(queryClient);
    await waitFor(() => expect(useWorkspace.getState().selectedStash[1]).toBeNull());
    expect(useWorkspace.getState().selected[1]).toEqual(other);
  });

  it("keeps a working-tree file selection", async () => {
    const other = { path: "x.txt", scope: "unstaged" as const };
    useWorkspace.setState({ selected: { 1: other } });
    const { queryClient } = await renderSummary();
    await vanish(queryClient);
    await waitFor(() => expect(useWorkspace.getState().selectedStash[1]).toBeNull());
    expect(useWorkspace.getState().selected[1]).toEqual(other);
  });

  it("should clear the selection when the files are revisionNotFound", async () => {
    vi.mocked(getStashFiles).mockRejectedValue({ kind: "revisionNotFound", message: "gone" });
    renderWithProviders(<StashSummary repoId={1} oid={W} />);
    await waitFor(() => expect(useWorkspace.getState().selectedStash[1]).toBeNull());
  });

  it("does not clear the selection while the list is still loading", async () => {
    vi.mocked(listStashes).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<StashSummary repoId={1} oid={W} />);
    await screen.findByText("Loading stash…");
    expect(useWorkspace.getState().selectedStash[1]).toBe(W);
  });
});
