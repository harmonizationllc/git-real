// Task 13: Failing tests for useSettings hook.
// These tests import modules/symbols that do not exist yet — red phase.

import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkGitCli, getSettings, updateSettings } from "../../lib/ipc";
import type { AppError, Settings } from "../../lib/ipc";
import { queryClient } from "../../lib/query/client";
import { queryKeys } from "../../lib/query/keys";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useSettings } from "./useSettings";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  checkGitCli: vi.fn(),
}));

const defaultSettings: Settings = {
  defaultCloneDir: null,
  gitExecutable: null,
  externalEditor: null,
  externalDiffTool: null,
  externalMergeTool: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  vi.mocked(getSettings).mockResolvedValue(defaultSettings);
  vi.mocked(checkGitCli).mockResolvedValue({
    available: true,
    path: "/usr/bin/git",
    version: "2.43.0",
    error: null,
  });
});

// Contract: useSettings queries getSettings under the settings key.
describe("useSettings query", () => {
  it("loads settings under the settings key", async () => {
    const { result } = renderHookWithProviders(() => useSettings());
    await waitFor(() => expect(result.current.settings).toBeDefined());
    expect(getSettings).toHaveBeenCalled();
    expect(result.current.settings).toEqual(defaultSettings);
    expect(result.current.error).toBeNull();
  });

  it("exposes saving as false when idle", async () => {
    const { result } = renderHookWithProviders(() => useSettings());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(result.current.saving).toBe(false);
  });
});

// Contract: update writes the returned settings into the TanStack Query cache.
describe("useSettings update", () => {
  it("update writes the returned settings into the cache", async () => {
    const updated: Settings = { ...defaultSettings, externalEditor: "code --wait" };
    vi.mocked(updateSettings).mockResolvedValue(updated);
    const { result, queryClient: qc } = renderHookWithProviders(() => useSettings());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await act(() => result.current.update({ externalEditor: "code --wait" }));
    const cached = qc.getQueryData<Settings>(queryKeys.settings);
    expect(cached).toEqual(updated);
  });

  it("update invalidates gitCli only when the patch has gitExecutable", async () => {
    vi.mocked(updateSettings).mockResolvedValue(defaultSettings);
    const { result, queryClient: qc } = renderHookWithProviders(() => useSettings());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    // Patch without gitExecutable: gitCli must NOT be invalidated.
    await act(() => result.current.update({ externalEditor: "code" }));
    const gitCliCallsBefore = invalidateSpy.mock.calls.filter((c) =>
      JSON.stringify(c[0]).includes("gitCli"),
    ).length;
    expect(gitCliCallsBefore).toBe(0);

    // Patch with gitExecutable: gitCli MUST be invalidated.
    await act(() => result.current.update({ gitExecutable: "/usr/bin/git" }));
    const gitCliCallsAfter = invalidateSpy.mock.calls.filter((c) =>
      JSON.stringify(c[0]).includes("gitCli"),
    ).length;
    expect(gitCliCallsAfter).toBeGreaterThan(0);
  });

  it("update rejects with the AppError", async () => {
    const err: AppError = { kind: "invalidSettings", message: "bad path" };
    vi.mocked(updateSettings).mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useSettings());
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await expect(act(() => result.current.update({ defaultCloneDir: "relative" }))).rejects.toBe(
      err,
    );
  });
});
