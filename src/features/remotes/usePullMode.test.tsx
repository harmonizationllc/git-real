import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pullDefaultMode } from "../../lib/ipc";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { usePullMode } from "./usePullMode";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  pullDefaultMode: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(pullDefaultMode).mockResolvedValue("rebase");
});

// Contract: the default pull mode of a repo; merge until loaded and on error.
describe("usePullMode", () => {
  it("should call pullDefaultMode with the repo id", async () => {
    renderHookWithProviders(() => usePullMode(7));
    await waitFor(() => expect(pullDefaultMode).toHaveBeenCalledExactlyOnceWith(7));
  });

  it("should be merge until loaded", () => {
    vi.mocked(pullDefaultMode).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => usePullMode(1));
    expect(result.current).toBe("merge");
  });

  it("should expose the loaded mode", async () => {
    const { result } = renderHookWithProviders(() => usePullMode(1));
    await waitFor(() => expect(result.current).toBe("rebase"));
  });

  it("should be merge on error", async () => {
    vi.mocked(pullDefaultMode).mockRejectedValue(new Error("boom"));
    const { result, queryClient } = renderHookWithProviders(() => usePullMode(1));
    await waitFor(() =>
      expect(queryClient.getQueryState(["repo", 1, "pullMode"])?.status).toBe("error"),
    );
    expect(result.current).toBe("merge");
  });

  it("should cache under queryKeys.pullMode", async () => {
    const { result, queryClient } = renderHookWithProviders(() => usePullMode(1));
    await waitFor(() => expect(result.current).toBe("rebase"));
    expect(queryClient.getQueryData(["repo", 1, "pullMode"])).toBe("rebase");
  });

  it("should refetch when the repo prefix is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => usePullMode(1));
    await waitFor(() => expect(result.current).toBe("rebase"));
    vi.mocked(pullDefaultMode).mockResolvedValue("merge");
    await queryClient.invalidateQueries({ queryKey: ["repo", 1] });
    await waitFor(() => expect(result.current).toBe("merge"));
  });
});
