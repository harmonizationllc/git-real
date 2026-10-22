import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostingConnect, hostingDisconnect } from "../../lib/ipc";
import { hostingAccount, hostingError } from "../../test/hostingFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useAccountActions } from "./useAccountActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingConnect: vi.fn(),
  hostingDisconnect: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const TOKEN = "ghp_supersecret";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hostingConnect).mockResolvedValue(hostingAccount());
  vi.mocked(hostingDisconnect).mockResolvedValue(undefined);
});

// Contract: connect resolves with the account or the AppError and never rejects.
describe("useAccountActions connect", () => {
  it("should call hostingConnect with provider, host and token and resolve the account", async () => {
    const { result } = renderHookWithProviders(() => useAccountActions());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.connect("github", null, "t");
    });
    expect(hostingConnect).toHaveBeenCalledExactlyOnceWith("github", null, "t");
    expect(outcome).toEqual({ account: hostingAccount() });
  });

  it("should pass a custom host through", async () => {
    const { result } = renderHookWithProviders(() => useAccountActions());
    await act(() => result.current.connect("gitlab", "git.corp", "t"));
    expect(hostingConnect).toHaveBeenCalledExactlyOnceWith("gitlab", "git.corp", "t");
  });

  it("should resolve the AppError when the command rejects", async () => {
    const error = hostingError("hostingAuth");
    vi.mocked(hostingConnect).mockRejectedValue(error);
    const { result } = renderHookWithProviders(() => useAccountActions());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.connect("github", null, "t");
    });
    expect(outcome).toEqual({ error });
  });

  it("should turn a plain Error rejection into an io error", async () => {
    vi.mocked(hostingConnect).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useAccountActions());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.connect("github", null, "t");
    });
    expect(outcome).toEqual({ error: { kind: "io", message: "boom" } });
  });
});

// Contract: disconnect resolves null on success and the AppError on failure.
describe("useAccountActions disconnect", () => {
  it("should call hostingDisconnect with the account id and resolve null", async () => {
    const { result } = renderHookWithProviders(() => useAccountActions());
    let outcome: unknown = "unset";
    await act(async () => {
      outcome = await result.current.disconnect("github:github.com:octo");
    });
    expect(hostingDisconnect).toHaveBeenCalledExactlyOnceWith("github:github.com:octo");
    expect(outcome).toBeNull();
  });

  it("should resolve the AppError when the command rejects", async () => {
    const error = hostingError("keychainUnavailable");
    vi.mocked(hostingDisconnect).mockRejectedValue(error);
    const { result } = renderHookWithProviders(() => useAccountActions());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.disconnect("x");
    });
    expect(outcome).toEqual(error);
  });
});

// Contract: accounts, pull requests and hosting contexts refresh after every connect or disconnect.
describe("useAccountActions invalidation", () => {
  it("should invalidate the hosting keys after a successful connect", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useAccountActions());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.connect("github", null, "t"));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["hosting"] }));
  });

  it("should invalidate the hosting keys after a failed connect", async () => {
    vi.mocked(hostingConnect).mockRejectedValue(hostingError("hostingAuth"));
    const { result, queryClient } = renderHookWithProviders(() => useAccountActions());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.connect("github", null, "t"));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["hosting"] }));
  });

  it("should invalidate the hosting keys after a disconnect", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useAccountActions());
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    await act(() => result.current.disconnect("x"));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ["hosting"] }));
  });
});

// Contract: pending covers a connect or a disconnect in flight.
describe("useAccountActions pending", () => {
  it("should be idle at first", () => {
    const { result } = renderHookWithProviders(() => useAccountActions());
    expect(result.current.pending).toBe(false);
  });

  it("should be pending while connect runs and idle after", async () => {
    const call = deferred<ReturnType<typeof hostingAccount>>();
    vi.mocked(hostingConnect).mockReturnValue(call.promise);
    const { result } = renderHookWithProviders(() => useAccountActions());
    let outcome!: Promise<unknown>;
    act(() => {
      outcome = result.current.connect("github", null, "t");
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => {
      call.resolve(hostingAccount());
      await outcome;
    });
    expect(result.current.pending).toBe(false);
  });

  it("should be pending while disconnect runs", async () => {
    const call = deferred<undefined>();
    vi.mocked(hostingDisconnect).mockReturnValue(call.promise);
    const { result } = renderHookWithProviders(() => useAccountActions());
    let outcome!: Promise<unknown>;
    act(() => {
      outcome = result.current.disconnect("x");
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    await act(async () => {
      call.resolve(undefined);
      await outcome;
    });
    expect(result.current.pending).toBe(false);
  });
});

// Contract: the token crosses the hook once and never rests in the TanStack mutation cache.
describe("useAccountActions token hygiene", () => {
  it("should hold no mutation carrying the token after a successful connect", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useAccountActions());
    await act(() => result.current.connect("github", null, TOKEN));
    expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain(TOKEN);
  });

  it("should hold no mutation carrying the token after a failed connect", async () => {
    vi.mocked(hostingConnect).mockRejectedValue(hostingError("hostingAuth"));
    const { result, queryClient } = renderHookWithProviders(() => useAccountActions());
    await act(() => result.current.connect("github", null, TOKEN));
    expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain(TOKEN);
  });

  it("should not expose the token in the mutation cache while connect is in flight", async () => {
    const call = deferred<ReturnType<typeof hostingAccount>>();
    vi.mocked(hostingConnect).mockReturnValue(call.promise);
    const { result, queryClient } = renderHookWithProviders(() => useAccountActions());
    let outcome!: Promise<unknown>;
    act(() => {
      outcome = result.current.connect("github", null, TOKEN);
    });
    await waitFor(() => expect(result.current.pending).toBe(true));
    expect(JSON.stringify(queryClient.getMutationCache().getAll())).not.toContain(TOKEN);
    await act(async () => {
      call.resolve(hostingAccount());
      await outcome;
    });
  });

  it("should leave no mutation in the cache once connect settles", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useAccountActions());
    await act(() => result.current.connect("github", null, TOKEN));
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toEqual([]));
  });
});
