import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHECK_INTERVAL_MS, STARTUP_DELAY_MS, useUpdateState } from "../lib/store/updateState";
import { resetSettings, seedSettings } from "../test/settingsStore";
import { useToasts } from "../lib/store/toasts";
import { useUpdateCheck } from "./useUpdateCheck";

vi.mock(import("../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  checkForUpdate: vi.fn(),
  updateSettings: vi.fn(),
  openExternal: vi.fn(),
}));

beforeEach(async () => {
  vi.resetAllMocks();
  await resetSettings();
  vi.useFakeTimers();
  useToasts.setState({ toasts: [] });
  useUpdateState.setState(useUpdateState.getInitialState(), true);
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

// Contract: waits STARTUP_DELAY_MS then calls checkForUpdate on first mount
// when checkOnStartup=true and lastCheckedAt=null.
describe("useUpdateCheck startup check", () => {
  it("should call checkForUpdate after STARTUP_DELAY_MS when never checked", async () => {
    const { checkForUpdate } = await import("../lib/ipc");
    vi.mocked(checkForUpdate).mockResolvedValue({
      current: "0.1.0",
      latest: null,
      available: false,
      url: null,
    });
    renderHook(() => useUpdateCheck());
    expect(vi.mocked(checkForUpdate)).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 1_000));
    expect(checkForUpdate).toHaveBeenCalledOnce();
  });

  it("should not call checkForUpdate before STARTUP_DELAY_MS elapses", async () => {
    const { checkForUpdate } = await import("../lib/ipc");
    renderHook(() => useUpdateCheck());
    act(() => {
      vi.advanceTimersByTime(STARTUP_DELAY_MS - 1);
    });
    expect(checkForUpdate).not.toHaveBeenCalled();
  });
});

// Contract: does nothing when checkOnStartup is false.
describe("useUpdateCheck disabled", () => {
  it("should not call checkForUpdate when checkOnStartup is false", async () => {
    const { checkForUpdate } = await import("../lib/ipc");
    await seedSettings({ updates: { checkOnStartup: false } });
    renderHook(() => useUpdateCheck());
    act(() => {
      vi.advanceTimersByTime(STARTUP_DELAY_MS + 1000);
    });
    expect(checkForUpdate).not.toHaveBeenCalled();
  });
});

// Contract: skips the check if lastCheckedAt is within CHECK_INTERVAL_MS.
describe("useUpdateCheck skip recent", () => {
  it("should not check if checked within the last 24 h", async () => {
    const { checkForUpdate } = await import("../lib/ipc");
    const recent = Date.now() - CHECK_INTERVAL_MS + 1_000;
    useUpdateState.setState({ ...useUpdateState.getInitialState(), lastCheckedAt: recent }, true);
    renderHook(() => useUpdateCheck());
    act(() => {
      vi.advanceTimersByTime(STARTUP_DELAY_MS + 1_000);
    });
    expect(checkForUpdate).not.toHaveBeenCalled();
  });

  it("should check when lastCheckedAt is exactly CHECK_INTERVAL_MS ago", async () => {
    const { checkForUpdate } = await import("../lib/ipc");
    vi.mocked(checkForUpdate).mockResolvedValue({
      current: "0.1.0",
      latest: null,
      available: false,
      url: null,
    });
    const old = Date.now() - CHECK_INTERVAL_MS;
    useUpdateState.setState({ ...useUpdateState.getInitialState(), lastCheckedAt: old }, true);
    renderHook(() => useUpdateCheck());
    await act(() => vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 1_000));
    expect(checkForUpdate).toHaveBeenCalledOnce();
  });
});

// Contract: toasts "Git Real ‹latest› is available" with a "Release notes"
// action when an update is available; marks checked on success.
describe("useUpdateCheck toast on update", () => {
  it("should toast info sticky with the new version when available", async () => {
    const { checkForUpdate } = await import("../lib/ipc");
    vi.mocked(checkForUpdate).mockResolvedValue({
      current: "0.1.0",
      latest: "1.0.0",
      available: true,
      url: "https://github.com/harmonizationllc/git-real/releases/tag/v1.0.0",
    });
    renderHook(() => useUpdateCheck());
    await act(() => vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 1_000));
    const toast = useToasts.getState().toasts.find((t) => t.text === "Git Real 1.0.0 is available");
    expect(toast).toBeDefined();
    // Must have a "Release notes" action.
    expect(toast?.action?.label).toBe("Release notes");
  });

  it("should invoke openExternal when the Release notes action is run", async () => {
    const { checkForUpdate, openExternal } = await import("../lib/ipc");
    const releaseUrl = "https://github.com/harmonizationllc/git-real/releases/tag/v1.0.0";
    vi.mocked(checkForUpdate).mockResolvedValue({
      current: "0.1.0",
      latest: "1.0.0",
      available: true,
      url: releaseUrl,
    });
    renderHook(() => useUpdateCheck());
    await act(() => vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 1_000));
    const toast = useToasts.getState().toasts.find((t) => t.text === "Git Real 1.0.0 is available");
    expect(toast?.action).not.toBeNull();
    // Run the action — this calls openExternal with the release URL.
    toast!.action!.run();
    expect(openExternal).toHaveBeenCalledWith(releaseUrl);
  });

  it("should omit the Release notes action when url is null", async () => {
    const { checkForUpdate } = await import("../lib/ipc");
    vi.mocked(checkForUpdate).mockResolvedValue({
      current: "0.1.0",
      latest: "1.0.0",
      available: true,
      url: null,
    });
    renderHook(() => useUpdateCheck());
    await act(() => vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 1_000));
    const toast = useToasts.getState().toasts.find((t) => t.text === "Git Real 1.0.0 is available");
    expect(toast).toBeDefined();
    // No url → action must be null (not a Release notes link).
    expect(toast?.action).toBeNull();
  });

  it("should call markChecked after a successful check", async () => {
    const { checkForUpdate } = await import("../lib/ipc");
    vi.mocked(checkForUpdate).mockResolvedValue({
      current: "0.1.0",
      latest: null,
      available: false,
      url: null,
    });
    renderHook(() => useUpdateCheck());
    await act(() => vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 1_000));
    expect(checkForUpdate).toHaveBeenCalledOnce();
    expect(useUpdateState.getState().lastCheckedAt).not.toBeNull();
  });
});

// Contract: swallows failures silently and still marks checked.
describe("useUpdateCheck failure handling", () => {
  it("should swallow a checkForUpdate rejection without crashing", async () => {
    const { checkForUpdate } = await import("../lib/ipc");
    vi.mocked(checkForUpdate).mockRejectedValue({
      kind: "updateCheckFailed",
      message: "rate limited",
    });
    const { unmount } = renderHook(() => useUpdateCheck());
    await act(() => vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 1_000));
    expect(checkForUpdate).toHaveBeenCalledOnce();
    // No error toast — failures are silently swallowed.
    expect(useToasts.getState().toasts).toHaveLength(0);
    unmount();
  });

  it("should call markChecked even when checkForUpdate rejects", async () => {
    const { checkForUpdate } = await import("../lib/ipc");
    vi.mocked(checkForUpdate).mockRejectedValue({ kind: "updateCheckFailed", message: "x" });
    renderHook(() => useUpdateCheck());
    await act(() => vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + 1_000));
    expect(checkForUpdate).toHaveBeenCalledOnce();
    expect(useUpdateState.getState().lastCheckedAt).not.toBeNull();
  });
});

// Contract: unmounting clears the pending timer.
describe("useUpdateCheck cleanup", () => {
  it("should clear the startup timer on unmount before it fires", async () => {
    const { checkForUpdate } = await import("../lib/ipc");
    const { unmount } = renderHook(() => useUpdateCheck());
    unmount();
    act(() => {
      vi.advanceTimersByTime(STARTUP_DELAY_MS + 1_000);
    });
    expect(checkForUpdate).not.toHaveBeenCalled();
  });
});
