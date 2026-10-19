import { focusManager } from "@tanstack/react-query";
import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOperationState } from "../../lib/ipc";
import type { AppError, OperationState } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useOperationState } from "./useOperationState";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getOperationState: vi.fn(),
}));

const state: OperationState = {
  kind: "merge",
  head: "a".repeat(40),
  branch: "feature",
  message: { subject: "Merge branch 'feature'", body: "" },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getOperationState).mockResolvedValue(state);
});

// Contract: useOperationState queries getOperationState under the operation key.
describe("useOperationState", () => {
  it("should report no state before the query resolves", () => {
    const { result } = renderHookWithProviders(() => useOperationState(1));
    expect(result.current.state).toBeUndefined();
  });

  it("should expose the state returned by getOperationState", async () => {
    const { result } = renderHookWithProviders(() => useOperationState(3));
    await waitFor(() => expect(result.current.state).toEqual(state));
    expect(getOperationState).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("should cache the state under the operation key", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useOperationState(3));
    await waitFor(() => expect(result.current.state).toBeDefined());
    expect(queryClient.getQueryData(queryKeys.operation(3))).toEqual(state);
  });

  it("should have a null error while the query succeeds", async () => {
    const { result } = renderHookWithProviders(() => useOperationState(1));
    await waitFor(() => expect(result.current.state).toBeDefined());
    expect(result.current.error).toBeNull();
  });

  it("should expose a rejected AppError as error", async () => {
    const err: AppError = { kind: "unknownRepo", message: "gone" };
    vi.mocked(getOperationState).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useOperationState(1));
    await waitFor(() => expect(result.current.error).toEqual(err));
  });

  it("should map a non-AppError rejection to an io error", async () => {
    vi.mocked(getOperationState).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useOperationState(1));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
  });

  it("should query again when refetch is called", async () => {
    const { result } = renderHookWithProviders(() => useOperationState(1));
    await waitFor(() => expect(result.current.state).toBeDefined());
    result.current.refetch();
    await waitFor(() => expect(getOperationState).toHaveBeenCalledTimes(2));
  });
});

// Coverage audit: freshness triggers named by the brief.
describe("useOperationState freshness", () => {
  it("should query again when the window regains focus", async () => {
    const { result } = renderHookWithProviders(() => useOperationState(1));
    await waitFor(() => expect(result.current.state).toBeDefined());
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await waitFor(() => expect(getOperationState).toHaveBeenCalledTimes(2));
    focusManager.setFocused(undefined);
  });

  it("should query again when the repo prefix is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useOperationState(1));
    await waitFor(() => expect(result.current.state).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(1) }));
    expect(getOperationState).toHaveBeenCalledTimes(2);
  });

  it("should not query again when another repo is invalidated", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useOperationState(1));
    await waitFor(() => expect(result.current.state).toBeDefined());
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.repo(2) }));
    expect(getOperationState).toHaveBeenCalledTimes(1);
  });

  it("should expose the new state after a refetch returns one", async () => {
    const { result } = renderHookWithProviders(() => useOperationState(1));
    await waitFor(() => expect(result.current.state).toEqual(state));
    vi.mocked(getOperationState).mockResolvedValue({ kind: "none" });
    result.current.refetch();
    await waitFor(() => expect(result.current.state).toEqual({ kind: "none" }));
  });
});
