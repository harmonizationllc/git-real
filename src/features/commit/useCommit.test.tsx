import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commit } from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useCommitDraft } from "../../lib/store/commitDraft";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useCommit } from "./useCommit";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  commit: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  useCommitDraft.setState({ drafts: {} });
  useCommitDraft.getState().setSubject(1, "typed");
});

describe("useCommit", () => {
  it("calls commit with repo id, message and amend", async () => {
    vi.mocked(commit).mockResolvedValue({ oid: "abc", summary: "S" });
    const { result } = renderHookWithProviders(() => useCommit(1));
    act(() => result.current.commit({ subject: "S", body: "B" }, true));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(commit).toHaveBeenCalledExactlyOnceWith(1, { subject: "S", body: "B" }, true);
  });

  it("clears the draft and invalidates the repo prefix on success", async () => {
    vi.mocked(commit).mockResolvedValue({ oid: "abc", summary: "S" });
    const { result, queryClient } = renderHookWithProviders(() => useCommit(1));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    act(() => result.current.commit({ subject: "S", body: "" }, false));
    await waitFor(() => expect(useCommitDraft.getState().drafts[1]).toBeUndefined());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.repo(1) });
  });

  it("keeps the draft, exposes the error and still invalidates on failure", async () => {
    const err: AppError = { kind: "commitFailed", message: "hook says no" };
    vi.mocked(commit).mockRejectedValue(err);
    const { result, queryClient } = renderHookWithProviders(() => useCommit(1));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    act(() => result.current.commit({ subject: "S", body: "" }, false));
    await waitFor(() => expect(result.current.error).toEqual(err));
    expect(useCommitDraft.getState().drafts[1]).toMatchObject({ subject: "typed" });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.repo(1) });
  });

  it("wraps a non-AppError rejection as io and clearError resets it", async () => {
    vi.mocked(commit).mockRejectedValue(new Error("boom"));
    const { result } = renderHookWithProviders(() => useCommit(1));
    act(() => result.current.commit({ subject: "S", body: "" }, false));
    await waitFor(() => expect(result.current.error).toEqual({ kind: "io", message: "boom" }));
    act(() => result.current.clearError());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("reports pending while the commit runs", async () => {
    let resolve: (v: { oid: string; summary: string }) => void = () => undefined;
    vi.mocked(commit).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { result } = renderHookWithProviders(() => useCommit(1));
    act(() => result.current.commit({ subject: "S", body: "" }, false));
    await waitFor(() => expect(result.current.pending).toBe(true));
    act(() => resolve({ oid: "a", summary: "S" }));
    await waitFor(() => expect(result.current.pending).toBe(false));
  });
});

describe("useCommit clearError", () => {
  it("is a harmless no-op after a successful commit", async () => {
    vi.mocked(commit).mockResolvedValue({ oid: "abc", summary: "S" });
    const { result } = renderHookWithProviders(() => useCommit(1));
    act(() => result.current.commit({ subject: "S", body: "" }, false));
    await waitFor(() => expect(useCommitDraft.getState().drafts[1]).toBeUndefined());
    await waitFor(() => expect(result.current.pending).toBe(false));
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
    expect(useCommitDraft.getState().drafts[1]).toBeUndefined();
  });
});
