import { open } from "@tauri-apps/plugin-dialog";

export function pickFolder(title?: string): Promise<string | null> {
  return open({ directory: true, multiple: false, title });
}
