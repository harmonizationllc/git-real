import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostingCreatePullRequest,
  hostingPullRequestDraft,
  hostingRepoContext,
  hostingRepoInfo,
  listBranches,
  listRemotes,
  openExternal,
} from "../../lib/ipc";
import type { BranchList, HeadState, Tracking } from "../../lib/ipc";
import { useToasts } from "../../lib/store/toasts";
import {
  hostingAccount,
  hostingError,
  prDraft,
  pullRequest,
  repoContext,
  repoInfo,
} from "../../test/hostingFixtures";
import { oidOf } from "../../test/graphFixtures";
import { authError, networkError, remoteInfo } from "../../test/remoteFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { networkMessage } from "../remotes/networkMessage";
import { CreatePullRequestDialog } from "./CreatePullRequestDialog";
import { PUBLISH_FIRST_TEXT, hostingErrorText } from "./hostingCopy";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listBranches: vi.fn(),
  listRemotes: vi.fn(),
  hostingRepoContext: vi.fn(),
  hostingRepoInfo: vi.fn(),
  hostingPullRequestDraft: vi.fn(),
  hostingCreatePullRequest: vi.fn(),
  openExternal: vi.fn(),
}));

const onClose = vi.fn();

const synced: Tracking = { upstream: "origin/feat", ahead: 0, behind: 0 };

/** HEAD on `feat` carrying `tracking`; origin has the given branches. */
function branchList(
  over: { tracking?: Tracking | null; origin?: string[] | null; head?: HeadState } = {},
): BranchList {
  const { tracking = synced, origin = ["main", "develop", "feat"] } = over;
  return {
    head: over.head ?? { kind: "branch", name: "feat" },
    local: [{ name: "feat", oid: oidOf(1), isHead: true, tracking }],
    remotes:
      origin === null
        ? []
        : [
            {
              remote: "origin",
              branches: origin.map((name) => ({ remote: "origin", name, oid: oidOf(2) })),
            },
          ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  useToasts.setState({ toasts: [] });
  vi.mocked(listBranches).mockResolvedValue(branchList());
  vi.mocked(listRemotes).mockResolvedValue([remoteInfo("origin")]);
  vi.mocked(hostingRepoContext).mockResolvedValue(repoContext());
  vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo());
  vi.mocked(hostingPullRequestDraft).mockResolvedValue(prDraft());
  vi.mocked(hostingCreatePullRequest).mockResolvedValue(
    pullRequest(124, { sourceBranch: "feat", targetBranch: "main" }),
  );
  vi.mocked(openExternal).mockResolvedValue(undefined);
});

const dialog = () => screen.getByRole("dialog", { name: "Create pull request" });
const title = () => screen.getByLabelText("Title") as HTMLInputElement;
const description = () => screen.getByLabelText("Description") as HTMLTextAreaElement;
const target = () => screen.getByLabelText("Target") as HTMLSelectElement;
const create = () => screen.getByRole("button", { name: "Create pull request" });
const targetOptions = () =>
  within(target())
    .getAllByRole("option")
    .map((o) => o.textContent);

/** Renders the dialog and waits until the form has mounted. */
async function renderForm() {
  const view = renderWithProviders(<CreatePullRequestDialog repoId={1} onClose={onClose} />);
  await screen.findByLabelText("Title");
  return view;
}

/** Renders the dialog and waits until the body has settled into something other than Loading…. */
async function renderSettled() {
  const view = renderWithProviders(<CreatePullRequestDialog repoId={1} onClose={onClose} />);
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  return view;
}

// Contract: a modal titled Create pull request that loads before it shows the form.
describe("CreatePullRequestDialog loading", () => {
  it("should be a modal dialog titled Create pull request", async () => {
    await renderForm();
    expect(dialog()).toHaveAttribute("aria-modal", "true");
  });

  it("should show Loading… while the branches have not loaded", () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<CreatePullRequestDialog repoId={1} onClose={onClose} />);
    expect(within(dialog()).getByText("Loading…")).toBeInTheDocument();
  });

  it("should show Loading… while the repository info has not loaded", () => {
    vi.mocked(hostingRepoInfo).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<CreatePullRequestDialog repoId={1} onClose={onClose} />);
    expect(within(dialog()).getByText("Loading…")).toBeInTheDocument();
  });

  it("should show Loading… while the draft has not loaded", async () => {
    vi.mocked(hostingPullRequestDraft).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<CreatePullRequestDialog repoId={1} onClose={onClose} />);
    await waitFor(() => expect(hostingPullRequestDraft).toHaveBeenCalled());
    expect(within(dialog()).getByText("Loading…")).toBeInTheDocument();
  });

  it("should show no form fields while loading", () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<CreatePullRequestDialog repoId={1} onClose={onClose} />);
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  it("should replace Loading… with the form", async () => {
    await renderForm();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("should focus the Title field when the form mounts", async () => {
    await renderForm();
    expect(title()).toHaveFocus();
  });
});

// Contract: Source is the HEAD branch; Target lists origin's other branches, default per provider.
describe("CreatePullRequestDialog source and target", () => {
  it("should show the HEAD branch as the Source", async () => {
    await renderForm();
    expect(screen.getByLabelText("Source")).toHaveValue("feat");
  });

  it("should not let the Source be edited", async () => {
    await renderForm();
    expect(screen.getByLabelText("Source")).toHaveAttribute("readonly");
  });

  it("should list origin's branches except the source as the Target options", async () => {
    await renderForm();
    expect(targetOptions()).toEqual(["main", "develop"]);
  });

  it("should select the provider's default branch as the Target", async () => {
    await renderForm();
    expect(target()).toHaveValue("main");
  });

  it("should select develop when that is the provider's default branch", async () => {
    vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo({ defaultBranch: "develop" }));
    await renderForm();
    expect(target()).toHaveValue("develop");
  });

  it("should request the draft for the default target", async () => {
    vi.mocked(hostingRepoInfo).mockResolvedValue(repoInfo({ defaultBranch: "develop" }));
    await renderForm();
    expect(hostingPullRequestDraft).toHaveBeenCalledExactlyOnceWith(1, "develop");
  });

  it("should leave the source out of the Target when it is the provider's default branch", async () => {
    vi.mocked(listBranches).mockResolvedValue({
      head: { kind: "branch", name: "main" },
      local: [
        {
          name: "main",
          oid: oidOf(1),
          isHead: true,
          tracking: { ...synced, upstream: "origin/main" },
        },
      ],
      remotes: [
        {
          remote: "origin",
          branches: ["main", "develop"].map((name) => ({ remote: "origin", name, oid: oidOf(2) })),
        },
      ],
    });
    await renderForm();
    expect(targetOptions()).toEqual(["develop"]);
    expect(target()).toHaveValue("develop");
    expect(hostingPullRequestDraft).toHaveBeenCalledExactlyOnceWith(1, "develop");
  });

  it("should leave the upstream's name out of the Target when it differs from the local name", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      branchList({
        tracking: { ...synced, upstream: "origin/renamed" },
        origin: ["main", "renamed"],
      }),
    );
    await renderForm();
    expect(targetOptions()).toEqual(["main"]);
  });

  it("should not refill the title or request another draft when the Target changes", async () => {
    const { user } = await renderForm();
    await user.clear(title());
    await user.type(title(), "Mine");
    await user.selectOptions(target(), "develop");
    expect(title()).toHaveValue("Mine");
    expect(hostingPullRequestDraft).toHaveBeenCalledOnce();
  });
});

// Contract: Title and Description start from the draft; Create needs a title.
describe("CreatePullRequestDialog fields", () => {
  it("should prefill the Title from the draft", async () => {
    await renderForm();
    expect(title()).toHaveValue("Add login");
  });

  it("should prefill the Description from the draft", async () => {
    await renderForm();
    expect(description()).toHaveValue("Why");
  });

  it("should leave Title and Description empty when the draft fails", async () => {
    vi.mocked(hostingPullRequestDraft).mockRejectedValue(hostingError("revisionNotFound"));
    await renderForm();
    expect([title().value, description().value]).toEqual(["", ""]);
  });

  it("should enable Create when the title is filled", async () => {
    await renderForm();
    expect(create()).toBeEnabled();
  });

  it("should disable Create while the title is blank", async () => {
    const { user } = await renderForm();
    await user.clear(title());
    expect(create()).toBeDisabled();
  });

  it("should keep Create disabled for a whitespace-only title", async () => {
    const { user } = await renderForm();
    await user.clear(title());
    await user.type(title(), "   ");
    expect(create()).toBeDisabled();
  });

  it("should disable Create when the draft failed and nothing was typed", async () => {
    vi.mocked(hostingPullRequestDraft).mockRejectedValue(hostingError("revisionNotFound"));
    await renderForm();
    expect(create()).toBeDisabled();
  });
});

// Contract: the push line depends on the branch's upstream: publish text, a checkbox, or nothing.
describe("CreatePullRequestDialog push line", () => {
  const checkbox = () => screen.queryByRole("checkbox");

  it("should say the branch will be published first when it has no upstream", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ tracking: null }));
    await renderForm();
    expect(within(dialog()).getByText(PUBLISH_FIRST_TEXT)).toBeInTheDocument();
  });

  it("should offer no push checkbox when the branch will be published", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ tracking: null }));
    await renderForm();
    expect(checkbox()).toBeNull();
  });

  it("should offer a checked Push 2 commits first checkbox when 2 commits are unpushed", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ tracking: { ...synced, ahead: 2 } }));
    await renderForm();
    expect(screen.getByRole("checkbox", { name: "Push 2 commits first" })).toBeChecked();
  });

  it("should word one unpushed commit in the singular", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ tracking: { ...synced, ahead: 1 } }));
    await renderForm();
    expect(screen.getByRole("checkbox", { name: "Push 1 commit first" })).toBeInTheDocument();
  });

  it("should not say the branch will be published when it is only ahead", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ tracking: { ...synced, ahead: 2 } }));
    await renderForm();
    expect(screen.queryByText(PUBLISH_FIRST_TEXT)).toBeNull();
  });

  it("should show neither the text nor a checkbox when the branch is level with its upstream", async () => {
    await renderForm();
    expect([screen.queryByText(PUBLISH_FIRST_TEXT), checkbox()]).toEqual([null, null]);
  });

  it("should publish when the upstream is gone", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      branchList({ tracking: { upstream: "origin/feat", ahead: null, behind: null } }),
    );
    await renderForm();
    expect(within(dialog()).getByText(PUBLISH_FIRST_TEXT)).toBeInTheDocument();
  });
});

// Contract: submit sends what was typed and chosen; a success closes the dialog.
describe("CreatePullRequestDialog submit", () => {
  it("should create with the typed title and description and the chosen target", async () => {
    const { user } = await renderForm();
    await user.clear(title());
    await user.type(title(), "Fix login");
    await user.clear(description());
    await user.type(description(), "Closes #1");
    await user.selectOptions(target(), "develop");
    await user.click(create());
    expect(hostingCreatePullRequest).toHaveBeenCalledExactlyOnceWith(
      1,
      {
        branch: "feat",
        push: null,
        pr: {
          title: "Fix login",
          body: "Closes #1",
          sourceBranch: "feat",
          targetBranch: "develop",
        },
      },
      null,
    );
  });

  it("should publish the branch first when it has no upstream", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ tracking: null }));
    const { user } = await renderForm();
    await user.click(create());
    expect(vi.mocked(hostingCreatePullRequest).mock.calls[0]?.[1].push).toEqual({
      kind: "setUpstream",
      remote: "origin",
      branch: "feat",
    });
  });

  it("should push to the upstream first when the checkbox is left checked", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ tracking: { ...synced, ahead: 2 } }));
    const { user } = await renderForm();
    await user.click(create());
    expect(vi.mocked(hostingCreatePullRequest).mock.calls[0]?.[1].push).toEqual({
      kind: "upstream",
    });
  });

  it("should not push when the checkbox is unchecked", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ tracking: { ...synced, ahead: 2 } }));
    const { user } = await renderForm();
    await user.click(screen.getByRole("checkbox", { name: "Push 2 commits first" }));
    await user.click(create());
    expect(vi.mocked(hostingCreatePullRequest).mock.calls[0]?.[1].push).toBeNull();
  });

  it("should close the dialog after the pull request is created", async () => {
    const { user } = await renderForm();
    await user.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("should show an Opened #124 toast after the pull request is created", async () => {
    const { user } = await renderForm();
    await user.click(create());
    await waitFor(() => expect(useToasts.getState().toasts[0]?.text).toBe("Opened #124"));
  });

  it("should not close the dialog before the call settles", async () => {
    vi.mocked(hostingCreatePullRequest).mockReturnValue(new Promise(() => undefined));
    const { user } = await renderForm();
    await user.click(create());
    await waitFor(() => expect(hostingCreatePullRequest).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should send nothing when Cancel is clicked", async () => {
    const { user } = await renderForm();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(hostingCreatePullRequest).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// Contract: a failure keeps the dialog open with its message; a cancelled sign-in is silent.
describe("CreatePullRequestDialog failures", () => {
  it("keeps the dialog open with the push error", async () => {
    const error = networkError("hostUnreachable", { verb: "push" }, "fatal: unable to access");
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(error);
    const { user } = await renderForm();
    await user.click(create());
    const alert = await within(dialog()).findByRole("alert");
    expect(alert).toHaveTextContent(networkMessage(error).title);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should push again when Create is clicked after a failure", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValueOnce(networkError("hostUnreachable"));
    const { user } = await renderForm();
    await user.click(create());
    await within(dialog()).findByRole("alert");
    await user.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(hostingCreatePullRequest).toHaveBeenCalledTimes(2);
  });

  it("should remove the error when it is dismissed", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(networkError("hostUnreachable"));
    const { user } = await renderForm();
    await user.click(create());
    const alert = await within(dialog()).findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });

  it("stays open without an error when the sign-in is cancelled", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(authError());
    const { user } = await renderForm();
    await user.click(create());
    const signIn = await screen.findByRole("dialog", { name: "Sign in to github.com" });
    await user.click(within(signIn).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Sign in/ })).toBeNull());
    expect(dialog()).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should retry with the typed credentials when the sign-in is submitted", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValueOnce(authError());
    const { user } = await renderForm();
    await user.click(create());
    const signIn = await screen.findByRole("dialog", { name: "Sign in to github.com" });
    await user.type(within(signIn).getByLabelText("Username"), "me");
    await user.type(within(signIn).getByLabelText("Token or password"), "tok");
    await user.click(within(signIn).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(hostingCreatePullRequest).toHaveBeenLastCalledWith(1, expect.anything(), {
      origin: "https://github.com",
      username: "me",
      token: "tok",
    });
  });

  it("shows the provider's message inline when the pull request is rejected", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(
      hostingError("hostingRejected", "A pull request already exists for feat."),
    );
    const { user } = await renderForm();
    await user.click(create());
    expect(
      await within(dialog()).findByText("A pull request already exists for feat."),
    ).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should show the hosting copy for a rejected token", async () => {
    const error = hostingError("hostingAuth");
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(error);
    const { user } = await renderForm();
    await user.click(create());
    expect(await within(dialog()).findByText(hostingErrorText(error, "github"))).toBeVisible();
  });

  it("should show no toast when the call fails", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(hostingError("hostingRejected"));
    const { user } = await renderForm();
    await user.click(create());
    await within(dialog()).findByRole("alert");
    expect(useToasts.getState().toasts).toEqual([]);
  });
});

// Contract: a repository-info failure is shown inline and the form still opens with target main.
describe("CreatePullRequestDialog repository info error", () => {
  const failing = hostingError("hostingUnreachable");

  beforeEach(() => {
    vi.mocked(hostingRepoInfo).mockRejectedValue(failing);
  });

  it("should show the hosting copy for the failure", async () => {
    await renderForm();
    expect(within(dialog()).getByText(hostingErrorText(failing, "github"))).toBeInTheDocument();
  });

  it("should still render the form", async () => {
    await renderForm();
    expect(title()).toBeInTheDocument();
  });

  it("should fall back to main as the Target", async () => {
    await renderForm();
    expect(target()).toHaveValue("main");
  });

  it("should request the draft for main", async () => {
    await renderForm();
    expect(hostingPullRequestDraft).toHaveBeenCalledExactlyOnceWith(1, "main");
  });
});

// Contract: with nothing to target or no branch to open from, the dialog explains and only closes.
describe("CreatePullRequestDialog nothing to open", () => {
  it("should say origin has no branches to target when it has none", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ origin: [] }));
    await renderSettled();
    expect(
      within(dialog()).getByText("origin has no branches to target. Fetch first."),
    ).toBeInTheDocument();
  });

  it("should say the same when there is no origin group at all", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ origin: null }));
    await renderSettled();
    expect(
      within(dialog()).getByText("origin has no branches to target. Fetch first."),
    ).toBeInTheDocument();
  });

  it("should offer only Close and no form when origin has no branches", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ origin: [] }));
    await renderSettled();
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("should close when Close is clicked", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ origin: [] }));
    const { user } = await renderSettled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should not request a draft when origin has no branches", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ origin: [] }));
    await renderSettled();
    expect(hostingPullRequestDraft).not.toHaveBeenCalled();
  });

  it("should ask to check out a branch when HEAD is detached", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      branchList({ head: { kind: "detached", oid: oidOf(1) } }),
    );
    await renderSettled();
    expect(
      within(dialog()).getByText("Check out a branch to open a pull request."),
    ).toBeInTheDocument();
  });

  it("should show no form and request no draft when HEAD is detached", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      branchList({ head: { kind: "detached", oid: oidOf(1) } }),
    );
    await renderSettled();
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(hostingPullRequestDraft).not.toHaveBeenCalled();
  });
});

// Contract: Escape cancels unless the call is in flight; the backdrop never closes.
describe("CreatePullRequestDialog dismissal", () => {
  it("should close on Escape when nothing is pending", async () => {
    await renderForm();
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should ignore Escape while the call is in flight", async () => {
    vi.mocked(hostingCreatePullRequest).mockReturnValue(new Promise(() => undefined));
    const { user } = await renderForm();
    await user.click(create());
    await waitFor(() => expect(hostingCreatePullRequest).toHaveBeenCalled());
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("should close on Escape while an error is showing", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(hostingError("hostingRejected"));
    const { user } = await renderForm();
    await user.click(create());
    await within(dialog()).findByRole("alert");
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("should not close when the backdrop is clicked", async () => {
    const { user } = await renderForm();
    await user.click(dialog().parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Contract: once the form is up, a refetch of the repository never remounts it or resets its state.
describe("CreatePullRequestDialog stability", () => {
  it("should keep typed text, Target options and the draft request after a failed create refreshes the branches", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValueOnce(hostingError("hostingRejected"));
    const { user } = await renderForm();
    await user.clear(title());
    await user.type(title(), "Mine");
    await user.selectOptions(target(), "develop");
    vi.mocked(listBranches).mockResolvedValue(
      branchList({ origin: ["main", "develop", "feat", "other"] }),
    );
    await user.click(create());
    await within(dialog()).findByRole("alert");
    await waitFor(() => expect(listBranches).toHaveBeenCalledTimes(2));
    expect(title()).toHaveValue("Mine");
    expect(target()).toHaveValue("develop");
    expect(targetOptions()).toEqual(["main", "develop"]);
    expect(hostingPullRequestDraft).toHaveBeenCalledOnce();
  });

  it("should stop announcing the publish and send no push on a retry once the branch is on origin", async () => {
    vi.mocked(listBranches).mockResolvedValue(branchList({ tracking: null }));
    vi.mocked(hostingCreatePullRequest).mockRejectedValueOnce(hostingError("hostingRejected"));
    const { user } = await renderForm();
    vi.mocked(listBranches).mockResolvedValue(branchList({ tracking: synced }));
    await user.click(create());
    await within(dialog()).findByRole("alert");
    await waitFor(() => expect(screen.queryByText(PUBLISH_FIRST_TEXT)).toBeNull());
    await user.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(vi.mocked(hostingCreatePullRequest).mock.calls[1]?.[1].push).toBeNull();
  });
});

// Contract: focus starts on Title, returns to Title after an error, and is held on the box while
// the call is in flight; the box is inert while a sign-in dialog is on top.
describe("CreatePullRequestDialog focus", () => {
  it("should focus the dialog box while it shows Loading…", () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<CreatePullRequestDialog repoId={1} onClose={onClose} />);
    expect(dialog()).toHaveFocus();
  });

  it("should return focus to the Title field after an error", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(hostingError("hostingRejected"));
    const { user } = await renderForm();
    await user.click(create());
    await within(dialog()).findByRole("alert");
    expect(title()).toHaveFocus();
  });

  it("should hold focus on the dialog box while the call is in flight", async () => {
    vi.mocked(hostingCreatePullRequest).mockReturnValue(new Promise(() => undefined));
    const { user } = await renderForm();
    await user.click(create());
    await waitFor(() => expect(dialog()).toHaveFocus());
  });

  it("should make the box inert while the sign-in dialog is open", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(authError());
    const { user } = await renderForm();
    await user.click(create());
    await screen.findByRole("dialog", { name: "Sign in to github.com" });
    expect(
      screen.getByRole("dialog", { name: "Create pull request", hidden: true }),
    ).toHaveAttribute("inert");
  });

  it("should not make the box inert while no sign-in is open", async () => {
    await renderForm();
    expect(dialog()).not.toHaveAttribute("inert");
  });
});

// Contract: while the call is in flight the form is read-only and says Creating….
describe("CreatePullRequestDialog while creating", () => {
  async function renderPending() {
    vi.mocked(listBranches).mockResolvedValue(branchList({ tracking: { ...synced, ahead: 2 } }));
    vi.mocked(hostingCreatePullRequest).mockReturnValue(new Promise(() => undefined));
    const view = await renderForm();
    await view.user.click(create());
    await waitFor(() => expect(hostingCreatePullRequest).toHaveBeenCalled());
    return view;
  }

  it("should disable the Target, Title, Description and push checkbox", async () => {
    await renderPending();
    expect(target()).toBeDisabled();
    expect(title()).toBeDisabled();
    expect(description()).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });

  it("should disable Cancel", async () => {
    await renderPending();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("should relabel the submit button Creating… and disable it", async () => {
    await renderPending();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Create pull request" })).toBeNull();
  });

  it("should keep the source read-only and unchanged", async () => {
    await renderPending();
    expect(screen.getByLabelText("Source")).toHaveValue("feat");
  });
});

// Contract: Enter in a field submits the form, but never with a blank title.
describe("CreatePullRequestDialog keyboard submit", () => {
  it("should create when Enter is pressed in the Title field", async () => {
    const { user } = await renderForm();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(hostingCreatePullRequest).toHaveBeenCalledOnce());
  });

  it("should not create when Enter is pressed with a blank title", async () => {
    const { user } = await renderForm();
    await user.clear(title());
    await user.keyboard("{Enter}");
    expect(hostingCreatePullRequest).not.toHaveBeenCalled();
  });
});

// Contract: the push line follows the upstream, whichever remote it is on and however far it lags.
describe("CreatePullRequestDialog push line edge cases", () => {
  it("should offer neither the text nor a checkbox when the upstream is only behind", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      branchList({ tracking: { ...synced, ahead: 0, behind: 3 } }),
    );
    await renderForm();
    expect([screen.queryByText(PUBLISH_FIRST_TEXT), screen.queryByRole("checkbox")]).toEqual([
      null,
      null,
    ]);
  });

  it("should publish and keep the local name out of the Target when the upstream is on another remote", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      branchList({
        tracking: { upstream: "fork/feat", ahead: 0, behind: 0 },
        origin: ["main", "feat"],
      }),
    );
    vi.mocked(listRemotes).mockResolvedValue([remoteInfo("origin"), remoteInfo("fork")]);
    await renderForm();
    expect(within(dialog()).getByText(PUBLISH_FIRST_TEXT)).toBeInTheDocument();
    expect(targetOptions()).toEqual(["main"]);
  });

  it("should publish and keep the local name out of the Target when the upstream is gone", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      branchList({
        tracking: { upstream: "origin/feat", ahead: null, behind: null },
        origin: ["main", "feat"],
      }),
    );
    await renderForm();
    expect(within(dialog()).getByText(PUBLISH_FIRST_TEXT)).toBeInTheDocument();
    expect(targetOptions()).toEqual(["main"]);
  });
});

// Contract: the form waits for every input and never opens on a missing hosting context.
describe("CreatePullRequestDialog waiting for inputs", () => {
  async function stayLoading() {
    renderWithProviders(<CreatePullRequestDialog repoId={1} onClose={onClose} />);
    await waitFor(() => expect(hostingRepoInfo).toHaveBeenCalled());
    await act(() => Promise.resolve());
    expect(within(dialog()).getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(hostingPullRequestDraft).not.toHaveBeenCalled();
  }

  it("should keep showing Loading… while the remotes have not loaded", async () => {
    vi.mocked(listRemotes).mockReturnValue(new Promise(() => undefined));
    await stayLoading();
  });

  it("should keep showing Loading… when the origin is not on a supported host", async () => {
    vi.mocked(hostingRepoContext).mockResolvedValue(null);
    await stayLoading();
  });

  it("should close on Escape while Loading…", () => {
    vi.mocked(listBranches).mockReturnValue(new Promise(() => undefined));
    renderWithProviders(<CreatePullRequestDialog repoId={1} onClose={onClose} />);
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

// Contract: an unborn HEAD is not a branch to open from, like a detached one.
describe("CreatePullRequestDialog unborn HEAD", () => {
  it("should ask to check out a branch and offer only Close", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      branchList({ head: { kind: "unborn", name: "main" } }),
    );
    await renderSettled();
    expect(
      within(dialog()).getByText("Check out a branch to open a pull request."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(hostingPullRequestDraft).not.toHaveBeenCalled();
  });
});

// Contract: the dialog keeps the branch it opened for, even when HEAD moves under it.
describe("CreatePullRequestDialog when HEAD moves", () => {
  it("should keep the Source and open the pull request from the original branch", async () => {
    vi.mocked(hostingCreatePullRequest).mockRejectedValueOnce(hostingError("hostingRejected"));
    const { user } = await renderForm();
    vi.mocked(listBranches).mockResolvedValue({
      head: { kind: "branch", name: "other" },
      local: [
        { name: "feat", oid: oidOf(1), isHead: false, tracking: synced },
        { name: "other", oid: oidOf(3), isHead: true, tracking: null },
      ],
      remotes: branchList().remotes,
    });
    await user.click(create());
    await within(dialog()).findByRole("alert");
    await waitFor(() => expect(listBranches).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("Source")).toHaveValue("feat");
    await user.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const request = vi.mocked(hostingCreatePullRequest).mock.calls[1]?.[1];
    expect([request?.branch, request?.pr.sourceBranch]).toEqual(["feat", "feat"]);
  });
});

// Contract: dismissing the repository info error asks again, without moving the chosen target.
describe("CreatePullRequestDialog repository info retry", () => {
  it("should ask again on Dismiss, clear the line and keep the fallback target", async () => {
    vi.mocked(hostingRepoInfo)
      .mockRejectedValueOnce(hostingError("hostingUnreachable"))
      .mockResolvedValue(repoInfo({ defaultBranch: "develop" }));
    const { user } = await renderForm();
    const alert = await within(dialog()).findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(within(dialog()).queryByRole("alert")).toBeNull());
    expect(hostingRepoInfo).toHaveBeenCalledTimes(2);
    expect(target()).toHaveValue("main");
    expect(hostingPullRequestDraft).toHaveBeenCalledOnce();
  });
});

// Contract: provider copy follows the repository's provider, not a fixed one.
describe("CreatePullRequestDialog provider copy", () => {
  const gitlab = () => {
    vi.mocked(hostingRepoContext).mockResolvedValue({
      repo: { provider: "gitlab", host: "gitlab.com", namespace: "g", name: "r" },
      account: hostingAccount({ provider: "gitlab", host: "gitlab.com" }),
    });
  };

  it("should name GitLab in the repository info error", async () => {
    gitlab();
    const failing = hostingError("hostingUnreachable");
    vi.mocked(hostingRepoInfo).mockRejectedValue(failing);
    await renderForm();
    expect(within(dialog()).getByText(hostingErrorText(failing, "gitlab"))).toBeInTheDocument();
  });

  it("should name GitLab in a rejected token error from the create call", async () => {
    gitlab();
    const rejected = hostingError("hostingAuth");
    vi.mocked(hostingCreatePullRequest).mockRejectedValue(rejected);
    const { user } = await renderForm();
    await user.click(create());
    expect(await within(dialog()).findByText(hostingErrorText(rejected, "gitlab"))).toBeVisible();
  });
});
