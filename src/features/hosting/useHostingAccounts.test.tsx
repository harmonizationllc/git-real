import { QueryObserver } from "@tanstack/react-query";
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostingListAccounts } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { hostingAccount } from "../../test/hostingFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { invalidateHosting, useHostingAccounts } from "./useHostingAccounts";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  hostingListAccounts: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(hostingListAccounts).mockResolvedValue([hostingAccount()]);
});

// Contract: the connected accounts are a global query under ["hosting", "accounts"].
describe("useHostingAccounts", () => {
  it("should load the accounts through hostingListAccounts", async () => {
    const { result } = renderHookWithProviders(() => useHostingAccounts());
    await waitFor(() => expect(result.current.accounts).toEqual([hostingAccount()]));
  });

  it("should have no accounts and no error while loading", () => {
    vi.mocked(hostingListAccounts).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useHostingAccounts());
    expect([result.current.accounts, result.current.error]).toEqual([undefined, null]);
  });

  it("should cache under queryKeys.hostingAccounts", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useHostingAccounts());
    await waitFor(() => expect(result.current.accounts).toBeDefined());
    expect(queryClient.getQueryData(queryKeys.hostingAccounts)).toEqual([hostingAccount()]);
  });

  it("should map a rejection into error", async () => {
    vi.mocked(hostingListAccounts).mockRejectedValue({ kind: "io", message: "x" });
    const { result } = renderHookWithProviders(() => useHostingAccounts());
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "x" }));
  });

  it("should map a plain Error rejection to an io error", async () => {
    vi.mocked(hostingListAccounts).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useHostingAccounts());
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });

  it("should query again when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useHostingAccounts());
    await waitFor(() => expect(result.current.accounts).toBeDefined());
    result.current.refetch();
    await waitFor(() => expect(hostingListAccounts).toHaveBeenCalledTimes(2));
  });
});

// Contract: invalidateHosting refetches accounts, pull requests and every repo's hosting context only.
describe("invalidateHosting", () => {
  /** Subscribes an observer per key, so an invalidation refetches it; returns the fetch spies. */
  async function observed() {
    const { queryClient } = renderHookWithProviders(() => useHostingAccounts());
    const keys = {
      pullRequests: queryKeys.pullRequests(1),
      context1: queryKeys.hostingContext(1),
      context2: queryKeys.hostingContext(2),
      status: queryKeys.status(1),
    };
    const spies = Object.fromEntries(
      Object.entries(keys).map(([name, queryKey]) => {
        const queryFn = vi.fn().mockResolvedValue(null);
        new QueryObserver(queryClient, { queryKey, queryFn }).subscribe(() => undefined);
        return [name, queryFn];
      }),
    ) as Record<keyof typeof keys, ReturnType<typeof vi.fn>>;
    await waitFor(() => expect(spies.status).toHaveBeenCalledTimes(1));
    await act(() => invalidateHosting(queryClient));
    return spies;
  }

  it("should refetch the active accounts query", async () => {
    const { queryClient } = renderHookWithProviders(() => useHostingAccounts());
    await waitFor(() => expect(hostingListAccounts).toHaveBeenCalledTimes(1));
    await act(() => invalidateHosting(queryClient));
    expect(hostingListAccounts).toHaveBeenCalledTimes(2);
  });

  it("should refetch the pull requests", async () => {
    const spies = await observed();
    expect(spies.pullRequests).toHaveBeenCalledTimes(2);
  });

  it("should refetch the hosting context of every repo", async () => {
    const spies = await observed();
    expect([spies.context1.mock.calls.length, spies.context2.mock.calls.length]).toEqual([2, 2]);
  });

  it("should leave other repo queries such as status alone", async () => {
    const spies = await observed();
    expect(spies.status).toHaveBeenCalledTimes(1);
  });
});
