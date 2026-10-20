import { screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppError,
  BranchList,
  OperationState,
  StatusEntry,
  WorkingTreeStatus,
} from "../../lib/ipc";
import { renderWithProviders } from "../../test/renderWithProviders";
import { useBranches } from "../branches/useBranches";
import { useStatus } from "../worktree/useStatus";
import { OperationBanner } from "./OperationBanner";
import { useIntegrationActions } from "./useIntegrationActions";
import type { UseIntegrationActions } from "./useIntegrationActions";
import { useOperationState } from "./useOperationState";

vi.mock("./useOperationState", () => ({ useOperationState: vi.fn() }));
vi.mock("./useIntegrationActions", () => ({ useIntegrationActions: vi.fn() }));
vi.mock("../branches/useBranches", () => ({ useBranches: vi.fn() }));
vi.mock("../worktree/useStatus", () => ({ useStatus: vi.fn() }));

const message = { subject: "s", body: "" };
const oid = (c: string) => c.repeat(40);

const mergeState: OperationState = {
  kind: "merge",
  head: oid("a"),
  branch: "feature",
  message,
};
const rebaseState: OperationState = {
  kind: "rebase",
  onto: oid("b"),
  ontoName: "main",
  branch: "feature",
  step: 2,
  total: 5,
  stoppedForEdit: false,
};
const pickState: OperationState = { kind: "cherryPick", oid: oid("c"), message };
const revertState: OperationState = { kind: "revert", oid: oid("d"), message };

const run = vi.fn<UseIntegrationActions["run"]>();
const clearError = vi.fn();

function provide(opts: {
  state?: OperationState | undefined;
  conflicts?: number;
  pending?: boolean;
  error?: AppError | null;
  head?: BranchList["head"];
  noBranches?: boolean;
  noStatus?: boolean;
}) {
  const { state, conflicts = 0, pending = false, error = null } = opts;
  vi.mocked(useOperationState).mockReturnValue({
    state,
    error: null,
    refetch: vi.fn(),
  });
  const entries: StatusEntry[] = Array.from({ length: conflicts }, (_, i) => ({
    path: `f${i}.txt`,
    oldPath: null,
    index: null,
    worktree: "conflicted",
    conflicted: true,
  }));
  const status: WorkingTreeStatus = { entries, headUnborn: false } as WorkingTreeStatus;
  vi.mocked(useStatus).mockReturnValue({
    status: opts.noStatus ? undefined : status,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  vi.mocked(useBranches).mockReturnValue({
    branches: opts.noBranches
      ? undefined
      : { head: opts.head ?? { kind: "branch", name: "main" }, local: [], remotes: [] },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
  vi.mocked(useIntegrationActions).mockReturnValue({ run, pending, error, clearError });
}

beforeEach(() => {
  vi.resetAllMocks();
  run.mockResolvedValue(null);
});

// Contract: nothing renders until an operation is in progress.
describe("OperationBanner visibility", () => {
  it("should render nothing while the state is loading", () => {
    provide({ state: undefined });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.queryByRole("region", { name: "Operation in progress" })).toBeNull();
  });

  it("should render nothing when no operation is in progress", () => {
    provide({ state: { kind: "none" } });
    const { container } = renderWithProviders(<OperationBanner repoId={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("should expose a labelled region while an operation is in progress", () => {
    provide({ state: mergeState });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("region", { name: "Operation in progress" })).toBeInTheDocument();
  });

  it("should pass the repo id to the state hook", () => {
    provide({ state: mergeState });
    renderWithProviders(<OperationBanner repoId={7} />);
    expect(useOperationState).toHaveBeenCalledWith(7);
  });
});

// Contract: titles per spec 5.6 with the conflict suffix.
describe("OperationBanner titles", () => {
  it("should title a merge with its branch and the conflict count", () => {
    provide({ state: mergeState, conflicts: 1 });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByText("Merging feature into main, 1 conflict remaining")).toBeInTheDocument();
  });

  it("should title a merge with no conflicts remaining", () => {
    provide({ state: mergeState, conflicts: 0 });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(
      screen.getByText("Merging feature into main, no conflicts remaining"),
    ).toBeInTheDocument();
  });

  it("should use HEAD as the current name when the head is detached", () => {
    provide({ state: mergeState, head: { kind: "detached", oid: oid("e") } });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(
      screen.getByText("Merging feature into HEAD, no conflicts remaining"),
    ).toBeInTheDocument();
  });

  it("should read HEAD while the branches are not loaded", () => {
    provide({ state: mergeState, noBranches: true });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(
      screen.getByText("Merging feature into HEAD, no conflicts remaining"),
    ).toBeInTheDocument();
  });

  it("should count no conflicts while the status is not loaded", () => {
    provide({ state: mergeState, noStatus: true });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(
      screen.getByText("Merging feature into main, no conflicts remaining"),
    ).toBeInTheDocument();
  });

  it("should name the merged commit by short oid when the branch is unknown", () => {
    provide({ state: { ...mergeState, branch: null } as OperationState });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(
      screen.getByText("Merging aaaaaaa into main, no conflicts remaining"),
    ).toBeInTheDocument();
  });

  it("should title a rebase with its step and plural conflicts", () => {
    provide({ state: rebaseState, conflicts: 2 });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(
      screen.getByText("Rebasing feature onto main, step 2 of 5, 2 conflicts remaining"),
    ).toBeInTheDocument();
  });

  it("should title a cherry-pick with the short oid", () => {
    provide({ state: pickState, conflicts: 1 });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByText("Cherry-picking ccccccc, 1 conflict remaining")).toBeInTheDocument();
  });

  it("should title a revert with the short oid", () => {
    provide({ state: revertState, conflicts: 0 });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByText("Reverting ddddddd, no conflicts remaining")).toBeInTheDocument();
  });
});

// Contract: Abort… asks first, then runs abort.
describe("OperationBanner abort", () => {
  it("should offer Abort… in every operation", () => {
    provide({ state: pickState });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("button", { name: "Abort…" })).toBeEnabled();
  });

  it("should not run abort before the dialog is confirmed", async () => {
    provide({ state: mergeState });
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Abort…" }));
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    [mergeState, "Abort merge?"],
    [rebaseState, "Abort rebase?"],
    [pickState, "Abort cherry-pick?"],
    [revertState, "Abort revert?"],
  ] as const)("should open a dialog titled for %j", async (state, title) => {
    provide({ state });
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Abort…" }));
    expect(screen.getByRole("dialog", { name: title })).toBeInTheDocument();
  });

  it("should describe what abort does in the dialog body", async () => {
    provide({ state: mergeState });
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Abort…" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "The working tree and index return to their state before the operation started. Resolved conflicts are lost.",
    );
  });

  it("should close the dialog without aborting when Cancel is clicked", async () => {
    provide({ state: mergeState });
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Abort…" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("should run abort when the dialog is confirmed", async () => {
    provide({ state: mergeState });
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Abort…" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Abort" }));
    expect(run).toHaveBeenCalledExactlyOnceWith({ action: "abort" });
  });

  it("should close the dialog once abort has run", async () => {
    provide({ state: mergeState });
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Abort…" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Abort" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// Contract: a rebase resumes with Continue once no conflicts remain.
describe("OperationBanner rebase continue", () => {
  it("should disable Continue with a reason while conflicts remain", () => {
    provide({ state: rebaseState, conflicts: 1 });
    renderWithProviders(<OperationBanner repoId={1} />);
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Resolve all conflicts first");
  });

  it("should not call run when the disabled Continue is clicked", async () => {
    provide({ state: rebaseState, conflicts: 2 });
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(run).not.toHaveBeenCalled();
  });

  it("should enable Continue at zero conflicts and run continue", async () => {
    provide({ state: rebaseState, conflicts: 0 });
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(run).toHaveBeenCalledExactlyOnceWith({ action: "continue" });
  });

  it("should disable Continue while an action is pending", () => {
    provide({ state: rebaseState, conflicts: 0, pending: true });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("should offer no Go to commit during a rebase", () => {
    provide({ state: rebaseState });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.queryByRole("button", { name: "Go to commit" })).toBeNull();
  });
});

// Contract: the other operations finish through the commit box.
describe("OperationBanner go to commit", () => {
  it.each([[mergeState], [pickState], [revertState]])(
    "should offer Go to commit and no Continue for %j",
    (state) => {
      provide({ state });
      renderWithProviders(<OperationBanner repoId={1} />);
      expect(screen.getByRole("button", { name: "Go to commit" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    },
  );

  it("should disable Go to commit while conflicts remain", () => {
    provide({ state: mergeState, conflicts: 1 });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("button", { name: "Go to commit" })).toBeDisabled();
  });

  it("should focus the commit subject input when Go to commit is clicked", async () => {
    provide({ state: mergeState });
    const { user } = renderWithProviders(
      <>
        <input id="commit-subject" aria-label="Subject" />
        <OperationBanner repoId={1} />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Go to commit" }));
    expect(screen.getByLabelText("Subject")).toHaveFocus();
  });

  it("should not throw when there is no commit subject input", async () => {
    provide({ state: mergeState });
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Go to commit" }));
    expect(run).not.toHaveBeenCalled();
  });
});

// Contract: failures and busy state show in the banner.
describe("OperationBanner feedback", () => {
  const error: AppError = { kind: "operationFailed", message: "hook refused the merge" };

  it("should show a failed action's message in an alert", () => {
    provide({ state: mergeState, error });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("alert")).toHaveTextContent("hook refused the merge");
  });

  it("should show no alert without an error", () => {
    provide({ state: mergeState });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should clear the error when Dismiss is clicked", async () => {
    provide({ state: mergeState, error });
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(clearError).toHaveBeenCalledOnce();
  });

  it("should be aria-busy while an action is pending", () => {
    provide({ state: mergeState, pending: true });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("region", { name: "Operation in progress" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("should not be aria-busy when idle", () => {
    provide({ state: mergeState, pending: false });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("region", { name: "Operation in progress" })).not.toHaveAttribute(
      "aria-busy",
    );
  });
});

// Coverage audit: behaviours the first round left unpinned.
describe("OperationBanner busy and error handling", () => {
  const error: AppError = { kind: "operationFailed", message: "hook refused" };

  it("should disable Abort… while an action is pending", () => {
    provide({ state: mergeState, pending: true });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("button", { name: "Abort…" })).toBeDisabled();
  });

  it("should clear a previous error when Abort… is opened", async () => {
    provide({ state: mergeState, error });
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Abort…" }));
    expect(clearError).toHaveBeenCalledOnce();
  });

  it("should close the dialog when abort fails", async () => {
    run.mockResolvedValue(error);
    provide({ state: mergeState });
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Abort…" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Abort" }));
    expect(run).toHaveBeenCalledExactlyOnceWith({ action: "abort" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("should show the dialog as working and keep Cancel disabled while abort is pending", async () => {
    provide({ state: mergeState });
    const { user, rerender } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Abort…" }));
    provide({ state: mergeState, pending: true });
    rerender(<OperationBanner repoId={1} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("should show an error and its message together with the dialog closed", () => {
    provide({ state: rebaseState, error });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("alert")).toHaveTextContent("hook refused");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("OperationBanner conflict gating details", () => {
  it("should give Go to commit the resolve-first reason while conflicts remain", () => {
    provide({ state: mergeState, conflicts: 2 });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("button", { name: "Go to commit" })).toHaveAttribute(
      "title",
      "Resolve all conflicts first",
    );
  });

  it("should give Go to commit and Continue no title at zero conflicts", () => {
    provide({ state: mergeState });
    const { unmount } = renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("button", { name: "Go to commit" })).not.toHaveAttribute("title");
    unmount();
    provide({ state: rebaseState });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("button", { name: "Continue" })).not.toHaveAttribute("title");
  });

  it("should not run anything when the disabled Go to commit is clicked", async () => {
    provide({ state: mergeState, conflicts: 1 });
    const { user } = renderWithProviders(
      <>
        <input id="commit-subject" aria-label="Subject" />
        <OperationBanner repoId={1} />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Go to commit" }));
    expect(screen.getByLabelText("Subject")).not.toHaveFocus();
  });

  it("should count only conflicted entries", () => {
    provide({ state: mergeState });
    vi.mocked(useStatus).mockReturnValue({
      status: {
        headUnborn: false,
        entries: [
          { path: "a", oldPath: null, index: null, worktree: "conflicted", conflicted: true },
          { path: "b", oldPath: null, index: null, worktree: "modified", conflicted: false },
          { path: "c", oldPath: null, index: "added", worktree: null, conflicted: false },
        ],
      } as WorkingTreeStatus,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByText(/1 conflict remaining/)).toBeInTheDocument();
  });

  it("should enable Continue when the only entries are not conflicted", () => {
    provide({ state: rebaseState });
    vi.mocked(useStatus).mockReturnValue({
      status: {
        headUnborn: false,
        entries: [
          { path: "b", oldPath: null, index: null, worktree: "modified", conflicted: false },
        ],
      } as WorkingTreeStatus,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });
});

describe("OperationBanner state transitions", () => {
  it("should appear when the state arrives and disappear when the operation ends", () => {
    provide({ state: undefined });
    const { rerender } = renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.queryByRole("region")).toBeNull();
    provide({ state: mergeState });
    rerender(<OperationBanner repoId={1} />);
    expect(screen.getByRole("region", { name: "Operation in progress" })).toBeInTheDocument();
    provide({ state: { kind: "none" } });
    rerender(<OperationBanner repoId={1} />);
    expect(screen.queryByRole("region")).toBeNull();
  });
});

// Contract: a failed action and an open dialog belong to one operation and never carry over.
describe("OperationBanner failed abort and pending", () => {
  const failure: AppError = { kind: "operationFailed", message: "abort refused" };

  it("should close the dialog and show the error when abort fails", async () => {
    provide({ state: mergeState, error: failure });
    run.mockResolvedValue(failure);
    const { user } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Abort…" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Abort" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("abort refused");
  });

  it("should disable Abort… while an action is pending", () => {
    provide({ state: mergeState, pending: true });
    renderWithProviders(<OperationBanner repoId={1} />);
    expect(screen.getByRole("button", { name: "Abort…" })).toBeDisabled();
  });
});

describe("OperationBanner across operations", () => {
  const failure: AppError = { kind: "operationFailed", message: "hook refused" };

  // A stateful stand-in: each mount of the component using it starts without an error.
  function useFakeActions(): UseIntegrationActions {
    const [error, setError] = useState<AppError | null>(null);
    return {
      run: () => {
        setError(failure);
        return Promise.resolve(failure);
      },
      pending: false,
      error,
      clearError: () => setError(null),
    };
  }

  function setState(state: OperationState) {
    vi.mocked(useOperationState).mockReturnValue({ state, error: null, refetch: vi.fn() });
  }

  it("should not show a previous operation's error for the next one", async () => {
    provide({ state: mergeState });
    vi.mocked(useIntegrationActions).mockImplementation(useFakeActions);
    const { user, rerender } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Abort…" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Abort" }));
    expect(screen.getByRole("alert")).toHaveTextContent("hook refused");
    setState({ kind: "none" });
    rerender(<OperationBanner repoId={1} />);
    setState(rebaseState);
    rerender(<OperationBanner repoId={1} />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should not keep an open Abort dialog for the next operation", async () => {
    provide({ state: mergeState });
    vi.mocked(useIntegrationActions).mockImplementation(useFakeActions);
    const { user, rerender } = renderWithProviders(<OperationBanner repoId={1} />);
    await user.click(screen.getByRole("button", { name: "Abort…" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    setState({ kind: "none" });
    rerender(<OperationBanner repoId={1} />);
    setState(rebaseState);
    rerender(<OperationBanner repoId={1} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
