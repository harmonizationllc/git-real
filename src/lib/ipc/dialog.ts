import { open } from "@tauri-apps/plugin-dialog";

export function pickFolder(title?: string, defaultPath?: string): Promise<string | null> {
  return open({
    directory: true,
    multiple: false,
    title,
    ...(defaultPath !== undefined ? { defaultPath } : {}),
  });
}

export function pickFile(title?: string): Promise<string | null> {
  return open({ directory: false, multiple: false, title });
}
