// GR-15 Cycle 1, Task 3 – IPC seam tests for appVersion.
//
// RED PHASE: `./app` does not exist yet; every test in this file fails at
// module resolution time.

import { afterEach, describe, expect, it, vi } from "vitest";
import { appVersion } from "./app"; // RED: module missing

vi.mock(import("@tauri-apps/api/app"), async () => ({
  getVersion: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

// Contract: appVersion calls Tauri's getVersion() and returns the string.
describe("appVersion", () => {
  it("should return the version string from getVersion", async () => {
    const { getVersion } = await import("@tauri-apps/api/app");
    vi.mocked(getVersion).mockResolvedValue("0.1.0");
    const result = await appVersion();
    expect(result).toBe("0.1.0");
    expect(getVersion).toHaveBeenCalledOnce();
  });

  it("should propagate a rejection from getVersion", async () => {
    const { getVersion } = await import("@tauri-apps/api/app");
    vi.mocked(getVersion).mockRejectedValue(new Error("plugin unavailable"));
    await expect(appVersion()).rejects.toThrow("plugin unavailable");
  });
});
