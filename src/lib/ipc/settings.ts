import { invoke } from "@tauri-apps/api/core";
import type { Settings, SettingsHealth, SettingsPatch } from "./types";

export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return invoke<Settings>("update_settings", { patch });
}

/** Shows settings.json in the system file manager, creating it first if needed. */
export async function revealSettingsFile(): Promise<void> {
  await invoke("reveal_settings_file");
}

export function checkSettingsHealth(): Promise<SettingsHealth> {
  return invoke<SettingsHealth>("check_settings_health");
}
