import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFileDiff } from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { fileDiff, hunk, L } from "../../test/diffFixtures";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useFileDiff } from "./useFileDiff";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getFileDiff: vi.fn(),
}));

const diff = fileDiff([hunk([L("addition", "x", null, 1)])]);
const file = { path: "a.ts", scope: "unstaged" } as const;
const noChanges: AppError = { kind: "noChanges", message: "no changes" };
const gitError: AppError = { kind: "git", message: "boom" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFileDiff).mockResolvedValue(diff);
});

// Contract: the query is disabled until a file is selected.
describe("useFileDiff enablement", () => {
  it("should not call getFileDiff when file is null", () => {
    renderHookWithProviders(() => useFileDiff(1, null, false, null));
    expect(getFileDiff).not.toHaveBeenCalled();
  });
  it("should not report loading when file is null", () => {
    const { result } = renderHookWithProviders(() => useFileDiff(1, null, false, null));
    expect(result.current.loading).toBe(false);
  });
  it("should have no diff when file is null", () => {
    const { result } = renderHookWithProviders(() => useFileDiff(1, null, false, null));
    expect(result.current.diff).toBeUndefined();
  });
});

// Contract: arguments are forwarded to getFileDiff, null maxLines becoming undefined.
describe("useFileDiff request", () => {
  it("should pass undefined maxLines when maxLines is null", async () => {
    renderHookWithProviders(() => useFileDiff(1, file, true, null));
    await waitFor(() => expect(getFileDiff).toHaveBeenCalled());
    expect(getFileDiff).toHaveBeenCalledWith(1, "a.ts", "unstaged", true, undefined);
  });
  it("should pass a numeric maxLines through", async () => {
    renderHookWithProviders(() => useFileDiff(1, file, false, 1_000_000));
    await waitFor(() => expect(getFileDiff).toHaveBeenCalled());
    expect(getFileDiff).toHaveBeenCalledWith(1, "a.ts", "unstaged", false, 1_000_000);
  });
});

// Contract: a successful fetch exposes the diff.
describe("useFileDiff success", () => {
  it("should expose the resolved diff", async () => {
    const { result } = renderHookWithProviders(() => useFileDiff(1, file, false, null));
    await waitFor(() => expect(result.current.diff).toEqual(diff));
  });
  it("should report noChanges false and no error", async () => {
    const { result } = renderHookWithProviders(() => useFileDiff(1, file, false, null));
    await waitFor(() => expect(result.current.diff).toBeDefined());
    expect(result.current.noChanges).toBe(false);
    expect(result.current.error).toBeNull();
  });
  it("should report loading until the query resolves", async () => {
    const { result } = renderHookWithProviders(() => useFileDiff(1, file, false, null));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});

// Contract: errors are mapped; noChanges is a state, not an error.
describe("useFileDiff errors", () => {
  it("should report noChanges with no error and no diff", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(noChanges);
    const { result } = renderHookWithProviders(() => useFileDiff(1, file, false, null));
    await waitFor(() => expect(result.current.noChanges).toBe(true));
    expect(result.current.error).toBeNull();
    expect(result.current.diff).toBeUndefined();
  });
  it("should expose a git error", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    const { result } = renderHookWithProviders(() => useFileDiff(1, file, false, null));
    await waitFor(() => expect(result.current.error?.kind).toBe("git"));
    expect(result.current.noChanges).toBe(false);
  });
  it("should map a non-AppError rejection to an io error", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(new Error("x"));
    const { result } = renderHookWithProviders(() => useFileDiff(1, file, false, null));
    await waitFor(() => expect(result.current.error?.kind).toBe("io"));
  });
  it("should not retry a failing request", async () => {
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    const { result } = renderHookWithProviders(() => useFileDiff(1, file, false, null));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(getFileDiff).toHaveBeenCalledTimes(1);
  });
});

// Contract: after a successful fetch, a failing refetch must not leave a stale diff behind.
describe("useFileDiff refetch", () => {
  it("should call getFileDiff again on refetch", async () => {
    const { result } = renderHookWithProviders(() => useFileDiff(1, file, false, null));
    await waitFor(() => expect(result.current.diff).toBeDefined());
    act(() => result.current.refetch());
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledTimes(2));
  });
  it("should drop the diff and report noChanges when a refetch rejects with noChanges", async () => {
    const { result } = renderHookWithProviders(() => useFileDiff(1, file, false, null));
    await waitFor(() => expect(result.current.diff).toBeDefined());
    vi.mocked(getFileDiff).mockRejectedValue(noChanges);
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.noChanges).toBe(true));
    expect(result.current.diff).toBeUndefined();
    expect(result.current.error).toBeNull();
  });
  it("should drop the diff when a refetch rejects with a git error", async () => {
    const { result } = renderHookWithProviders(() => useFileDiff(1, file, false, null));
    await waitFor(() => expect(result.current.diff).toBeDefined());
    vi.mocked(getFileDiff).mockRejectedValue(gitError);
    act(() => result.current.refetch());
    await waitFor(() => expect(result.current.error?.kind).toBe("git"));
    expect(result.current.diff).toBeUndefined();
  });
});

// Contract: query inputs are part of the key, so changing them refetches.
describe("useFileDiff keys", () => {
  it("should request again when ignoreWhitespace changes", async () => {
    let ws = false;
    const { rerender } = renderHookWithProviders(() => useFileDiff(1, file, ws, null));
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledTimes(1));
    ws = true;
    rerender();
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledTimes(2));
    expect(getFileDiff).toHaveBeenLastCalledWith(1, "a.ts", "unstaged", true, undefined);
  });
  it("should request again when maxLines changes", async () => {
    let max: number | null = null;
    const { rerender } = renderHookWithProviders(() => useFileDiff(1, file, false, max));
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledTimes(1));
    max = 1_000_000;
    rerender();
    await waitFor(() => expect(getFileDiff).toHaveBeenCalledTimes(2));
    expect(getFileDiff).toHaveBeenLastCalledWith(1, "a.ts", "unstaged", false, 1_000_000);
  });
});
