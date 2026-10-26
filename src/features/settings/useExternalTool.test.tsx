import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/query/client";
import { useShell } from "../../lib/store/shell";
import { useToasts } from "../../lib/store/toasts";
import { renderHookWithProviders } from "../../test/renderWithProviders";
import { resetSettings, seedSettings } from "../../test/settingsStore";
import { useExternalTool } from "./useExternalTool";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  updateSettings: vi.fn(),
}));

beforeEach(async () => {
  vi.resetAllMocks();
  await resetSettings();
  queryClient.clear();
  useShell.setState({ dialog: null, repoActions: null });
  useToasts.setState({ toasts: [] });
});

// Contract: configured iff settings.tools[key] is a non-null string.
describe("useExternalTool configured", () => {
  it("configured reflects settings.tools for each tool", async () => {
    await seedSettings({ tools: { editor: "code --wait", diffTool: null, mergeTool: "meld" } });
    const { result: editor } = renderHookWithProviders(() => useExternalTool("editor"));
    const { result: diff } = renderHookWithProviders(() => useExternalTool("diff"));
    const { result: merge } = renderHookWithProviders(() => useExternalTool("merge"));
    expect(editor.current.configured).toBe(true);
    expect(diff.current.configured).toBe(false);
    expect(merge.current.configured).toBe(true);
  });

  it("is not configured with the default settings", () => {
    const { result } = renderHookWithProviders(() => useExternalTool("editor"));
    expect(result.current.configured).toBe(false);
  });

  it("follows a later change to settings.tools", async () => {
    const { result } = renderHookWithProviders(() => useExternalTool("diff"));
    expect(result.current.configured).toBe(false);
    await act(() => seedSettings({ tools: { diffTool: "meld" } }));
    expect(result.current.configured).toBe(true);
  });
});

// Contract: run opens Settings at Tools and skips the call when the tool is unset.
describe("useExternalTool run — unset tool", () => {
  it("run opens Settings at Tools and skips the call when unset", async () => {
    const call = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useExternalTool("editor"));
    await act(() => result.current.run(call));
    expect(call).not.toHaveBeenCalled();
    expect(useShell.getState().dialog).toMatchObject({ kind: "settings", section: "tools" });
  });
});

// Contract: run calls through when the tool is set.
describe("useExternalTool run — configured tool", () => {
  it("run calls through when set", async () => {
    await seedSettings({ tools: { editor: "code --wait" } });
    const call = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHookWithProviders(() => useExternalTool("editor"));
    await act(() => result.current.run(call));
    expect(call).toHaveBeenCalledOnce();
    expect(useShell.getState().dialog).toBeNull();
  });
});

// Contract: run toasts Couldn't open <tool>: <message> with a Settings… action on rejection.
describe("useExternalTool run — rejection", () => {
  it("run toasts Couldn't open diff tool: <message> with a Settings… action on rejection", async () => {
    await seedSettings({ tools: { diffTool: "meld" } });
    const err = { kind: "externalToolFailed", message: "meld failed to start" };
    const call = vi.fn().mockRejectedValue(err);
    const { result } = renderHookWithProviders(() => useExternalTool("diff"));
    await act(() => result.current.run(call));
    const toasts = useToasts.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].text).toBe("Couldn't open diff tool: meld failed to start");
    expect(toasts[0].action?.label).toBe("Settings…");
  });

  it("Settings… action on the toast opens settings at tools", async () => {
    await seedSettings({ tools: { mergeTool: "meld" } });
    const call = vi.fn().mockRejectedValue({ kind: "externalToolFailed", message: "error" });
    const { result } = renderHookWithProviders(() => useExternalTool("merge"));
    await act(() => result.current.run(call));
    const toast = useToasts.getState().toasts[0];
    act(() => toast.action?.run());
    expect(useShell.getState().dialog).toMatchObject({ kind: "settings", section: "tools" });
  });
});
