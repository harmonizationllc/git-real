import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AppError, Credentials } from "../../lib/ipc";
import { authError, networkError } from "../../test/remoteFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { needsCredentials, useNetworkAction } from "./useNetworkAction";
import type { NetworkResult } from "./useNetworkAction";

type Action = (credentials: Credentials | null) => Promise<string>;

function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Starts a run inside act and returns the pending result promise. */
function start(run: (a: Action) => Promise<NetworkResult<string>>, action: Action) {
  let result!: Promise<NetworkResult<string>>;
  act(() => {
    result = run(action);
  });
  return result;
}

// Contract: the gate runs the action first without credentials and resolves its value.
describe("useNetworkAction first attempt", () => {
  it("should run the action with null credentials and resolve ok with its value", async () => {
    const action = vi.fn<Action>().mockResolvedValue("done");
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.run(action);
    });
    expect(action).toHaveBeenCalledExactlyOnceWith(null);
    expect(outcome).toEqual({ status: "ok", value: "done" });
  });

  it("should resolve failed without prompting when the failure is not an auth failure", async () => {
    const error = networkError("hostUnreachable");
    const action = vi.fn<Action>().mockRejectedValue(error);
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.run(action);
    });
    expect(outcome).toEqual({ status: "failed", error });
    expect(result.current.prompt).toBeNull();
  });

  it.each<[string, AppError]>([
    [
      "is not https",
      networkError("httpsAuthRequired", { https: false, origin: "https://github.com" }),
    ],
    ["has no origin", networkError("httpsAuthRequired", { https: true, origin: null })],
  ])("should resolve failed without prompting when an auth failure %s", async (_name, error) => {
    const action = vi.fn<Action>().mockRejectedValue(error);
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.run(action);
    });
    expect(outcome).toEqual({ status: "failed", error });
    expect(action).toHaveBeenCalledOnce();
  });

  it("should turn a plain Error rejection into an io AppError", async () => {
    const action = vi.fn<Action>().mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.run(action);
    });
    expect(outcome).toEqual({ status: "failed", error: { kind: "io", message: "boom" } });
  });
});

// Contract: an HTTPS auth failure opens a prompt; submit retries with the credentials.
describe("useNetworkAction credential prompt", () => {
  it("should open a prompt naming the origin's host when auth is required", async () => {
    const action = vi.fn<Action>().mockRejectedValue(authError());
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    start(result.current.run, action);
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    expect(result.current.prompt).toMatchObject({
      origin: "https://github.com",
      host: "github.com",
      rejected: false,
    });
  });

  it("should rerun the action with the entered credentials and the origin on submit", async () => {
    const action = vi.fn<Action>().mockRejectedValueOnce(authError()).mockResolvedValueOnce("done");
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    const outcome = start(result.current.run, action);
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.submit("me", "tok"));
    await expect(outcome).resolves.toEqual({ status: "ok", value: "done" });
    expect(action).toHaveBeenLastCalledWith({
      origin: "https://github.com",
      username: "me",
      token: "tok",
    });
  });

  it("should close the prompt once the retry succeeds", async () => {
    const action = vi.fn<Action>().mockRejectedValueOnce(authError()).mockResolvedValueOnce("done");
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    const outcome = start(result.current.run, action);
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.submit("me", "tok"));
    await act(async () => {
      await outcome;
    });
    expect(result.current.prompt).toBeNull();
  });

  it("should reopen the prompt marked rejected when the entered credentials are refused", async () => {
    const action = vi
      .fn<Action>()
      .mockRejectedValueOnce(authError())
      .mockRejectedValueOnce(authError("httpsAuthRejected"));
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    start(result.current.run, action);
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.submit("me", "bad"));
    await waitFor(() => expect(result.current.prompt?.rejected).toBe(true));
  });

  it("should not mark the first prompt rejected even when the stored credentials were refused", async () => {
    const action = vi.fn<Action>().mockRejectedValue(authError("httpsAuthRejected"));
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    start(result.current.run, action);
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    expect(result.current.prompt?.rejected).toBe(false);
  });

  it("should resolve cancelled and close the prompt on cancel", async () => {
    const action = vi.fn<Action>().mockRejectedValue(authError());
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    const outcome = start(result.current.run, action);
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.cancel());
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    await waitFor(() => expect(result.current.prompt).toBeNull());
  });

  it("should not rerun the action after cancel", async () => {
    const action = vi.fn<Action>().mockRejectedValue(authError());
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    const outcome = start(result.current.run, action);
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.cancel());
    await outcome;
    expect(action).toHaveBeenCalledOnce();
  });

  it("should resolve failed when a retry fails for another reason", async () => {
    const other = networkError("hostUnreachable");
    const action = vi.fn<Action>().mockRejectedValueOnce(authError()).mockRejectedValueOnce(other);
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    const outcome = start(result.current.run, action);
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.submit("me", "tok"));
    await expect(outcome).resolves.toEqual({ status: "failed", error: other });
  });
});

// Contract: every attempt refreshes the repo's queries on settle, success or failure.
describe("useNetworkAction invalidation", () => {
  it("should invalidate the repo queries after a successful attempt", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useNetworkAction(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.run(vi.fn<Action>().mockResolvedValue("x")));
    expect(spy).toHaveBeenCalledWith({ queryKey: ["repo", 1] });
  });

  it("should invalidate the repo queries after a failed attempt", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useNetworkAction(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() =>
      result.current.run(vi.fn<Action>().mockRejectedValue(networkError("hostUnreachable"))),
    );
    expect(spy).toHaveBeenCalledWith({ queryKey: ["repo", 1] });
  });

  it("should invalidate after each attempt of a retried run", async () => {
    const action = vi.fn<Action>().mockRejectedValueOnce(authError()).mockResolvedValueOnce("done");
    const { result, queryClient } = renderHookWithProviders(() => useNetworkAction(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    const outcome = start(result.current.run, action);
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.submit("me", "tok"));
    await act(async () => {
      await outcome;
    });
    expect(
      spy.mock.calls.filter(([f]) => JSON.stringify(f) === '{"queryKey":["repo",1]}'),
    ).toHaveLength(2);
  });

  it("should not invalidate another repo", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useNetworkAction(1));
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.run(vi.fn<Action>().mockResolvedValue("x")));
    expect(spy).not.toHaveBeenCalledWith({ queryKey: ["repo", 2] });
  });
});

// Contract: pending covers this instance's run (prompt included) and any network action of the repo.
describe("useNetworkAction pending", () => {
  it("should start idle", () => {
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    expect(result.current.pending).toBe(false);
  });

  it("should be pending from the start of a run until it settles", async () => {
    const d = deferred();
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    const outcome = start(result.current.run, () => d.promise);
    expect(result.current.pending).toBe(true);
    await act(async () => {
      d.resolve("x");
      await outcome;
    });
    expect(result.current.pending).toBe(false);
  });

  it("should stay pending while the prompt is open", async () => {
    const action = vi.fn<Action>().mockRejectedValue(authError());
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    start(result.current.run, action);
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    expect(result.current.pending).toBe(true);
  });

  it("should end pending after a cancel", async () => {
    const action = vi.fn<Action>().mockRejectedValue(authError());
    const { result } = renderHookWithProviders(() => useNetworkAction(1));
    const outcome = start(result.current.run, action);
    await waitFor(() => expect(result.current.prompt).not.toBeNull());
    act(() => result.current.prompt?.cancel());
    await act(async () => {
      await outcome;
    });
    expect(result.current.pending).toBe(false);
  });

  it("should be pending while another instance of the same repo runs, and not for another repo", async () => {
    const d = deferred();
    const { result } = renderHookWithProviders(() => ({
      first: useNetworkAction(1),
      second: useNetworkAction(1),
      other: useNetworkAction(2),
    }));
    const outcome = start(result.current.first.run, () => d.promise);
    await waitFor(() => expect(result.current.second.pending).toBe(true));
    expect(result.current.other.pending).toBe(false);
    await act(async () => {
      d.resolve("x");
      await outcome;
    });
    expect(result.current.second.pending).toBe(false);
  });

  it("should register a running action under the repo's network mutation key", async () => {
    const d = deferred();
    const { result, queryClient } = renderHookWithProviders(() => useNetworkAction(1));
    const outcome = start(result.current.run, () => d.promise);
    await waitFor(() => expect(queryClient.isMutating({ mutationKey: ["network", 1] })).toBe(1));
    expect(queryClient.isMutating({ mutationKey: ["network", 2] })).toBe(0);
    await act(async () => {
      d.resolve("x");
      await outcome;
    });
  });
});

// Contract: a prompt can help only for an HTTPS auth failure with a known origin.
describe("needsCredentials", () => {
  it.each<[string, AppError, boolean]>([
    ["httpsAuthRequired with an origin", authError("httpsAuthRequired"), true],
    ["httpsAuthRejected with an origin", authError("httpsAuthRejected"), true],
    [
      "an auth kind without https",
      networkError("httpsAuthRequired", { origin: "https://github.com" }),
      false,
    ],
    ["an auth kind without an origin", networkError("httpsAuthRequired", { https: true }), false],
    [
      "a non-auth network kind",
      networkError("hostUnreachable", { https: true, origin: "https://github.com" }),
      false,
    ],
    [
      "ssh auth failed",
      networkError("sshAuthFailed", { https: true, origin: "https://github.com" }),
      false,
    ],
    ["a non-network error", { kind: "io", message: "x" }, false],
    ["networkFailed without a payload", { kind: "networkFailed", message: "x" }, false],
  ])("should be %s -> %s", (_name, error, expected) => {
    expect(needsCredentials(error)).toBe(expected);
  });
});
