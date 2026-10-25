// Task 13: Failing tests for useExternalTool hook.
// These tests import modules/symbols that do not exist yet — red phase.

import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings, openExternalDiff, openExternalMerge, openInEditor } from "../../lib/ipc";
import type { Settings } from "../../lib/ipc";
import { queryClient } from "../../lib/query/client";
import { useShell } from "../../lib/store/shell";
import { useToasts } from "../../lib/store/toasts";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { useExternalTool } from "./useExternalTool";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(),
  openInEditor: vi.fn(),
  openExternalDiff: vi.fn(),
  openExternalMerge: vi.fn(),
}));

const makeSettings = (over: Partial<Settings> = {}): Settings => ({
  defaultCloneDir: null,
  gitExecutable: null,
  externalEditor: null,
  externalDiffTool: null,
  externalMergeTool: null,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  useShell.setState({ dialog: null, repoActions: null });
  useToasts.setState({ toasts: [] });
  vi.mocked(getSettings).mockResolvedValue(makeSettings());
});

// Contract: configured reflects whether the setting for the given tool is set.
describe("useExternalTool configured", () => {
  it("configured reflects the setting for each tool", async () => {
    vi.mocked(getSettings).mockResolvedValue(
      makeSettings({
        externalEditor: "code --wait",
        externalDiffTool: null,
        externalMergeTool: "meld",
      }),
    );
    const { result: editorResult } = renderHookWithProviders(() => useExternalTool("editor"));
    const { result: diffResult } = renderHookWithProviders(() => useExternalTool("diff"));
    const { result: mergeResult } = renderHookWithProviders(() => useExternalTool("merge"));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(editorResult.current.configured).toBe(true);
    expect(diffResult.current.configured).toBe(false);
    expect(mergeResult.current.configured).toBe(true);
  });
});

// Contract: run opens Settings at Tools and skips the call when the tool is unset.
describe("useExternalTool run — unset tool", () => {
  it("run opens Settings at Tools and skips the call when unset", async () => {
    vi.mocked(getSettings).mockResolvedValue(makeSettings({ externalEditor: null }));
    const call = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useExternalTool("editor"));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await act(() => result.current.run(call));
    expect(call).not.toHaveBeenCalled();
    expect(useShell.getState().dialog).toMatchObject({ kind: "settings", section: "tools" });
  });
});

// Contract: run calls through when the tool is set.
describe("useExternalTool run — configured tool", () => {
  it("run calls through when set", async () => {
    vi.mocked(getSettings).mockResolvedValue(makeSettings({ externalEditor: "code --wait" }));
    const call = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useExternalTool("editor"));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await act(() => result.current.run(call));
    expect(call).toHaveBeenCalledOnce();
    expect(useShell.getState().dialog).toBeNull();
  });
});

// Contract: run toasts Couldn't open <tool>: <message> with a Settings… action on rejection.
describe("useExternalTool run — rejection", () => {
  it("run toasts Couldn't open diff tool: <message> with a Settings… action on rejection", async () => {
    vi.mocked(getSettings).mockResolvedValue(makeSettings({ externalDiffTool: "meld" }));
    const err = { kind: "externalToolFailed", message: "meld failed to start" };
    const call = vi.fn().mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useExternalTool("diff"));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await act(() => result.current.run(call));
    const toasts = useToasts.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].text).toBe("Couldn't open diff tool: meld failed to start");
    expect(toasts[0].action).not.toBeNull();
    expect(toasts[0].action?.label).toBe("Settings…");
  });

  it("Settings… action on the toast opens settings at tools", async () => {
    vi.mocked(getSettings).mockResolvedValue(makeSettings({ externalMergeTool: "meld" }));
    const err = { kind: "externalToolFailed", message: "error" };
    const call = vi.fn().mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useExternalTool("merge"));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    await act(() => result.current.run(call));
    const toast = useToasts.getState().toasts[0];
    act(() => toast.action?.run());
    expect(useShell.getState().dialog).toMatchObject({ kind: "settings", section: "tools" });
  });
});

// unused imports satisfy linter
void openInEditor;
void openExternalDiff;
void openExternalMerge;
