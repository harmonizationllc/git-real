import { invoke } from "@tauri-apps/api/core";
import type { Settings, SettingsPatch } from "./types";

export function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return invoke<Settings>("update_settings", { patch });
}
