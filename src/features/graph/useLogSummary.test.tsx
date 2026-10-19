import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLogSummary } from "../../lib/ipc";
import type { LogSummary } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useLogSummary } from "./useLogSummary";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getLogSummary: vi.fn(),
}));

const summary: LogSummary = { generation: 3, total: 1200, maxLanes: 4 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getLogSummary).mockResolvedValue(summary);
});

// Contract: the summary query calls getLogSummary for the repo under queryKeys.log.
describe("useLogSummary loading", () => {
  it("should call getLogSummary with the repo id", async () => {
    renderHookWithProviders(() => useLogSummary(5));
    await waitFor(() => expect(getLogSummary).toHaveBeenCalledExactlyOnceWith(5));
  });

  it("should expose the summary once it resolves", async () => {
    const { result } = renderHookWithProviders(() => useLogSummary(5));
    await waitFor(() => expect(result.current.summary).toEqual(summary));
  });

  it("should report loading and no summary before the first resolve", () => {
    vi.mocked(getLogSummary).mockReturnValue(new Promise(() => undefined));
    const { result } = renderHookWithProviders(() => useLogSummary(5));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.summary).toBeUndefined();
  });

  it("should stop loading and have no error after a successful resolve", async () => {
    const { result } = renderHookWithProviders(() => useLogSummary(5));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it("should store the summary under queryKeys.log for the repo", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useLogSummary(5));
    await waitFor(() => expect(result.current.summary).toBeDefined());
    expect(queryClient.getQueryData(queryKeys.log(5))).toEqual(summary);
  });

  it("should not store the summary under another repo's key", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useLogSummary(5));
    await waitFor(() => expect(result.current.summary).toBeDefined());
    expect(queryClient.getQueryData(queryKeys.log(6))).toBeUndefined();
  });
});

// Contract: failures arrive as AppError (toAppError mapping) and refetch retries.
describe("useLogSummary errors", () => {
  it("should expose an AppError rejection as error", async () => {
    vi.mocked(getLogSummary).mockRejectedValue({ kind: "git", message: "boom" });
    const { result } = renderHookWithProviders(() => useLogSummary(5));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "git", message: "boom" }));
  });

  it("should map a plain Error rejection to an io error with its message", async () => {
    vi.mocked(getLogSummary).mockRejectedValue(new Error("plain"));
    const { result } = renderHookWithProviders(() => useLogSummary(5));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "plain" }));
  });

  it("should leave the summary undefined when the call fails", async () => {
    vi.mocked(getLogSummary).mockRejectedValue({ kind: "git", message: "boom" });
    const { result } = renderHookWithProviders(() => useLogSummary(5));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.summary).toBeUndefined();
  });

  it("should call getLogSummary again when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useLogSummary(5));
    await waitFor(() => expect(result.current.summary).toBeDefined());
    result.current.refetch();
    await waitFor(() => expect(getLogSummary).toHaveBeenCalledTimes(2));
  });
});
