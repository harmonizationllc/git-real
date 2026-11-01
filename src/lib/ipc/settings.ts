import { invoke } from "@tauri-apps/api/core";
import type { Settings, SettingsHealth, SettingsPatch, ThemePref } from "./types";

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

/** Tells Rust the page's theme and the desktop colour scheme it sees, so the window background matches. */
export async function syncWindowBackground(theme: ThemePref, desktopDark: boolean): Promise<void> {
  await invoke("sync_window_background", { theme, desktopDark });
}
