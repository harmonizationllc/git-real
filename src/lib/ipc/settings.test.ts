// Task 5: Failing tests for settings IPC wrappers.
// Imports reference modules/symbols that do not yet exist — red phase.

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it } from "vitest";
import { getSettings, updateSettings } from "./settings";
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
  defaultCloneDir: null,
  gitExecutable: null,
  externalEditor: null,
  externalDiffTool: null,
  externalMergeTool: null,
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

// Contract: updateSettings sends the patch under the 'patch' key, including null values.
describe("updateSettings", () => {
  it("sends the patch under patch (null keys included)", async () => {
    const calls = mockWith(defaultSettings);
    const patch: SettingsPatch = { externalEditor: null, externalDiffTool: "meld" };
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
    await expect(updateSettings({ defaultCloneDir: "relative" })).rejects.toBe(err);
  });
});
