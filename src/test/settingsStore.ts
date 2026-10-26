import { vi } from "vitest";
import { updateSettings } from "../lib/ipc";
import type { Settings, SettingsPatch } from "../lib/ipc";
import { DEFAULT_SETTINGS, useSettings } from "../lib/store/settings";

/** What the stand-in backend holds; `updateSettings` merges patches into it like Rust does. */
let server: Settings = DEFAULT_SETTINGS;

function apply(patch: SettingsPatch): Settings {
  const next = { ...server } as Record<string, unknown>;
  for (const section of Object.keys(patch) as (keyof Settings)[]) {
    next[section] = { ...server[section], ...patch[section] };
  }
  server = next as unknown as Settings;
  return server;
}

/**
 * Puts the settings store and a stand-in backend back to the defaults. Call it in `beforeEach`,
 * after any `vi.resetAllMocks()`, from a file that mocks `../lib/ipc` with `updateSettings: vi.fn()`.
 * Calls made while resetting or seeding are not counted. It first drains edits a previous test left pending so they cannot land in this one.
 * That drain awaits in-flight requests, so it would hang on a mocked `updateSettings` that never settles.
 */
export async function resetSettings(): Promise<void> {
  await useSettings.getState().flush();
  server = DEFAULT_SETTINGS;
  vi.mocked(updateSettings).mockImplementation(async (patch) => apply(patch));
  await useSettings.getState().save(DEFAULT_SETTINGS);
  vi.mocked(updateSettings).mockClear();
}

/**
 * Starts a test from non-default settings. It goes through the backend stand-in, because the
 * store re-derives what it shows from the last backend reply and a bare `setState` would be lost.
 */
export async function seedSettings(patch: SettingsPatch): Promise<void> {
  await useSettings.getState().save(patch);
  vi.mocked(updateSettings).mockClear();
}
