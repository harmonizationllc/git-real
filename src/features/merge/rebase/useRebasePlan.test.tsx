import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { rebasePlan } from "../../../lib/ipc";
import type { AppError, RebaseCommit } from "../../../lib/ipc";
import { queryKeys } from "../../../lib/query/keys";
import { renderHookWithProviders } from "../../../test/renderWithProviders";
import { useRebasePlan } from "./useRebasePlan";

vi.mock(import("../../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  rebasePlan: vi.fn(),
}));

const commits: RebaseCommit[] = [
  { oid: "a".repeat(40), subject: "first", author: { name: "Ann", email: "a@x.io", time: 1 } },
];
const failure: AppError = { kind: "badSelection", message: "not an ancestor" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(rebasePlan).mockResolvedValue(commits);
});

// Contract: the plan is the commits git would replay, fetched for (repo, base).
describe("useRebasePlan data", () => {
  it("should be loading with no commits before the plan arrives", () => {
    vi.mocked(rebasePlan).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useRebasePlan(4, "main"));
    expect(result.current).toEqual({ commits: undefined, error: null, loading: true });
  });

  it("should resolve the commits and stop loading", async () => {
    const { result } = renderHookWithProviders(() => useRebasePlan(4, "main"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ commits, error: null, loading: false });
  });

  it("should call rebasePlan with the repo id and base", async () => {
    const { result } = renderHookWithProviders(() => useRebasePlan(4, "feature"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(rebasePlan).toHaveBeenCalledExactlyOnceWith(4, "feature");
  });

  it("should cache the plan under queryKeys.rebasePlan", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRebasePlan(4, "main"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(queryClient.getQueryData(queryKeys.rebasePlan(4, "main"))).toEqual(commits);
  });

  it("should fetch again for a different base", async () => {
    const { result, rerender } = renderHookWithProviders((props?: { base: string }) =>
      useRebasePlan(4, props?.base ?? "main"),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ base: "other" });
    await waitFor(() => expect(rebasePlan).toHaveBeenCalledWith(4, "other"));
  });
});

// Contract: failures surface as an AppError and are never retried.
describe("useRebasePlan errors", () => {
  it("should expose a rejected AppError as error and leave commits undefined", async () => {
    vi.mocked(rebasePlan).mockRejectedValue(failure);
    const { result } = renderHookWithProviders(() => useRebasePlan(4, "main"));
    await waitFor(() => expect(result.current.error).toEqual(failure));
    expect(result.current.commits).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });

  it("should map a non-AppError rejection to an io error", async () => {
    vi.mocked(rebasePlan).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useRebasePlan(4, "main"));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });

  it("should not retry a failed plan even when the client would", async () => {
    vi.mocked(rebasePlan).mockRejectedValue(failure);
    const client = new QueryClient({ defaultOptions: { queries: { retry: 3, retryDelay: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRebasePlan(4, "main"), { wrapper });
    await waitFor(() => expect(result.current.error).toEqual(failure));
    await new Promise((r) => setTimeout(r, 20));
    expect(rebasePlan).toHaveBeenCalledTimes(1);
  });
});
