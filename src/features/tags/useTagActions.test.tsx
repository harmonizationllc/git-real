import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTag, deleteRemoteTag, deleteTag, pushTag } from "../../lib/ipc";
import { authError, networkError } from "../../test/remoteFixtures";
import { mutationKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useNetworkAction } from "../remotes/useNetworkAction";
import { useTagActions } from "./useTagActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
  pushTag: vi.fn(),
  deleteRemoteTag: vi.fn(),
}));

const OID = "a".repeat(40);
const failure = {
  kind: "networkFailed",
  message: "rejected",
  network: { verb: "push", kind: "other", https: false, origin: null },
};

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<undefined>((res, rej) => {
    resolve = () => res(undefined);
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createTag).mockResolvedValue(undefined);
  vi.mocked(deleteTag).mockResolvedValue(undefined);
  vi.mocked(pushTag).mockResolvedValue(undefined);
  vi.mocked(deleteRemoteTag).mockResolvedValue(undefined);
});

// Contract: each action resolves with the AppError or null, never rejects, and refreshes the tags.
describe("useTagActions calls", () => {
  it("create calls createTag with name, oid and message and resolves null", async () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.create("v1", OID, "Release");
    });
    expect(createTag).toHaveBeenCalledExactlyOnceWith(1, "v1", OID, "Release");
    expect(outcome).toBeNull();
  });

  it("create passes a null message for a lightweight tag", async () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.create("v1", OID, null));
    expect(createTag).toHaveBeenCalledExactlyOnceWith(1, "v1", OID, null);
  });

  it("remove calls deleteTag", async () => {
    const { result } = renderHookWithProviders(() => useTagActions(2));
    await act(() => result.current.remove("v1"));
    expect(deleteTag).toHaveBeenCalledExactlyOnceWith(2, "v1");
  });

  it("push passes null credentials first", async () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.push("origin", "v1"));
    expect(pushTag).toHaveBeenCalledExactlyOnceWith(1, "origin", "v1", null);
  });

  it("deleteRemote passes null credentials first", async () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.deleteRemote("origin", "v1"));
    expect(deleteRemoteTag).toHaveBeenCalledExactlyOnceWith(1, "origin", "v1", null);
  });
});

// Contract: only a successful push or remote delete leaves a status, cleared by the next action.
describe("useTagActions status", () => {
  it("starts idle with no error, no status and no last name", () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    expect([
      result.current.pending,
      result.current.error,
      result.current.status,
      result.current.lastName,
    ]).toEqual([false, null, null, null]);
  });

  it("push sets a pushed status", async () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.push("origin", "v1"));
    expect(result.current.status).toEqual({ kind: "pushed", name: "v1", remote: "origin" });
  });

  it("deleteRemote sets a deletedRemote status", async () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.deleteRemote("origin", "v1"));
    expect(result.current.status).toEqual({
      kind: "deletedRemote",
      name: "v1",
      remote: "origin",
    });
  });

  it("create and remove set no status", async () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.create("v1", OID, null));
    await act(() => result.current.remove("v1"));
    expect(result.current.status).toBeNull();
  });

  it("the next action clears the previous status", async () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.push("origin", "v1"));
    await act(() => result.current.remove("v1"));
    expect(result.current.status).toBeNull();
  });

  it("a failed push sets no status", async () => {
    vi.mocked(pushTag).mockRejectedValue(failure);
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.push("origin", "v1"));
    expect(result.current.status).toBeNull();
  });

  it("a failed push clears the status of an earlier push", async () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.push("origin", "v1"));
    vi.mocked(pushTag).mockRejectedValue(failure);
    await act(() => result.current.push("origin", "v2"));
    expect(result.current.status).toBeNull();
  });

  it("clearStatus resets the status", async () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.push("origin", "v1"));
    act(() => result.current.clearStatus());
    expect(result.current.status).toBeNull();
  });
});

// Contract: failures resolve with the AppError, mirror it in error, and never reject.
describe("useTagActions errors", () => {
  it("a rejected action resolves with the AppError and mirrors it in error", async () => {
    vi.mocked(deleteTag).mockRejectedValue({ kind: "tagNotFound", message: "gone" });
    const { result } = renderHookWithProviders(() => useTagActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.remove("v1");
    });
    expect(outcome).toEqual({ kind: "tagNotFound", message: "gone" });
    await waitFor(() =>
      expect(result.current.error).toEqual({ kind: "tagNotFound", message: "gone" }),
    );
  });

  it("a plain Error rejection becomes an io AppError", async () => {
    vi.mocked(createTag).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useTagActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.create("v1", OID, null);
    });
    expect(outcome).toEqual({ kind: "io", message: "boom" });
  });

  it("clearError resets the error", async () => {
    vi.mocked(pushTag).mockRejectedValue(failure);
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.push("origin", "v1"));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => result.current.clearError());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("lastName names the tag of the latest action", async () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.push("origin", "v1"));
    await act(() => result.current.push("origin", "v2"));
    expect(result.current.lastName).toBe("v2");
  });

  it("lastName names the tag of a failed action", async () => {
    vi.mocked(deleteTag).mockRejectedValue({ kind: "tagNotFound", message: "gone" });
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.remove("v9"));
    expect(result.current.lastName).toBe("v9");
  });
});

// Contract: pending covers every tag action of the repo, in this hook or another, and no other repo.
describe("useTagActions pending", () => {
  it("pending is true while an action runs", async () => {
    const d = deferred();
    vi.mocked(pushTag).mockReturnValue(d.promise);
    const { result } = renderHookWithProviders(() => useTagActions(1));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.push("origin", "v1");
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => {
      d.resolve();
      await done;
    });
    expect(result.current.pending).toBe(false);
  });

  it("pending is true while another instance of the same repo runs an action", async () => {
    const d = deferred();
    vi.mocked(pushTag).mockReturnValue(d.promise);
    const { result } = renderHookWithProviders(() => ({
      first: useTagActions(1),
      second: useTagActions(1),
      other: useTagActions(2),
    }));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.first.push("origin", "v1");
    });
    await waitFor(() => expect(result.current.second.pending).toBe(true));
    expect(result.current.other.pending).toBe(false);
    await act(async () => {
      d.resolve();
      await done;
    });
    expect(result.current.second.pending).toBe(false);
  });

  it("counts a running action under the repo's tag mutation key only", async () => {
    const d = deferred();
    vi.mocked(deleteTag).mockReturnValue(d.promise);
    const { result, queryClient } = renderHookWithProviders(() => useTagActions(1));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.remove("v1");
    });
    await waitFor(() =>
      expect(queryClient.isMutating({ mutationKey: mutationKeys.tag(1) })).toBe(1),
    );
    expect(queryClient.isMutating({ mutationKey: mutationKeys.tag(2) })).toBe(0);
    await act(async () => {
      d.resolve();
      await done;
    });
    expect(queryClient.isMutating({ mutationKey: mutationKeys.tag(1) })).toBe(0);
  });

  it("pending ends after a failed action", async () => {
    vi.mocked(pushTag).mockRejectedValue(failure);
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.push("origin", "v1"));
    expect(result.current.pending).toBe(false);
  });
});

// Contract: every action refreshes the tag list on settle; create and remove also the graph.
describe("useTagActions invalidation", () => {
  const tagsKey = { queryKey: ["repo", 1, "tags"] };
  const logKey = { queryKey: ["repo", 1, "log"] };
  const repoKey = { queryKey: ["repo", 1] };

  it("create invalidates tags and log after success", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useTagActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.create("v1", OID, null));
    expect(spy).toHaveBeenCalledWith(tagsKey);
    expect(spy).toHaveBeenCalledWith(logKey);
  });

  it("create invalidates tags and log after failure", async () => {
    vi.mocked(createTag).mockRejectedValue({ kind: "tagExists", message: "x" });
    const { result, queryClient } = renderHookWithProviders(() => useTagActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.create("v1", OID, null));
    expect(spy).toHaveBeenCalledWith(tagsKey);
    expect(spy).toHaveBeenCalledWith(logKey);
  });

  it("remove invalidates tags and log after success and after failure", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useTagActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.remove("v1"));
    vi.mocked(deleteTag).mockRejectedValue({ kind: "tagNotFound", message: "x" });
    await act(() => result.current.remove("v1"));
    expect(
      spy.mock.calls.filter(([f]) => JSON.stringify(f) === JSON.stringify(tagsKey)),
    ).toHaveLength(2);
    expect(
      spy.mock.calls.filter(([f]) => JSON.stringify(f) === JSON.stringify(logKey)),
    ).toHaveLength(2);
  });

  it("push invalidates the repo queries, also after failure", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useTagActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.push("origin", "v1"));
    vi.mocked(pushTag).mockRejectedValue(failure);
    await act(() => result.current.push("origin", "v2"));
    expect(
      spy.mock.calls.filter(([f]) => JSON.stringify(f) === JSON.stringify(repoKey)),
    ).toHaveLength(2);
  });

  it("deleteRemote invalidates the repo queries, also after failure", async () => {
    vi.mocked(deleteRemoteTag).mockRejectedValue(failure);
    const { result, queryClient } = renderHookWithProviders(() => useTagActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.deleteRemote("origin", "v1"));
    expect(spy).toHaveBeenCalledWith(repoKey);
  });

  it("push and deleteRemote do not invalidate the log separately", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useTagActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.push("origin", "v1"));
    await act(() => result.current.deleteRemote("origin", "v1"));
    expect(spy).not.toHaveBeenCalledWith(logKey);
  });

  it("does not invalidate another repo", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useTagActions(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.create("v1", OID, null));
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ["repo", 2, "tags"] });
  });
});

// Contract: push and deleteRemote go through the network gate: credentials on an HTTPS auth
// failure, a cancelled sign-in resolving null, and network failures mirrored in error.
describe("useTagActions network gate", () => {
  it("push asks for credentials on an HTTPS auth failure and retries with them", async () => {
    vi.mocked(pushTag).mockRejectedValueOnce(authError()).mockResolvedValueOnce(undefined);
    const { result } = renderHookWithProviders(() => useTagActions(1));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.push("origin", "v1");
    });
    await waitFor(() => expect(result.current.prompt?.host).toBe("github.com"));
    act(() => result.current.prompt?.submit("me", "tok"));
    await act(async () => {
      await done;
    });
    expect(pushTag).toHaveBeenLastCalledWith(1, "origin", "v1", {
      origin: "https://github.com",
      username: "me",
      token: "tok",
    });
    expect(result.current.status).toEqual({ kind: "pushed", name: "v1", remote: "origin" });
    expect(result.current.prompt).toBeNull();
  });

  it("deleteRemote asks for credentials on an HTTPS auth failure and retries with them", async () => {
    vi.mocked(deleteRemoteTag).mockRejectedValueOnce(authError()).mockResolvedValueOnce(undefined);
    const { result } = renderHookWithProviders(() => useTagActions(1));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.deleteRemote("origin", "v1");
    });
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.submit("me", "tok"));
    await act(async () => {
      await done;
    });
    expect(result.current.status).toEqual({ kind: "deletedRemote", name: "v1", remote: "origin" });
  });

  it("has no prompt while idle", () => {
    const { result } = renderHookWithProviders(() => useTagActions(1));
    expect(result.current.prompt).toBeNull();
  });

  it("a cancelled sign-in resolves null with no status and no error", async () => {
    vi.mocked(pushTag).mockRejectedValue(authError());
    const { result } = renderHookWithProviders(() => useTagActions(1));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.push("origin", "v1");
    });
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.cancel());
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await done;
    });
    expect(outcome).toBeNull();
    expect(result.current.status).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("a network failure resolves with the AppError and mirrors it in error", async () => {
    const error = networkError("hostUnreachable");
    vi.mocked(pushTag).mockRejectedValue(error);
    const { result } = renderHookWithProviders(() => useTagActions(1));
    let outcome: unknown = null;
    await act(async () => {
      outcome = await result.current.push("origin", "v1");
    });
    expect(outcome).toEqual(error);
    await waitFor(() => expect(result.current.error).toEqual(error));
  });

  it("a remote delete failure also mirrors in error and clearError resets it", async () => {
    const error = networkError("hostUnreachable");
    vi.mocked(deleteRemoteTag).mockRejectedValue(error);
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.deleteRemote("origin", "v1"));
    await waitFor(() => expect(result.current.error).toEqual(error));
    act(() => result.current.clearError());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("a successful push after a failure clears the mirrored error", async () => {
    vi.mocked(pushTag).mockRejectedValueOnce(networkError("hostUnreachable"));
    const { result } = renderHookWithProviders(() => useTagActions(1));
    await act(() => result.current.push("origin", "v1"));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    await act(() => result.current.push("origin", "v1"));
    expect(result.current.error).toBeNull();
  });

  it("pending covers a network action of this repo run elsewhere", async () => {
    let finish!: () => void;
    vi.mocked(pushTag).mockReturnValue(
      new Promise<undefined>((r) => (finish = () => r(undefined))),
    );
    const { result } = renderHookWithProviders(() => ({
      tags: useTagActions(1),
      network: useNetworkAction(1),
      other: useTagActions(2),
    }));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.network.run(() => pushTag(1, "origin", "v1", null));
    });
    await waitFor(() => expect(result.current.tags.pending).toBe(true));
    expect(result.current.other.pending).toBe(false);
    await act(async () => {
      finish();
      await done;
    });
    expect(result.current.tags.pending).toBe(false);
  });

  it("pending is true while the sign-in prompt is open", async () => {
    vi.mocked(pushTag).mockRejectedValue(authError());
    const { result } = renderHookWithProviders(() => useTagActions(1));
    act(() => void result.current.push("origin", "v1"));
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    expect(result.current.pending).toBe(true);
  });
});
