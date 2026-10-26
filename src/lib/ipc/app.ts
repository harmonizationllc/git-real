import { getVersion } from "@tauri-apps/api/app";

/** This build's version, from the Tauri app plugin (`plugin:app|version`). */
export function appVersion(): Promise<string> {
  return getVersion();
}
