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

/** The absolute path of settings.json. */
export function settingsFilePath(): Promise<string> {
  return invoke<string>("settings_file_path");
}

/** Tells Rust the desktop colour scheme the page sees, so the window background follows it on `system`. */
export async function syncWindowBackground(desktopDark: boolean): Promise<void> {
  await invoke("sync_window_background", { desktopDark });
}
