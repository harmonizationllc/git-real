// Settings IPC wrappers; GR-29 moved them to the nested version-2 shape.

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkSettingsHealth,
  getSettings,
  revealSettingsFile,
  syncWindowBackground,
  updateSettings,
} from "./settings";
import type { Settings, SettingsPatch } from "./types";

type Call = { cmd: string; args: Record<string, unknown> };

function mockWith(value: unknown): Call[] {
  const calls: Call[] = [];
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: (args as Record<string, unknown>) ?? {} });
    return value;
  });
  return calls;
}

function mockThrowing(err: unknown): void {
  mockIPC(() => {
    throw err;
  });
}

afterEach(() => {
  clearMocks();
});

const defaultSettings: Settings = {
  git: { executable: null },
  clone: { defaultDir: null, urlForm: "https" },
  tools: { editor: null, diffTool: null, mergeTool: null },
  appearance: { theme: "system", diffFontFamily: null, diffFontSize: 13 },
  diff: { mode: "split", ignoreWhitespace: false },
  layout: {
    refsWidth: 240,
    sidebarWidth: 320,
    tagsCollapsed: true,
    pullRequestsCollapsed: false,
    issuesCollapsed: true,
    branchesHeight: null,
    stashesHeight: null,
    tagsHeight: null,
    pullRequestsHeight: null,
  },
  updates: { checkOnStartup: true },
  window: { width: 1280, height: 800, maximized: false },
};

// Contract: getSettings invokes get_settings with no arguments.
describe("getSettings", () => {
  it("sends get_settings with no arguments", async () => {
    const calls = mockWith(defaultSettings);
    const result = await getSettings();
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("get_settings");
    expect(calls[0].args).toEqual({});
    expect(result).toEqual(defaultSettings);
  });

  it("getSettings rejection passes through", async () => {
    const err = { kind: "io", message: "disk error" };
    mockThrowing(err);
    await expect(getSettings()).rejects.toBe(err);
  });
});

// Contract: updateSettings sends the nested patch under the 'patch' key, including null values.
describe("updateSettings", () => {
  it("sends the patch under patch (null keys included)", async () => {
    const calls = mockWith(defaultSettings);
    const patch: SettingsPatch = { tools: { editor: null, diffTool: "meld" } };
    const result = await updateSettings(patch);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("update_settings");
    expect(calls[0].args).toEqual({ patch });
    expect(result).toEqual(defaultSettings);
  });

  it("updateSettings sends an empty patch object", async () => {
    const calls = mockWith(defaultSettings);
    await updateSettings({});
    expect(calls[0].args).toEqual({ patch: {} });
  });

  it("updateSettings rejection passes through", async () => {
    const err = { kind: "invalidSettings", message: "bad path" };
    mockThrowing(err);
    await expect(updateSettings({ clone: { defaultDir: "relative" } })).rejects.toBe(err);
  });
});

// Contract (GR-29): revealSettingsFile invokes reveal_settings_file with no arguments.
describe("revealSettingsFile", () => {
  it("sends reveal_settings_file with no arguments and resolves to undefined", async () => {
    const calls = mockWith(null);
    await expect(revealSettingsFile()).resolves.toBeUndefined();
    expect(calls).toEqual([{ cmd: "reveal_settings_file", args: {} }]);
  });

  it("revealSettingsFile rejection passes through", async () => {
    const err = { kind: "io", message: "no file manager" };
    mockThrowing(err);
    await expect(revealSettingsFile()).rejects.toBe(err);
  });
});

// Contract (GR-29): checkSettingsHealth invokes check_settings_health and returns its reply.
describe("checkSettingsHealth", () => {
  it("sends check_settings_health with no arguments", async () => {
    const calls = mockWith({ defaultCloneDirMissing: true });
    await expect(checkSettingsHealth()).resolves.toEqual({ defaultCloneDirMissing: true });
    expect(calls).toEqual([{ cmd: "check_settings_health", args: {} }]);
  });

  it("checkSettingsHealth rejection passes through", async () => {
    const err = { kind: "io", message: "disk error" };
    mockThrowing(err);
    await expect(checkSettingsHealth()).rejects.toBe(err);
  });
});

// Contract (GR-19): syncWindowBackground invokes sync_window_background with the page's scheme flag.
describe("syncWindowBackground", () => {
  it("sends sync_window_background with desktopDark and resolves to undefined", async () => {
    const calls = mockWith(null);
    await expect(syncWindowBackground(true)).resolves.toBeUndefined();
    expect(calls).toEqual([{ cmd: "sync_window_background", args: { desktopDark: true } }]);
  });

  it("syncWindowBackground rejection passes through", async () => {
    const err = { kind: "io", message: "no window" };
    mockThrowing(err);
    await expect(syncWindowBackground(false)).rejects.toBe(err);
  });
});
