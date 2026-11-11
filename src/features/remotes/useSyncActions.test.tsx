import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAll,
  getOperationState,
  listBranches,
  listRemotes,
  pull,
  pullDefaultMode,
  push,
} from "../../lib/ipc";
import type { OperationState, Tracking } from "../../lib/ipc";
import { authError, networkError, remoteInfo, trackedList } from "../../test/remoteFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { queryKeys } from "../../lib/query/keys";
import { useAutoFetchState } from "../../lib/store/autoFetch";
import { useRepoTabs } from "../../lib/store/repoTabs";
import { pausesAutoFetch, useSyncActions } from "./useSyncActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listBranches: vi.fn(),
  listRemotes: vi.fn(),
  pullDefaultMode: vi.fn(),
  fetchAll: vi.fn(),
  getOperationState: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
}));

const origin: Tracking = { upstream: "origin/main", ahead: 0, behind: 0 };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<undefined>((res) => {
    resolve = () => res(undefined);
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  useAutoFetchState.setState({ repos: {} });
  vi.mocked(listBranches).mockResolvedValue(trackedList(origin));
  vi.mocked(listRemotes).mockResolvedValue([remoteInfo("origin")]);
  vi.mocked(pullDefaultMode).mockResolvedValue("merge");
  vi.mocked(fetchAll).mockResolvedValue(undefined);
  vi.mocked(getOperationState).mockResolvedValue({ kind: "none" });
  vi.mocked(pull).mockResolvedValue("completed");
  vi.mocked(push).mockResolvedValue(undefined);
});

/** Renders the hook and waits until the branch list and the remotes have loaded. */
async function setup() {
  const view = renderHookWithProviders(() => useSyncActions(1));
  await waitFor(() => expect(view.result.current.gates.pull).toBeNull());
  return view;
}

// Contract: gates and upstream text follow the branch list, the remotes and the network state.
describe("useSyncActions state", () => {
  it("should enable everything and describe the upstream once loaded", async () => {
    const { result } = await setup();
    expect(result.current.gates).toEqual({ fetch: null, pull: null, push: null, forcePush: null });
    expect(result.current.upstream).toEqual({ text: "→ origin/main", ahead: 0, behind: 0 });
  });

  it("should gate everything with Loading… until the remotes arrive", () => {
    vi.mocked(listRemotes).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    expect(result.current.gates.fetch).toBe("Loading…");
  });

  it("should gate everything with No remotes configured when there are none", async () => {
    vi.mocked(listRemotes).mockResolvedValue([]);
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(result.current.gates.fetch).toBe("No remotes configured"));
  });

  it("should gate pull and force push when the branch has no upstream", async () => {
    vi.mocked(listBranches).mockResolvedValue(trackedList(null));
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(result.current.gates.pull).toBe("This branch has no upstream"));
    expect(result.current.gates.push).toBeNull();
    expect(result.current.upstream?.text).toBe("no upstream");
  });

  it("should gate everything while a network action runs", async () => {
    const d = deferred();
    vi.mocked(fetchAll).mockReturnValue(d.promise);
    const { result } = await setup();
    act(() => result.current.fetch());
    await waitFor(() =>
      expect(result.current.gates.push).toBe("Another network operation is running"),
    );
    await act(async () => d.resolve());
  });

  it("should report the remote of the tracked upstream", async () => {
    const { result } = await setup();
    expect(result.current.upstreamRemote).toBe("origin");
  });

  it("should report no upstream remote without an upstream", async () => {
    vi.mocked(listBranches).mockResolvedValue(trackedList(null));
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(result.current.upstream).not.toBeNull());
    expect(result.current.upstreamRemote).toBeNull();
  });
});

// Contract: fetch runs fetchAll through the gate and reports the running verb.
describe("useSyncActions fetch", () => {
  it("should run fetchAll with null credentials and report running fetch until it settles", async () => {
    const d = deferred();
    vi.mocked(fetchAll).mockReturnValue(d.promise);
    const { result } = await setup();
    expect(result.current.running).toBeNull();
    act(() => result.current.fetch());
    await waitFor(() => expect(result.current.running).toBe("fetch"));
    expect(fetchAll).toHaveBeenCalledExactlyOnceWith(1, null);
    await act(async () => d.resolve());
    await waitFor(() => expect(result.current.running).toBeNull());
  });

  it("should ignore fetch, pull and push while gated", async () => {
    vi.mocked(listRemotes).mockResolvedValue([]);
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(result.current.gates.fetch).toBe("No remotes configured"));
    act(() => {
      result.current.fetch();
      result.current.pull();
      result.current.push();
    });
    expect([fetchAll, pull, push].map((f) => vi.mocked(f).mock.calls.length)).toEqual([0, 0, 0]);
  });

  it("should ignore pull while the branch has no upstream", async () => {
    vi.mocked(listBranches).mockResolvedValue(trackedList(null));
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(result.current.gates.pull).toBe("This branch has no upstream"));
    act(() => result.current.pull());
    expect(pull).not.toHaveBeenCalled();
  });
});

// Contract: pull defaults to the configured mode and shows nothing when it stops on conflicts.
describe("useSyncActions pull", () => {
  it("should pull in the configured default mode unless one is given", async () => {
    vi.mocked(pullDefaultMode).mockResolvedValue("rebase");
    const { result, queryClient } = await setup();
    await waitFor(() => expect(queryClient.getQueryData(["repo", 1, "pullMode"])).toBe("rebase"));
    await act(async () => result.current.pull());
    expect(pull).toHaveBeenLastCalledWith(1, "rebase", null);
  });

  it("should pull in the given mode when one is given", async () => {
    vi.mocked(pullDefaultMode).mockResolvedValue("rebase");
    const { result, queryClient } = await setup();
    await waitFor(() => expect(queryClient.getQueryData(["repo", 1, "pullMode"])).toBe("rebase"));
    await act(async () => result.current.pull("merge"));
    expect(pull).toHaveBeenLastCalledWith(1, "merge", null);
  });

  it("should pull in merge mode when the default has not loaded", async () => {
    const { result } = await setup();
    await act(async () => result.current.pull());
    expect(pull).toHaveBeenLastCalledWith(1, "merge", null);
  });

  it("should show no message when a pull stops on conflicts", async () => {
    vi.mocked(pull).mockResolvedValue("conflicts");
    const { result } = await setup();
    await act(async () => result.current.pull());
    await waitFor(() => expect(result.current.running).toBeNull());
    expect(result.current.message).toBeNull();
  });
});

// Contract: push targets the upstream; without one it opens the set-upstream dialog.
describe("useSyncActions push", () => {
  it("should push to the upstream without force", async () => {
    const { result } = await setup();
    await act(async () => result.current.push());
    expect(push).toHaveBeenCalledExactlyOnceWith(1, { kind: "upstream" }, false, "main", null);
  });

  it("should show a message when the push fails because HEAD is no longer the displayed branch", async () => {
    vi.mocked(push).mockRejectedValue({
      kind: "operationInProgress",
      message: "HEAD moved to another branch",
    });
    const { result } = await setup();
    await act(async () => result.current.push());
    await waitFor(() =>
      expect(result.current.message?.title).toBe("Another operation is in progress"),
    );
  });

  it("should open the set-upstream dialog with every remote and the branch name when push has no upstream", async () => {
    vi.mocked(listRemotes).mockResolvedValue([remoteInfo("origin"), remoteInfo("upstream")]);
    vi.mocked(listBranches).mockResolvedValue(trackedList(null));
    vi.mocked(push).mockRejectedValue({ kind: "noUpstream", message: "no upstream" });
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(result.current.gates.fetch).toBeNull());
    await waitFor(() => expect(result.current.upstream).not.toBeNull());
    await act(async () => result.current.push());
    await waitFor(() =>
      expect(result.current.setUpstream).toEqual({
        remotes: ["origin", "upstream"],
        branch: "main",
        error: null,
      }),
    );
    expect(result.current.message).toBeNull();
  });
});

// Contract: publish pushes with setUpstream; the dialog stays only for errors it can fix.
describe("useSyncActions publish", () => {
  async function openDialog() {
    vi.mocked(listBranches).mockResolvedValue(trackedList(null));
    const view = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(view.result.current.gates.push).toBeNull());
    await waitFor(() => expect(view.result.current.upstream).not.toBeNull());
    vi.mocked(push).mockRejectedValueOnce({ kind: "noUpstream", message: "no upstream" });
    await act(async () => view.result.current.push());
    await waitFor(() => expect(view.result.current.setUpstream).not.toBeNull());
    return view;
  }

  it("should push with setUpstream and close the dialog", async () => {
    const { result } = await openDialog();
    await act(async () => result.current.publish("origin", "topic"));
    expect(push).toHaveBeenLastCalledWith(
      1,
      { kind: "setUpstream", remote: "origin", branch: "topic" },
      false,
      "main",
      null,
    );
    await waitFor(() => expect(result.current.setUpstream).toBeNull());
  });

  it("should send the displayed HEAD branch as expectedBranch, not the remote branch name", async () => {
    const { result } = await openDialog();
    await act(async () => result.current.publish("origin", "topic"));
    expect(vi.mocked(push).mock.lastCall?.[3]).toBe("main");
  });

  // Contract: publish pushes the branch captured when the dialog opened, even if HEAD moves while it is open.
  async function moveHeadToFeature(view: Awaited<ReturnType<typeof openDialog>>) {
    vi.mocked(listBranches).mockResolvedValue(
      trackedList(null, { kind: "branch", name: "feature" }),
    );
    await act(async () => view.queryClient.invalidateQueries({ queryKey: queryKeys.branches(1) }));
    await waitFor(() => expect(view.result.current.upstream?.text).toBe("no upstream"));
  }

  it("should send the branch captured when the dialog opened as expectedBranch when HEAD moves while it is open", async () => {
    const view = await openDialog();
    await moveHeadToFeature(view);
    await act(async () => view.result.current.publish("origin", "topic"));
    expect(push).toHaveBeenLastCalledWith(
      1,
      { kind: "setUpstream", remote: "origin", branch: "topic" },
      false,
      "main",
      null,
    );
  });

  it("should still send the captured branch on the retry after sign-in when HEAD moved while the dialog was open", async () => {
    const view = await openDialog();
    await moveHeadToFeature(view);
    vi.mocked(push).mockRejectedValueOnce(authError()).mockResolvedValueOnce(undefined);
    act(() => view.result.current.publish("origin", "topic"));
    await waitFor(() => expect(view.result.current.prompt).not.toBeNull());
    act(() => view.result.current.prompt?.submit("me", "tok"));
    await waitFor(() => expect(view.result.current.running).toBeNull());
    expect(push).toHaveBeenLastCalledWith(
      1,
      { kind: "setUpstream", remote: "origin", branch: "topic" },
      false,
      "main",
      { origin: "https://github.com", username: "me", token: "tok" },
    );
  });

  it("should keep the dialog open with the error when the branch name is invalid", async () => {
    const { result } = await openDialog();
    const error = { kind: "invalidBranchName", message: "bad..x" };
    vi.mocked(push).mockRejectedValueOnce(error);
    await act(async () => result.current.publish("origin", "bad..x"));
    await waitFor(() => expect(result.current.setUpstream?.error).toEqual(error));
    expect(result.current.message).toBeNull();
  });

  it("should keep the dialog open with the error when the remote is not found", async () => {
    const { result } = await openDialog();
    const error = { kind: "remoteNotFound", message: "no remote" };
    vi.mocked(push).mockRejectedValueOnce(error);
    await act(async () => result.current.publish("gone", "main"));
    await waitFor(() => expect(result.current.setUpstream?.error).toEqual(error));
  });

  it("should close the dialog and show the message when the push fails on the network", async () => {
    const { result } = await openDialog();
    vi.mocked(push).mockRejectedValueOnce(networkError("hostUnreachable"));
    await act(async () => result.current.publish("origin", "main"));
    await waitFor(() => expect(result.current.setUpstream).toBeNull());
    expect(result.current.message?.title).toBe("Could not reach the remote");
  });

  it("should close the dialog and show no message when the sign-in is cancelled", async () => {
    const { result } = await openDialog();
    vi.mocked(push).mockRejectedValueOnce(authError());
    act(() => result.current.publish("origin", "main"));
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.cancel());
    await waitFor(() => expect(result.current.setUpstream).toBeNull());
    expect(result.current.message).toBeNull();
  });

  it("should close the dialog on cancelSetUpstream", async () => {
    const { result } = await openDialog();
    act(() => result.current.cancelSetUpstream());
    expect(result.current.setUpstream).toBeNull();
  });
});

// Contract: force push needs an explicit confirmation naming branch, remote and upstream.
describe("useSyncActions force push", () => {
  it("should open the confirmation naming the branch, remote and upstream", async () => {
    const { result } = await setup();
    act(() => result.current.requestForcePush());
    expect(result.current.forcePush).toEqual({
      local: "main",
      remote: "origin",
      upstream: "origin/main",
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("should open the confirmation with an empty remote when the upstream's remote is not configured", async () => {
    vi.mocked(listBranches).mockResolvedValue(
      trackedList({ upstream: "gone/main", ahead: 0, behind: 0 }),
    );
    const { result } = await setup();
    act(() => result.current.requestForcePush());
    expect(result.current.forcePush).toEqual({ local: "main", remote: "", upstream: "gone/main" });
  });

  it("should ignore requestForcePush while gated", async () => {
    vi.mocked(listBranches).mockResolvedValue(trackedList(null));
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(result.current.gates.forcePush).toBe("This branch has no upstream"));
    act(() => result.current.requestForcePush());
    expect(result.current.forcePush).toBeNull();
  });

  it("should close the confirmation on cancelForcePush without pushing", async () => {
    const { result } = await setup();
    act(() => result.current.requestForcePush());
    act(() => result.current.cancelForcePush());
    expect(result.current.forcePush).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it("should push with force and close the confirmation on success", async () => {
    const { result } = await setup();
    act(() => result.current.requestForcePush());
    await act(async () => result.current.confirmForcePush());
    expect(push).toHaveBeenCalledExactlyOnceWith(1, { kind: "upstream" }, true, "main", null);
    await waitFor(() => expect(result.current.forcePush).toBeNull());
  });

  it("should close the confirmation and show the message when the force push fails", async () => {
    vi.mocked(push).mockRejectedValue(networkError("leaseStale"));
    const { result } = await setup();
    act(() => result.current.requestForcePush());
    await act(async () => result.current.confirmForcePush());
    await waitFor(() => expect(result.current.forcePush).toBeNull());
    expect(result.current.message?.title).toBe("The remote branch moved since your last fetch");
  });

  it("should send the branch confirmed at confirm time even when HEAD moves to another branch before the confirm", async () => {
    const { result, queryClient } = await setup();
    act(() => result.current.requestForcePush());
    vi.mocked(listBranches).mockResolvedValue(
      trackedList(origin, { kind: "branch", name: "feature" }),
    );
    await act(async () => queryClient.invalidateQueries({ queryKey: queryKeys.branches(1) }));
    await waitFor(() => expect(result.current.forcePush?.local).toBe("main"));
    await act(async () => result.current.confirmForcePush());
    expect(push).toHaveBeenCalledExactlyOnceWith(1, { kind: "upstream" }, true, "main", null);
  });

  it("should still send the confirmed branch on the retry after sign-in when HEAD moved meanwhile", async () => {
    vi.mocked(push).mockRejectedValueOnce(authError()).mockResolvedValueOnce(undefined);
    const { result, queryClient } = await setup();
    act(() => result.current.requestForcePush());
    act(() => result.current.confirmForcePush());
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    vi.mocked(listBranches).mockResolvedValue(
      trackedList(origin, { kind: "branch", name: "feature" }),
    );
    await act(async () => queryClient.invalidateQueries({ queryKey: queryKeys.branches(1) }));
    act(() => result.current.prompt?.submit("me", "tok"));
    await waitFor(() => expect(result.current.running).toBeNull());
    expect(push).toHaveBeenLastCalledWith(1, { kind: "upstream" }, true, "main", {
      origin: "https://github.com",
      username: "me",
      token: "tok",
    });
  });

  it("should show a message when the force push fails because HEAD is no longer the confirmed branch", async () => {
    vi.mocked(push).mockRejectedValue({
      kind: "operationInProgress",
      message: "HEAD moved to another branch",
    });
    const { result } = await setup();
    act(() => result.current.requestForcePush());
    await act(async () => result.current.confirmForcePush());
    await waitFor(() => expect(result.current.forcePush).toBeNull());
    expect(result.current.message).toMatchObject({
      title: "Another operation is in progress",
      hint: "Finish or abort it, then try again.",
    });
  });

  it("should keep the confirmation open while the push runs", async () => {
    const d = deferred();
    vi.mocked(push).mockReturnValue(d.promise);
    const { result } = await setup();
    act(() => result.current.requestForcePush());
    act(() => result.current.confirmForcePush());
    await waitFor(() => expect(result.current.running).toBe("push"));
    expect(result.current.forcePush).not.toBeNull();
    await act(async () => d.resolve());
  });
});

// Contract: a failure becomes a message until dismissed or until the next action starts.
describe("useSyncActions messages", () => {
  it("should turn a failure into a message and clear it on dismissMessage", async () => {
    vi.mocked(fetchAll).mockRejectedValue(networkError("hostUnreachable", { verb: "fetch" }));
    const { result } = await setup();
    await act(async () => result.current.fetch());
    await waitFor(() => expect(result.current.message?.title).toBe("Could not reach the remote"));
    act(() => result.current.dismissMessage());
    expect(result.current.message).toBeNull();
  });

  it("should clear the previous message when the next action starts", async () => {
    const d = deferred();
    vi.mocked(fetchAll)
      .mockRejectedValueOnce(networkError("hostUnreachable", { verb: "fetch" }))
      .mockReturnValueOnce(d.promise);
    const { result } = await setup();
    await act(async () => result.current.fetch());
    await waitFor(() => expect(result.current.message).not.toBeNull());
    await waitFor(() => expect(result.current.gates.fetch).toBeNull());
    act(() => result.current.fetch());
    expect(result.current.message).toBeNull();
    await act(async () => d.resolve());
  });

  it("should show no message when the sign-in is cancelled", async () => {
    vi.mocked(push).mockRejectedValue(authError());
    const { result } = await setup();
    act(() => result.current.push());
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.cancel());
    await waitFor(() => expect(result.current.running).toBeNull());
    expect(result.current.message).toBeNull();
  });

  it("should expose the credential prompt and retry with the entered credentials", async () => {
    vi.mocked(push).mockRejectedValueOnce(authError()).mockResolvedValueOnce(undefined);
    const { result } = await setup();
    act(() => result.current.push());
    await waitFor(() => expect(result.current.prompt?.host).toBe("github.com"));
    act(() => result.current.prompt?.submit("me", "tok"));
    await waitFor(() => expect(result.current.running).toBeNull());
    expect(push).toHaveBeenLastCalledWith(1, { kind: "upstream" }, false, "main", {
      origin: "https://github.com",
      username: "me",
      token: "tok",
    });
    expect(result.current.message).toBeNull();
  });

  it("should show the titled operation-in-progress message when a pull races an operation", async () => {
    vi.mocked(pull).mockRejectedValue({ kind: "operationInProgress", message: "merge running" });
    const { result } = await setup();
    await act(async () => result.current.pull());
    await waitFor(() =>
      expect(result.current.message?.title).toBe("Another operation is in progress"),
    );
  });
});

// Contract (W2): the gates follow the repo's operation state (the query OperationBanner uses), so
// pull and push do nothing during a merge, rebase, cherry-pick or revert.
describe("useSyncActions during an in-progress operation", () => {
  const rebase: OperationState = {
    kind: "rebase",
    onto: "b".repeat(40),
    ontoName: "main",
    branch: "topic",
    step: 1,
    total: 2,
    stoppedForEdit: false,
  };
  const merge: OperationState = {
    kind: "merge",
    head: "a".repeat(40),
    branch: "topic",
    message: { subject: "Merge", body: "" },
  };

  it("should gate pull, push and force push with the operation's name but leave fetch enabled", async () => {
    vi.mocked(getOperationState).mockResolvedValue(merge);
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(result.current.gates.pull).toBe("Finish or abort the merge first"));
    expect(result.current.gates).toEqual({
      fetch: null,
      pull: "Finish or abort the merge first",
      push: "Finish or abort the merge first",
      forcePush: "Finish or abort the merge first",
    });
  });

  it("should name a rebase in the gates", async () => {
    vi.mocked(getOperationState).mockResolvedValue(rebase);
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(result.current.gates.push).toBe("Finish or abort the rebase first"));
  });

  it("should ignore pull, push and requestForcePush while an operation is in progress", async () => {
    vi.mocked(getOperationState).mockResolvedValue(merge);
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(result.current.gates.pull).toBe("Finish or abort the merge first"));
    act(() => {
      result.current.pull();
      result.current.push();
      result.current.requestForcePush();
    });
    expect([pull, push].map((f) => vi.mocked(f).mock.calls.length)).toEqual([0, 0]);
    expect(result.current.forcePush).toBeNull();
  });

  it("should still fetch while an operation is in progress", async () => {
    vi.mocked(getOperationState).mockResolvedValue(merge);
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(result.current.gates.pull).toBe("Finish or abort the merge first"));
    await act(async () => result.current.fetch());
    expect(fetchAll).toHaveBeenCalledExactlyOnceWith(1, null);
  });

  it("should enable pull and push again when the operation state is none", async () => {
    const { result } = await setup();
    expect(result.current.gates).toEqual({ fetch: null, pull: null, push: null, forcePush: null });
  });
});

// Contract (GR-14): completion toasts.
import { useToasts } from "../../lib/store/toasts";

describe("useSyncActions completion toasts (GR-14)", () => {
  beforeEach(() => {
    useToasts.setState({ toasts: [] });
  });

  it("toasts Fetch complete on success and nothing on failure", async () => {
    vi.mocked(fetchAll).mockResolvedValue(undefined);
    const { result } = await setup();
    await act(async () => result.current.fetch());
    const texts = useToasts.getState().toasts.map((t) => t.text);
    expect(texts).toContain("Fetch complete");
  });

  it("does not toast on fetch failure", async () => {
    vi.mocked(fetchAll).mockRejectedValue(networkError);
    const { result } = await setup();
    await act(async () => result.current.fetch());
    const texts = useToasts.getState().toasts.map((t) => t.text);
    expect(texts).not.toContain("Fetch complete");
  });

  it("toasts Pull complete only for a completed outcome", async () => {
    vi.mocked(pull).mockResolvedValue("completed");
    const { result } = await setup();
    await act(async () => result.current.pull());
    expect(useToasts.getState().toasts.map((t) => t.text)).toContain("Pull complete");
  });

  it("does not toast Pull complete for a conflicts outcome", async () => {
    vi.mocked(pull).mockResolvedValue("conflicts");
    const { result } = await setup();
    await act(async () => result.current.pull());
    expect(useToasts.getState().toasts.map((t) => t.text)).not.toContain("Pull complete");
  });

  it("toasts Pushed <branch> after push", async () => {
    vi.mocked(push).mockResolvedValue(undefined);
    const { result } = await setup();
    await act(async () => result.current.push());
    const texts = useToasts.getState().toasts.map((t) => t.text);
    const pushed = texts.find((t) => t.startsWith("Pushed "));
    expect(pushed).toBeTruthy();
  });
});

// Contract: autoFetch fetches without a prompt and toasts its failures; the sync actions feed the auto-fetch store.
describe("useSyncActions autoFetch", () => {
  const entry = () => useAutoFetchState.getState().repos[1];

  beforeEach(() => {
    useToasts.setState({ toasts: [] });
    useRepoTabs.setState(useRepoTabs.getInitialState(), true);
  });

  /** Opens repo 1 as a tab, as the app does before mounting its pane. */
  const openRepoTab = () =>
    useRepoTabs.getState().openTab({
      id: 1,
      summary: { path: "/r/1", name: "r1", headBranch: "main", isBare: false },
    });

  /** Runs one auto-fetch that fails on auth and waits until it has settled. */
  async function failOnAuth() {
    vi.mocked(fetchAll).mockRejectedValue(authError());
    const view = await setup();
    act(() => view.result.current.autoFetch());
    await waitFor(() => expect(useToasts.getState().toasts).toHaveLength(1));
    await waitFor(() => expect(view.result.current.running).toBeNull());
    return view;
  }

  it("should run fetchAll with null credentials, report running fetch, and record the fetch time on success", async () => {
    const d = deferred();
    vi.mocked(fetchAll).mockReturnValue(d.promise);
    const { result } = await setup();
    act(() => result.current.autoFetch());
    await waitFor(() => expect(result.current.running).toBe("fetch"));
    expect(fetchAll).toHaveBeenCalledExactlyOnceWith(1, null);
    await act(async () => d.resolve());
    await waitFor(() => expect(result.current.running).toBeNull());
    expect(entry()?.lastFetchedAt).toEqual(expect.any(Number));
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("should skip while gated", async () => {
    vi.mocked(listRemotes).mockResolvedValue([]);
    const { result } = renderHookWithProviders(() => useSyncActions(1));
    await waitFor(() => expect(result.current.gates.fetch).toBe("No remotes configured"));
    act(() => result.current.autoFetch());
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it("should skip while a network action is already running", async () => {
    const d = deferred();
    vi.mocked(fetchAll).mockReturnValue(d.promise);
    const { result } = await setup();
    act(() => result.current.fetch());
    await waitFor(() => expect(result.current.running).toBe("fetch"));
    act(() => result.current.autoFetch());
    expect(fetchAll).toHaveBeenCalledOnce();
    await act(async () => d.resolve());
  });

  it("should toast Auto-fetch failed with a Fetch action, pause, and not open a prompt, on an auth failure", async () => {
    const { result } = await failOnAuth();
    const [toast] = useToasts.getState().toasts;
    expect(toast).toMatchObject({ text: "Auto-fetch failed: Sign-in required", variant: "error" });
    expect(toast?.action?.label).toBe("Fetch");
    expect(entry()?.paused).toBe(true);
    expect(result.current.prompt).toBeNull();
    expect(result.current.message).toBeNull();
  });

  it("should run the manual fetch when the toast's Fetch action runs", async () => {
    openRepoTab();
    await failOnAuth();
    vi.mocked(fetchAll).mockResolvedValue(undefined);
    act(() => useToasts.getState().toasts[0]?.action?.run());
    await waitFor(() => expect(fetchAll).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(entry()?.paused).toBe(false));
  });

  it("should toast once per streak: a second failure while paused is not attempted", async () => {
    const { result } = await failOnAuth();
    act(() => result.current.autoFetch());
    expect(fetchAll).toHaveBeenCalledOnce();
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it("should record the fetch time after a manual fetch succeeds", async () => {
    const { result } = await setup();
    act(() => result.current.fetch());
    await waitFor(() => expect(entry()?.lastFetchedAt).toEqual(expect.any(Number)));
  });

  it("should record the fetch time after a pull completes", async () => {
    const { result } = await setup();
    act(() => result.current.pull());
    await waitFor(() => expect(entry()?.lastFetchedAt).toEqual(expect.any(Number)));
  });

  it("should resume after a push succeeds", async () => {
    useAutoFetchState.getState().recordFailure(1);
    const { result } = await setup();
    act(() => result.current.push());
    await waitFor(() => expect(entry()?.paused).toBe(false));
  });

  it("should pause silently after a manual fetch fails", async () => {
    vi.mocked(fetchAll).mockRejectedValue(networkError("hostUnreachable"));
    const { result } = await setup();
    act(() => result.current.fetch());
    await waitFor(() => expect(entry()?.paused).toBe(true));
    expect(useToasts.getState().toasts).toHaveLength(0);
  });

  it("should not run the toast's Fetch action once the repo's tab has closed", async () => {
    openRepoTab();
    await failOnAuth();
    useRepoTabs.getState().closeTab(1);
    await act(async () => useToasts.getState().toasts[0]?.action?.run());
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(fetchAll).toHaveBeenCalledOnce();
  });

  it("should not pause after a push is rejected as non-fast-forward", async () => {
    vi.mocked(push).mockRejectedValue(networkError("pushRejectedNonFastForward"));
    const { result } = await setup();
    act(() => result.current.push());
    await waitFor(() => expect(result.current.message).not.toBeNull());
    expect(entry()?.paused ?? false).toBe(false);
  });

  it("should not pause after a pull races an operation", async () => {
    vi.mocked(pull).mockRejectedValue({ kind: "operationInProgress", message: "merge running" });
    const { result } = await setup();
    act(() => result.current.pull());
    await waitFor(() => expect(result.current.message).not.toBeNull());
    expect(entry()?.paused ?? false).toBe(false);
  });

  it("should pause after a push fails because the host is unreachable", async () => {
    vi.mocked(push).mockRejectedValue(networkError("hostUnreachable"));
    const { result } = await setup();
    act(() => result.current.push());
    await waitFor(() => expect(entry()?.paused).toBe(true));
  });

  it("should pause after a pull fails because the host is unreachable", async () => {
    vi.mocked(pull).mockRejectedValue(networkError("hostUnreachable"));
    const { result } = await setup();
    act(() => result.current.pull());
    await waitFor(() => expect(entry()?.paused).toBe(true));
  });

  it("should record the fetch time after a pull stops on conflicts", async () => {
    vi.mocked(pull).mockResolvedValue("conflicts");
    const { result } = await setup();
    act(() => result.current.pull());
    await waitFor(() => expect(entry()?.lastFetchedAt).toEqual(expect.any(Number)));
  });

  it("should record nothing when a manual action's sign-in is cancelled", async () => {
    vi.mocked(fetchAll).mockRejectedValue(authError());
    const { result } = await setup();
    act(() => result.current.fetch());
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.cancel());
    await waitFor(() => expect(result.current.running).toBeNull());
    expect(entry()).toBeUndefined();
  });

  it("should stay silent and unpaused when an autoFetch is cancelled", async () => {
    vi.mocked(fetchAll).mockRejectedValue(authError());
    const { result } = await setup();
    // Captured while ungated: the prompt the manual fetch opens makes this run resolve cancelled.
    const staleAutoFetch = result.current.autoFetch;
    act(() => result.current.fetch());
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => staleAutoFetch());
    await waitFor(() => expect(fetchAll).toHaveBeenCalledOnce());
    act(() => result.current.prompt?.cancel());
    await waitFor(() => expect(result.current.running).toBeNull());
    expect(useToasts.getState().toasts).toHaveLength(0);
    expect(entry()).toBeUndefined();
  });
});

describe("pausesAutoFetch", () => {
  it("is true for connectivity and auth failures", () => {
    expect(pausesAutoFetch(networkError("hostUnreachable"))).toBe(true);
    expect(pausesAutoFetch(authError())).toBe(true);
  });

  it("is false for rejected pushes and non-network errors", () => {
    for (const kind of ["pushRejectedNonFastForward", "leaseStale", "remoteRejected"] as const) {
      expect(pausesAutoFetch(networkError(kind))).toBe(false);
    }
    expect(pausesAutoFetch({ kind: "operationInProgress", message: "m" })).toBe(false);
  });
});
