import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { canFastForward } from "../../lib/ipc";
import { createQueryClient } from "../../lib/query/client";
import { queryKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useCanFastForward } from "./useCanFastForward";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  canFastForward: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(canFastForward).mockResolvedValue("possible");
});

// Contract: the check runs only for a given branch and is never served stale.
describe("useCanFastForward", () => {
  it("should report loading with no check before the query resolves", () => {
    const { result } = renderHookWithProviders(() => useCanFastForward(1, "feature"));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.check).toBeUndefined();
  });

  it("should expose the check returned by canFastForward", async () => {
    const { result } = renderHookWithProviders(() => useCanFastForward(2, "feature"));
    await waitFor(() => expect(result.current.check).toBe("possible"));
    expect(canFastForward).toHaveBeenCalledExactlyOnceWith(2, "feature");
  });

  it("should stop loading once the check arrived", async () => {
    const { result } = renderHookWithProviders(() => useCanFastForward(1, "feature"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it("should stop loading with no check when canFastForward rejects", async () => {
    vi.mocked(canFastForward).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useCanFastForward(1, "feature"));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.check).toBeUndefined();
  });

  it("should not query when the branch is null", async () => {
    const { result } = renderHookWithProviders(() => useCanFastForward(1, null));
    await Promise.resolve();
    expect(canFastForward).not.toHaveBeenCalled();
    expect(result.current.check).toBeUndefined();
  });

  it("should not report loading when the branch is null", () => {
    const { result } = renderHookWithProviders(() => useCanFastForward(1, null));
    expect(result.current.isLoading).toBe(false);
  });

  it("should cache the check under a key that includes the branch", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useCanFastForward(2, "feature"));
    await waitFor(() => expect(result.current.check).toBeDefined());
    expect(queryClient.getQueryData(queryKeys.fastForward(2, "feature"))).toBe("possible");
    expect(queryClient.getQueryData(queryKeys.fastForward(2, "other"))).toBeUndefined();
  });

  it("should query the new branch when the branch changes", async () => {
    vi.mocked(canFastForward).mockImplementation((_id, branch) =>
      Promise.resolve(branch === "a" ? "possible" : "diverged"),
    );
    const queryClient = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(({ branch }) => useCanFastForward(1, branch), {
      wrapper,
      initialProps: { branch: "a" },
    });
    await waitFor(() => expect(result.current.check).toBe("possible"));
    rerender({ branch: "b" });
    await waitFor(() => expect(result.current.check).toBe("diverged"));
  });

  it("should check again when the hook mounts a second time", async () => {
    const queryClient = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const first = renderHook(() => useCanFastForward(1, "feature"), { wrapper });
    await waitFor(() => expect(first.result.current.check).toBe("possible"));
    first.unmount();
    const second = renderHook(() => useCanFastForward(1, "feature"), { wrapper });
    await waitFor(() => expect(canFastForward).toHaveBeenCalledTimes(2));
    second.unmount();
  });
});
