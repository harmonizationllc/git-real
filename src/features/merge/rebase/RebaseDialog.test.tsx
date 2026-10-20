import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rebasePlan } from "../../../lib/ipc";
import type { AppError, RebaseCommit } from "../../../lib/ipc";
import { queryKeys } from "../../../lib/query/keys";
import { renderWithProviders } from "../../../test/renderWithProviders";
import { RebaseDialog } from "./RebaseDialog";
import type { RebaseDialogProps } from "./RebaseDialog";

vi.mock(import("../../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  rebasePlan: vi.fn(),
}));

const commit = (c: string): RebaseCommit => ({
  oid: c.repeat(40),
  subject: `subject ${c}`,
  author: { name: "Ann", email: "ann@example.com", time: 1 },
});
// git order: a is the oldest, c the newest; the dialog lists newest first.
const commits = [commit("a"), commit("b"), commit("c")];
const full = (c: string) => c.repeat(40);

function renderDialog(over: Partial<RebaseDialogProps> = {}) {
  const props: RebaseDialogProps = {
    repoId: 4,
    base: "main",
    label: "main",
    head: "feature",
    run: vi.fn<RebaseDialogProps["run"]>().mockResolvedValue(null),
    pending: false,
    onClose: vi.fn(),
    ...over,
  };
  const utils = renderWithProviders(<RebaseDialog {...props} />);
  return { props, ...utils };
}

const dialog = () => screen.getByRole("dialog");
const list = () => screen.findByRole("list", { name: "Commits to rebase" });
const rows = () =>
  within(screen.getByRole("list", { name: "Commits to rebase" })).getAllByRole("listitem");
// "ccccccc" → "c": which commit a row shows, read from its select label.
const letter = (row: HTMLElement) =>
  (within(row).getByRole("combobox").getAttribute("aria-label") as string).slice(-7)[0];
const order = () => rows().map(letter).join("");
const selectOf = (c: string) => screen.getByRole("combobox", { name: `Action for ${c.repeat(7)}` });
const rowOf = (c: string) => selectOf(c).closest("li") as HTMLElement;
const start = () => screen.getByRole("button", { name: "Start rebase" });
const fakeTransfer = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(rebasePlan).mockResolvedValue(commits);
});

// Contract: the dialog title names the current branch and the base's label.
describe("RebaseDialog title", () => {
  it("should title the dialog with the head and the base label", () => {
    renderDialog();
    expect(
      screen.getByRole("heading", { name: "Rebase feature onto main interactively" }),
    ).toBeInTheDocument();
  });

  it("should label the dialog by its title", () => {
    renderDialog();
    expect(dialog()).toHaveAccessibleName("Rebase feature onto main interactively");
  });

  it("should show the label, not the raw base, in the title", () => {
    renderDialog({ base: full("f"), label: "fffffff" });
    expect(screen.getByRole("heading")).toHaveTextContent(
      "Rebase feature onto fffffff interactively",
    );
  });

  it("should ask the backend for the plan of the given base", async () => {
    renderDialog({ base: full("f"), label: "fffffff" });
    await list();
    expect(rebasePlan).toHaveBeenCalledExactlyOnceWith(4, full("f"));
  });

  it("should be a modal dialog", () => {
    renderDialog();
    expect(dialog()).toHaveAttribute("aria-modal", "true");
  });
});

// Contract: while the plan loads the body is a status and Cancel is the only button.
describe("RebaseDialog loading", () => {
  beforeEach(() => {
    vi.mocked(rebasePlan).mockReturnValue(new Promise(() => undefined));
  });

  it("should show Loading commits… as a status", () => {
    renderDialog();
    expect(screen.getByRole("status")).toHaveTextContent("Loading commits…");
  });

  it("should offer only Cancel while loading", () => {
    renderDialog();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel"]);
  });

  it("should call onClose when Cancel is clicked while loading", async () => {
    const { props, user } = renderDialog();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("should close on Escape while loading", async () => {
    const { props, user } = renderDialog();
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

// Contract: the plan lists the commits newest first with a summary footer.
describe("RebaseDialog plan", () => {
  it("should list the commits newest first", async () => {
    renderDialog();
    await list();
    expect(order()).toBe("cba");
  });

  it("should show each commit's subject", async () => {
    renderDialog();
    await list();
    expect(rows().map((r) => within(r).getByText(/^subject /).textContent)).toEqual([
      "subject c",
      "subject b",
      "subject a",
    ]);
  });

  it("should replace the loading status once the plan arrives", async () => {
    renderDialog();
    await list();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("should show the summary of the initial plan", async () => {
    renderDialog();
    await list();
    expect(screen.getByText("3 commits, 0 squashed, 0 dropped")).toBeInTheDocument();
  });

  it("should update the summary when an action changes", async () => {
    const { user } = renderDialog();
    await list();
    await user.selectOptions(selectOf("b"), "squash");
    expect(screen.getByText("2 commits, 1 squashed, 0 dropped")).toBeInTheDocument();
  });

  it("should count a dropped commit in the summary", async () => {
    const { user } = renderDialog();
    await list();
    await user.selectOptions(selectOf("a"), "drop");
    expect(screen.getByText("2 commits, 0 squashed, 1 dropped")).toBeInTheDocument();
  });

  it("should offer exactly one Cancel and a Start rebase button", async () => {
    renderDialog();
    await list();
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    expect(start()).toBeInTheDocument();
  });

  it("should enable Start for the initial plan", async () => {
    renderDialog();
    await list();
    expect(start()).toBeEnabled();
  });

  it("should call onClose when Cancel is clicked", async () => {
    const { props, user } = renderDialog();
    await list();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

// Contract: an empty plan says there is nothing to rebase and offers only Cancel.
describe("RebaseDialog empty plan", () => {
  beforeEach(() => {
    vi.mocked(rebasePlan).mockResolvedValue([]);
  });

  it("should explain there is nothing to rebase", async () => {
    renderDialog();
    expect(
      await screen.findByText("Nothing to rebase: feature has no commits after main."),
    ).toBeInTheDocument();
  });

  it("should offer no Start button", async () => {
    renderDialog();
    await screen.findByText(/Nothing to rebase/);
    expect(screen.queryByRole("button", { name: "Start rebase" })).not.toBeInTheDocument();
  });

  it("should offer only Cancel", async () => {
    renderDialog();
    await screen.findByText(/Nothing to rebase/);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel"]);
  });

  it("should render no commit list", async () => {
    renderDialog();
    await screen.findByText(/Nothing to rebase/);
    expect(screen.queryByRole("list", { name: "Commits to rebase" })).not.toBeInTheDocument();
  });

  it("should use the label in the message", async () => {
    renderDialog({ base: full("f"), label: "fffffff" });
    expect(
      await screen.findByText("Nothing to rebase: feature has no commits after fffffff."),
    ).toBeInTheDocument();
  });
});

// Contract: a plan-load error is an alert with the mapped message and Cancel as the only button.
describe("RebaseDialog plan error", () => {
  const reject = (error: AppError) => vi.mocked(rebasePlan).mockRejectedValue(error);

  it("should map badSelection to the no shared history message", async () => {
    reject({ kind: "badSelection", message: "raw" });
    renderDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "feature and main share no history.",
    );
  });

  it("should use the label in the no shared history message", async () => {
    reject({ kind: "badSelection", message: "raw" });
    renderDialog({ base: full("f"), label: "fffffff" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "feature and fffffff share no history.",
    );
  });

  it("should not show the removed not-on-branch message", async () => {
    reject({ kind: "badSelection", message: "raw" });
    renderDialog();
    await screen.findByRole("alert");
    expect(screen.queryByText(/is not on/)).not.toBeInTheDocument();
  });

  it("should map mergeCommit to the merge commit message", async () => {
    reject({ kind: "mergeCommit", message: "raw" });
    renderDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The range contains a merge commit, which cannot be rebased interactively yet.",
    );
  });

  it("should show another error's own message", async () => {
    reject({ kind: "branchNotFound", message: "no such branch: main" });
    renderDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent("no such branch: main");
  });

  it("should offer only Cancel with no Dismiss", async () => {
    reject({ kind: "badSelection", message: "raw" });
    renderDialog();
    await screen.findByRole("alert");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Cancel"]);
  });

  it("should render no Start button", async () => {
    reject({ kind: "badSelection", message: "raw" });
    renderDialog();
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Start rebase" })).not.toBeInTheDocument();
  });

  it("should call onClose when Cancel is clicked", async () => {
    reject({ kind: "badSelection", message: "raw" });
    const { props, user } = renderDialog();
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("should close on Escape in the error state", async () => {
    reject({ kind: "badSelection", message: "raw" });
    const { props, user } = renderDialog();
    await screen.findByRole("alert");
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

// Contract: focus goes to the dialog box itself, so Escape works in every state, and returns
// to the opener on close.
describe("RebaseDialog focus", () => {
  it("should be focusable without being in the tab order", () => {
    renderDialog();
    expect(dialog()).toHaveAttribute("tabindex", "-1");
  });

  it("should focus the dialog on open", () => {
    renderDialog();
    expect(dialog()).toHaveFocus();
  });

  it("should keep focus on the dialog after the plan loads", async () => {
    renderDialog();
    await list();
    expect(dialog()).toHaveFocus();
  });

  it("should close on Escape after the plan has loaded", async () => {
    const { props, user } = renderDialog();
    await list();
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("should move focus to the dialog when pending starts", async () => {
    const { props, rerender } = renderDialog();
    await list();
    start().focus();
    expect(start()).toHaveFocus();
    rerender(<RebaseDialog {...props} pending />);
    expect(dialog()).toHaveFocus();
  });

  it("should keep focus on the dialog, not the alert, when a run fails", async () => {
    let resolve!: (e: AppError | null) => void;
    const run = vi.fn<RebaseDialogProps["run"]>(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { props, user, rerender } = renderDialog({ run });
    await list();
    await user.click(start());
    rerender(<RebaseDialog {...props} pending />);
    resolve({ kind: "operationFailed", message: "git said no" });
    rerender(<RebaseDialog {...props} pending={false} />);
    expect(await screen.findByRole("alert")).not.toHaveFocus();
    expect(dialog()).toHaveFocus();
  });

  it("should close on Escape once a failed run's pending ends", async () => {
    let resolve!: (e: AppError | null) => void;
    const run = vi.fn<RebaseDialogProps["run"]>(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { props, user, rerender } = renderDialog({ run });
    await list();
    await user.click(start());
    rerender(<RebaseDialog {...props} pending />);
    resolve({ kind: "operationFailed", message: "git said no" });
    rerender(<RebaseDialog {...props} pending={false} />);
    await screen.findByRole("alert");
    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("should pull focus back to the dialog when a retry after a failed run goes pending", async () => {
    const { props, rerender } = renderDialog();
    await list();
    rerender(<RebaseDialog {...props} pending />);
    rerender(<RebaseDialog {...props} pending={false} />);
    start().focus();
    expect(start()).toHaveFocus();
    rerender(<RebaseDialog {...props} pending />);
    expect(dialog()).toHaveFocus();
  });

  it("should restore focus to the opener when it unmounts", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = renderDialog();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("should focus the fallback on close when nothing held focus at open", () => {
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.appendChild(fallback);
    (document.activeElement as HTMLElement).blur();
    const { unmount } = renderDialog({ fallbackFocus: { current: fallback } });
    unmount();
    expect(fallback).toHaveFocus();
    fallback.remove();
  });

  it("should focus the fallback when the opener was removed while open", () => {
    const opener = document.createElement("button");
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.append(opener, fallback);
    opener.focus();
    const { unmount } = renderDialog({ fallbackFocus: { current: fallback } });
    opener.remove();
    unmount();
    expect(fallback).toHaveFocus();
    fallback.remove();
  });

  it("should prefer the opener over the fallback when the opener can take focus", () => {
    const opener = document.createElement("button");
    const fallback = document.createElement("div");
    fallback.tabIndex = -1;
    document.body.append(opener, fallback);
    opener.focus();
    const { unmount } = renderDialog({ fallbackFocus: { current: fallback } });
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
    fallback.remove();
  });
});

// Contract: Escape and a backdrop click close the dialog; nothing else does.
describe("RebaseDialog dismissal", () => {
  it("should close on a backdrop click", async () => {
    const { props } = renderDialog();
    await list();
    fireEvent.click(dialog().parentElement as HTMLElement);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("should not close on a click inside the dialog box", async () => {
    const { props, user } = renderDialog();
    await list();
    await user.click(screen.getByRole("heading"));
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("should not close on a key other than Escape", async () => {
    const { props, user } = renderDialog();
    await list();
    await user.keyboard("a");
    await user.keyboard("{Enter}");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("should not close on Escape while pending", async () => {
    const { props, user } = renderDialog({ pending: true });
    await list();
    await user.keyboard("{Escape}");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("should not close on a backdrop click while pending", async () => {
    const { props } = renderDialog({ pending: true });
    await list();
    fireEvent.click(dialog().parentElement as HTMLElement);
    expect(props.onClose).not.toHaveBeenCalled();
  });
});

// Contract: Start runs the plan oldest first, closes on success and shows a run error.
describe("RebaseDialog start", () => {
  it("should run the initial plan oldest first", async () => {
    const { props, user } = renderDialog();
    await list();
    await user.click(start());
    expect(props.run).toHaveBeenCalledExactlyOnceWith({
      action: "rebaseInteractive",
      base: "main",
      steps: [
        { action: "pick", oid: full("a") },
        { action: "pick", oid: full("b") },
        { action: "pick", oid: full("c") },
      ],
    });
  });

  it("should send the base git is given, not the label", async () => {
    const { props, user } = renderDialog({ base: full("f"), label: "fffffff" });
    await list();
    await user.click(start());
    expect(vi.mocked(props.run).mock.calls[0]?.[0]).toMatchObject({ base: full("f") });
  });

  it("should reflect a chosen action in the run request", async () => {
    const { props, user } = renderDialog();
    await list();
    await user.selectOptions(selectOf("c"), "drop");
    await user.click(start());
    expect(vi.mocked(props.run).mock.calls[0]?.[0]).toMatchObject({
      steps: [
        { action: "pick", oid: full("a") },
        { action: "pick", oid: full("b") },
        { action: "drop", oid: full("c") },
      ],
    });
  });

  it("should reflect a reorder in the run request", async () => {
    const { props, user } = renderDialog();
    await list();
    await user.click(within(rowOf("c")).getByRole("button", { name: "Move down" }));
    await user.click(start());
    expect(vi.mocked(props.run).mock.calls[0]?.[0]).toMatchObject({
      steps: [
        { action: "pick", oid: full("a") },
        { action: "pick", oid: full("c") },
        { action: "pick", oid: full("b") },
      ],
    });
  });

  it("should close the dialog when the run succeeds", async () => {
    const { props, user } = renderDialog();
    await list();
    await user.click(start());
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
  });

  it("should keep the dialog open and show the error when the run fails", async () => {
    const run = vi.fn<RebaseDialogProps["run"]>().mockResolvedValue({
      kind: "operationFailed",
      message: "git said no",
    });
    const { props, user } = renderDialog({ run });
    await list();
    await user.click(start());
    expect(await screen.findByRole("alert")).toHaveTextContent("git said no");
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("should remove the run error when it is dismissed", async () => {
    const run = vi.fn<RebaseDialogProps["run"]>().mockResolvedValue({
      kind: "operationFailed",
      message: "git said no",
    });
    const { user } = renderDialog({ run });
    await list();
    await user.click(start());
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("should keep the plan after a failed run", async () => {
    const run = vi.fn<RebaseDialogProps["run"]>().mockResolvedValue({
      kind: "operationFailed",
      message: "git said no",
    });
    const { user } = renderDialog({ run });
    await list();
    await user.selectOptions(selectOf("b"), "squash");
    await user.click(start());
    await screen.findByRole("alert");
    expect(selectOf("b")).toHaveValue("squash");
  });
});

// Contract: while pending the plan is frozen and Start reads Working….
describe("RebaseDialog pending", () => {
  it("should read Working… on the disabled Start button", async () => {
    renderDialog({ pending: true });
    await list();
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
  });

  it("should disable the action selects", async () => {
    renderDialog({ pending: true });
    await list();
    expect(selectOf("b")).toBeDisabled();
  });

  it("should disable the move buttons", async () => {
    renderDialog({ pending: true });
    await list();
    expect(within(rowOf("b")).getByRole("button", { name: "Move up" })).toBeDisabled();
  });

  it("should not make the rows draggable", async () => {
    renderDialog({ pending: true });
    await list();
    expect(rowOf("b")).not.toHaveAttribute("draggable", "true");
  });
});

// Contract: Move up / Move down reorder the plan and keep keyboard focus on the moved commit.
describe("RebaseDialog keyboard reorder", () => {
  it("should move a commit down when its Move down is clicked", async () => {
    const { user } = renderDialog();
    await list();
    await user.click(within(rowOf("c")).getByRole("button", { name: "Move down" }));
    expect(order()).toBe("bca");
  });

  it("should move a commit up when its Move up is clicked", async () => {
    const { user } = renderDialog();
    await list();
    await user.click(within(rowOf("a")).getByRole("button", { name: "Move up" }));
    expect(order()).toBe("cab");
  });

  it("should keep focus on the moved commit's Move down button", async () => {
    const { user } = renderDialog();
    await list();
    await user.click(within(rowOf("c")).getByRole("button", { name: "Move down" }));
    expect(within(rowOf("c")).getByRole("button", { name: "Move down" })).toHaveFocus();
  });

  it("should keep focus on the moved commit's Move up button", async () => {
    const { user } = renderDialog();
    await list();
    await user.click(within(rowOf("a")).getByRole("button", { name: "Move up" }));
    expect(within(rowOf("a")).getByRole("button", { name: "Move up" })).toHaveFocus();
  });

  it("should leave the other rows' actions in place after a move", async () => {
    const { user } = renderDialog();
    await list();
    await user.selectOptions(selectOf("a"), "drop");
    await user.click(within(rowOf("c")).getByRole("button", { name: "Move down" }));
    expect(selectOf("a")).toHaveValue("drop");
  });
});

// Contract: dragging a row onto another moves it there.
describe("RebaseDialog drag and drop", () => {
  it("should move the dragged row to the drop position", async () => {
    renderDialog();
    await list();
    fireEvent.dragStart(rows()[0] as HTMLElement, { dataTransfer: fakeTransfer() });
    fireEvent.dragOver(rows()[2] as HTMLElement, { dataTransfer: fakeTransfer() });
    fireEvent.drop(rows()[2] as HTMLElement);
    expect(order()).toBe("bac");
  });

  it("should move a row upward on drop", async () => {
    renderDialog();
    await list();
    fireEvent.dragStart(rows()[2] as HTMLElement, { dataTransfer: fakeTransfer() });
    fireEvent.dragOver(rows()[0] as HTMLElement, { dataTransfer: fakeTransfer() });
    fireEvent.drop(rows()[0] as HTMLElement);
    expect(order()).toBe("acb");
  });

  it("should mark the dragged row and the row under the pointer", async () => {
    renderDialog();
    await list();
    fireEvent.dragStart(rows()[0] as HTMLElement, { dataTransfer: fakeTransfer() });
    fireEvent.dragOver(rows()[2] as HTMLElement, { dataTransfer: fakeTransfer() });
    expect([rows()[0], rows()[2]].map((r) => [r?.dataset.dragging, r?.dataset.dropTarget])).toEqual(
      [
        ["true", undefined],
        [undefined, "true"],
      ],
    );
  });

  it("should clear the markers after a drop", async () => {
    renderDialog();
    await list();
    fireEvent.dragStart(rows()[0] as HTMLElement, { dataTransfer: fakeTransfer() });
    fireEvent.dragOver(rows()[2] as HTMLElement, { dataTransfer: fakeTransfer() });
    fireEvent.drop(rows()[2] as HTMLElement);
    expect(rows().filter((r) => r.dataset.dragging || r.dataset.dropTarget)).toEqual([]);
  });

  it("should not reorder when a row is dragged over without a drag start", async () => {
    renderDialog();
    await list();
    fireEvent.dragOver(rows()[1] as HTMLElement, { dataTransfer: fakeTransfer() });
    fireEvent.drop(rows()[1] as HTMLElement);
    expect(order()).toBe("cba");
  });

  it("should not highlight a row dragged over without a drag start", async () => {
    renderDialog();
    await list();
    fireEvent.dragOver(rows()[1] as HTMLElement, { dataTransfer: fakeTransfer() });
    expect(rows().filter((r) => r.dataset.dropTarget)).toEqual([]);
  });

  it("should clear the drag state when the drag ends without a drop", async () => {
    renderDialog();
    await list();
    fireEvent.dragStart(rows()[0] as HTMLElement, { dataTransfer: fakeTransfer() });
    fireEvent.dragOver(rows()[2] as HTMLElement, { dataTransfer: fakeTransfer() });
    fireEvent.dragEnd(screen.getByRole("list", { name: "Commits to rebase" }));
    expect(rows().filter((r) => r.dataset.dragging || r.dataset.dropTarget)).toEqual([]);
  });

  it("should not reorder when the drag ends without a drop", async () => {
    renderDialog();
    await list();
    fireEvent.dragStart(rows()[0] as HTMLElement, { dataTransfer: fakeTransfer() });
    fireEvent.dragEnd(screen.getByRole("list", { name: "Commits to rebase" }));
    expect(order()).toBe("cba");
  });

  it("should ignore a drop after the drag ended", async () => {
    renderDialog();
    await list();
    fireEvent.dragStart(rows()[0] as HTMLElement, { dataTransfer: fakeTransfer() });
    fireEvent.dragEnd(screen.getByRole("list", { name: "Commits to rebase" }));
    fireEvent.drop(rows()[2] as HTMLElement);
    expect(order()).toBe("cba");
  });
});

// Contract: a fold needs a kept commit below it; Start stays disabled while one lacks it.
describe("RebaseDialog blocked fold", () => {
  async function blockTheSquash() {
    const view = renderDialog();
    await list();
    await view.user.selectOptions(selectOf("a"), "drop");
    await view.user.selectOptions(selectOf("b"), "squash");
    return view;
  }

  it("should alert on a squash with no kept commit below it", async () => {
    await blockTheSquash();
    expect(within(rowOf("b")).getByRole("alert")).toHaveTextContent(
      "Cannot squash the oldest commit",
    );
  });

  it("should disable Start while a fold is blocked", async () => {
    await blockTheSquash();
    expect(start()).toBeDisabled();
  });

  it("should clear the alert and enable Start once a kept commit is below the squash", async () => {
    const { user } = await blockTheSquash();
    await user.click(within(rowOf("b")).getByRole("button", { name: "Move up" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(start()).toBeEnabled();
  });

  it("should disable Start when every commit is dropped", async () => {
    const { user } = renderDialog();
    await list();
    for (const c of ["a", "b", "c"]) await user.selectOptions(selectOf(c), "drop");
    expect(start()).toBeDisabled();
  });

  it("should not run anything when Start is disabled", async () => {
    const { props, user } = await blockTheSquash();
    await user.click(start());
    expect(props.run).not.toHaveBeenCalled();
  });
});

// Contract: a refetch that changes the commit list resets the plan; the same list keeps it.
describe("RebaseDialog refetch", () => {
  it("should reset the plan and follow the new commits when the list changes", async () => {
    const { queryClient, user } = renderDialog();
    await list();
    await user.selectOptions(selectOf("b"), "squash");
    vi.mocked(rebasePlan).mockResolvedValue([commit("d"), commit("e")]);
    await queryClient.invalidateQueries({ queryKey: queryKeys.rebasePlan(4, "main") });
    await waitFor(() => expect(order()).toBe("ed"));
    expect(selectOf("e")).toHaveValue("pick");
  });

  it("should keep the user's edits when the refetch returns the same commits", async () => {
    const { queryClient, user } = renderDialog();
    await list();
    await user.selectOptions(selectOf("b"), "squash");
    vi.mocked(rebasePlan).mockClear();
    await queryClient.invalidateQueries({ queryKey: queryKeys.rebasePlan(4, "main") });
    await waitFor(() => expect(rebasePlan).toHaveBeenCalledOnce());
    expect(selectOf("b")).toHaveValue("squash");
  });

  it("should keep the user's reorder when the refetch returns the same commits", async () => {
    const { queryClient, user } = renderDialog();
    await list();
    await user.click(within(rowOf("c")).getByRole("button", { name: "Move down" }));
    vi.mocked(rebasePlan).mockClear();
    await queryClient.invalidateQueries({ queryKey: queryKeys.rebasePlan(4, "main") });
    await waitFor(() => expect(rebasePlan).toHaveBeenCalledOnce());
    expect(order()).toBe("bca");
  });
});

// Contract: Start sends exactly what the plan shows, oldest first, whatever way it was edited.
describe("RebaseDialog start payload", () => {
  const failure: AppError = { kind: "operationFailed", message: "git said no" };

  it("should send every action kind in git's order for a mixed plan", async () => {
    vi.mocked(rebasePlan).mockResolvedValue([commit("a"), commit("b"), commit("c"), commit("d")]);
    const { props, user } = renderDialog();
    await list();
    await user.selectOptions(selectOf("b"), "squash");
    await user.selectOptions(selectOf("c"), "drop");
    await user.selectOptions(selectOf("d"), "edit");
    await user.click(start());
    expect(props.run).toHaveBeenCalledExactlyOnceWith({
      action: "rebaseInteractive",
      base: "main",
      steps: [
        { action: "pick", oid: full("a") },
        { action: "squash", oid: full("b") },
        { action: "drop", oid: full("c") },
        { action: "edit", oid: full("d") },
      ],
    });
  });

  it("should send a fixup step", async () => {
    const { props, user } = renderDialog();
    await list();
    await user.selectOptions(selectOf("b"), "fixup");
    await user.click(start());
    expect(vi.mocked(props.run).mock.calls[0]?.[0]).toMatchObject({
      steps: [
        { action: "pick", oid: full("a") },
        { action: "fixup", oid: full("b") },
        { action: "pick", oid: full("c") },
      ],
    });
  });

  it("should send the order produced by a drag, not only by the move buttons", async () => {
    const { props, user } = renderDialog();
    await list();
    fireEvent.dragStart(rowOf("c"), { dataTransfer: fakeTransfer() });
    fireEvent.dragOver(rowOf("a"), { dataTransfer: fakeTransfer() });
    fireEvent.drop(rowOf("a"));
    await user.click(start());
    expect(vi.mocked(props.run).mock.calls[0]?.[0]).toMatchObject({
      steps: [
        { action: "pick", oid: full("c") },
        { action: "pick", oid: full("a") },
        { action: "pick", oid: full("b") },
      ],
    });
  });

  it("should send an action chosen before a move with the moved commit", async () => {
    const { props, user } = renderDialog();
    await list();
    await user.selectOptions(selectOf("c"), "squash");
    await user.click(within(rowOf("c")).getByRole("button", { name: "Move down" }));
    await user.click(start());
    expect(vi.mocked(props.run).mock.calls[0]?.[0]).toMatchObject({
      steps: [
        { action: "pick", oid: full("a") },
        { action: "squash", oid: full("c") },
        { action: "pick", oid: full("b") },
      ],
    });
  });

  it("should start again after a failed run was dismissed and close on success", async () => {
    const run = vi
      .fn<RebaseDialogProps["run"]>()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(null);
    const { props, user } = renderDialog({ run });
    await list();
    await user.selectOptions(selectOf("b"), "drop");
    await user.click(start());
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    await user.click(start());
    await waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toEqual(run.mock.calls[0]?.[0]);
  });

  it("should show the newest error when a second run also fails", async () => {
    const run = vi
      .fn<RebaseDialogProps["run"]>()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce({ kind: "operationFailed", message: "still no" });
    const { user } = renderDialog({ run });
    await list();
    await user.click(start());
    await screen.findByText(/git said no/);
    await user.click(start());
    expect(await screen.findByText(/still no/)).toBeInTheDocument();
    expect(screen.queryByText(/git said no/)).not.toBeInTheDocument();
  });

  it("should let a squash be sent after the blocking commit is moved out of the way", async () => {
    const { props, user } = renderDialog();
    await list();
    await user.selectOptions(selectOf("a"), "squash");
    expect(start()).toBeDisabled();
    await user.click(within(rowOf("a")).getByRole("button", { name: "Move up" }));
    await user.click(start());
    expect(vi.mocked(props.run).mock.calls[0]?.[0]).toMatchObject({
      steps: [
        { action: "pick", oid: full("b") },
        { action: "squash", oid: full("a") },
        { action: "pick", oid: full("c") },
      ],
    });
  });
});
